import type { Entry, Live } from '../types'
import { isTweening, pickFocus, pruneTweens, tokenText, turnUsage, tweenColorTo, tweenTo } from './anim'
import type { Anim, Odo, Scene } from './anim'
import {
  CHEAP,
  DARK,
  DEFAULT,
  DELTA_COLOR,
  DIVIDER,
  EMPTY_BAR,
  FIGURES,
  FLASH_DOWN,
  FLASH_UP,
  GLYPH,
  HIGH_BG,
  HOT,
  LIVE,
  LIVE_BUMP,
  LIVE_FILL,
  SEP,
  TOKEN_FLASH_DOWN,
  TOKEN_FLASH_UP,
  WHITE,
  blank,
  isBright,
  labelText,
  lighten,
  normalizeDisplay,
  rampColor,
  safeCp,
  textCells,
} from './cells'
import type { Cell, Display } from './cells'
import { formatCost, formatDelta, formatPercentDelta, formatTokens, logShare, rampFor } from './format'
import type { Delta } from './format'
import {
  CHART_STYLES,
  DEFAULT_CHART_STYLE,
  DEFAULT_METER_STYLE,
  DEFAULT_STRIP_STYLE,
  METER_STYLES,
  STRIP_STYLES,
  isChartStyle,
  isMeterStyle,
  isStripStyle,
} from './styles'
import type { ChartStyleId, MeterStyleId, StripStyleId } from './styles'

export type Style = 'meter' | 'chart' | 'strip'
export type Effects = { reacts: boolean; stock: boolean; celebrate: boolean; shimmer: boolean; grow: boolean }
export type Settings = {
  style: Style
  meterStyle: MeterStyleId
  chartStyle: ChartStyleId
  stripStyle: StripStyleId
  effects: Effects
  display: Display
  stripLabels: boolean
  /** How many recent turns the strip shows, the running one included: 4 to 24. */
  stripTurns: number
  /** How many bars the chart has: 4 to 32. */
  chartBars: number
  gapAbove: boolean
}

const STYLES: readonly Style[] = ['meter', 'chart', 'strip']

/** `value` as a whole number from `min` to `max`, else `fallback`. */
const countIn = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value)

  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** The settings, each falling back to its default when unknown. */
export function normalizeSettings(options: Record<string, unknown>): Settings {
  const on = (key: string): boolean => options[key] !== 'off'

  return {
    style: STYLES.find(s => s === options.style) ?? 'meter',
    meterStyle: isMeterStyle(options.meterStyle) ? options.meterStyle : DEFAULT_METER_STYLE,
    chartStyle: isChartStyle(options.chartStyle) ? options.chartStyle : DEFAULT_CHART_STYLE,
    stripStyle: isStripStyle(options.stripStyle) ? options.stripStyle : DEFAULT_STRIP_STYLE,
    effects: { reacts: on('reacts'), stock: on('stock'), celebrate: on('celebrate'), shimmer: on('shimmer'), grow: on('grow') },
    display: normalizeDisplay(options),
    stripLabels: on('stripLabels'),
    stripTurns: countIn(options.stripTurns, 4, 24, 8),
    chartBars: countIn(options.chartBars, 4, 32, 16),
    gapAbove: on('gapAbove'),
  }
}

const cp = (ch: string): number => safeCp(ch.codePointAt(0) ?? 0x3f)
const glyph = (code: number, fg: number, bg: number = DEFAULT): Cell => ({ cp: safeCp(code), fg, bg })
const space = (bg: number = DEFAULT): Cell => ({ cp: 0x20, fg: DEFAULT, bg })
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/** `s` cut to `n` code points. */
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('')

/** The left eighths a moving bar tip is drawn with: index `eighths - 1`. */
export const TIP: readonly number[] = [0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589]

// ---- shimmer ------------------------------------------------------------------------------------

/** How far the cell `i` of an element `w` cells wide is lightened by the sweep at `tick` (a 3-cell highlight, then a pause). */
export function sweepAmount(i: number, w: number, tick: number): number {
  const head = tick % (w + 6)
  const d = Math.abs(i - head)

  return d === 0 ? 0.55 : d === 1 ? 0.3 : 0
}

/** The lightening of the single chart bar at `tick`: a 4-frame pulse. */
export function pulseAmount(tick: number): number {
  return [0, 0.3, 0.55, 0.3][tick % 4] ?? 0
}

// ---- the small parts ----------------------------------------------------------------------------

