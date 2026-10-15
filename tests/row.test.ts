import { expect, test } from 'claude-code/testing'

import type { Entry, Live } from '../types'
import {
  FOCUS_HOLD,
  TOKEN_FLASH_FRAMES,
  advance,
  createAnim,
  isFocusSettled,
  isSettled,
  markFlow,
  pickFocus,
  raiseBadge,
  setOdo,
  stepOdo,
  stepTokenOdo,
  syncTargets,
  tokenText,
  tweenColorTo,
  tweenTo,
  tweenValue,
} from '../hooks/anim'
import type { Focus, Odo, Scene } from '../hooks/anim'
import {
  DARK,
  DEFAULT,
  DEFAULT_DISPLAY,
  DOWN,
  EMPTY_BAR,
  FIGURES,
  LIVE,
  LIVE_FILL,
  RAMP,
  SEP,
  TOKEN_FLASH_UP,
  UP,
  WHITE,
  lighten,
  mixColor,
} from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { formatCost, formatTokens, logShare } from '../hooks/format'
import { composeRow, meterCells, normalizeSettings, stripLayout, stripWidths, tokenCells } from '../hooks/row'
import type { StripItem, TokenFigure } from '../hooks/row'

const EFFECTS_OFF = { reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' }

function entry(over: Partial<Entry> = {}): Entry {
  return {
    n: 1,
    symbol: 'FIX',
    prompt: 'fix the login bug',
    costUsd: 0.42,
    tokensIn: 312_400,
    tokensOut: 2100,
    cacheRead: 293_656,
    cacheWrite: 16_744,
    model: 'claude-opus-5-5',
    durationMs: 4000,
    at: 0,
    agents: 0,
    isAborted: false,
    ...over,
  }
}

const SYMBOLS = ['EXPLAI', 'FIX', 'ALPHA', 'BRAVO', 'CHARLI', 'DELTA']

/** Finished entries n = 1, 2, ... with the given costs. */
const entriesOf = (costs: number[]): Entry[] => costs.map((costUsd, i) => entry({ n: i + 1, symbol: SYMBOLS[i] ?? 'TURN', costUsd }))

const text = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** A token figure at rest: its formatted text, no flash. */
const fig = (n: number): TokenFigure => ({ text: formatTokens(n), flash: null })

const live = (over: Partial<Live> = {}): Live => ({
  turnId: 'live-1',
  symbol: 'EXPLAI',
  prompt: 'explain the cache',
  startUsd: 0,
  startedAt: 0,
  main: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
  agent: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  agentIds: [],
  costUsd: 0.05,
  foreignUsd: 0,
  ...over,
})

function compose(
  entries: Entry[],
  options: Record<string, unknown>,
  cols: number,
  extra: { ledger?: number | null; live?: Live | null; still?: boolean; growing?: number[] } = {},
) {
  const settings = normalizeSettings(options)
  const scene: Scene = { entries, live: extra.live ?? null, ledger: extra.ledger ?? null, growing: extra.growing ?? [] }
  const anim = createAnim()
  syncTargets(anim, scene, settings, 's')

  return composeRow(scene, anim, settings, cols, extra.still ?? false)
}

/** The reference scene: EXPLAI $0.11, then FIX $0.42 (312K in, 94% cached), ledger $0.53. */
const reference = (options: Record<string, unknown>, cols: number, still = false) =>
  compose([entry({ n: 1, symbol: 'EXPLAI', costUsd: 0.11 }), entry({ n: 2, symbol: 'FIX', costUsd: 0.42 })], options, cols, {
    ledger: 0.53,
    still,
  })

/** The runs of cells on a non-default background in cells `from` to `to` (inclusive): where each starts and ends. */
function bgRuns(cells: Cell[], from: number, to: number): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = []
  for (let i = from; i <= to; i++) {
    const on = cells[i]?.bg !== DEFAULT
    const last = runs.at(-1)
    if (on && last !== undefined && last.end === i - 1) last.end = i
    else if (on) runs.push({ start: i, end: i })
  }

  return runs
}

test('normalizeSettings: the style, the five effects, the strip labels and the gap, each with a default', () => {
  expect(normalizeSettings({})).toEqual({
    style: 'meter',
    effects: { reacts: true, stock: true, celebrate: true, shimmer: true, grow: true },
    display: DEFAULT_DISPLAY,
    stripLabels: true,
    stripTurns: 12,
    gapAbove: true,
  })
  const odd = normalizeSettings({ style: 'bogus', stock: 'off', stripLabels: 'off', gapAbove: 'off', particles: 'on' })
  expect(odd.style).toBe('meter')
  expect(odd.effects.stock).toBe(false)
  expect(odd.effects.reacts).toBe(true)
  expect(odd.stripLabels).toBe(false)
  expect(odd.gapAbove).toBe(false)
})

test('normalizeSettings: strip turns', () => {
  expect(normalizeSettings({}).stripTurns).toBe(12)
  expect(normalizeSettings({ stripTurns: '8' }).stripTurns).toBe(8)
  expect(normalizeSettings({ stripTurns: '16' }).stripTurns).toBe(16)
  expect(normalizeSettings({ stripTurns: '24' }).stripTurns).toBe(24)
  expect(normalizeSettings({ stripTurns: 'bogus' }).stripTurns).toBe(12)
  expect(normalizeSettings({ stripTurns: '10' }).stripTurns).toBe(12)
})

test('meter, still: the left core, the label, the Blocks bar, the dividers and the figures in plain gray', () => {
  const { cells } = reference(EFFECTS_OFF, 100)
  const row = text(cells)
  expect(cells.length).toBe(100)
  expect(row.startsWith('Σ $0.53 │ ● FIX │ █')).toBe(true)
  expect(row).toContain('░ │ $0.42 ▲0.31 │ 312K↓ 2.1K↑')
  expect(row).not.toContain('%c')
  // The fixed log scale: $0.42 fills 36 of the 49 cells (100 minus the 51 of the other parts).
  const start = cells.findIndex(c => c.cp === 0x2588)
  expect(start).toBe(18)
  const bar = cells.slice(start, start + 49)
  expect(bar.slice(0, 36).every(c => c.cp === 0x2588 && c.fg === FIGURES)).toBe(true)
  expect(bar.slice(36).every(c => c.cp === 0x2591 && c.fg === SEP)).toBe(true)
  expect(bar.slice(36).length).toBe(13)
  expect(cells[10]?.cp).toBe(0x25cf)
  expect(cells[10]?.fg).toBe(SEP)
  expect(cells.find(c => c.cp === 0x25b2)?.fg).toBe(UP)
  // The token figures are plain gray; no cell of the row has a background.
  const at = row.indexOf('312K')
  expect(cells.slice(at, at + 4).every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)
  expect(cells[at + 4]?.cp).toBe(0x2193)
  expect(cells[at + 4]?.fg).toBe(FIGURES)
  expect(cells[at + 4]?.bg).toBe(DEFAULT)
  expect(cells.filter(c => c.bg !== DEFAULT).length).toBe(0)
})

test('meter: a turn of $0.20 fills 29 of the 49 cells on the fixed log scale', () => {
  const { cells } = compose(entriesOf([0.4, 0.2]), EFFECTS_OFF, 100)
  const start = cells.findIndex(c => c.cp === 0x2588)
  const bar = cells.slice(start, start + 49)
  expect(bar.slice(0, 29).every(c => c.cp === 0x2588 && c.fg === FIGURES)).toBe(true)
  expect(bar.slice(29).every(c => c.cp === 0x2591 && c.fg === SEP)).toBe(true)
  expect(bar.slice(29).length).toBe(20)
})

