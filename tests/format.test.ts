import { expect, test } from 'claude-code/testing'

import type { Entry, RecordEntry, SessionSummary } from '../types'
import { DEFAULT_DISPLAY, GLYPH, decodeCells, encodeCells, labelText, normalizeDisplay, safeCp } from '../hooks/cells'
import {
  cacheHit,
  formatCost,
  formatDelta,
  formatPercentDelta,
  formatTokens,
  logShare,
  promptSnippet,
  rampFor,
  shortTool,
  symbolFor,
  toneFor,
} from '../hooks/format'
import {
  RECORDS_KEPT,
  SESSIONS_KEPT,
  mergeRecord,
  normalizeSummaries,
  pruneRuns,
  pruneSummaries,
  pushIndex,
  reconcileGrowing,
  renumberAfterClear,
  topSessions,
  upsertRecord,
} from '../hooks/history'

function entry(over: Partial<Entry> = {}): Entry {
  return {
    n: 7,
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

test('formatCost: three decimals under ten cents, two above, never negative', () => {
  expect(formatCost(0.004)).toBe('$0.004')
  expect(formatCost(0.0996)).toBe('$0.100')
  expect(formatCost(0.42)).toBe('$0.42')
  expect(formatCost(12.345)).toBe('$12.35')
  expect(formatCost(-1)).toBe('$0.000')
})

test('formatDelta: the change against the turn before, in dollars', () => {
  expect(formatDelta(0.42, undefined)).toBe(null)
  expect(formatDelta(0.73, 0.42)).toEqual({ text: '▲0.31', dir: 'up' })
  expect(formatDelta(0.42, 0.73)).toEqual({ text: '▼0.31', dir: 'down' })
  expect(formatDelta(0.0504, 0.05)).toEqual({ text: '=0.00', dir: 'flat' })
  expect(formatDelta(0.05, 0.002)?.text).toBe('▲0.048')
})

test('formatTokens floors and never rounds up', () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(2100)).toBe('2.1K')
  expect(formatTokens(2000)).toBe('2K')
  expect(formatTokens(9999)).toBe('9.9K')
  expect(formatTokens(312_400)).toBe('312K')
  expect(formatTokens(1_250_000)).toBe('1.2M')
  expect(formatTokens(2_000_000)).toBe('2M')
})

test('cacheHit is the share of the input the cache served', () => {
  expect(cacheHit({ tokensIn: 312_400, cacheRead: 293_656 })).toBe(94)
  expect(cacheHit({ tokensIn: 0, cacheRead: 0 })).toBe(0)
})

test('symbolFor names a turn by the first word that says something', () => {
  const text = (t: string) => symbolFor({ kind: 'text', text: t })
  expect(text('fix the login bug')).toBe('FIX')
  expect(text('please refactor the parser')).toBe('REFACT')
  expect(text('I would like a band')).toBe('LIKE')
  expect(text('@src/app.ts explain this')).toBe('EXPLAI')
  expect(text('perché non va')).toBe('PERCHE')
  expect(text('你好')).toBe('TURN')
  expect(text('')).toBe('TURN')

  const command = (name: string) => symbolFor({ kind: 'command', name, args: '' })
  expect(command('code-review')).toBe('/CODE')
  expect(command('anthropic-skills:iwo')).toBe('/IWO')
  expect(command('---')).toBe('/CMD')
})

test('promptSnippet is one line of at most 80 characters', () => {
  expect(promptSnippet({ kind: 'text', text: '  fix\n\n  the   bug ' })).toBe('fix the bug')
  expect(promptSnippet({ kind: 'text', text: 'x'.repeat(200) }).length).toBe(80)
  expect(promptSnippet({ kind: 'command', name: 'iwo', args: 'fix it' })).toBe('/iwo fix it')
  expect(promptSnippet({ kind: 'text', text: '   ' })).toBe('(continuation)')
})