/** Block widths for a strip of `cols` cells: each as wide as its share, none under one cell. */
export function stripWidths(values: number[], cols: number): number[] {
  const count = values.length
  if (count === 0) return []
  const total = values.reduce((s, v) => s + v, 0)
  if (total <= 0) {
    const each = Math.floor(cols / count)
    const widths = values.map(() => each)
    widths[count - 1] = (widths[count - 1] ?? 0) + (cols - each * count)

    return widths
  }
  const raw = values.map(v => (v / total) * cols)
  const widths = raw.map(r => Math.floor(r))
  let leftover = cols - widths.reduce((s, w) => s + w, 0)
  const byFraction = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : b.i - a.i))
  for (const item of byFraction) {
    if (leftover <= 0) break
    widths[item.i] = (widths[item.i] ?? 0) + 1
    leftover--
  }
  for (let i = 0; i < count; i++) {
    if ((widths[i] ?? 0) > 0) continue
    let widest = 0
    for (let j = 1; j < count; j++) {
      if ((widths[j] ?? 0) > (widths[widest] ?? 0)) widest = j
    }
    if ((widths[widest] ?? 0) <= 1) continue
    widths[widest] = (widths[widest] ?? 0) - 1
    widths[i] = 1
  }

  return widths
}

/** The running turn's block is at least this wide. */
const MIN_LIVE = 2
/** Any other turn's block is at least this wide. */
const MIN_TURN = 1
/** A block shrinking away is at least this wide. */
const MIN_LEAVING = 1

/** A block of the strip: a finished turn, the running turn, or a turn shrinking out of the window. */
export type StripItem = { kind: 'turn' | 'live' | 'leaving'; n: number; symbol: string; value: number }
export type StripBlock = {
  kind: StripItem['kind']
  /** The tween key of the block's value. */
  key: string
  n: number
  symbol: string
  /** The drawn value (eased), which sets the width. */
  value: number
  /** The target value. */
  target: number
  width: number
}

/** The least a block is wide: live 2, turn 1, leaving 1. */
const minWidth = (b: StripBlock): number => (b.kind === 'live' ? MIN_LIVE : b.kind === 'turn' ? MIN_TURN : MIN_LEAVING)

/**
 * The blocks of a strip `S` cells wide, in the order given (finished and leaving blocks by turn number, the running turn last). The blocks
 * touch (each later block starts with a hairline that belongs to its own width). Widths follow `shown(key, target)`, the eased value of each block (the target by
 * default). A block under its minimum takes cells, one at a time, from the widest block that stays at or above its own minimum.
 */
export function stripLayout(
  items: StripItem[],
  S: number,
  shown: (key: string, target: number) => number = (_key, target) => target,
): StripBlock[] {
  const blocks: StripBlock[] = items.map(item => {
    const key = `s:${item.n}`

    return { kind: item.kind, key, n: item.n, symbol: item.symbol, value: shown(key, item.value), target: item.value, width: 0 }
  })
  const widths = stripWidths(
    blocks.map(b => b.value),
    S,
  )
  blocks.forEach((b, i) => {
    b.width = widths[i] ?? 0
  })
  const order = [...blocks.filter(b => b.kind === 'live'), ...blocks.filter(b => b.kind !== 'live')]
  for (const block of order) {
    while (block.width < minWidth(block)) {
      let donor: StripBlock | undefined
      for (const b of blocks) {
        if (b === block || b.width - 1 < minWidth(b)) continue
        if (donor === undefined || b.width > donor.width) donor = b
      }
      if (donor === undefined) break
      donor.width -= 1
      block.width += 1
    }
  }

  return blocks
}

/**
 * The finished turns a window of `count` slots shows: the newest ones, except that the focused turn and the turns a
 * background helper is still working on keep a slot even when older (at most `count - 1` of them, so the newest turn
 * always stays), in turn order.
 */
export function windowEntries(entries: Entry[], growing: readonly number[], focusN: number | null, count: number): Entry[] {
  const size = Math.min(count, entries.length)
  if (size <= 0) return []
  const known = new Set(entries.map(e => e.n))
  const candidates: number[] = []
  const consider = (n: number): void => {
    if (known.has(n) && !candidates.includes(n)) candidates.push(n)
  }
  if (focusN !== null) consider(focusN)
  for (let i = growing.length - 1; i >= 0; i--) consider(growing[i] ?? Number.NaN)
  const pinned = new Set(candidates.slice(0, Math.max(0, count - 1)))
  const taken = new Set<number>()
  for (let i = entries.length - 1; i >= 0 && pinned.size + taken.size < size; i--) {
    const n = entries[i]?.n
    if (n !== undefined && !pinned.has(n)) taken.add(n)
  }

  return entries.filter(e => pinned.has(e.n) || taken.has(e.n))
}