test('chart: one bar per turn, newest at the right, empty slots on the left, teal by the median', () => {
  const { cells } = compose(entriesOf([0.1, 0.2, 0.3, 0.9]), { ...EFFECTS_OFF, style: 'chart' }, 100)
  // The label (● BRAVO, 7 cells) and its divider come first: the 32 bars start at cell 20.
  expect(text(cells.slice(0, 20))).toBe('Σ $1.50 │ ● BRAVO │ ')
  const slots = cells.slice(20, 52)
  expect(slots.slice(0, 28).every(c => c.cp === 0x2581 && c.fg === EMPTY_BAR)).toBe(true)
  expect(slots.slice(28).map(c => c.cp)).toEqual([0x2584, 0x2585, 0x2585, 0x2587])
  expect(slots.slice(28).map(c => c.fg)).toEqual([RAMP[0], RAMP[1], RAMP[2], RAMP[3]])
})

test('strip: widths follow the shares, names sit inside the blocks, a young session is gray', () => {
  const { cells } = reference({ ...EFFECTS_OFF, style: 'strip' }, 120)
  const row = text(cells)
  expect(stripWidths([0.11, 0.42], 68)).toEqual([14, 54])
  expect(row).toContain(' EXPLAI 21%')
  expect(row).toContain(' FIX 79%')
  // The label (● FIX, 5 cells) and its divider come first: the strip starts at cell 18.
  expect(text(cells.slice(0, 18))).toBe('Σ $0.53 │ ● FIX │ ')
  expect(cells[18]?.bg).toBe(FIGURES)
  expect(cells[32]?.cp).toBe(0x20)
  expect(cells[32]?.bg).toBe(DEFAULT)
  expect(cells[33]?.bg).toBe(FIGURES)
  const at = row.indexOf(' EXPLAI 21%')
  expect(cells.slice(at + 1, at + 11).every(c => c.fg === DARK)).toBe(true)
  expect(stripWidths([1, 0, 0], 5)).toEqual([3, 1, 1])
  expect(stripWidths([0, 0], 5)).toEqual([2, 3])
  // Narrower: the first block has room for the name only.
  const narrow = text(reference({ ...EFFECTS_OFF, style: 'strip' }, 100).cells)
  expect(stripWidths([0.11, 0.42], 48)).toEqual([10, 38])
  expect(narrow).toContain(' EXPLAI ')
  expect(narrow).not.toContain('EXPLAI 21%')
})

test('stripLayout: a tiny turn keeps two cells, taken from the widest blocks', () => {
  const values = [1, 1, 1, 1, 1, 1, 1, 0.001]
  const items: StripItem[] = values.map((value, i) => ({ kind: 'turn', n: i + 1, symbol: SYMBOLS[i] ?? 'TURN', value }))
  const blocks = stripLayout(items, 40)
  expect(blocks.map(b => b.width)).toEqual([4, 4, 4, 4, 5, 5, 5, 2])
  expect(blocks.every(b => b.kind === 'turn')).toBe(true)
})

test('stripLayout: the running turn keeps three cells at the least', () => {
  const items: StripItem[] = [
    { kind: 'turn', n: 1, symbol: 'AAA', value: 0.9 },
    { kind: 'turn', n: 2, symbol: 'BBB', value: 0.9 },
    { kind: 'live', n: 3, symbol: 'CCC', value: 0 },
  ]
  const blocks = stripLayout(items, 20)
  expect(blocks.map(b => b.kind)).toEqual(['turn', 'turn', 'live'])
  expect(blocks.reduce((s, b) => s + b.width, 0)).toBe(18)
  expect(blocks[2]?.width).toBe(3)
})

test('strip labels off: the blocks carry no text', () => {
  const row = text(reference({ ...EFFECTS_OFF, style: 'strip', stripLabels: 'off' }, 120).cells)
  // The turn name of the newest turn still reads in the label before the bar; the blocks hold nothing.
  expect(row).not.toContain('EXPLAI')
  expect(row).not.toContain('21%')
  expect(row).not.toContain('79%')
})

test('strip ramp: finished blocks take the teal ramp and every turn keeps its own block', () => {
  const { cells } = compose(entriesOf([0.1, 0.2, 0.3, 0.9]), { ...EFFECTS_OFF, style: 'strip' }, 120)
  const row = text(cells)
  expect(stripWidths([0.1, 0.2, 0.3, 0.9], 66)).toEqual([4, 9, 13, 40])
  // The label (● BRAVO, 7 cells) and its divider come first: the strip starts at cell 20.
  expect(cells.slice(20, 24).every(c => c.cp === 0x20 && c.bg === RAMP[0])).toBe(true)
  expect(cells[24]?.bg).toBe(DEFAULT)
  const fix = row.indexOf(' FIX 13%') + 1
  expect(fix).toBe(26)
  expect(cells[fix]?.bg).toBe(RAMP[1])
  expect(cells[fix]?.fg).toBe(WHITE)
  const alpha = row.indexOf(' ALPHA 20%') + 1
  expect(cells[alpha]?.bg).toBe(RAMP[2])
  expect(cells[alpha]?.fg).toBe(DARK)
  const bravo = row.indexOf(' BRAVO 60%') + 1
  expect(cells[bravo]?.bg).toBe(RAMP[3])
  expect(cells[bravo]?.fg).toBe(DARK)
  expect(cells.slice(20, 89).some(c => c.cp === 0x2591)).toBe(false)
  expect(cells.some(c => c.bg === 0x005f87 || c.bg === 0x5f5f87)).toBe(false)
})

/** 25 finished turns: 0.1 for the odd numbers, 0.12 for the even ones. */
const longSession = (): Entry[] =>
  Array.from({ length: 25 }, (_, i) => entry({ n: i + 1, symbol: 'TURN', costUsd: (i + 1) % 2 === 1 ? 0.1 : 0.12 }))

test('a long session keeps 8 colored blocks, also when the running turn ends', () => {
  const options = { ...EFFECTS_OFF, style: 'strip', stripTurns: '8' }
  const turns = longSession()
  const items: StripItem[] = turns.slice(17).map(e => ({ kind: 'turn', n: e.n, symbol: e.symbol, value: e.costUsd }))
  expect(stripLayout(items, 59).map(b => b.width)).toEqual([7, 6, 7, 6, 7, 6, 7, 6])

  const finished = compose(turns, options, 110).cells
  // The label comes first: ● TURN (6 cells) puts the 59-cell strip at cells 19 to 77.
  const runs = bgRuns(finished, 19, 77)
  expect(runs.length).toBe(8)
  expect(runs.slice(1).every((r, i) => r.start - (runs[i]?.end ?? 0) === 2)).toBe(true)
  expect(finished.slice(19, 78).filter(c => c.bg !== DEFAULT).every(c => c.bg === RAMP[2])).toBe(true)
  expect(finished.some(c => c.cp === 0x2591)).toBe(false)

  // The same session with the 25th turn still running (● EXPLAI, 8 cells: the strip at cells 21 to 79), and again once it has ended.
  const running = compose(turns.slice(0, 24), options, 110, { live: live({ costUsd: 0.1 }) }).cells
  const runningRuns = bgRuns(running, 21, 79)
  expect(runningRuns.length).toBe(8)
  expect(running.some(c => c.cp === 0x2591)).toBe(false)
  const lastRun = bgRuns(finished, 19, 77).at(-1)
  expect(finished[lastRun?.start ?? 0]?.bg).toBe(RAMP[2])
})

test('the odometer rolls one step a frame and flashes the digits that changed', () => {
  const odo: Odo = { shown: 0.38, target: 0.38, flashFrom: 0, flashUntil: 0, flashDir: 'up' }
  setOdo(odo, 0.42, false)
  const seen: string[] = []
  for (let tick = 1; tick <= 4; tick++) {
    stepOdo(odo, tick)
    seen.push(formatCost(odo.shown))
    if (tick === 2) {
      expect(odo.flashFrom).toBe(3)
      expect(odo.flashDir).toBe('up')
      expect(odo.flashUntil).toBe(5)
    }
  }
  expect(seen).toEqual(['$0.39', '$0.40', '$0.41', '$0.42'])
})