test('toneFor reads a turn against the median of its session', () => {
  expect(toneFor(0.9, [0.1, 0.2, 0.9])).toBe('neutral')
  const costs = [0.1, 0.2, 0.3, 0.4]
  expect(toneFor(0.5, costs)).toBe('hot')
  expect(toneFor(0.3, costs)).toBe('warn')
  expect(toneFor(0.1, costs)).toBe('ok')
  expect(toneFor(0, [0, 0, 0, 0])).toBe('neutral')
})

test('rampFor puts a turn on the teal scale against the session median; null while the session is young', () => {
  const costs = [0.1, 0.2, 0.3, 0.9]
  expect(rampFor(0.9, costs)).toBe(3)
  expect(rampFor(0.3, costs)).toBe(2)
  expect(rampFor(0.2, costs)).toBe(1)
  expect(rampFor(0.1, costs)).toBe(0)
  expect(rampFor(0.9, [0.1, 0.2, 0.9])).toBe(null)
  expect(rampFor(0, [0, 0, 0, 0])).toBe(null)
})

test('logShare puts a cost on a fixed log dollar scale: full at $2, about 1.9x per eighth', () => {
  const level = (cost: number): number => (cost <= 0 ? 0 : Math.min(8, Math.max(1, Math.round(logShare(cost) * 8))))
  expect([0.01, 0.02, 0.05, 0.1, 0.25, 0.3, 1, 1.2, 2, 5].map(level)).toEqual([1, 2, 3, 4, 5, 5, 7, 7, 8, 8])
  expect(logShare(0)).toBe(0)
  expect(logShare(-1)).toBe(0)
  expect(level(0.001)).toBe(1)
  expect(logShare(2)).toBe(1)
  expect(logShare(50)).toBe(1)
})

test('pushIndex keeps the 20 newest sessions and names the ones dropped', () => {
  const old = Array.from({ length: SESSIONS_KEPT }, (_, i) => `s${i + 1}`)
  const pushed = pushIndex(old, 'new')
  expect(pushed.index.length).toBe(SESSIONS_KEPT)
  expect(pushed.index[0]).toBe('new')
  expect(pushed.dropped).toEqual(['s20'])
  expect(pushIndex(['a', 'b', 'c'], 'c')).toEqual({ index: ['c', 'a', 'b'], dropped: [] })
  expect(pushIndex('junk', 'a')).toEqual({ index: ['a'], dropped: [] })
})

test('mergeRecord keeps the 10 priciest, an older tie ahead, and ignores free turns', () => {
  const rec = (n: number, costUsd: number): RecordEntry => ({ ...entry({ n, costUsd }), sessionId: 's' })
  let list: RecordEntry[] = []
  for (let i = 1; i <= 12; i++) list = mergeRecord(list, rec(i, i / 10))
  expect(list.length).toBe(RECORDS_KEPT)
  expect(list.map(r => r.n)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])

  const tied = mergeRecord([rec(1, 0.5)], rec(2, 0.5))
  expect(tied.map(r => r.n)).toEqual([1, 2])
  expect(mergeRecord(tied, rec(3, 0))).toBe(tied)
})

test('encodeCells packs little-endian [code point, foreground, background] triplets', () => {
  const input = [{ cp: 0x41, fg: 0xff0000, bg: 0x303030 }]
  const bytes = Array.from(atob(encodeCells(input)), c => c.charCodeAt(0))
  expect(bytes).toEqual([0x41, 0, 0, 0, 0, 0, 0xff, 0, 0x30, 0x30, 0x30, 0])
  expect(decodeCells(encodeCells(input))).toEqual(input)
})

test('safeCp keeps what a Raster takes and turns the rest into a question mark', () => {
  expect(safeCp(0x1f600)).toBe(0x3f)
  expect(safeCp(0x4f60)).toBe(0x3f)
  expect(safeCp(0x0301)).toBe(0x3f)
  expect(safeCp(0x200b)).toBe(0x3f)
  expect(safeCp(0x0a)).toBe(0x3f)
  expect(safeCp(0x25b2)).toBe(0x25b2)
  expect(safeCp(0x2588)).toBe(0x2588)
  for (const code of Object.values(GLYPH).flat()) expect(safeCp(code)).toBe(code)
})

