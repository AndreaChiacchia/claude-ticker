import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { CACHE_FG, DEFAULT, FIGURES, LIVE, RAMP, SEP, decodeCells } from '../hooks/cells'
import type { Cell } from '../hooks/cells'

const NOW = Date.parse('2026-10-14T10:00:00Z')

const HINT = {
  plugin: 'claudeticker',
  surface: 'terminal',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never,
  // The hint slot is indented by 2, so the row has 100 columns.
  viewport: { columns: 102, rows: 40 } as never,
} as const

const PANE = {
  plugin: 'claudeticker',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'ticker-table',
  props: { title: 'Claude-Ticker', isFocused: false } as never,
} as const

/** All five effects off: a still row and no timer. */
const EFFECTS_OFF = { reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off', grow: 'off' }

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  return ((node as Node).children ?? []).map(text).join('')
}

function walk(node: unknown, out: Node[] = []): Node[] {
  if (node === null || typeof node !== 'object') return out
  out.push(node as Node)
  for (const child of (node as Node).children ?? []) walk(child, out)
  return out
}

const raster = (node: unknown) => walk(node).find(n => n.type === 'Raster')

/** The row's own wrapper: the Box whose top margin is the one blank line above the row. */
const gapBox = (node: unknown) => walk(node).filter(n => n.type === 'Box' && n.props?.marginTop === 1)

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** The Raster's cells, decoded. */
const rowCells = (node: unknown): Cell[] => decodeCells(String(raster(node)?.props?.cells ?? ''))

/** The Raster's cells as text. */
const rowText = (node: unknown): string => cellText(rowCells(node))

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The engine beneath the mod, with the figures the tests move: the session id, the cost ledger, the step usage. */
function world(on: On, stacked: string[] = []) {
  const state = {
    ledger: 0,
    sid: 'sess-1',
    turns: 0,
    blitAnswer: {} as { deny?: string },
    step: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Usage,
    chunks: [] as TurnStepChunk[],
    /** When set, the step stub moves the ledger to it before it returns: spend that lands during a response. */
    ledgerOnStep: null as number | null,
    /** The id the agent.spawn stub answers with. */
    nextAgentId: 'ag1',
    /** What agent.list answers: the agents the spawn stub started, with the status a test sets. */
    agents: [] as { id: string; status: string }[],
    /** When set, agent.list throws (the list is unavailable). */
    agentsFail: false,
    root: '/x/claudeticker',
    /** What session.repo answers: a repository, or null for none. */
    repo: { root: '/x/claudeticker', remote: null, internal: false, name: null } as object | null,
    branch: 'main',
  }
  const blits: { requestId: string; key: string; cells?: string }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  // The mod's own key-value store, in memory; the test reads it back through `store`.
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: state.sid }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1, window: 1_000_000, percent: 0 },
      rateLimits: [],
      cost: { usd: state.ledger },
    },
  }))
  on('session.root', () => ({ value: state.root }))
  on('session.repo', () => ({ value: state.repo }) as never)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: state.branch + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }) as never)
  on('agent.spawn', () => {
    state.agents.push({ id: state.nextAgentId, status: 'running' })
    return { model: 'm', agentId: state.nextAgentId } as never
  })
  on('agent.list', () => {
    if (state.agentsFail) throw new Error('unavailable')
    return { value: state.agents } as never
  })
  on('classic.SessionStart', () => ({}))
  on('command.register', () => ({ value: { command: 'ticker' } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.blit', (_$, e) => {
    blits.push({ requestId: e.requestId, key: e.key, cells: (e as unknown as { cells?: string }).cells })
    return { value: state.blitAnswer }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    for (const chunk of state.chunks) yield chunk
    if (state.ledgerOnStep !== null) state.ledger = state.ledgerOnStep
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', ...state.step },
    }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  // The engine's own hint line, with the rows other mods stacked under it.
  on('ui.render', ({ ui }, e) => {
    const { Box, Text } = ui.resolve(e)
    if (stacked.length === 0) return <Text>? for shortcuts</Text>
    return (
      <Box flexDirection="column">
        <Text>? for shortcuts</Text>
        {stacked.map(row => (
          <Text>{row}</Text>
        ))}
      </Box>
    )
  })

  return { state, blits, toasts, clock, store }
}

type World = ReturnType<typeof world>

const blitText = (b: { cells?: string } | undefined): string => cellText(decodeCells(b?.cells ?? ''))

const usage = (over: Partial<Usage> = {}): Usage => ({
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...over,
})

/** One whole turn of the main loop: the ledger reads `ledgerAfter` once it ends. */
async function turn($: Engine, w: World, prompt: string, tokens: Usage, ledgerAfter: number) {
  const turnId = `t${++w.state.turns}`
  await $.turn.start({ text: prompt, turnId } as never)
  w.state.ledger = ledgerAfter
  await $.turn.complete({
    answer: '',
    durationMs: 4000,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', ...tokens },
  } as never)
}

/** One model response inside the running turn `turnId`, of the main loop or of the agent `agentId`. */
async function step($: Engine, turnId: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId } as never)
  for await (const _ of stream) void _
}

/** The end of the main turn `turnId`. */
async function finish($: Engine, turnId: string, tokens: Usage) {
  await $.turn.complete({
    answer: '',
    durationMs: 4000,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', ...tokens },
  } as never)
}

/** A slot can be mounted once per requestId: a test mounts it once and re-reads the tree from the handle. */
type Slot = { drawn: () => Promise<unknown> }

const mount = ($: Engine, target: object = HINT) => $.ui.mount(target as never)
const drawing = (ui: Slot) => ui.drawn()
const hint = async (ui: Slot) => text(await ui.drawn())