test('badges: a higher priority replaces, a lower one is ignored, and each expires', () => {
  const anim = createAnim()
  const { effects } = normalizeSettings({})
  raiseBadge(anim, 'tool', 'x', 8)
  expect(anim.badge.kind).toBe('tool')
  raiseBadge(anim, 'high', 'y', 10)
  expect(anim.badge.kind).toBe('high')
  raiseBadge(anim, 'tool', 'z', 8)
  expect(anim.badge.kind).toBe('high')
  for (let i = 0; i < 10; i++) advance(anim, effects)
  expect(anim.badge.kind).toBe('none')
})

test('shimmer sweeps the current turn while tokens flow', () => {
  const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off' })
  const scene: Scene = { entries: entriesOf([0.11]), live: live(), ledger: 0.16, growing: [] }
  const bar = (cells: Cell[]) => cells.filter(c => c.cp === 0x2588)

  const anim = createAnim()
  syncTargets(anim, scene, settings, 's')
  markFlow(anim)
  const flowing = bar(composeRow(scene, anim, settings, 100, false).cells)
  expect(flowing.length).toBe(17)
  expect(flowing[0]?.fg).toBe(lighten(LIVE, 0.55))
  expect(flowing[1]?.fg).toBe(lighten(LIVE, 0.3))
  expect(flowing.slice(2).every(c => c.fg === LIVE)).toBe(true)
  expect(lighten(LIVE, 0.55)).toBe(0xdbdbed)

  const quiet = createAnim()
  syncTargets(quiet, scene, settings, 's')
  const resting = bar(composeRow(scene, quiet, settings, 100, false).cells)
  expect(resting.length).toBe(17)
  expect(resting.every(c => c.fg === LIVE)).toBe(true)

  const still = createAnim()
  syncTargets(still, scene, settings, 's')
  markFlow(still)
  expect(bar(composeRow(scene, still, settings, 100, true).cells).every(c => c.fg === LIVE)).toBe(true)

  const chart = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', style: 'chart' })
  const pulse = createAnim(2)
  syncTargets(pulse, scene, chart, 's')
  markFlow(pulse)
  // ● EXPLAI (8 cells) and its divider put the 32 bars at cells 21 to 52.
  expect(composeRow(scene, pulse, chart, 100, false).cells[52]?.fg).toBe(lighten(LIVE, 0.55))
})

test('narrow rows drop whole groups in order, never leaving a bar dangling or doubled', () => {
  const wide = text(reference({}, 100, true).cells)
  expect(wide).toContain('312K↓')
  expect(wide).toContain('▲0.31 │ 312K↓')
  expect(wide).toContain('│ ● FIX │ █')
  expect(wide).toContain('░ │ $0.42')

  const narrow = reference({}, 60, true)
  const narrowText = text(narrow.cells)
  expect(narrow.cells.length).toBe(60)
  expect(narrowText).toContain('│ ● FIX │ █')
  expect(narrowText).toContain('│ $0.42 ▲0.31 │ 312K↓ 2.1K↑')

  const noTokens = text(reference({}, 50, true).cells)
  expect(noTokens).toContain('│ $0.42 ▲0.31')
  expect(noTokens).not.toContain('312K↓')
  expect(noTokens).not.toContain('▲0.31 │')

  const tiny = text(reference({}, 40, true).cells)
  expect(tiny).toContain('● FIX')
  expect(tiny).toContain('│ $0.42')
  expect(tiny).not.toContain('▲0.31')

  // With the label dropped the divider that followed it goes too: the bar then follows the core directly.
  const noLabel = text(reference({}, 37, true).cells)
  expect(noLabel).not.toContain('FIX')
  expect(noLabel).toContain('Σ $0.53 │ █')
  expect(noLabel).toContain('░ │ $0.42')

  // The thresholds of the sequence core, label, divider, bar (8 at the least), divider, cost, change, divider, tokens, badge:
  // 73 everything (the badge slot is blank on a still frame), 59..72 no badge, 45..58 also no tokens, 38..44 also no change,
  // 27..37 also no label, under 27 the core alone.
  for (const width of [100, 74, 73, 72, 59, 58, 45, 44, 38, 37, 27, 26, 22]) {
    expect(text(reference({}, width, true).cells)).not.toContain('│ │')
  }
  expect(text(reference({}, 59, true).cells)).toContain('312K↓')
  expect(text(reference({}, 58, true).cells)).not.toContain('312K↓')
  expect(text(reference({}, 45, true).cells)).toContain('▲0.31')
  expect(text(reference({}, 44, true).cells)).not.toContain('▲0.31')
  expect(text(reference({}, 38, true).cells)).toContain('● FIX')
  expect(text(reference({}, 37, true).cells)).not.toContain('FIX')
  expect(text(reference({}, 27, true).cells)).toContain('│ $0.42')
  expect(text(reference({}, 26, true).cells)).not.toContain('$0.42')
})

test('chart and strip narrow: whole groups go, the divider after the label goes with it', () => {
  for (const style of ['chart', 'strip']) {
    const w50 = text(reference({ style }, 50, true).cells)
    expect(w50).toContain('Σ $0.53 │ ● FIX │ ')
    expect(w50).toContain(' │ $0.42 ▲0.31')
    expect(w50).not.toContain('312K↓')
    const w35 = text(reference({ style }, 35, true).cells)
    expect(w35).toContain('Σ $0.53 │ ')
    expect(w35).toContain(' │ $0.42')
    expect(w35).not.toContain('●')
    expect(w35).not.toContain('│ │')
  }
})

test('the label setting numbered reads #n and the symbol, the running turn with its upcoming number', () => {
  const finished = text(reference({ ...EFFECTS_OFF, label: 'numbered' }, 100).cells)
  expect(finished).toContain('Σ $0.53 │ ● #2 FIX │ █')
  const running = text(compose(entriesOf([0.11, 0.42]), { ...EFFECTS_OFF, label: 'numbered' }, 100, { live: live() }).cells)
  expect(running).toContain('● #3 EXPLAI │ ')
  // The strip blocks keep the bare symbol.
  const strip = text(reference({ ...EFFECTS_OFF, label: 'numbered', style: 'strip' }, 120).cells)
  expect(strip).toContain('● #2 FIX │ ')
  expect(strip).toContain(' EXPLAI 21%')
  expect(strip).toContain(' FIX 79%')
})

test('change off keeps one divider pair around the cost', () => {
  const row = text(reference({ ...EFFECTS_OFF, change: 'off' }, 100).cells)
  expect(row).toContain('│ $0.42 │ 312K↓')
  expect(row).not.toContain('▲')
})

test('tokenCells: every figure is plain gray, whatever the cached share', () => {
  for (const share of [0, 0.01, 0.5, 0.94, 1]) {
    const compact = tokenCells(fig(312_400), fig(2100), share, false, false)
    expect(text(compact)).toBe('312K↓ 2.1K↑')
    expect(compact.every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)
    const labeled = tokenCells(fig(312_400), fig(2100), share, true, false)
    expect(text(labeled)).toBe('312K in · 2.1K out')
    expect(labeled.every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)
  }

  const dim = tokenCells(fig(0), fig(0), 0, false, true)
  expect(text(dim)).toBe('0↓ 0↑')
  expect(dim.every(c => c.fg === SEP && c.bg === DEFAULT)).toBe(true)
  expect(text(tokenCells(fig(0), fig(0), 0, true, true))).toBe('0 in · 0 out')

  // A flashing figure colors its characters from the flash index on; the rest and the arrow stay gray.
  const flashing = tokenCells({ text: '2.4K', flash: { from: 2, dir: 'up' } }, fig(2100), 0, false, false)
  expect(text(flashing)).toBe('2.4K↓ 2.1K↑')
  expect(flashing.slice(0, 2).every(c => c.fg === FIGURES)).toBe(true)
  expect(flashing.slice(2, 4).every(c => c.fg === TOKEN_FLASH_UP)).toBe(true)
  expect(flashing[4]?.fg).toBe(FIGURES)
  expect(flashing.slice(5).every(c => c.fg === FIGURES)).toBe(true)
})