/**
 * The `B` cells of the meter bar in `style` and the span `[from, to)` of its filled cells (fill glyphs, eighth tip, arrow
 * head), all in `fg`. A frame (the brackets of ascii and arrow) is dim and never part of the span. At rest the filled part
 * is whole cells (at least one when `atLeastOne`); an eighth-block tip shows while `isMoving` (Blocks) or always (smooth).
 */
export function meterBar(
  B: number,
  f: number,
  fg: number,
  isMoving: boolean,
  atLeastOne = false,
  style: MeterStyleId = 'blocks',
): { cells: Cell[]; from: number; to: number } {
  const st = METER_STYLES[style]
  const hasOpen = st.open !== undefined
  const hasClose = st.close !== undefined
  const I = B - (hasOpen ? 1 : 0) - (hasClose ? 1 : 0)
  const from = hasOpen ? 1 : 0
  const ratio = clamp01(f)
  const inner: Cell[] = []
  let to: number
  if (st.eighths === 'always' || (st.eighths === 'moving' && isMoving)) {
    let E = Math.round(ratio * I * 8)
    if (atLeastOne && E < 1) E = 1
    const whole = Math.floor(E / 8)
    const part = E % 8
    for (let i = 0; i < I; i++) {
      if (i < whole) inner.push(glyph(st.fill, fg))
      else if (i === whole && part > 0) inner.push(glyph(TIP[part - 1] ?? st.fill, fg))
      else inner.push(glyph(st.track, st.trackColor))
    }
    to = from + whole + (part > 0 ? 1 : 0)
  } else {
    const F = ratio > 0 || atLeastOne ? Math.max(1, Math.min(I, Math.round(ratio * I))) : 0
    for (let i = 0; i < I; i++) inner.push(i < F ? glyph(st.fill, fg) : glyph(st.track, st.trackColor))
    if (st.head !== undefined && F > 0 && F < I) inner[F - 1] = glyph(st.head, fg)
    to = from + F
  }
  const cells: Cell[] = []
  if (st.open !== undefined) cells.push(glyph(st.open, SEP))
  cells.push(...inner)
  if (st.close !== undefined) cells.push(glyph(st.close, SEP))

  return { cells, from, to }
}

/** The `B` cells of the meter bar in `style` (Blocks by default); see `meterBar`. */
export function meterCells(B: number, f: number, fg: number, isMoving: boolean, atLeastOne = false, style: MeterStyleId = 'blocks'): Cell[] {
  return meterBar(B, f, fg, isMoving, atLeastOne, style).cells
}

/** The 12-cell badge slot: the tool flash, the cheap sparkle or NEW HIGH; blank when none shows, or on a still frame. */
export function badgeCells(anim: Anim, still: boolean): Cell[] {
  const b = anim.badge
  if (still) return blank(12)
  let cells: Cell[]
  const phase = Math.floor((anim.tick - b.from) / 2) % 2
  if (b.kind === 'none') {
    cells = []
  } else if (b.kind === 'tool') {
    cells = textCells(b.text, anim.tick - b.from < 2 ? WHITE : LIVE)
  } else if (b.kind === 'cheap') {
    const a = phase === 0 ? GLYPH.star1 : GLYPH.star2
    const b2 = phase === 0 ? GLYPH.star2 : GLYPH.star1
    cells = [glyph(a, CHEAP), space(), glyph(b2, CHEAP), space(), glyph(a, CHEAP)]
  } else {
    cells = phase === 0 ? textCells(b.text, WHITE, HIGH_BG) : textCells(b.text, HOT)
  }
  while (cells.length < 12) cells.push(space())

  return cells.slice(0, 12)
}

/** One token figure as drawn: its text (left-padded while it rolls) and, while its changed characters flash, the index they start at and the direction. */
export type TokenFigure = { text: string; flash: { from: number; dir: 'up' | 'down' } | null }

/**
 * The token figures: `312K↓ 2.1K↑` (or `312K in · 2.1K out` when labeled), all in the figures gray (dim gray before the
 * turn has usage), no background. While a figure rolls its changed characters flash warm white going up, ice blue going
 * down. With `showPercent` the cached `share` reads `(94%c)` / `(94% cached)` in the same gray right after the input figure.
 */