/** The second turn of the reference row: 312K in (94% cached), 2.1K out, $0.42 after $0.11. */
const REFERENCE = usage({ input_tokens: 2000, cache_read_input_tokens: 293_656, cache_creation_input_tokens: 16_744, output_tokens: 2100 })

async function twoTurns($: Engine, w: World) {
  await turn($, w, 'explain the cache', usage(), 0.11)
  await turn($, w, 'fix the login bug', REFERENCE, 0.53)
}

test('the row draws last under the hint, aligned with it, and holds each turn', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  expect(await hint(ui)).toBe('? for shortcuts')
  // No turn yet: the ticker draws nothing, so no blank line either.
  expect(gapBox(await drawing(ui))).toEqual([])
  await twoTurns($, w)
  const drawn = (await drawing(ui)) as Node
  expect(drawn.type).toBe('Box')
  // The row is the last child, inside its own Box: one blank line (marginTop 1) above it, the Raster unkeyed by the wrapper.
  const wrapper = (drawn.children ?? []).at(-1) as Node
  expect(gapBox(drawn)).toEqual([wrapper])
  expect(wrapper.children).toEqual([raster(drawn)])
  expect(raster(drawn)?.props?.rows).toBe(1)
  expect(raster(drawn)?.props?.columns).toBe(100)
  const row = rowText(drawn)
  expect(row.startsWith('Σ $0.53 │ ● FIX │ █')).toBe(true)
  expect(row).toContain('░ │ $0.42 ▲0.31 │ 312K↓ 2.1K↑')
  // The hint slot is already indented: any padding pushes the row right of the hint.
  expect(JSON.stringify(drawn)).not.toContain('paddingLeft')
})

test('the row goes after the rows other mods stacked under the hint', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on, ['PEEKER-LINE', 'SPOTTER-TITLE', 'SPOTTER-ROW'])
  await turn($, w, 'fix the login bug', usage(), 0.11)
  const drawn = (await drawing(await mount($))) as Node
  expect(text(drawn)).toBe('? for shortcutsPEEKER-LINESPOTTER-TITLESPOTTER-ROW')
  // One column Box: the hint Text first, the stacked rows, then the Raster. What is beneath is flattened, not nested.
  expect(drawn.type).toBe('Box')
  expect(drawn.props?.flexDirection).toBe('column')
  const children = (drawn.children ?? []) as Node[]
  expect(children.length).toBe(5)
  expect(children[0]?.type).toBe('Text')
  expect(text(children[0])).toBe('? for shortcuts')
  // The last child is the row's own Box (one blank line above it) holding the Raster.
  expect(children[4]?.type).toBe('Box')
  expect(children[4]?.props?.marginTop).toBe(1)
  expect(children[4]?.children).toEqual([raster(drawn)])
  expect(rowText(drawn).startsWith('Σ $0.11')).toBe(true)
})

test('the running turn counts up per response', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  const beginning = await drawing(ui)
  const first = rowText(beginning)
  expect(first).toContain('● EXPLAI')
  expect(first).toContain('│ $0.000 │ 0↓ 0↑')
  expect(first).not.toContain('…')
  const zeros = rowCells(beginning)
  const at = first.indexOf('0↓ 0↑')
  expect(zeros.slice(at, at + 5).every(c => c.fg === SEP && c.bg === DEFAULT)).toBe(true)
  w.state.step = usage({ input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 500 })
  w.state.ledger = 0.05
  // One response, and no session.measure: the cost comes from the ledger read after the step.
  await step($, 'live-1')
  const after = await drawing(ui)
  const counted = rowText(after)
  expect(counted).toContain('│ $0.050 │ 10K↓ 500↑')
  expect(counted).not.toContain('%c')
  // 90% of the three digits of 10K are teal text: all three, on the default background.
  const k = counted.indexOf('10K')
  expect(rowCells(after).slice(k, k + 3).every(c => c.fg === CACHE_FG && c.bg === DEFAULT)).toBe(true)
})

test('colors read against the median of the session', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  // Turns costing 0.1, 0.2, 0.3 and 0.9.
  await turn($, w, 'alpha', usage(), 0.1)
  await turn($, w, 'bravo', usage(), 0.3)
  await turn($, w, 'charlie', usage(), 0.6)
  const ui = await mount($)
  const labelFg = (cells: Cell[], label: string) => {
    const at = cellText(cells).indexOf(label)
    expect(at).toBeGreaterThanOrEqual(0)
    return cells.slice(at, at + label.length).map(c => c.fg)
  }
  // Three turns or fewer: the label has no usage color and the bar is gray.
  const three = rowCells(await drawing(ui))
  expect(labelFg(three, 'CHARLI').every(fg => fg === DEFAULT)).toBe(true)
  expect(three.filter(c => c.cp === 0x2588).every(c => c.fg === FIGURES)).toBe(true)
  await turn($, w, 'delta', usage(), 1.5)
  // Four turns: 0.9 is above twice the median of 0.25, the top step of the teal ramp; the label stays plain.
  const four = rowCells(await drawing(ui))
  expect(labelFg(four, 'DELTA').every(fg => fg === DEFAULT)).toBe(true)
  expect(four.some(c => c.cp === 0x2588 && c.fg === RAMP[3])).toBe(true)
})

test('the row animates while a turn runs and goes still when idle', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  expect(raster(await drawing(ui))).toBeDefined()
  await w.clock.advance(300)
  expect(w.blits.length).toBe(3)
  expect(w.blits.every(b => b.requestId === 'hint' && b.key === 'row')).toBe(true)

  // The turn ends: the figures settle in a second or two and the timer stops.
  w.state.ledger = 0.11
  await $.turn.complete({
    answer: '',
    durationMs: 4000,
    isAborted: false,
    turnId: 'live-1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', ...usage() },
  } as never)
  await drawing(ui)
  await w.clock.advance(3000)
  const settled = w.blits.length
  expect(settled).toBeGreaterThan(3)
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(settled)
})