test('tokenCells with the cache percent: a gray note right after the input figure, none without usage', () => {
  const on = tokenCells(fig(312_400), fig(2100), 0.94, false, false, true)
  expect(text(on)).toBe('312K↓ (94%c) 2.1K↑')
  expect(on.every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)
  // Off (the default) is the old text.
  expect(text(tokenCells(fig(312_400), fig(2100), 0.94, false, false))).toBe('312K↓ 2.1K↑')
  expect(text(tokenCells(fig(312_400), fig(2100), 0.94, false, false, false))).toBe('312K↓ 2.1K↑')

  const labeled = tokenCells(fig(312_400), fig(2100), 0.5, true, false, true)
  expect(text(labeled)).toBe('312K in (50% cached) · 2.1K out')
  expect(labeled.every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)

  // Usage with nothing cached reads 0%; no usage yet (dim) or no input at all shows nothing, never (0%c).
  expect(text(tokenCells(fig(312_400), fig(2100), 0, false, false, true))).toBe('312K↓ (0%c) 2.1K↑')
  expect(text(tokenCells(fig(0), fig(0), 0, false, true, true))).toBe('0↓ 0↑')
  expect(text(tokenCells(fig(0), fig(0), 0, true, true, true))).toBe('0 in · 0 out')
  expect(text(tokenCells(fig(0), fig(0), 0, false, false, false))).toBe('0↓ 0↑')
})