export function tokenCells(
  input: TokenFigure,
  output: TokenFigure,
  share: number,
  labeled: boolean,
  isDim: boolean,
  showPercent = false,
): Cell[] {
  const fg = isDim ? SEP : FIGURES
  const figure = (f: TokenFigure): Cell[] => {
    const flash = f.flash
    const flashFg = flash === null ? fg : flash.dir === 'up' ? TOKEN_FLASH_UP : TOKEN_FLASH_DOWN

    return textCells(f.text, fg).map((cell, i) => (flash !== null && i >= flash.from ? { ...cell, fg: flashFg } : cell))
  }
  const percent = Math.round(clamp01(share) * 100)
  const note = showPercent && !isDim ? textCells(labeled ? ` (${percent}% cached)` : ` (${percent}%c)`, fg) : []

  return labeled
    ? [...figure(input), ...textCells(' in', fg), ...note, ...textCells(' · ', fg), ...figure(output), ...textCells(' out', fg)]
    : [...figure(input), ...textCells('↓', fg), ...note, ...textCells(' ', fg), ...figure(output), ...textCells('↑', fg)]
}

// ---- the context every style draws from --------------------------------------------------------

type Ctx = {
  anim: Anim
  settings: Settings
  still: boolean
  entries: Entry[]
  live: Live | null
  costs: number[]
  /** Finished turns with a background helper still at work, by last activity (the most recent last). */
  growing: number[]
  /** The number of the newest finished turn (0 when none). */
  lastN: number
  /** The focused turn is finished and a background helper is still adding to it. */
  isGrowing: boolean
  /** The focused turn is finished and is not the newest one. */
  isOlder: boolean
  /** The cost of the turn before the focused one (the newest finished turn while one runs); undefined for the first. */
  prevCost: number | undefined
  /** Label and cost color of the turn: lavender while it runs or its helper works, the default text color otherwise. */
  fg: number
  /** The number of the focused turn: the running one, a finished one with a helper at work, or the newest. */
  n: number
  symbol: string
  prompt: string
  turnTarget: number
  turnValue: number
  sigmaValue: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  /** A live turn that has no tokens yet. */
  isEmptyLive: boolean
  isBump: boolean
  /** Tokens are streaming and `shimmer` is on. */
  isFlowing: boolean
  /** Sizes and colors ease (a moving frame with `grow` on). */
  useTween: boolean
  /** The tween keys this frame used, so the others can be forgotten. */
  keys: Set<string>
}

function makeCtx(scene: Scene, anim: Anim, settings: Settings, still: boolean): Ctx | null {
  const { entries, live } = scene
  const costs = entries.map(x => x.costUsd)
  const lastN = entries.at(-1)?.n ?? 0
  const sigmaTarget = scene.ledger ?? costs.reduce((s, x) => s + x, 0)
  const sigmaValue = still ? sigmaTarget : anim.sigma.shown
  // The focus: normally set by `syncTargets` / `syncFocus` before the draw; the fallback covers a draw without one.
  const f = anim.focus
  const focusN =
    live !== null
      ? lastN + 1
      : f !== null && f.mode !== 'live' && entries.some(x => x.n === f.n)
        ? f.n
        : pickFocus(scene, null, anim.tick, 0).n
  const focused = live !== null ? undefined : entries.find(x => x.n === focusN)
  if (live === null && focused === undefined) return null
  const turnTarget = live !== null ? live.costUsd : (focused?.costUsd ?? 0)
  const { tokensIn, tokensOut, cacheRead } = turnUsage(scene, focusN)
  const isGrowing = live === null && scene.growing.includes(focusN)
  const isOlder = live === null && focusN !== lastN
  const at = entries.findIndex(x => x.n === focusN)
  const prevCost = live !== null ? entries.at(-1)?.costUsd : at > 0 ? entries[at - 1]?.costUsd : undefined

  return {
    anim,
    settings,
    still,
    entries,
    live,
    costs,
    growing: scene.growing,
    lastN,
    isGrowing,
    isOlder,
    prevCost,
    fg: live !== null || isGrowing ? LIVE : DEFAULT,
    n: focusN,
    symbol: live ? live.symbol : (focused?.symbol ?? ''),
    prompt: live ? live.prompt : (focused?.prompt ?? ''),
    turnTarget,
    turnValue: still ? turnTarget : anim.turn.shown,
    sigmaValue,
    tokensIn,
    tokensOut,
    cacheRead,
    isEmptyLive: live !== null && tokensIn + tokensOut === 0,
    isBump: settings.effects.reacts && !still && (live !== null || isGrowing) && anim.tick < anim.bumpUntil,
    isFlowing: settings.effects.shimmer && !still && live !== null && anim.tick < anim.flowUntil,
    useTween: !still && settings.effects.grow,
    keys: new Set(),
  }
}