test('a refused blit after it worked stops the timer; the next draw is a Raster again', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  await drawing(ui)
  await w.clock.advance(300)
  expect(w.blits.length).toBe(3)

  w.state.blitAnswer = { deny: 'not mounted' }
  await w.clock.advance(100)
  expect(w.blits.length).toBe(4)
  await w.clock.advance(500)
  expect(w.blits.length).toBe(4)
  // Blits worked before, so the next draw is a Raster again.
  expect(raster(await drawing(ui))).toBeDefined()
})

test('a slot that refuses its first blits three times is drawn still', async ($, on) => {
  const w = world(on)
  w.state.blitAnswer = { deny: 'no such site' }
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  for (let i = 0; i < 3; i++) {
    expect(raster(await drawing(ui))).toBeDefined()
    await w.clock.advance(100)
  }
  expect(w.blits.length).toBe(3)
  const again = await drawing(ui)
  expect(raster(again)).toBeUndefined()
  expect(text(again)).toContain('EXPLAI')
  await w.clock.advance(500)
  expect(w.blits.length).toBe(3)
})

test('tool calls flash their name', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  await drawing(ui)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await w.clock.advance(100)
  expect(blitText(w.blits.at(-1))).toContain('‹Bash›')
  expect(blitText(w.blits.at(-1))).not.toContain(String.fromCodePoint(0x27e8))
  await w.clock.advance(1000)
  expect(blitText(w.blits.at(-1))).not.toContain('Bash')
})

test(
  'streamed text makes the live bar shimmer',
  { options: { reacts: 'off', stock: 'off', celebrate: 'off' } },
  async ($, on) => {
    const w = world(on)
    await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
    const ui = await mount($)
    await drawing(ui)
    w.state.ledger = 0.01
    w.state.chunks = [{ kind: 'text', index: 0, text: 'x'.repeat(480) } as never]
    await step($, 'live-1')
    await drawing(ui)
    await w.clock.advance(100)
    const bar = (b: { cells?: string } | undefined) => decodeCells(b?.cells ?? '').filter(c => c.cp === 0x2588)
    expect(bar(w.blits.at(-1)).some(c => c.fg !== LIVE)).toBe(true)
    await w.clock.advance(1000)
    expect(bar(w.blits.at(-1)).length).toBeGreaterThan(0)
    expect(bar(w.blits.at(-1)).every(c => c.fg === LIVE)).toBe(true)
  },
)

test('the meter eases when a response lands, then goes still', { options: { reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'explain the cache', turnId: 'live-1' } as never)
  const ui = await mount($)
  await drawing(ui)
  w.state.ledger = 0.01
  await step($, 'live-1')
  await drawing(ui)
  const before = w.blits.length
  await w.clock.advance(400)
  const isTip = (c: Cell) => c.cp >= 0x2589 && c.cp <= 0x258f
  const fresh = w.blits.slice(before)
  expect(fresh.length).toBeGreaterThan(0)
  expect(fresh.some(b => decodeCells(b.cells ?? '').some(isTip))).toBe(true)
  await w.clock.advance(1000)
  const settled = w.blits.length
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(settled)
  const last = decodeCells(w.blits.at(-1)?.cells ?? '')
  expect(last.some(isTip)).toBe(false)
  // B 49 at W 100: logShare(0.01) is 0.0711, 3.48 cells, so 3 at rest.
  expect(last.filter(c => c.cp === 0x2588).length).toBe(3)
})

test('a new session high pulses live', { options: { reacts: 'off', stock: 'off', shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.1)
  await turn($, w, 'two', usage(), 0.2)
  await turn($, w, 'three', usage(), 0.3)
  await $.turn.start({ text: 'four', turnId: 'live-4' } as never)
  const ui = await mount($)
  await drawing(ui)
  w.state.ledger = 0.5
  await step($, 'live-4')
  await drawing(ui)
  await w.clock.advance(100)
  expect(blitText(w.blits.at(-1))).toContain('NEW HIGH')
})

test('Σ follows the ledger, the session is saved, /clear starts over', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const saved = w.store.get('session:sess-1') as { entries: unknown[] }
  expect(saved.entries.length).toBe(2)
  expect(w.store.get('sessions')).toEqual(['sess-1'])

  // Spend while no turn ran: Σ reads the ledger, the entries stay as they were.
  w.state.ledger = 0.8
  await $.session.measure({
    context: { tokens: 1, window: 1_000_000, percent: 0 },
    rateLimits: [],
    cost: { usd: 0.8 },
    changed: ['cost'],
  } as never)
  const ui = await mount($)
  expect(rowText(await drawing(ui)).startsWith('Σ $0.80 │')).toBe(true)
  expect(await hint(await mount($, PANE))).toContain('Outside listed turns: $0.27')

  // /ticker clear empties the tape; Σ keeps reading the ledger.
  await $.command.run({ command: 'ticker', args: 'clear', origin: { kind: 'composer' } } as never)
  expect(rowText(await drawing(ui)).trimEnd()).toBe('Σ $0.80 │')
  await turn($, w, 'fix the login bug', usage(), 0.9)
  expect(rowText(await drawing(ui)).startsWith('Σ $0.90 │')).toBe(true)

  // The same session id after a restart: the same tape.
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  expect(rowText(await drawing(ui))).toContain('FIX')

  // /clear is a new session: back to the plain hint, and the next turn is number 1.
  w.state.sid = 'sess-2'
  w.state.ledger = 0
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  const cleared = await drawing(ui)
  expect(text(cleared)).toBe('? for shortcuts')
  expect(raster(cleared)).toBeUndefined()
  // Nothing drawn, so the blank line goes with it.
  expect(gapBox(cleared)).toEqual([])
  await turn($, w, 'next thing', usage(), 0.05)
  const fresh = w.store.get('session:sess-2') as { entries: { n: number }[] }
  expect(fresh.entries[0]?.n).toBe(1)
})

