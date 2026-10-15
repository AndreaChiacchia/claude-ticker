import type { Entry, Live, Usage } from '../types'

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/** A field-wise sum; `b` absent leaves `a` as it is. */
export function addUsage(a: Usage, b: Usage | null | undefined): Usage {
  if (!b) return a

  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

export function usageTotal(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/** `$0.004`, `$0.42`, `$12.35`: three decimals under ten cents, two above. */
export function formatCost(usd: number): string {
  const x = Math.max(0, usd)

  return '$' + (x < 0.1 ? x.toFixed(3) : x.toFixed(2))
}

const amount = (x: number): string => (x < 0.1 ? x.toFixed(3) : x.toFixed(2))

export type Delta = { text: string; dir: 'up' | 'down' | 'flat' }

/** The cost against the turn before, in dollars; null for the session's first turn. */
export function formatDelta(cost: number, prev: number | undefined): Delta | null {
  if (prev === undefined) return null
  const d = cost - prev
  if (Math.abs(d) < 0.0005) return { text: '=0.00', dir: 'flat' }
  if (d > 0) return { text: '▲' + amount(d), dir: 'up' }

  return { text: '▼' + amount(-d), dir: 'down' }
}

/** The cost against the turn before, in percent; null for the session's first turn. */
export function formatPercentDelta(cost: number, prev: number | undefined): Delta | null {
  if (prev === undefined) return null
  const d = cost - prev
  if (Math.abs(d) < 0.0005) return { text: '=0%', dir: 'flat' }
  if (prev < 0.0005) return { text: '▲new', dir: 'up' }
  const pct = Math.round((Math.abs(d) / prev) * 100)
  const shown = pct === 0 ? '<1' : pct > 999 ? '>999' : String(pct)

  return { text: (d > 0 ? '▲' : '▼') + shown + '%', dir: d > 0 ? 'up' : 'down' }
}

/** `999`, `2.1K`, `312K`, `1.2M`: floored, never rounded up. */
export function formatTokens(n: number): string {
  const x = Math.floor(Math.max(0, n))
  if (x < 1000) return String(x)
  if (x < 10_000) return Math.floor(x / 100) / 10 + 'K'
  if (x < 1_000_000) return Math.floor(x / 1000) + 'K'

  return Math.floor(x / 100_000) / 10 + 'M'
}

/** The share of the input served from the prompt cache, in percent. */
export function cacheHit(e: { tokensIn: number; cacheRead: number }): number {
  return e.tokensIn === 0 ? 0 : Math.round((e.cacheRead * 100) / e.tokensIn)
}

export type Source = { kind: 'command'; name: string; args: string } | { kind: 'text'; text: string }

export const STOPWORDS: readonly string[] = [
  'a', 'an', 'the', 'i', 'im', 'please', 'pls', 'can', 'could', 'would', 'will', 'you', 'u', 'we', 'me', 'my',
  'let', 'lets', 'ok', 'okay', 'so', 'hey', 'hi', 'hello', 'and', 'now', 'just', 'to', 'also', 'then', 'well',
  'yes', 'no',
]

/** A short ASCII word naming the turn: `FIX`, `/IWO`. */
export function symbolFor(source: Source): string {
  if (source.kind === 'command') {
    const tail = source.name.slice(source.name.lastIndexOf(':') + 1)
    const first = tail.split(/[-_]/)[0] ?? ''
    const kept = first.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5)

    return kept === '' ? '/CMD' : '/' + kept
  }
  const plain = source.text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/@\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  const words = plain.match(/[A-Za-z0-9]+/g) ?? []
  const pick = words.find(w => w.length >= 2 && !STOPWORDS.includes(w.toLowerCase())) ?? words[0]

  return pick === undefined ? 'TURN' : pick.toUpperCase().slice(0, 6)
}

/** The prompt as one line of at most 80 characters. */
export function promptSnippet(source: Source): string {
  const raw = source.kind === 'command' ? `/${source.name}${source.args === '' ? '' : ' ' + source.args}` : source.text
  const line = Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, 80).join('')

  return line === '' ? '(continuation)' : line
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0

  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'hot'

/** How a turn's cost reads against the session's median; neutral while the session is young. */
export function toneFor(cost: number, sessionCosts: number[]): Tone {
  if (sessionCosts.length <= 3) return 'neutral'
  const m = median(sessionCosts)
  if (m <= 0) return 'neutral'
  if (cost >= 2 * m) return 'hot'

  return cost >= m ? 'warn' : 'ok'
}

/**
 * The step of the teal ramp (0 cheapest, 3 priciest) a turn takes against the session's median;
 * null (gray) while the session is young, as `toneFor` is neutral then.
 */
export function rampFor(cost: number, sessionCosts: number[]): 0 | 1 | 2 | 3 | null {
  if (sessionCosts.length <= 3) return null
  const m = median(sessionCosts)
  if (m <= 0) return null
  if (cost >= 2 * m) return 3
  if (cost >= m) return 2
  if (cost >= 0.5 * m) return 1

  return 0
}

/** The cost at the bottom of the chart and meter scale: below it a bar is a sliver. */
export const LOG_FLOOR_USD = 1 / 150
/** The cost at the top of the scale: this much or more is a full bar. */
export const LOG_CAP_USD = 2

/**
 * Where a turn's cost sits on the fixed log dollar scale, 0..1: 0 for no cost, 1 from `LOG_CAP_USD` up.
 * Each eighth of the height is about 1.9 times the cost of the one below; it never depends on the session.
 */
export function logShare(cost: number): number {
  if (cost <= 0) return 0
  if (cost >= LOG_CAP_USD) return 1
  const share = Math.log2(cost / LOG_FLOOR_USD) / Math.log2(LOG_CAP_USD / LOG_FLOOR_USD)

  return Math.max(0, Math.min(1, share))
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`

  return `${Math.floor(ms / 60_000)}m${pad2(Math.min(59, Math.round((ms % 60_000) / 1000)))}s`
}

/** `DD/MM HH:MM` in the local time `offsetMin` minutes east of UTC. */
export function stamp(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000)

  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/** The session total and mean as the summary and the panel title show them. */
export function sessionFigures(entries: Entry[], ledgerUsd: number | null): { sigma: number; count: number; avg: number } {
  const sum = entries.reduce((s, x) => s + x.costUsd, 0)
  const count = entries.length

  return { sigma: ledgerUsd ?? sum, count, avg: count === 0 ? 0 : sum / count }
}

/** A tool's short name for the badge: the part after the last `__` (MCP tools), cut to 10 code points. */
export function shortTool(name: string): string {
  const at = name.lastIndexOf('__')
  const tail = at >= 0 ? name.slice(at + 2) : name
  const short = Array.from(tail).slice(0, 10).join('')

  return short === '' ? 'tool' : short
}

/** The entry a finished turn leaves on the tape. */
export function entryFrom(
  live: Live,
  finalMain: Usage,
  costUsd: number,
  model: string,
  durationMs: number,
  isAborted: boolean,
  n: number,
  at: number,
): Entry {
  const u = addUsage(finalMain, live.agent)

  return {
    n,
    symbol: live.symbol,
    prompt: live.prompt,
    costUsd,
    tokensIn: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    tokensOut: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    model,
    durationMs,
    at,
    agents: live.agentIds.length,
    isAborted,
  }
}