/** The number under `key` at this tick: eased toward `target` when the frame eases, else the target itself. */
function ease(c: Ctx, key: string, target: number): number {
  if (!c.useTween) return target
  c.keys.add(key)

  return tweenTo(c.anim, key, target, true)
}

/** `ease` for a color. */
function easeColor(c: Ctx, key: string, target: number): number {
  if (!c.useTween) return target
  c.keys.add(key)

  return tweenColorTo(c.anim, key, target, true)
}

/** True when the finished turn `n` shimmers because a background helper is still adding to it. */
function growShimmer(c: Ctx, n: number): boolean {
  return c.settings.effects.shimmer && !c.still && c.growing.includes(n)
}

/** The money text as cells; digits at or after the odometer's flash point take the flash color. */
function moneyCells(value: number, odo: Odo, fg: number, c: Ctx): Cell[] {
  const chars = Array.from(formatCost(value))
  const out: Cell[] = []
  const flashing = !c.still && c.anim.tick < odo.flashUntil
  const flash = odo.flashDir === 'up' ? FLASH_UP : FLASH_DOWN
  chars.forEach((ch, i) => {
    out.push({ cp: cp(ch), fg: flashing && i >= odo.flashFrom ? flash : fg, bg: DEFAULT })
  })

  return out
}

/** The unit the width budget drops: all the parts of a group go together, so no divider is left dangling. */
type PartId = 'core' | 'label' | 'cost' | 'delta' | 'tokens' | 'badge'
/** `cells` is what is drawn (natural width); `reserve` is what the width budget counts, so the visual never changes width. */
type Part = { group: PartId; cells: Cell[]; reserve: number }

function corePart(c: Ctx): Part {
  const cells = [
    ...textCells('Σ ', DEFAULT),
    ...moneyCells(c.sigmaValue, c.anim.sigma, DEFAULT, c),
    space(),
    glyph(GLYPH.sep, DIVIDER),
    space(),
  ]

  return { group: 'core', cells, reserve: cells.length }
}

/** A ` · ` divider that belongs to `group`. */
function dividerPart(group: PartId): Part {
  return { group, cells: [space(), glyph(GLYPH.sep, DIVIDER), space()], reserve: 3 }
}

/** The pulsing live marker; a steady lavender `↻` for a finished turn a helper is still adding to; a dim steady dot otherwise. */
function markerCells(c: Ctx): Cell[] {
  if (!c.live) return [c.isGrowing ? glyph(GLYPH.refresh, LIVE) : glyph(GLYPH.live, SEP), space()]
  const on = !c.settings.effects.reacts || c.still || Math.floor(c.anim.tick / 5) % 2 === 0

  return [glyph(on ? GLYPH.live : GLYPH.liveOff, LIVE), space()]
}

function labelPart(c: Ctx): Part {
  // An older focused turn always carries its number: in `symbol` mode it is drawn as `numbered` (`↻ #71 FIX`).
  const kind = c.settings.display.label === 'symbol' && c.isOlder ? 'numbered' : c.settings.display.label
  const width = kind === 'symbol' ? 6 : kind === 'prompt' ? 26 : kind === 'numbered' ? 12 : 4
  const text = cut(labelText({ ...c.settings.display, label: kind }, c.n, c.symbol, c.prompt), width)

  return { group: 'label', cells: [...markerCells(c), ...textCells(text, c.fg)], reserve: 2 + width }
}

function costPart(c: Ctx): Part {
  const cells = moneyCells(c.turnValue, c.anim.turn, c.fg, c)

  return { group: 'cost', cells, reserve: Math.max(6, cells.length) }
}

function deltaFor(c: Ctx): Delta | null {
  const prev = c.prevCost

  return c.settings.display.change === 'percent'
    ? formatPercentDelta(c.turnTarget, prev)
    : formatDelta(c.turnTarget, prev)
}

/** The change against the turn before: it shows its new value at once, in the color of its sign. */
function deltaPart(c: Ctx): Part {
  const d = deltaFor(c)

  return { group: 'delta', cells: d === null ? [] : [space(), ...textCells(d.text, DELTA_COLOR[d.dir])], reserve: 7 }
}

/** One token figure: rolling (padded to its target's width, the changed characters flashing) under `stock` on a moving frame, else exactly the target. */
function tokenFigure(c: Ctx, odo: Odo, target: number): TokenFigure {
  const rolling = !c.still && c.settings.effects.stock && odo.target === target
  if (!rolling) return { text: formatTokens(target), flash: null }

  return { text: tokenText(odo), flash: c.anim.tick < odo.flashUntil ? { from: odo.flashFrom, dir: odo.flashDir } : null }
}