test(
  'the display settings shape the figures, and leave the panel alone',
  { options: { ...EFFECTS_OFF, label: 'prompt', change: 'percent', tokens: 'labeled' } },
  async ($, on) => {
    const w = world(on)
    await twoTurns($, w)
    const cells = rowCells(await drawing(await mount($)))
    const row = cellText(cells)
    expect(row).toContain('#2 "fix the login bug"')
    expect(row).toContain('▲282%')
    expect(row).toContain('312K in · 2.1K out')
    expect(row).not.toContain('% cache')
    const k = row.indexOf('312K in')
    expect(cells.slice(k, k + 4).every(c => c.fg === CACHE_FG)).toBe(true)
    expect(cells.slice(k + 4, k + 7).every(c => c.fg === FIGURES)).toBe(true)
    expect(cells.slice(k, k + 18).every(c => c.bg === DEFAULT)).toBe(true)
    expect(await hint(await mount($, PANE))).toContain('Priciest: #2 FIX $0.42')
  },
)

test('the chart style draws one bar per turn', { options: { ...EFFECTS_OFF, style: 'chart' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const row = rowText(await drawing(await mount($)))
  // $0.42 on the fixed log scale is six eighths high; nothing here is a full bar.
  expect(row.slice(10)).toContain('▆')
  expect(row.slice(10)).not.toContain('█')
})

/** The hint slot at 112 columns: the row is 110 wide. */
const WIDE = { ...HINT, viewport: { columns: 112, rows: 40 } as never }

test('the strip style writes names inside the blocks', { options: { ...EFFECTS_OFF, style: 'strip' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const row = rowText(await drawing(await mount($, { ...HINT, viewport: { columns: 122, rows: 40 } as never })))
  expect(row).toContain(' EXPLAI 21%')
  expect(row).toContain(' FIX 79%')
})

test('strip labels off: the blocks carry no text', { options: { ...EFFECTS_OFF, style: 'strip', stripLabels: 'off' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const row = rowText(await drawing(await mount($, { ...HINT, viewport: { columns: 122, rows: 40 } as never })))
  // The newest turn's name still reads in the label before the bar; the blocks hold no names and no shares.
  expect(row).not.toContain('EXPLAI')
  expect(row).not.toContain('FIX 79%')
  expect(row).not.toContain('79%')
})

test('the chart shows the same figures as the meter', { options: { ...EFFECTS_OFF, style: 'chart' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const row = rowText(await drawing(await mount($, WIDE)))
  // The same order in every style: core, label, divider, visual, divider, figures.
  expect(row.startsWith('Σ $0.53 │ ● FIX │ ▁')).toBe(true)
  expect(row).toContain(' │ $0.42 ▲0.31 │ 312K↓ 2.1K↑')
})

test('the strip shows the same figures as the meter', { options: { ...EFFECTS_OFF, style: 'strip' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const row = rowText(await drawing(await mount($, WIDE)))
  expect(row.startsWith('Σ $0.53 │ ● FIX │ ')).toBe(true)
  expect(row).toContain(' │ $0.42 ▲0.31 │ 312K↓ 2.1K↑')
})

test('the meter shows the same figures too', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const cells = rowCells(await drawing(await mount($, WIDE)))
  const row = cellText(cells)
  expect(row.startsWith('Σ $0.53 │ ● FIX │ █')).toBe(true)
  expect(row).toContain('░ │ $0.42 ▲0.31 │ 312K↓ 2.1K↑')
  // B 59 at W 110: $0.42 fills 43 cells on the fixed log scale.
  expect(cells.filter(c => c.cp === 0x2588).length).toBe(43)
  expect(cells.filter(c => c.cp === 0x2591).length).toBe(16)
})

test('the cache percent shows beside the input figure when on', { options: { ...EFFECTS_OFF, cachePercent: 'on' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const cells = rowCells(await drawing(await mount($, WIDE)))
  const row = cellText(cells)
  expect(row).toContain('│ 312K↓ (94%c) 2.1K↑')
  const k = row.indexOf('(94%c)')
  expect(cells.slice(k, k + 6).every(c => c.fg === CACHE_FG && c.bg === DEFAULT)).toBe(true)
})

test('gapAbove off draws the row right under the lines above', { options: { ...EFFECTS_OFF, gapAbove: 'off' } }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const drawn = (await drawing(await mount($))) as Node
  const wrapper = (drawn.children ?? []).at(-1) as Node
  expect(wrapper.type).toBe('Box')
  expect(wrapper.children).toEqual([raster(drawn)])
  expect(gapBox(drawn)).toEqual([])
  expect(rowText(drawn).startsWith('Σ $0.53')).toBe(true)
})

test('gapAbove off on the desktop: no blank line either', { options: { ...EFFECTS_OFF, gapAbove: 'off' } }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'fix the login bug', usage(), 0.11)
  const drawn = await drawing(await mount($, { ...HINT, surface: 'desktop' }))
  expect(raster(drawn)).toBeUndefined()
  expect(gapBox(drawn)).toEqual([])
  expect(text(drawn)).toContain('FIX')
})

test('a new session high raises one toast, and the records are kept sorted', { options: { ...EFFECTS_OFF, newHighToast: 'on' } }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.1)
  await turn($, w, 'two', usage(), 0.2)
  await turn($, w, 'three', usage(), 0.3)
  await turn($, w, 'four', usage(), 0.8)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]?.startsWith('Claude-Ticker: new session high $0.50 ·')).toBe(true)
  const records = w.store.get('records') as { costUsd: number }[]
  expect(records.length).toBe(4)
  expect(records.map(r => r.costUsd)).toEqual([...records.map(r => r.costUsd)].sort((a, b) => b - a))
})