test('label: symbol, prompt, number or number and symbol', () => {
  const lead = (d: Partial<typeof DEFAULT_DISPLAY>, e = entry()) =>
    labelText({ ...DEFAULT_DISPLAY, ...d }, e.n, e.symbol, e.prompt)
  expect(lead({ label: 'symbol' })).toBe('FIX')
  expect(lead({ label: 'prompt' })).toBe('#7 "fix the login bug"')
  const long = entry({ prompt: 'refactor the whole parser module' })
  expect(lead({ label: 'prompt' }, long)).toBe('#7 "refactor the whole…"')
  expect(lead({ label: 'number' })).toBe('#7')
  expect(lead({ label: 'numbered' })).toBe('#7 FIX')
  expect(labelText({ ...DEFAULT_DISPLAY, label: 'numbered' }, 73, 'FIX', 'fix the login bug')).toBe('#73 FIX')
})

test('change: percent figures', () => {
  expect(formatPercentDelta(0.42, 0.11)?.text).toBe('▲282%')
  expect(formatPercentDelta(0.11, 0.42)?.text).toBe('▼74%')
  expect(formatPercentDelta(0.4215, 0.42)?.text).toBe('▲<1%')
  expect(formatPercentDelta(15, 0.01)?.text).toBe('▲>999%')
  expect(formatPercentDelta(0.05, 0)?.text).toBe('▲new')
  expect(formatPercentDelta(0.0504, 0.05)).toEqual({ text: '=0%', dir: 'flat' })
  expect(formatPercentDelta(0.42, undefined)).toBe(null)
})

test('tokens: the display settings normalize', () => {
  expect(normalizeDisplay({ label: 'bogus' })).toEqual(DEFAULT_DISPLAY)
  expect(normalizeDisplay({ label: 'numbered' }).label).toBe('numbered')
  expect(normalizeDisplay({ label: 'number', change: 'off', tokens: 'labeled' })).toEqual({
    label: 'number',
    change: 'off',
    tokens: 'labeled',
    cachePercent: 'off',
  })
  expect(DEFAULT_DISPLAY.cachePercent).toBe('off')
  expect(normalizeDisplay({ cachePercent: 'on' }).cachePercent).toBe('on')
  expect(normalizeDisplay({ cachePercent: 'bogus' }).cachePercent).toBe('off')
})

test('shortTool: the badge name of a tool', () => {
  expect(shortTool('Edit')).toBe('Edit')
  expect(shortTool('mcp__claude_ai_Google_Drive__search_files')).toBe('search_fil')
  expect(shortTool('')).toBe('tool')
})

test('upsertRecord replaces the record of the same session and turn, then keeps the order', () => {
  const rec = (sessionId: string, n: number, costUsd: number): RecordEntry => ({ ...entry({ n, costUsd }), sessionId })
  const list = [rec('a', 1, 0.9), rec('a', 2, 0.5), rec('b', 1, 0.3)]
  const grown = upsertRecord(list, rec('a', 2, 1.2))
  expect(grown.map(r => `${r.sessionId}${r.n}`)).toEqual(['a2', 'a1', 'b1'])
  expect(grown.map(r => r.costUsd)).toEqual([1.2, 0.9, 0.3])
  const added = upsertRecord(list, rec('c', 1, 0.6))
  expect(added.map(r => `${r.sessionId}${r.n}`)).toEqual(['a1', 'c1', 'a2', 'b1'])
})