/** The token counts roll like claudespotter's odometer under `stock` (stepped in `advance`, their changed characters flashing); the cached share of the `(94%c)` note eases with `grow`. */
function tokensPart(c: Ctx): Part {
  const labeled = c.settings.display.tokens === 'labeled'
  const share = ease(c, `cache:${c.n}`, c.tokensIn > 0 ? c.cacheRead / c.tokensIn : 0)

  const showPercent = c.settings.display.cachePercent === 'on'

  // The percent note goes with the group (one drop unit): up to ` (100%c)` (8 cells) or ` (100% cached)` (14 cells) more.
  return {
    group: 'tokens',
    cells: tokenCells(
      tokenFigure(c, c.anim.tokensIn, c.tokensIn),
      tokenFigure(c, c.anim.tokensOut, c.tokensOut),
      share,
      labeled,
      c.isEmptyLive,
      showPercent && c.tokensIn > 0,
    ),
    reserve: (labeled ? 18 : 11) + (showPercent ? (labeled ? 14 : 8) : 0),
  }
}

function badgePart(c: Ctx): Part {
  return { group: 'badge', cells: [space(), space(), ...badgeCells(c.anim, c.still)], reserve: 14 }
}

// ---- the three visuals --------------------------------------------------------------------------

type Visual = { min: number; max: number; build: (n: number) => Cell[] }

function meterVisual(c: Ctx): Visual {
  return {
    min: 8,
    max: 60,
    build: B => {
      const key = `meter:${c.n}`
      const f = ease(c, key, logShare(c.turnTarget))
      const isMoving = c.useTween && isTweening(c.anim, key)
      const fillTarget = c.live !== null || c.isGrowing ? LIVE : rampColor(rampFor(c.turnTarget, c.costs))
      const fill = easeColor(c, `c:meter:${c.n}`, fillTarget)
      const { cells: bar, from, to } = meterBar(B, f, fill, isMoving, c.turnTarget > 0, c.settings.meterStyle)
      if (c.live !== null ? c.isFlowing : growShimmer(c, c.n)) {
        for (let i = from; i < to; i++) {
          const cell = bar[i]
          if (cell) bar[i] = { ...cell, fg: lighten(cell.fg, sweepAmount(i - from, to - from, c.anim.tick)) }
        }
      }
      if (c.isBump && to > from) {
        const tip = bar[to - 1]
        if (tip) bar[to - 1] = { ...tip, fg: WHITE }
      }

      return bar
    },
  }
}

function chartVisual(c: Ctx): Visual {
  const cs = CHART_STYLES[c.settings.chartStyle]

  return {
    min: Math.min(8, c.settings.chartBars),
    max: c.settings.chartBars,
    build: C => {
      const k = Math.min(c.costs.length, c.live ? C - 1 : C)
      // The focused finished turn (a helper still at work) is lavender like a running one; every other bar keeps its ramp color.
      // The focused turn and the turns a helper still works on keep their bar even when older (see `windowEntries`).
      const picked = windowEntries(c.entries, c.growing, c.live === null ? c.n : null, k)
      const slots: { n: number; value: number; color: number; isLive: boolean; isFocus: boolean }[] = picked.map(e => {
        const isFocus = c.isGrowing && e.n === c.n

        return {
          n: e.n,
          value: e.costUsd,
          color: isFocus ? LIVE : rampColor(rampFor(e.costUsd, c.costs)),
          isLive: false,
          isFocus,
        }
      })
      if (c.live) slots.push({ n: c.n, value: c.turnTarget, color: LIVE, isLive: true, isFocus: false })
      const cells: Cell[] = []
      for (let i = 0; i < C - slots.length; i++) cells.push(glyph(cs.empty, EMPTY_BAR))
      for (const s of slots) {
        const r = ease(c, `chart:${s.n}`, logShare(s.value))
        let fg = easeColor(c, `c:chart:${s.n}`, s.color)
        if (s.isLive) {
          if (c.isBump) fg = WHITE
          else if (c.isFlowing) fg = lighten(fg, pulseAmount(c.anim.tick))
        } else if (s.isFocus && c.isBump) {
          fg = WHITE
        } else if (growShimmer(c, s.n)) {
          fg = lighten(fg, pulseAmount(c.anim.tick))
        }
        const level = s.value <= 0 ? 0 : Math.min(8, Math.max(1, Math.round(r * 8)))
        cells.push(level === 0 ? glyph(cs.empty, EMPTY_BAR) : glyph(cs.levels[level - 1] ?? cs.empty, fg))
      }

      return cells
    },
  }
}