test('no toast unless the setting is on', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.1)
  await turn($, w, 'two', usage(), 0.2)
  await turn($, w, 'three', usage(), 0.3)
  await turn($, w, 'four', usage(), 0.8)
  expect(w.toasts).toEqual([])
})

test('the panel lists the session and clears the tape', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const pane = await $.ui.mount(PANE as never)
  const shown = text(await pane.drawn())
  expect(shown).toContain('This session')
  expect(shown).toContain('FIX')
  expect(shown).toContain('Priciest: #2 FIX $0.42')
  expect(shown).toContain('All-time top 10')
  await pane.press({ key: 'clear' })
  expect(text(await pane.drawn())).toContain('No turns yet.')
})

test('the panel shows a ramp swatch and no usage-colored text', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'alpha', usage(), 0.1)
  await turn($, w, 'bravo', usage(), 0.3)
  await turn($, w, 'charlie', usage(), 0.6)
  await turn($, w, 'delta', usage(), 1.5)
  const pane = (await (await $.ui.mount(PANE as never)).drawn()) as Node
  expect(text(pane)).toContain('Priciest: #4 DELTA $0.90')
  const swatches = walk(pane).filter(n => n.type === 'Text' && text(n) === '█')
  expect(swatches.length).toBe(4)
  expect(swatches.some(n => n.props?.color === '#5fd7d7')).toBe(true)
})

test('/ticker clear and a wrong argument', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const cleared = (await $.command.run({ command: 'ticker', args: 'clear', origin: { kind: 'composer' } } as never)) as {
    text: string
  }
  expect(cleared.text.startsWith('Cleared the ticker tape')).toBe(true)
  const wrong = (await $.command.run({ command: 'ticker', args: 'x', origin: { kind: 'composer' } } as never)) as { text: string }
  expect(wrong.text).toBe('Usage: /ticker [clear]')
})

test('the desktop draws the row still', async ($, on) => {
  const w = world(on)
  await turn($, w, 'fix the login bug', usage(), 0.11)
  const drawn = await drawing(await mount($, { ...HINT, surface: 'desktop' }))
  expect(raster(drawn)).toBeUndefined()
  // The still row has the same blank line above it.
  expect(gapBox(drawn).length).toBe(1)
  expect(text(drawn)).toContain('Σ $0.11')
  expect(text(drawn)).toContain('FIX')
})

test('a long session keeps its strip after a turn ends', { options: { ...EFFECTS_OFF, style: 'strip', stripTurns: '8' } }, async ($, on) => {
  const w = world(on)
  const ui = await mount($, WIDE)
  for (let i = 1; i <= 25; i++) await turn($, w, 'go on', usage(), i / 10)
  const runsIn = (cells: Cell[]): number => {
    let count = 0
    // The label ● GO (4 cells) and its divider come first: the 59-cell strip is cells 17 to 75.
    for (let i = 17; i <= 75; i++) if (cells[i]?.bg !== DEFAULT && (i === 17 || cells[i - 1]?.bg === DEFAULT)) count++
    return count
  }
  const first = rowCells(await drawing(ui))
  expect(runsIn(first)).toBe(8)
  expect(first.some(c => c.cp === 0x2591)).toBe(false)
  await turn($, w, 'go on', usage(), 2.6)
  const second = rowCells(await drawing(ui))
  expect(runsIn(second)).toBe(8)
  expect(second.some(c => c.cp === 0x2591)).toBe(false)
})

test('the live dot is only in the label, never inside the strip', { options: { ...EFFECTS_OFF, style: 'strip' } }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.1)
  await $.turn.start({ text: 'two', turnId: 'live-2' } as never)
  w.state.ledger = 0.15
  const ui = await mount($, WIDE)
  await step($, 'live-2')
  const row = rowText(await drawing(ui))
  // The one dot is the label's (● TWO, 5 cells, then its divider); cells 18 to 76 are the strip.
  expect(row.slice(10, 18)).toBe('● TWO │ ')
  expect(row.slice(18, 77)).not.toContain('●')
})

test('a background helper keeps crediting the turn that launched it', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  const pane = await mount($, PANE)
  await $.turn.start({ text: 'dig deep', turnId: 't1' } as never)
  w.state.nextAgentId = 'ag1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 0.125
  await finish($, 't1', usage())
  const entries = () => (w.store.get('session:sess-1') as { entries: { costUsd: number; tokensIn: number }[] }).entries
  expect(entries()[0]?.costUsd).toBe(0.125)

  await $.turn.start({ text: 'dig', turnId: 'h1', agentId: 'ag1' } as never)
  w.state.step = usage({ input_tokens: 1000, output_tokens: 100 })
  w.state.ledgerOnStep = 0.625
  await step($, 'h1', 'ag1')
  expect(entries()[0]?.costUsd).toBe(0.625)
  expect(entries()[0]?.tokensIn).toBe(2000)
  const row = rowText(await drawing(ui))
  expect(row).toContain('2K↓ 200↑')
  expect(row).toContain('Σ $0.63')
  // The row follows the turn the helper works on: the newest turn, so its marker has no number.
  expect(row).toContain('↻ DIG │')
  expect(text(await pane.drawn())).toContain('↻')

  w.state.ledgerOnStep = 1.125
  await step($, 'h1', 'ag1')
  expect(entries()[0]?.costUsd).toBe(1.125)
  expect(rowText(await drawing(ui))).toContain('Σ $1.13')
  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: false,
    turnId: 'h1',
    agentId: 'ag1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', ...usage() },
  } as never)
  expect(text(await pane.drawn())).not.toContain('↻')
  const finished = rowText(await drawing(ui))
  expect(finished).toContain('● DIG │')
  expect(finished).not.toContain('↻')
  const saved = w.store.get('records') as { costUsd: number; n: number }[]
  expect(saved.filter(r => r.n === 1).length).toBe(1)
  expect(saved.find(r => r.n === 1)?.costUsd).toBe(1.125)
})