test('upsertRecord replaces only the record that also has the same finish time (numbers restart after a clear)', () => {
  const rec = (n: number, costUsd: number, at: number): RecordEntry => ({ ...entry({ n, costUsd, at }), sessionId: 'a' })
  const list = [rec(2, 2, 100), rec(1, 0.1, 50)]
  // A new turn #2 of the same session, finished later: the old record #2 stays.
  const fresh = upsertRecord(list, rec(2, 0.5, 900))
  expect(fresh.map(r => `${r.n}@${r.at}`)).toEqual(['2@100', '2@900', '1@50'])
  // The same turn grown: its record is replaced.
  const grown = upsertRecord(list, rec(2, 2.5, 100))
  expect(grown.map(r => `${r.n}@${r.at}`)).toEqual(['2@100', '1@50'])
  expect(grown.map(r => r.costUsd)).toEqual([2.5, 0.1])
})

test('reconcileGrowing drops stale turns and keeps order', () => {
  // After a reload with no open run, nothing may stay growing.
  expect(reconcileGrowing([1, 3], {})).toEqual([])
  expect(reconcileGrowing([3, 1, 2], { a: 1, b: 3 })).toEqual([3, 1])
  const g = [1, 2]
  expect(reconcileGrowing(g, { a: 1, b: 2, c: 2 })).toBe(g)
  // It never adds a turn.
  expect(reconcileGrowing([], { a: 5 })).toEqual([])
  expect(reconcileGrowing([], {})).toEqual([])
})

test('pruneRuns keeps only agents still inside a turn', () => {
  const agents = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'waiting' },
    { id: 'c', status: 'completed' },
    { id: 'e', status: 'idle' },
  ]
  // c ended, d is not listed, e is idle.
  expect(pruneRuns({ a: 1, b: 2, c: 3, d: 4, e: 5 }, agents)).toEqual({ a: 1, b: 2 })
  const r = { a: 1 }
  expect(pruneRuns(r, [{ id: 'a', status: 'running' }])).toBe(r)
  expect(pruneRuns({}, [])).toEqual({})
  expect(pruneRuns({ a: 1 }, [])).toEqual({})
})

test('renumberAfterClear', () => {
  expect(renumberAfterClear({ a: 3, b: 2, c: 3 }, 3)).toEqual({ a: 1, c: 1 })
  expect(renumberAfterClear({ a: 3, b: 2, c: 3 }, null)).toEqual({})
  expect(renumberAfterClear({}, 1)).toEqual({})
})

const summary = (i: number): SessionSummary => ({
  id: `s${i}`,
  total: i,
  turns: i,
  project: 'p',
  branch: null,
  title: '',
  titleSource: 'none',
  startedAt: i,
  updatedAt: i,
})

test('normalizeSummaries keeps whole items and fills the defaults', () => {
  expect(normalizeSummaries('junk')).toEqual({})
  expect(normalizeSummaries(undefined)).toEqual({})
  const raw = { s: { id: 's', total: 1 }, bad: { id: 'x' }, worse: 3 }
  expect(normalizeSummaries(raw)).toEqual({
    s: { id: 's', total: 1, turns: 0, project: '', branch: null, title: '', titleSource: 'none', startedAt: 0, updatedAt: 0 },
  })
})

test('topSessions lists the ten priciest sessions, an older tie first', () => {
  const map: Record<string, SessionSummary> = {}
  for (let i = 1; i <= 12; i++) map[`s${i}`] = summary(i)
  expect(topSessions(map).map(s => s.id)).toEqual(['s12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3'])
  const tied = { a: { ...summary(1), id: 'a', total: 5, startedAt: 9 }, b: { ...summary(2), id: 'b', total: 5, startedAt: 3 } }
  expect(topSessions(tied).map(s => s.id)).toEqual(['b', 'a'])
})

test('pruneSummaries keeps the top ten, the sessions of the records and the current session', () => {
  const map: Record<string, SessionSummary> = {}
  for (let i = 1; i <= 15; i++) map[`s${i}`] = summary(i)
  const kept = pruneSummaries(map, ['s1', 's2'])
  expect(Object.keys(kept).sort()).toEqual(['s1', 's10', 's11', 's12', 's13', 's14', 's15', 's2', 's6', 's7', 's8', 's9'])
  expect(Object.keys(pruneSummaries(map, [])).length).toBe(10)
})