/** The text of a strip block, or null when none fits: the first candidate that leaves a space on each side. */
function stripLabel(b: StripBlock, pct: number, labelsOn: boolean): string | null {
  if (b.kind === 'leaving' || !labelsOn) return null
  // The live dot belongs to the label part of the row only, never inside a block.
  const sym = b.symbol
  const candidates = [`${sym} ${pct}%`, sym]

  return candidates.find(t => b.width >= Array.from(t).length + 2) ?? null
}

/** The turn numbers whose block is still shrinking out of the strip (a finished turn no longer shown); settled ones are forgotten. */
function leavingTurns(c: Ctx, shown: ReadonlySet<number>): number[] {
  const out: number[] = []
  for (const key of Array.from(c.anim.tweens.keys())) {
    const m = /^s:(\d+)$/.exec(key)
    const n = m?.[1] === undefined ? Number.NaN : Number(m[1])
    if (!(n <= c.lastN && !shown.has(n))) continue
    const value = tweenTo(c.anim, key, 0, true)
    if (value < 0.0005 && !isTweening(c.anim, key)) continue
    c.keys.add(key)
    out.push(n)
  }

  return out.sort((a, b) => a - b)
}

function stripVisual(c: Ctx): Visual {
  const ss = STRIP_STYLES[c.settings.stripStyle]

  return {
    min: 10,
    max: 512,
    build: S => {
      // The window: the last `stripTurns` turns, the running one included, as many as fit; a turn a helper still works
      // on (or the focused one) keeps its slot even when older (see `windowEntries`). The blocks touch and each later
      // one starts with a hairline.
      const K = Math.min(c.settings.stripTurns, c.entries.length + (c.live ? 1 : 0))
      const k = Math.min(K, S - 1)
      const finished = c.live ? Math.max(0, k - 1) : k
      const shownEntries = windowEntries(c.entries, c.growing, c.live === null ? c.n : null, finished)
      // Whether the strip was drawn before: only then does a finished turn that newly enters it grow in.
      const hadStrip = Array.from(c.anim.tweens.keys()).some(key => /^s:\d+$/.test(key))
      const shown = new Set(shownEntries.map(e => e.n))
      const items: StripItem[] = []
      if (c.useTween) {
        for (const n of leavingTurns(c, shown)) items.push({ kind: 'leaving', n, symbol: '', value: 0 })
      }
      for (const e of shownEntries) items.push({ kind: 'turn', n: e.n, symbol: e.symbol, value: e.costUsd })
      items.sort((a, b) => a.n - b.n)
      if (c.useTween && hadStrip) {
        for (const item of items) {
          if (item.kind === 'turn' && !c.anim.tweens.has(`s:${item.n}`)) tweenTo(c.anim, `s:${item.n}`, 0, true)
        }
      }
      if (c.live) items.push({ kind: 'live', n: c.n, symbol: c.live.symbol, value: c.turnTarget })
      const blocks = stripLayout(items, S, (key, target) => ease(c, key, target))
      const total = blocks.reduce((s, b) => (b.kind === 'leaving' ? s : s + b.value), 0)
      const cells: Cell[] = []
      blocks.forEach((b, i) => {
        const old = b.kind === 'leaving' ? c.entries.find(x => x.n === b.n) : undefined
        // The focused finished turn (a helper still at work) takes the lavender of the running block.
        const isFocus = b.kind === 'turn' && c.isGrowing && b.n === c.n
        const base =
          b.kind === 'live' || isFocus
            ? LIVE_FILL
            : b.kind === 'leaving'
              ? old === undefined
                ? FIGURES
                : rampColor(rampFor(old.costUsd, c.costs))
              : rampColor(rampFor(b.target, c.costs))
        let color = easeColor(c, `c:${b.key}`, base)
        if ((b.kind === 'live' || isFocus) && c.isBump) color = LIVE_BUMP
        const shimmering = b.kind === 'live' ? c.isFlowing : b.kind === 'turn' && growShimmer(c, b.n)
        let block: Cell[]
        if (ss.fill === null) {
          // Background blocks: the color is the cells' background, the name sits inside where it fits.
          block = blank(b.width, color)
          if (shimmering) {
            block.forEach((cell, j) => {
              cell.bg = lighten(color, sweepAmount(j, b.width, c.anim.tick))
            })
          }
          const pct = total > 0 ? Math.round((b.value / total) * 100) : 0
          const label = stripLabel(b, pct, c.settings.stripLabels)
          if (label !== null) {
            textCells(' ' + label, DEFAULT).forEach((cell, j) => {
              const target = block[j]
              if (target) block[j] = { cp: cell.cp, fg: isBright(target.bg) ? DARK : WHITE, bg: target.bg }
            })
          }
          // A thin dark line at the left edge of every block after the first, in place of its leading space.
          const first = block[0]
          if (i > 0 && first !== undefined) block[0] = glyph(ss.lead, DARK, first.bg)
        } else {
          // Glyph cells: every cell is the style's glyph in the block's color, with no name.
          const fillCp = ss.fill
          block = []
          for (let j = 0; j < b.width; j++) {
            block.push(glyph(fillCp, shimmering ? lighten(color, sweepAmount(j, b.width, c.anim.tick)) : color))
          }
          // The hollow lead cell at the left edge of every block after the first marks the boundary.
          const first = block[0]
          if (i > 0 && first !== undefined) block[0] = glyph(ss.lead, first.fg)
        }
        cells.push(...block)
      })

      return cells.length >= S ? cells.slice(0, S) : [...cells, ...blank(S - cells.length)]
    },
  }
}