/** Turn 1 launches a background helper and ends at $0.125; the helper answers once, taking turn 1 to $0.625. */
async function helperWorking($: Engine, w: World) {
  await $.turn.start({ text: 'dig deep', turnId: 't1' } as never)
  w.state.nextAgentId = 'ag1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 0.125
  await finish($, 't1', usage())
  await $.turn.start({ text: 'dig', turnId: 'h1', agentId: 'ag1' } as never)
  w.state.ledgerOnStep = 0.625
  await step($, 'h1', 'ag1')
}

/** The helper of turn 1 ends. */
async function helperDone($: Engine) {
  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: false,
    turnId: 'h1',
    agentId: 'ag1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', ...usage() },
  } as never)
}

/** Turn 2 runs while the helper works (it takes $0.125 and $0.25 more go to turn 1), then ends. */
async function secondTurn($: Engine, w: World, ui: Slot) {
  await $.turn.start({ text: 'next thing', turnId: 't2' } as never)
  w.state.ledgerOnStep = 0.75
  await step($, 't2')
  await drawing(ui)
  w.state.ledgerOnStep = 1.0
  await step($, 't2', 'ag1')
  return { running: rowText(await drawing(ui)) }
}

test('the row follows the active turn', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  await helperWorking($, w)
  // The helper's turn is the only one: its marker, no number.
  const helper = rowText(await drawing(ui))
  expect(helper).toContain('↻ DIG │')
  expect(helper).toContain('│ $0.63 │')

  // A newer turn runs: it has the row.
  const { running } = await secondTurn($, w, ui)
  expect(running).toContain('● NEXT │')
  expect(running).toContain('│ $0.13 ▼0.75 │')
  expect(running).not.toContain('↻')

  // It ends: the row goes back to turn 1 while its helper still works, lavender, with its number.
  w.state.ledgerOnStep = null
  w.state.ledger = 1.0
  await finish($, 't2', usage())
  const back = rowCells(await drawing(ui))
  const backText = cellText(back)
  expect(backText).toContain('↻ #1 DIG │')
  expect(backText).toContain('│ $0.88 │')
  expect(back[backText.indexOf('↻')]?.fg).toBe(LIVE)

  w.state.ledgerOnStep = 1.25
  await step($, 'h1', 'ag1')
  const grown = rowText(await drawing(ui))
  expect(grown).toContain('↻ #1 DIG │')
  expect(grown).toContain('│ $1.13 │')

  // The helper ends: the row settles on the newest turn.
  await helperDone($)
  const done = rowText(await drawing(ui))
  expect(done).toContain('● NEXT │')
  expect(done).toContain('│ $0.13 ▼1.00 │')
  expect(done).not.toContain('↻')
})

test(
  'a finished turn stays two seconds before the row moves on',
  { options: { reacts: 'off', stock: 'off', celebrate: 'off', shimmer: 'off' } },
  async ($, on) => {
    const w = world(on)
    const ui = await mount($)
    await helperWorking($, w)
    await drawing(ui)
    await secondTurn($, w, ui)
    w.state.ledgerOnStep = null
    w.state.ledger = 1.0
    await finish($, 't2', usage())
    // Right after it ends, turn 2 keeps the row with its final figures.
    const held = rowText(await drawing(ui))
    expect(held).toContain('● NEXT │')
    expect(held).not.toContain('↻')
    await w.clock.advance(1000)
    expect(blitText(w.blits.at(-1))).toContain('● NEXT │')
    await w.clock.advance(1500)
    expect(blitText(w.blits.at(-1))).toContain('↻ #1 DIG │')
    expect(blitText(w.blits.at(-1))).toContain('│ $0.88 │')

    // The helper ends: turn 1 keeps the row 2 s with its final figures, then the newest turn comes back.
    await helperDone($)
    expect(rowText(await drawing(ui))).toContain('● #1 DIG │')
    await w.clock.advance(2500)
    expect(blitText(w.blits.at(-1))).toContain('● NEXT │')
    expect(blitText(w.blits.at(-1))).not.toContain('#1')
    const settled = w.blits.length
    await w.clock.advance(1000)
    expect(w.blits.length).toBe(settled)
  },
)

test('the desktop follows the active turn without a hold', async ($, on) => {
  const w = world(on)
  await helperWorking($, w)
  await turn($, w, 'next thing', usage(), 0.75)
  const desktop = { ...HINT, surface: 'desktop' }
  const ui = await mount($, desktop)
  const shown = await drawing(ui)
  expect(raster(shown)).toBeUndefined()
  expect(text(shown)).toContain('↻ #1 DIG')
  await helperDone($)
  const after = text(await drawing(ui))
  expect(after).toContain('● NEXT')
  expect(after).not.toContain('↻')
})

test('a helper step during a newer live turn goes to its own turn', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'dig deep', turnId: 't1' } as never)
  w.state.nextAgentId = 'ag1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 0.125
  await finish($, 't1', usage())
  await $.turn.start({ text: 'dig', turnId: 'h1', agentId: 'ag1' } as never)
  w.state.ledgerOnStep = 0.625
  await step($, 'h1', 'ag1')

  await $.turn.start({ text: 'next thing', turnId: 't2' } as never)
  w.state.ledgerOnStep = 0.75
  await step($, 't2')
  w.state.ledgerOnStep = 1.0
  await step($, 't2', 'ag1')
  w.state.ledgerOnStep = null
  w.state.ledger = 1.0
  await finish($, 't2', usage())
  const entries = (w.store.get('session:sess-1') as { entries: { n: number; costUsd: number }[] }).entries
  expect(entries.find(e => e.n === 1)?.costUsd).toBe(0.875)
  expect(entries.find(e => e.n === 2)?.costUsd).toBe(0.125)
})