test('the cache percent in the row: off by default, in the tokens group when on, rolling with the eased share', () => {
  expect(text(reference(EFFECTS_OFF, 100).cells)).not.toContain('%c')
  const on = { ...EFFECTS_OFF, cachePercent: 'on' }
  expect(text(reference(on, 100).cells)).toContain('│ 312K↓ (94%c) 2.1K↑')
  const labeled = text(reference({ ...on, tokens: 'labeled' }, 110).cells)
  expect(labeled).toContain('│ 312K in (94% cached) · 2.1K out')
  for (const style of ['chart', 'strip']) {
    expect(text(reference({ ...on, style }, 120).cells)).toContain('│ 312K↓ (94%c) 2.1K↑')
  }

  // The note goes with the tokens group (and its divider): 67 keeps it, 66 drops the group, never a dangling bar.
  const all = { cachePercent: 'on' }
  expect(text(reference(all, 67, true).cells)).toContain('312K↓ (94%c)')
  const w66 = text(reference(all, 66, true).cells)
  expect(w66).not.toContain('312K')
  expect(w66).not.toContain('%c')
  expect(w66).not.toContain('│ │')

  // A live turn without usage shows no note.
  const empty = live({
    main: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    costUsd: 0,
  })
  const none = text(compose([], on, 100, { live: empty }).cells)
  expect(none).toContain('│ 0↓ 0↑')
  expect(none).not.toContain('%c')

  // The percent follows the eased share: halfway there it reads between the old and the new value.
  const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', cachePercent: 'on' })
  const anim = createAnim()
  const at = (cacheRead: number): Scene => ({
    entries: [],
    live: live({
      main: { input_tokens: 1000 - cacheRead, output_tokens: 500, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    }),
    ledger: null,
    growing: [],
  })
  syncTargets(anim, at(0), settings, 's')
  composeRow(at(0), anim, settings, 100, false)
  composeRow(at(1000), anim, settings, 100, false)
  const seen: string[] = []
  for (const t of [1, 2, 3, 4]) {
    anim.tick = t
    const row = text(composeRow(at(1000), anim, settings, 100, false).cells)
    seen.push(/\((\d+)%c\)/.exec(row)?.[1] ?? '')
  }
  expect(seen).toEqual(['44', '75', '94', '100'])
})

test('token counts roll under stock, and stay put without it', () => {
  const at = (input: number): Scene => ({
    entries: entriesOf([0.1]),
    live: live({
      main: { input_tokens: input, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    ledger: null,
    growing: [],
  })
  const base = { reacts: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' }

  // stock on: the input figure steps once per frame toward 1.2M, right-aligned to the width of its target.
  const settings = normalizeSettings(base)
  const anim = createAnim()
  syncTargets(anim, at(10_000), settings, 's')
  syncTargets(anim, at(1_200_000), settings, 's')
  const seen: string[] = []
  const frames: Cell[][] = []
  for (let f = 0; f < 9; f++) {
    advance(anim, settings.effects)
    const cells = composeRow(at(1_200_000), anim, settings, 100, false).cells
    const row = text(cells)
    const i = row.indexOf('↓ 500↑')
    seen.push(row.slice(i - 4, i))
    frames.push(cells.slice(i - 4, i))
  }
  expect(seen).toEqual(['307K', '530K', '697K', '823K', '923K', '  1M', '1.1M', '1.2M', '1.2M'])
  // The first step changes every character: all four flash warm white.
  expect(frames[0]?.every(c => c.fg === TOKEN_FLASH_UP && c.bg === DEFAULT)).toBe(true)
  // 1.1M -> 1.2M changes only the third character on: the first two stay gray.
  expect(frames[7]?.slice(0, 2).every(c => c.fg === FIGURES)).toBe(true)
  expect(frames[7]?.slice(2).every(c => c.fg === TOKEN_FLASH_UP)).toBe(true)

  // stock off: the figure reads its target at once, with no flash.
  const off = normalizeSettings({ ...base, stock: 'off' })
  const still = createAnim()
  syncTargets(still, at(10_000), off, 's')
  syncTargets(still, at(1_200_000), off, 's')
  advance(still, off.effects)
  const cells = composeRow(at(1_200_000), still, off, 100, false).cells
  const row = text(cells)
  const i = row.indexOf('↓ 500↑')
  expect(row.slice(i - 4, i)).toBe('1.2M')
  expect(cells.slice(i - 4, i).every(c => c.fg === FIGURES && c.bg === DEFAULT)).toBe(true)
})

test('stepTokenOdo steps like claudespotter and flashes the changed digits', () => {
  const odo = (shown: number, target: number): Odo => ({ shown, target, flashFrom: 0, flashUntil: 0, flashDir: 'up' })

  // 2.1K -> 2.4K in one step; only the characters from the third on changed.
  const a = odo(2100, 2400)
  stepTokenOdo(a, 1)
  expect(a.shown).toBe(2400)
  expect(a.flashFrom).toBe(2)
  expect(a.flashUntil).toBe(4)
  expect(a.flashDir).toBe('up')

  // 0 -> 100: a quarter of the gap each frame, at least one unit.
  const b = odo(0, 100)
  const shown: number[] = []
  for (let t = 1; t <= 14; t++) {
    stepTokenOdo(b, t)
    shown.push(b.shown)
    if (t === 1) expect(b.flashFrom).toBe(1)
  }
  expect(shown).toEqual([25, 44, 58, 69, 77, 83, 88, 91, 94, 96, 97, 98, 99, 100])

  // The text is right-aligned to the width of the target's text.
  expect(tokenText(odo(999, 1200))).toBe(' 999')

  // A settled odometer is left untouched, flash fields included.
  const c: Odo = { shown: 5, target: 5, flashFrom: 3, flashUntil: 9, flashDir: 'down' }
  stepTokenOdo(c, 20)
  expect(c).toEqual({ shown: 5, target: 5, flashFrom: 3, flashUntil: 9, flashDir: 'down' })
})

test('the change updates at once: never rolled, never flashed', () => {
  const settings = normalizeSettings({ reacts: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' })
  const anim = createAnim()
  const at = (cost: number): Scene => ({
    entries: [entry({ n: 1, symbol: 'ALPHA', costUsd: 0.5 })],
    live: live({ costUsd: cost }),
    ledger: null,
    growing: [],
  })
  syncTargets(anim, at(0.75), settings, 's')
  composeRow(at(0.75), anim, settings, 100, false)
  for (const t of [0, 1, 4]) {
    anim.tick = t
    const cells = composeRow(at(0.25), anim, settings, 100, false).cells
    const row = text(cells)
    expect(row).toContain('▼0.25')
    const i = row.indexOf('▼0.25')
    expect(cells.slice(i, i + 5).every(c => c.fg === DOWN)).toBe(true)
  }
  expect(Array.from(anim.tweens.keys()).some(k => k.startsWith('dlt:'))).toBe(false)
})

test('a live turn with no usage yet reads 0↓ 0↑ in dim gray', () => {
  const empty = live({
    main: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    costUsd: 0,
  })
  const { cells } = compose([], EFFECTS_OFF, 100, { live: empty })
  const row = text(cells)
  expect(row).toContain('● EXPLAI')
  expect(row).toContain('│ $0.000 │ 0↓ 0↑')
  expect(row).not.toContain('…')
  const i = row.indexOf('0↓ 0↑')
  expect(cells.slice(i, i + 5).every(c => c.fg === SEP && c.bg === DEFAULT)).toBe(true)
})

test('no growing note in the badge spot: the row shows the turn itself', () => {
  const options = { stock: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' }
  const growingCells = compose(entriesOf([0.625, 0.125]), options, 100, { growing: [1] }).cells
  expect(text(growingCells)).toContain('↻ #1 EXPLAI │')
  expect(text(growingCells)).not.toContain('↻#')
  expect(growingCells.filter(c => c.cp === 0x21bb).length).toBe(1)
  const idleCells = compose(entriesOf([0.625, 0.125]), options, 100, { growing: [] }).cells
  expect(idleCells.some(c => c.cp === 0x21bb)).toBe(false)
})

// ---- v7: the row follows the active turn -----------------------------------------------------------

/** Three finished turns: #1 EXPLAI $0.20, #2 FIX $0.80, #3 ALPHA $0.05 (a young session: finished colors are FIGURES). */
const C3 = [0.2, 0.8, 0.05]

const focusScene = (costs: number[], growing: number[], l: Live | null = null): Scene => ({
  entries: entriesOf(costs),
  live: l,
  ledger: null,
  growing,
})

test('FOCUS_HOLD is 20 frames', () => {
  expect(FOCUS_HOLD).toBe(20)
})

test('pickFocus: a running turn wins at once', () => {
  const scene = focusScene(C3, [2], live())
  const prev: Focus = { n: 2, mode: 'growing', since: 0 }
  expect(pickFocus(scene, prev, 1, 20)).toEqual({ n: 4, mode: 'live', since: 1 })
  const running: Focus = { n: 4, mode: 'live', since: 0 }
  expect(pickFocus(scene, running, 5, 20)).toBe(running)
})

test('pickFocus: the helper that worked last', () => {
  expect(pickFocus(focusScene(C3, [1, 2]), null, 0, 20)).toEqual({ n: 2, mode: 'growing', since: 0 })
  expect(pickFocus(focusScene(C3, [2, 1]), null, 0, 20)).toEqual({ n: 1, mode: 'growing', since: 0 })
  expect(pickFocus(focusScene(C3, [9]), null, 0, 20)).toEqual({ n: 3, mode: 'rest', since: 0 })
  expect(pickFocus(focusScene(C3, []), null, 0, 20)).toEqual({ n: 3, mode: 'rest', since: 0 })
})

test('pickFocus: the hold', () => {
  const scene = focusScene(C3, [2])
  const prev: Focus = { n: 3, mode: 'rest', since: 10 }
  expect(pickFocus(scene, prev, 29, 20)).toBe(prev)
  expect(pickFocus(scene, prev, 30, 20)).toEqual({ n: 2, mode: 'growing', since: 30 })
  expect(pickFocus(scene, prev, 11, 0)).toEqual({ n: 2, mode: 'growing', since: 11 })
})

test('pickFocus: a turn that just ended stays 2 s with its final figures', () => {
  const scene = focusScene(C3, [2])
  const ended: Focus = { n: 3, mode: 'live', since: 0 }
  const held = pickFocus(scene, ended, 40, 20)
  expect(held).toEqual({ n: 3, mode: 'rest', since: 40 })
  expect(pickFocus(scene, held, 59, 20)).toBe(held)
  expect(pickFocus(scene, held, 60, 20)).toEqual({ n: 2, mode: 'growing', since: 60 })
  // A render that saw the new entry and the running turn together: prev.n is one too high.
  const transient: Focus = { n: 4, mode: 'live', since: 0 }
  expect(pickFocus(scene, transient, 40, 20)).toEqual({ n: 3, mode: 'rest', since: 40 })
  // The ended turn has a helper at work already.
  const withHelper = focusScene(C3, [3])
  expect(pickFocus(withHelper, ended, 40, 20)).toEqual({ n: 3, mode: 'growing', since: 40 })
})

test('pickFocus: a helper that finishes keeps the row 2 s, then the newest turn', () => {
  const scene = focusScene(C3, [])
  const working: Focus = { n: 2, mode: 'growing', since: 0 }
  const rested = pickFocus(scene, working, 50, 20)
  expect(rested).toEqual({ n: 2, mode: 'rest', since: 50 })
  expect(pickFocus(scene, rested, 69, 20)).toBe(rested)
  expect(pickFocus(scene, rested, 70, 20)).toEqual({ n: 3, mode: 'rest', since: 70 })
  const cleared: Scene = { entries: [], live: null, ledger: null, growing: [] }
  expect(pickFocus(cleared, { n: 2, mode: 'rest', since: 0 }, 1, 20)).toEqual({ n: 0, mode: 'rest', since: 1 })
})

test('isFocusSettled: true once the focus is where it would go without a hold', () => {
  const anim = createAnim()
  const scene = focusScene(C3, [2])
  syncTargets(anim, scene, normalizeSettings({}), 's')
  expect(anim.focus).toEqual({ n: 2, mode: 'growing', since: 0 })
  expect(isFocusSettled(anim, scene)).toBe(true)
  anim.focus = { n: 3, mode: 'rest', since: 0 }
  expect(isFocusSettled(anim, scene)).toBe(false)
})

test('the row shows the older turn a helper is still working on', () => {
  const row = (growing: number[], options: Record<string, unknown> = EFFECTS_OFF) =>
    compose(entriesOf(C3), options, 100, { growing }).cells

  const older = row([2])
  const olderText = text(older)
  expect(olderText.startsWith('Σ $1.05 │ ↻ #2 FIX │ █')).toBe(true)
  expect(olderText).toContain('░ │ $0.80 ▲0.60 │ 312K↓ 2.1K↑')
  expect(older[10]?.cp).toBe(0x21bb)
  expect(older[10]?.fg).toBe(LIVE)
  expect(older.slice(12, 18).every(c => c.fg === LIVE)).toBe(true)
  const cost = olderText.indexOf('$0.80')
  expect(older.slice(cost, cost + 5).every(c => c.fg === LIVE)).toBe(true)
  // B is 43: the label reserves the numbered form (2 + 12) while an older turn is on show.
  const at = older.findIndex(c => c.cp === 0x2588)
  expect(older.slice(at, at + 36).every(c => c.cp === 0x2588 && c.fg === LIVE)).toBe(true)
  expect(older.slice(at + 36, at + 43).every(c => c.cp === 0x2591 && c.fg === SEP)).toBe(true)

  const rest = row([])
  const restText = text(rest)
  expect(restText.startsWith('Σ $1.05 │ ● ALPHA │ █')).toBe(true)
  expect(restText).toContain('│ $0.050 ▼0.75 │')
  const restAt = rest.findIndex(c => c.cp === 0x2588)
  expect(rest.slice(restAt, restAt + 17).every(c => c.cp === 0x2588 && c.fg === FIGURES)).toBe(true)
  expect(rest.slice(restAt + 17, restAt + 49).every(c => c.cp === 0x2591)).toBe(true)
  expect(rest.some(c => c.cp === 0x21bb)).toBe(false)

  // The newest turn growing: the marker, but no number.
  const newest = row([3])
  expect(text(newest).startsWith('Σ $1.05 │ ↻ ALPHA │ █')).toBe(true)
  const newestAt = newest.findIndex(c => c.cp === 0x2588)
  expect(newest.slice(newestAt, newestAt + 17).every(c => c.cp === 0x2588 && c.fg === LIVE)).toBe(true)

  expect(text(row([2], { ...EFFECTS_OFF, label: 'prompt' }))).toContain('↻ #2 "fix the login bug" │')
  expect(text(row([2], { ...EFFECTS_OFF, label: 'number' }))).toContain('↻ #2 │')
})

test('chart: the focused older bar is lavender', () => {
  const options = { ...EFFECTS_OFF, style: 'chart' }
  const bars = (cells: Cell[]) => cells.filter(c => c.cp >= 0x2581 && c.cp <= 0x2588)
  const focused = bars(compose(entriesOf(C3), options, 100, { growing: [2] }).cells)
  const lavender = focused.filter(c => c.fg === LIVE)
  expect(lavender.length).toBe(1)
  expect(lavender[0]?.cp).toBe(0x2587)
  expect(focused.find(c => c.cp === 0x2583)?.fg).toBe(FIGURES)
  const idle = bars(compose(entriesOf(C3), options, 100, { growing: [] }).cells)
  expect(idle.some(c => c.fg === LIVE)).toBe(false)
})

test('strip: the focused older block is lavender', () => {
  const options = { ...EFFECTS_OFF, style: 'strip' }
  const cells = compose(entriesOf(C3), options, 120, { growing: [2] }).cells
  const idx = cells.map((c, i) => (c.bg === LIVE_FILL ? i : -1)).filter(i => i >= 0)
  expect(idx.length).toBeGreaterThan(0)
  const first = idx[0] ?? 0
  const last = idx.at(-1) ?? 0
  expect(last - first + 1).toBe(idx.length)
  const block = cells.slice(first, last + 1)
  expect(text(block)).toContain('FIX 76%')
  expect(block.filter(c => c.cp !== 0x20).every(c => c.fg === DARK)).toBe(true)
  const idle = compose(entriesOf(C3), options, 120, { growing: [] }).cells
  expect(idle.some(c => c.bg === LIVE_FILL)).toBe(false)

  // Outside the window: the strip stays the last turns in order; the label and the figures say which turn the row is on.
  const far = compose(entriesOf(Array.from({ length: 10 }, () => 0.1)), { ...options, stripTurns: '8' }, 120, { growing: [1] }).cells
  expect(far.some(c => c.bg === LIVE_FILL)).toBe(false)
  expect(text(far)).toContain('↻ #1 EXPLAI │ ')
  expect(text(far)).toContain('│ $0.10 │ 312K↓')
})

test('a focus switch snaps the cost, held 2 s, then it rolls', () => {
  const settings = normalizeSettings({ reacts: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' })
  const anim = createAnim()
  syncTargets(anim, focusScene(C3, []), settings, 's')
  expect(anim.focus?.n).toBe(3)
  expect(anim.turn.shown).toBe(0.05)

  anim.tick = 5
  syncTargets(anim, focusScene(C3, [2]), settings, 's')
  expect(anim.focus?.n).toBe(3)
  expect(anim.turn.shown).toBe(0.05)

  anim.tick = 20
  syncTargets(anim, focusScene(C3, [2]), settings, 's')
  expect(anim.focus).toEqual({ n: 2, mode: 'growing', since: 20 })
  expect(anim.turn.shown).toBe(0.8)
  expect(anim.turn.flashUntil).toBe(0)

  syncTargets(anim, focusScene([0.2, 1.0, 0.05], [2]), settings, 's')
  expect(anim.turn.target).toBe(1)
  expect(anim.turn.shown).toBe(0.8)
  advance(anim, settings.effects)
  expect(anim.turn.shown).toBeGreaterThan(0.8)
  expect(1).toBeGreaterThan(anim.turn.shown)
})

test('token figures snap on a focus switch and roll within a turn, keeping isSettled false while they move', () => {
  const settings = normalizeSettings({ reacts: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' })
  const entries = [
    entry({ n: 1, symbol: 'EXPLAI', costUsd: 0.2, tokensIn: 50_000, tokensOut: 800 }),
    entry({ n: 2, symbol: 'FIX', costUsd: 0.8, tokensIn: 20_000, tokensOut: 400 }),
    entry({ n: 3, symbol: 'ALPHA', costUsd: 0.05, tokensIn: 312_400, tokensOut: 2100 }),
  ]
  const scene = (l: Live | null, growing: number[]): Scene => ({ entries, live: l, ledger: null, growing })
  const anim = createAnim()
  syncTargets(anim, scene(null, []), settings, 's')
  expect(anim.focus?.n).toBe(3)
  expect(anim.tokensIn.shown).toBe(312_400)
  expect(anim.tokensOut.shown).toBe(2100)

  // A helper on turn 1: the focus moves after the hold and the figures snap to that turn's counts, with no flash.
  anim.tick = 20
  syncTargets(anim, scene(null, [1]), settings, 's')
  expect(anim.focus?.n).toBe(1)
  expect(anim.tokensIn.target).toBe(50_000)
  expect(anim.tokensIn.shown).toBe(anim.tokensIn.target)
  expect(anim.tokensIn.flashUntil).toBe(0)
  expect(anim.tokensOut.shown).toBe(800)

  // A new running turn snaps too; the same turn then receiving more usage rolls.
  const usage = (cacheRead: number): Live =>
    live({ main: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } })
  syncTargets(anim, scene(usage(9000), []), settings, 's')
  expect(anim.tokensIn.shown).toBe(10_000)
  syncTargets(anim, scene(usage(99_000), []), settings, 's')
  expect(anim.tokensIn.target).toBe(100_000)
  expect(anim.tokensIn.shown).toBe(10_000)
  expect(isSettled(anim)).toBe(false)
  let frames = 0
  while (anim.tokensIn.shown !== anim.tokensIn.target && frames < 20) {
    advance(anim, settings.effects)
    frames++
  }
  expect(anim.tokensIn.shown).toBe(anim.tokensIn.target)
  // The last step's flash is still showing.
  expect(isSettled(anim)).toBe(false)
  for (let i = 0; i < TOKEN_FLASH_FRAMES; i++) advance(anim, settings.effects)
  expect(isSettled(anim)).toBe(true)
})

test('syncTargets primes silently, then raises the high and the cheap badges', () => {
  const settings = normalizeSettings({})
  const sync = (anim: ReturnType<typeof createAnim>, entries: Entry[]) =>
    syncTargets(anim, { entries, live: null, ledger: null, growing: [] }, settings, 's')

  const primed = createAnim()
  sync(primed, entriesOf([0.1, 0.2, 0.3, 0.9]))
  expect(primed.badge.kind).toBe('none')

  const high = createAnim()
  sync(high, entriesOf([0.1, 0.2, 0.3]))
  sync(high, entriesOf([0.1, 0.2, 0.3, 0.9]))
  expect(high.badge.kind).toBe('high')

  const cheap = createAnim()
  sync(cheap, entriesOf([0.4, 0.4, 0.4, 0.4]))
  sync(cheap, entriesOf([0.4, 0.4, 0.4, 0.4, 0.1]))
  expect(cheap.badge.kind).toBe('cheap')

  // An older turn that grows (a background helper) and becomes the session maximum raises the badge too.
  const grown = createAnim()
  sync(grown, entriesOf([0.2, 0.2, 0.2, 0.2]))
  expect(grown.badge.kind).toBe('none')
  sync(grown, entriesOf([0.9, 0.2, 0.2, 0.2]))
  expect(grown.badge.kind).toBe('high')
})

test('a still frame has a steady marker and no badge', () => {
  const settings = normalizeSettings({})
  const scene: Scene = { entries: entriesOf([0.11]), live: live(), ledger: 0.16, growing: [] }
  const anim = createAnim(5)
  syncTargets(anim, scene, settings, 's')
  raiseBadge(anim, 'tool', '‹Edit›', 8)
  const still = text(composeRow(scene, anim, settings, 100, true).cells)
  expect(still).toContain('●')
  expect(still).not.toContain('○')
  expect(still).not.toContain('Edit')
})

test('a tween eases out over four frames and ends exactly on its target', () => {
  const anim = createAnim()
  expect(tweenTo(anim, 'k', 0, true)).toBe(0)
  expect(tweenTo(anim, 'k', 1, true)).toBe(0)
  const seen: (number | undefined)[] = []
  for (const t of [1, 2, 3, 4]) {
    anim.tick = t
    seen.push(tweenValue(anim, 'k'))
    if (t === 3) expect(isSettled(anim)).toBe(false)
  }
  expect(seen).toEqual([0.4375, 0.75, 0.9375, 1])
  expect(isSettled(anim)).toBe(true)

  // Retargeted mid-flight: it starts from where it is.
  const flight = createAnim()
  tweenTo(flight, 'k', 0, true)
  tweenTo(flight, 'k', 1, true)
  flight.tick = 2
  expect(tweenTo(flight, 'k', 0, true)).toBe(0.75)
  flight.tick = 3
  expect(tweenValue(flight, 'k')).toBe(0.421875)

  // Without animation the new target is returned at once.
  const snap = createAnim()
  tweenTo(snap, 'k', 0, false)
  expect(tweenTo(snap, 'k', 1, false)).toBe(1)
  expect(isSettled(snap)).toBe(true)
})

test('a color tween blends channel by channel', () => {
  expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080)
  const anim = createAnim()
  tweenColorTo(anim, 'c', LIVE, true)
  tweenColorTo(anim, 'c', RAMP[3] ?? 0, true)
  anim.tick = 2
  expect(tweenValue(anim, 'c')).toBe(mixColor(LIVE, RAMP[3] ?? 0, 0.75))
  anim.tick = 4
  expect(tweenValue(anim, 'c')).toBe(RAMP[3])
})

test('meterCells: whole blocks at rest, an eighth on the tip while moving', () => {
  const X = 0x00afaf
  const moving = meterCells(10, 0.55, X, true)
  expect(moving.map(c => c.cp)).toEqual([0x2588, 0x2588, 0x2588, 0x2588, 0x2588, 0x258c, 0x2591, 0x2591, 0x2591, 0x2591])
  const rest = meterCells(10, 0.55, X, false)
  expect(rest.map(c => c.cp)).toEqual([0x2588, 0x2588, 0x2588, 0x2588, 0x2588, 0x2588, 0x2591, 0x2591, 0x2591, 0x2591])
  for (const cells of [moving, rest]) {
    expect(cells.every(c => c.bg === DEFAULT)).toBe(true)
    expect(cells.filter(c => c.cp !== 0x2591).every(c => c.fg === X)).toBe(true)
    expect(cells.filter(c => c.cp === 0x2591).every(c => c.fg === SEP)).toBe(true)
  }
})

test('the chart bar of the running turn rises through the block heights', () => {
  const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', style: 'chart' })
  const anim = createAnim()
  const before: Scene = { entries: entriesOf([0.1]), live: live({ costUsd: 0 }), ledger: null, growing: [] }
  const after: Scene = { entries: entriesOf([0.1]), live: live({ costUsd: 0.1 }), ledger: null, growing: [] }
  syncTargets(anim, before, settings, 's')
  composeRow(before, anim, settings, 100, false)
  const seen: number[] = []
  for (const t of [0, 1, 2, 3, 4]) {
    anim.tick = t
    // ● EXPLAI (8 cells) and its divider put the 32 bars at cells 21 to 52.
    seen.push(composeRow(after, anim, settings, 100, false).cells[52]?.cp ?? 0)
  }
  expect(seen).toEqual([0x2581, 0x2582, 0x2583, 0x2584, 0x2584])
})

/** The width of the first strip block: the cells from cell `start` up to the first one on the default background. */
const firstBlock = (cells: Cell[], start: number): number => {
  const gap = cells.findIndex((c, i) => i >= start && c.bg === DEFAULT)

  return gap - start
}

test('strip blocks slide to their new widths, the growing one pushing the others', () => {
  const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', style: 'strip' })
  const anim = createAnim()
  const scene = (a: number, b: number): Scene => ({ entries: entriesOf([a, b]), live: null, ledger: null, growing: [] })
  syncTargets(anim, scene(0.2, 0.2), settings, 's')
  // The label ● FIX (5 cells) and its divider come first: the strip starts at cell 18.
  expect(firstBlock(composeRow(scene(0.2, 0.2), anim, settings, 120, false).cells, 18)).toBe(34)
  const widths: number[] = []
  for (const t of [0, 1, 2, 3, 4]) {
    anim.tick = t
    const { cells } = composeRow(scene(0.2, 0.6), anim, settings, 120, false)
    expect(cells.length).toBe(120)
    widths.push(firstBlock(cells, 18))
  }
  expect(widths).toEqual([34, 24, 19, 18, 17])
  expect(isSettled(anim)).toBe(true)
})

test('window shift: the oldest block shrinks away while the live block appears, then 8 blocks again', () => {
  const eight = Array.from({ length: 8 }, () => 0.1)
  const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', style: 'strip', stripTurns: '8' })
  const anim = createAnim()
  const a: Scene = { entries: entriesOf(eight), live: null, ledger: null, growing: [] }
  const b: Scene = { entries: entriesOf(eight), live: live({ costUsd: 0 }), ledger: null, growing: [] }
  syncTargets(anim, a, settings, 's')
  // The 69-cell strip follows the label: ● TURN (6 cells) puts it at cells 19 to 87, ● EXPLAI (8 cells) at 21 to 89.
  expect(bgRuns(composeRow(a, anim, settings, 120, false).cells, 19, 87).length).toBe(8)
  const counts: number[] = []
  for (const t of [0, 1, 2, 3, 4]) {
    anim.tick = t
    const { cells } = composeRow(b, anim, settings, 120, false)
    expect(cells.length).toBe(120)
    counts.push(bgRuns(cells, 21, 89).length)
  }
  expect(counts).toEqual([9, 9, 9, 9, 8])
  expect(isSettled(anim)).toBe(true)
  expect(anim.tweens.has('s:1')).toBe(false)

  // With grow off the window shifts at once.
  const off = normalizeSettings({ ...EFFECTS_OFF, style: 'strip', stripTurns: '8' })
  const fresh = createAnim()
  syncTargets(fresh, a, off, 's')
  composeRow(a, fresh, off, 120, false)
  expect(bgRuns(composeRow(b, fresh, off, 120, false).cells, 21, 89).length).toBe(8)
})

test('grow off: the final sizes show from the first frame', () => {
  const strip = normalizeSettings({ ...EFFECTS_OFF, style: 'strip' })
  const anim = createAnim()
  const scene = (a: number, b: number): Scene => ({ entries: entriesOf([a, b]), live: null, ledger: null, growing: [] })
  syncTargets(anim, scene(0.2, 0.2), strip, 's')
  composeRow(scene(0.2, 0.2), anim, strip, 120, false)
  expect(firstBlock(composeRow(scene(0.2, 0.6), anim, strip, 120, false).cells, 18)).toBe(17)

  const chart = normalizeSettings({ ...EFFECTS_OFF, style: 'chart' })
  const bars = createAnim()
  const before: Scene = { entries: entriesOf([0.1]), live: live({ costUsd: 0 }), ledger: null, growing: [] }
  const after: Scene = { entries: entriesOf([0.1]), live: live({ costUsd: 0.1 }), ledger: null, growing: [] }
  syncTargets(bars, before, chart, 's')
  composeRow(before, bars, chart, 100, false)
  expect(composeRow(after, bars, chart, 100, false).cells[52]?.cp).toBe(0x2584)
})

test('the live strip block has no dot, keeps lavender and still shimmers', () => {
  const scene: Scene = { entries: entriesOf([0.11]), live: live(), ledger: 0.16, growing: [] }
  // The label ● EXPLAI (8 cells) and its divider come first: the 69-cell strip is cells 21 to 89.
  const blockCells = (cells: Cell[]): Cell[] => cells.slice(21, 90).filter(c => c.bg !== DEFAULT && c.bg !== FIGURES)
  for (const labels of ['on', 'off']) {
    const settings = normalizeSettings({ reacts: 'off', stock: 'off', celebrate: 'off', style: 'strip', stripLabels: labels })
    const quiet = createAnim()
    syncTargets(quiet, scene, settings, 's')
    const resting = composeRow(scene, quiet, settings, 120, false).cells
    expect(text(resting.slice(21, 90))).not.toContain('●')
    expect(blockCells(resting).length).toBeGreaterThan(0)
    expect(blockCells(resting).every(c => c.bg === LIVE_FILL)).toBe(true)
    // The one dot is the label's, before the strip.
    expect(text(resting.slice(10, 21))).toBe('● EXPLAI │ ')

    const flowing = createAnim()
    syncTargets(flowing, scene, settings, 's')
    markFlow(flowing)
    expect(blockCells(composeRow(scene, flowing, settings, 120, false).cells).some(c => c.bg !== LIVE_FILL)).toBe(true)
  }
  const named = createAnim()
  const on = normalizeSettings({ ...EFFECTS_OFF, style: 'strip' })
  syncTargets(named, scene, on, 's')
  expect(text(composeRow(scene, named, on, 120, false).cells.slice(21, 90))).toContain('EXPLAI')
})

test('stripLayout without gaps: the blocks touch, the running turn keeps two cells and a tiny turn one', () => {
  const items: StripItem[] = [
    { kind: 'turn', n: 1, symbol: 'AAA', value: 0.9 },
    { kind: 'turn', n: 2, symbol: 'BBB', value: 0.9 },
    { kind: 'live', n: 3, symbol: 'CCC', value: 0 },
  ]
  const blocks = stripLayout(items, 20, undefined, 0)
  expect(blocks.map(b => b.width)).toEqual([9, 9, 2])
  expect(blocks.reduce((s, b) => s + b.width, 0)).toBe(20)

  const tiny: StripItem[] = Array.from({ length: 24 }, (_, i) => ({ kind: 'turn', n: i + 1, symbol: 'T', value: i === 23 ? 5 : 0.001 }))
  const widths = stripLayout(tiny, 45, undefined, 0).map(b => b.width)
  expect(widths.reduce((s, w) => s + w, 0)).toBe(45)
  expect(widths.every(w => w >= 1)).toBe(true)
})

/** 30 finished turns named TURN: 0.1 for the odd numbers, 0.12 for the even ones. */
const thirty = (): Entry[] =>
  Array.from({ length: 30 }, (_, i) => entry({ n: i + 1, symbol: 'TURN', costUsd: (i + 1) % 2 === 1 ? 0.1 : 0.12 }))

test('each strip count: blank cells between blocks while they fit, hairlines when they do not', () => {
  const turns = thirty()
  const strip = (stripTurns?: string) =>
    compose(turns, stripTurns === undefined ? { ...EFFECTS_OFF, style: 'strip' } : { ...EFFECTS_OFF, style: 'strip', stripTurns }, 110, {
      ledger: 3.3,
    }).cells

  for (const count of [8, 12, 16]) {
    const cells = strip(String(count))
    expect(cells.length).toBe(110)
    // The label ● TURN (6 cells) and its divider come first: the 59-cell strip is cells 19 to 77.
    const runs = bgRuns(cells, 19, 77)
    expect(runs.length).toBe(count)
    expect(runs.slice(1).every((r, i) => r.start - (runs[i]?.end ?? 0) === 2)).toBe(true)
    expect(cells.some(c => c.cp === 0x258f)).toBe(false)
    expect(cells.some(c => c.cp === 0x2591)).toBe(false)
  }
  // The default is 12.
  expect(text(strip())).toBe(text(strip('12')))
  expect(bgRuns(strip(), 19, 77).length).toBe(12)

  // 24 turns need more than the 59 cells with a blank between them: the blocks touch, a hairline starts each later one.
  const cells = strip('24')
  expect(cells.length).toBe(110)
  expect(cells.slice(19, 78).every(c => c.bg !== DEFAULT)).toBe(true)
  const hairlines = cells.filter(c => c.cp === 0x258f)
  expect(hairlines.length).toBe(23)
  expect(hairlines.every(c => c.fg === DARK)).toBe(true)
  expect(cells.some(c => c.cp === 0x2591)).toBe(false)
  const items: StripItem[] = turns.slice(-24).map(e => ({ kind: 'turn', n: e.n, symbol: e.symbol, value: e.costUsd }))
  const widths = stripLayout(items, 59, undefined, 0).map(b => b.width)
  expect(widths.length).toBe(24)
  expect(widths.every(w => w >= 1)).toBe(true)
  expect(widths.reduce((s, w) => s + w, 0)).toBe(59)
})

test('24 turns at about 110 columns with all effects on: 24 touching blocks, also when the running turn ends', () => {
  const turns = thirty()
  const options = { style: 'strip', stripTurns: '24' }
  // The 45-cell strip follows the label: ● TURN (6 cells) puts it at cells 19 to 63, ● EXPLAI (8 cells) at 21 to 65.
  const hairlinesIn = (cells: Cell[], from: number): number => cells.slice(from, from + 45).filter(c => c.cp === 0x258f).length

  const finished = compose(turns, options, 110, { ledger: 3.3, still: true }).cells
  expect(finished.length).toBe(110)
  expect(hairlinesIn(finished, 19)).toBe(23)
  expect(finished.slice(19, 64).every(c => c.bg !== DEFAULT)).toBe(true)
  expect(finished.some(c => c.cp === 0x2591)).toBe(false)
  expect(finished[63]?.bg).toBe(RAMP[2])

  const running = compose(turns.slice(0, 29), options, 110, { ledger: 3.3, still: true, live: live({ costUsd: 0.12 }) }).cells
  expect(hairlinesIn(running, 21)).toBe(23)
  expect(running.slice(21, 66).every(c => c.bg !== DEFAULT)).toBe(true)
  expect(running.some(c => c.cp === 0x2591)).toBe(false)
  expect(running[65]?.bg).toBe(LIVE_FILL)
})

test('hairline labels: the hairline stands where the leading space was, a wide block shows its name after it', () => {
  const turns = [
    ...Array.from({ length: 29 }, (_, i) => entry({ n: i + 1, symbol: 'TURN', costUsd: 0.1 })),
    entry({ n: 30, symbol: 'TURN', costUsd: 5 }),
  ]
  const { cells } = compose(turns, { style: 'strip', stripTurns: '16' }, 110, { ledger: 7.9, still: true })
  const row = text(cells)
  // 16 blocks do not fit with blanks in 45 cells: the 15 cheap turns are one cell each, the costly one takes the rest.
  const at = row.indexOf('TURN 77%')
  expect(at).toBeGreaterThan(10)
  expect(cells[at - 1]?.cp).toBe(0x258f)
  expect(cells[at - 1]?.fg).toBe(DARK)
  // Hairlines carry no text, and no block but the costly one has a name.
  const hairlines = cells.filter(c => c.cp === 0x258f)
  expect(hairlines.length).toBe(15)
  // The strip is cells 19 to 63 (after ● TURN and its divider).
  expect(row.slice(19, 64).split('TURN').length).toBe(2)
})

test('the meter length follows the fixed log dollar scale', () => {
  const X = 0x00afaf
  const filled = (cost: number): number => meterCells(24, logShare(cost), X, false, cost > 0).filter(c => c.cp === 0x2588).length
  expect([0.05, 0.3, 1.2, 2, 5, 0, 0.001].map(filled)).toEqual([8, 16, 22, 24, 24, 0, 1])
})

test('the chart never rescales: a pricier turn does not move the other bars', () => {
  const options = { ...EFFECTS_OFF, style: 'chart' }
  const alone = compose(entriesOf([0.1]), options, 100, { ledger: 0.1 }).cells
  // ● EXPLAI (8 cells) puts the 32 bars at cells 21 to 52; ● FIX (5 cells) at cells 18 to 49.
  expect(alone[52]?.cp).toBe(0x2584)
  const beside = compose(entriesOf([0.1, 5]), options, 100, { ledger: 5.1 }).cells
  expect(beside[48]?.cp).toBe(0x2584)
  expect(beside[49]?.cp).toBe(0x2588)
})