// ---- the row ------------------------------------------------------------------------------------

/** Dropped (whole groups) in this order when the row is too narrow, the same for every style; then the left core stands alone. */
const DROP_ORDER: PartId[] = ['badge', 'tokens', 'delta', 'label']

type Seq = (Part | 'visual')[]

/**
 * The parts in drawing order, the same for every style, with a ` · ` divider after the label, after the visual and after the change:
 * `core, label, |, visual, |, cost, delta, |, tokens, badge`. The divider after the label goes with the label, so a dropped
 * label leaves `core, visual, |, cost ...` and never a doubled or dangling bar.
 */
function sequence(c: Ctx): { seq: Seq; visual: Visual } {
  const { style, effects } = c.settings
  const delta: Part[] = c.settings.display.change === 'off' ? [] : [deltaPart(c)]
  const badge: Part[] = effects.reacts || effects.celebrate ? [badgePart(c)] : []
  const figures: Part[] = [costPart(c), ...delta, dividerPart('tokens'), tokensPart(c), ...badge]

  return {
    seq: [corePart(c), labelPart(c), dividerPart('label'), 'visual', dividerPart('core'), ...figures],
    visual: style === 'meter' ? meterVisual(c) : style === 'chart' ? chartVisual(c) : stripVisual(c),
  }
}

/**
 * The row as exactly `cols` cells. `still` uses the targets and draws no flash, badge, shimmer, bump, rolling or easing:
 * for the desktop and the static fallback.
 */
export function composeRow(scene: Scene, anim: Anim, settings: Settings, cols: number, still: boolean): { cells: Cell[] } {
  const c = makeCtx(scene, anim, settings, still)
  const finish = (cells: Cell[]): Cell[] => (cells.length >= cols ? cells.slice(0, cols) : [...cells, ...blank(cols - cells.length)])
  if (c === null) {
    const sigma = scene.ledger ?? scene.entries.reduce((s, x) => s + x.costUsd, 0)
    const bare: Ctx = {
      anim, settings, still, entries: [], live: null, costs: [], growing: [], lastN: 0, isGrowing: false,
      isOlder: false, prevCost: undefined, fg: DEFAULT,
      n: 0, symbol: '', prompt: '', turnTarget: 0, turnValue: 0, sigmaValue: still ? sigma : anim.sigma.shown,
      tokensIn: 0, tokensOut: 0, cacheRead: 0, isEmptyLive: false, isBump: false, isFlowing: false,
      useTween: false, keys: new Set(),
    }

    return { cells: finish(corePart(bare).cells) }
  }

  const { seq, visual } = sequence(c)
  const order = DROP_ORDER.filter(id => seq.some(p => p !== 'visual' && p.group === id))
  const dropped = new Set<PartId>()
  for (;;) {
    const kept = seq.filter((p): p is Part => p !== 'visual' && !dropped.has(p.group))
    const fixed = kept.reduce((s, p) => s + p.reserve, 0)
    const n = Math.min(visual.max, cols - fixed)
    if (n >= visual.min) {
      const built = visual.build(n)
      const cells: Cell[] = []
      for (const p of seq) {
        if (p === 'visual') cells.push(...built)
        else if (!dropped.has(p.group)) cells.push(...p.cells)
      }
      if (!c.still) pruneTweens(anim, c.keys)

      return { cells: finish(cells) }
    }
    const next = order.shift()
    if (next === undefined) return { cells: finish(corePart(c).cells) }
    dropped.add(next)
  }
}