test('an unknown agent counts in Σ only', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.125)
  const ui = await mount($)
  w.state.ledgerOnStep = 0.375
  await step($, 'x', 'ghost')
  const entries = () => (w.store.get('session:sess-1') as { entries: { costUsd: number }[] }).entries
  expect(entries().map(e => e.costUsd)).toEqual([0.125])
  expect(rowText(await drawing(ui)).startsWith('Σ $0.38')).toBe(true)

  // During a live turn the unknown agent's usage and cost stay out of the turn.
  await $.turn.start({ text: 'two', turnId: 't2' } as never)
  w.state.step = usage({ input_tokens: 5000 })
  w.state.ledgerOnStep = 0.625
  await step($, 't2', 'ghost')
  const row = rowText(await drawing(ui))
  expect(row).toContain('│ $0.000 ▼0.13 │ 0↓ 0↑')
  expect(row.startsWith('Σ $0.63')).toBe(true)
})

test(
  'a helper that makes its turn the session high raises one toast',
  { options: { ...EFFECTS_OFF, newHighToast: 'on' } },
  async ($, on) => {
    const w = world(on)
    await turn($, w, 'one', usage(), 0.125)
    await turn($, w, 'two', usage(), 0.25)
    await turn($, w, 'three', usage(), 0.375)
    await $.turn.start({ text: 'four', turnId: 't4' } as never)
    w.state.nextAgentId = 'ag9'
    await $.agent.spawn({ prompt: 'dig', background: true } as never)
    w.state.ledger = 0.5
    await finish($, 't4', usage())
    expect(w.toasts).toEqual([])
    await $.turn.start({ text: 'dig', turnId: 'h9', agentId: 'ag9' } as never)
    w.state.ledgerOnStep = 1.0
    await step($, 'h9', 'ag9')
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]?.startsWith('Claude-Ticker: new session high $0.63 ·')).toBe(true)
    w.state.ledgerOnStep = 1.125
    await step($, 'h9', 'ag9')
    expect(w.toasts.length).toBe(1)
  },
)

const summaries = (w: World) => w.store.get('summaries') as Record<string, Record<string, unknown>>

test('the session summary is captured and shown', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const mine = summaries(w)['sess-1']
  expect(mine?.total).toBe(0.53)
  expect(mine?.turns).toBe(2)
  expect(mine?.project).toBe('claudeticker')
  expect(mine?.branch).toBe('main')
  expect(mine?.title).toBe('explain the cache')
  expect(mine?.titleSource).toBe('prompt')
  const shown = text(await (await $.ui.mount(PANE as never)).drawn())
  expect(shown).toContain('All-time top 10 sessions')
  expect(shown).toContain('$0.53')
  expect(shown).toContain('2 turns')
  expect(shown).toContain('claudeticker/main')
  expect(shown).toContain('explain the cache')
  expect(shown).toContain('this session')
  expect(shown).toContain('│ claudeticker/main · session $0.53 · explain the cache')
})

test("Claude Code's session title wins", { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await $.classic.SessionStart({ source: 'resume', session_title: 'Ticker planning' } as never)
  await twoTurns($, w)
  const mine = summaries(w)['sess-1']
  expect(mine?.title).toBe('Ticker planning')
  expect(mine?.titleSource).toBe('claude')
  expect(text(await (await $.ui.mount(PANE as never)).drawn())).toContain('Ticker planning')
})

test('no git: the folder name alone', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  w.state.repo = null
  await twoTurns($, w)
  expect(summaries(w)['sess-1']?.branch).toBe(null)
  const shown = text(await (await $.ui.mount(PANE as never)).drawn())
  expect(shown).toContain('claudeticker')
  expect(shown).not.toContain('claudeticker/')
})

test('the lists survive /ticker clear, and the ledger updates the total', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await twoTurns($, w)
  const pane = await $.ui.mount(PANE as never)
  await $.command.run({ command: 'ticker', args: 'clear', origin: { kind: 'composer' } } as never)
  const cleared = text(await pane.drawn())
  expect(cleared).toContain('0 turns')
  expect(cleared).toContain('$0.53')
  expect(cleared).toContain('FIX')
  w.state.ledger = 0.8
  await $.session.measure({
    context: { tokens: 1, window: 1_000_000, percent: 0 },
    rateLimits: [],
    cost: { usd: 0.8 },
    changed: ['cost'],
  } as never)
  expect(text(await pane.drawn())).toContain('$0.80')
})

/** `/ticker clear`, as the composer runs it. */
const clearCommand = ($: Engine) => $.command.run({ command: 'ticker', args: 'clear', origin: { kind: 'composer' } } as never)

test('a helper whose start was heard before its spawn was recorded still grows its turn, and the timer stops at the end', async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  const pane = await mount($, PANE)
  await $.turn.start({ text: 'dig deep', turnId: 't1' } as never)
  // The helper's run start reaches the mod before the spawn hook has written the owner.
  await $.turn.start({ text: 'dig', turnId: 'h1', agentId: 'ag1' } as never)
  w.state.nextAgentId = 'ag1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 0.125
  await finish($, 't1', usage())
  w.state.ledgerOnStep = 0.625
  await step($, 'h1', 'ag1')
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
  expect(text(await pane.drawn())).toContain('↻')

  await helperDone($)
  expect(rowText(await drawing(ui))).toContain('● DIG')
  expect(text(await pane.drawn())).not.toContain('↻')
  // Nothing is left to move: the timer stops.
  await w.clock.advance(4000)
  const settled = w.blits.length
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(settled)
})

const SESSION_START = { cwd: '/x', surface: 'terminal', isInteractive: true } as never

test('the open runs live in session state: session.start keeps a running helper and closes an ended one', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  const pane = await mount($, PANE)
  await helperWorking($, w)
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
  expect(text(await pane.drawn())).toContain('↻')

  // The agent still lists as running: its run in state is kept.
  await $.session.start(SESSION_START)
  expect(rowText(await drawing(ui))).toContain('↻ DIG')

  // The agent ended while this module did not hear it: the run is removed and `growing` follows.
  w.state.agents = [{ id: 'ag1', status: 'completed' }]
  await $.session.start(SESSION_START)
  const closed = rowText(await drawing(ui))
  expect(closed).toContain('● DIG')
  expect(closed).not.toContain('↻')
  expect(text(await pane.drawn())).not.toContain('↻')

  // The helper answers again: it re-joins through the credit path.
  w.state.ledgerOnStep = 0.875
  await step($, 'h1', 'ag1')
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
  await helperDone($)
  const done = rowText(await drawing(ui))
  expect(done).toContain('● DIG')
  expect(done).not.toContain('↻')

  // A closed run is not reopened by a later listing.
  w.state.agents = [{ id: 'ag1', status: 'running' }]
  await $.session.start(SESSION_START)
  const after = rowText(await drawing(ui))
  expect(after).toContain('● DIG')
  expect(after).not.toContain('↻')
})

test('an agent list that fails prunes nothing', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  await helperWorking($, w)
  w.state.agentsFail = true
  w.state.agents = []
  await $.session.start(SESSION_START)
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
})

test('session.start keeps the turn an open helper run still holds', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  await helperWorking($, w)
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  expect(rowText(await drawing(ui))).toContain('↻ DIG')
  await helperDone($)
  expect(rowText(await drawing(ui))).not.toContain('↻')
})

test('/ticker clear keeps the running turn its own subagent', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.125)
  await turn($, w, 'two', usage(), 0.25)
  await $.turn.start({ text: 'three with agent', turnId: 'x3' } as never)
  w.state.nextAgentId = 'fg1'
  await $.agent.spawn({ prompt: 'sub' } as never)
  await clearCommand($)

  w.state.step = usage({ input_tokens: 5000, output_tokens: 500 })
  w.state.ledgerOnStep = 0.75
  await step($, 'x3', 'fg1')
  w.state.ledgerOnStep = null
  await finish($, 'x3', usage())
  const entries = (w.store.get('session:sess-1') as { entries: { n: number; costUsd: number; tokensIn: number; agents: number }[] }).entries
  expect(entries.length).toBe(1)
  expect(entries[0]?.n).toBe(1)
  expect(entries[0]?.costUsd).toBe(0.5)
  expect(entries[0]?.tokensIn).toBe(6000)
  expect(entries[0]?.agents).toBe(1)
})

test('/ticker clear: a helper of a removed turn counts in Σ only, not in a new turn with the same number', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  const pane = await mount($, PANE)
  await turn($, w, 'one', usage(), 0.125)
  await $.turn.start({ text: 'two launches', turnId: 'x2' } as never)
  w.state.nextAgentId = 'bg1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 0.25
  await finish($, 'x2', usage())
  await $.turn.start({ text: 'dig', turnId: 'hb', agentId: 'bg1' } as never)

  await clearCommand($)
  await turn($, w, 'fresh one', usage(), 0.375)
  await turn($, w, 'fresh two', usage(), 0.5)
  w.state.ledgerOnStep = 1.5
  await step($, 'hb', 'bg1')
  const entries = (w.store.get('session:sess-1') as { entries: { n: number; costUsd: number; agents: number }[] }).entries
  expect(entries.map(e => e.n)).toEqual([1, 2])
  expect(entries[1]?.costUsd).toBe(0.125)
  expect(entries[1]?.agents).toBe(0)
  expect(rowText(await drawing(ui))).not.toContain('↻')
  expect(text(await pane.drawn())).toContain('Outside listed turns: $1.25')
})

test('/ticker clear keeps an all-time record even when a new turn reuses its number', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  await turn($, w, 'one', usage(), 0.125)
  await w.clock.advance(1000)
  await turn($, w, 'big old two', usage(), 2.125)
  await w.clock.advance(1000)
  await clearCommand($)
  await turn($, w, 'new one', usage(), 2.25)
  await w.clock.advance(1000)
  await $.turn.start({ text: 'new two', turnId: 'x2' } as never)
  w.state.nextAgentId = 'bg1'
  await $.agent.spawn({ prompt: 'dig', background: true } as never)
  w.state.ledger = 2.375
  await finish($, 'x2', usage())
  await $.turn.start({ text: 'dig', turnId: 'hb', agentId: 'bg1' } as never)
  w.state.ledgerOnStep = 2.4375
  await step($, 'hb', 'bg1')
  const saved = w.store.get('records') as { prompt: string; costUsd: number }[]
  expect(saved.find(r => r.prompt === 'big old two')?.costUsd).toBe(2)
  expect(saved.find(r => r.prompt === 'one')).toBeDefined()
  expect(saved.filter(r => r.prompt === 'new two').length).toBe(1)
  expect(saved.find(r => r.prompt === 'new two')?.costUsd).toBe(0.1875)
})

test('/ticker clear leaves another session out of the index alone when the index is full', { options: EFFECTS_OFF }, async ($, on) => {
  const w = world(on)
  const ids = Array.from({ length: 20 }, (_, i) => `other-${i}`)
  w.store.set('sessions', ids)
  for (const id of ids) w.store.set(`session:${id}`, { id, updatedAt: 1, entries: [] })
  // The current session (sess-1) has no turn saved yet and is not in the index.
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  await clearCommand($)
  await clearCommand($)
  expect(w.store.get('sessions')).toEqual(ids)
  for (const id of ids) expect(w.store.has(`session:${id}`)).toBe(true)
})
