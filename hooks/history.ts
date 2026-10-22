import type { Entry, RecordEntry, SessionRecord, SessionSummary } from '../types'

export const SESSION_PREFIX = 'session:'
export const INDEX_KEY = 'sessions'
export const RECORDS_KEY = 'records'
export const SUMMARIES_KEY = 'summaries'
export const SESSIONS_KEPT = 20
export const ENTRIES_KEPT = 300
export const RECORDS_KEPT = 10
export const SUMMARIES_TOP = 10

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** The stored items that are whole entries, with a default for each optional field. */
export function normalizeEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  const kept: Entry[] = []
  for (const item of raw as unknown[]) {
    if (!isObject(item)) continue
    const { costUsd, n, tokensIn, tokensOut, cacheRead, at, symbol } = item
    if (!isNum(costUsd) || !isNum(n) || !isNum(tokensIn) || !isNum(tokensOut) || !isNum(cacheRead) || !isNum(at)) continue
    if (typeof symbol !== 'string') continue
    kept.push({
      n,
      symbol,
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      costUsd,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite: isNum(item.cacheWrite) ? item.cacheWrite : 0,
      model: typeof item.model === 'string' ? item.model : '',
      durationMs: isNum(item.durationMs) ? item.durationMs : 0,
      at,
      agents: isNum(item.agents) ? item.agents : 0,
      isAborted: typeof item.isAborted === 'boolean' ? item.isAborted : false,
    })
  }

  return kept.slice(-ENTRIES_KEPT)
}

export function normalizeSession(raw: unknown, id: string): SessionRecord | null {
  if (!isObject(raw) || !('entries' in raw)) return null

  return { id, updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : 0, entries: normalizeEntries(raw.entries) }
}

/** The stored all-time records, priciest first. */
export function normalizeRecords(raw: unknown): RecordEntry[] {
  if (!Array.isArray(raw)) return []
  const kept: RecordEntry[] = []
  for (const item of raw as unknown[]) {
    if (!isObject(item) || typeof item.sessionId !== 'string') continue
    const [entry] = normalizeEntries([item])
    if (entry) kept.push({ ...entry, sessionId: item.sessionId })
  }

  return kept.sort((a, b) => b.costUsd - a.costUsd).slice(0, RECORDS_KEPT)
}

/** The session ids newest first, `id` moved to the front; `dropped` is what falls off the end. */
export function pushIndex(index: unknown, id: string): { index: string[]; dropped: string[] } {
  const old = Array.isArray(index) ? (index as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const all = [id, ...old.filter(x => x !== id)]

  return { index: all.slice(0, SESSIONS_KEPT), dropped: all.slice(SESSIONS_KEPT) }
}

/** Adds a record, priciest first; on a tie the older record stays ahead. */
export function mergeRecord(records: RecordEntry[], entry: RecordEntry): RecordEntry[] {
  if (entry.costUsd <= 0) return records
  const at = records.findIndex(r => r.costUsd < entry.costUsd)
  const next = at === -1 ? [...records, entry] : [...records.slice(0, at), entry, ...records.slice(at)]

  return next.slice(0, RECORDS_KEPT)
}

/** Replaces the record of the same turn (session, number and finish time), then merges as `mergeRecord` does (a turn that grew after it ended). */
export function upsertRecord(records: RecordEntry[], entry: RecordEntry): RecordEntry[] {
  const rest = records.filter(r => !(r.sessionId === entry.sessionId && r.n === entry.n && r.at === entry.at))

  return mergeRecord(rest, entry)
}

/** True when `a` is an array holding exactly the items of `b`, in order (by identity): a list that would be written unchanged. */
export function sameItems(a: unknown, b: readonly unknown[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The turns of `growing` that some run in `runs` still names as owner, in their order. It never adds a turn, and it
 * returns the same array when nothing is dropped (so a caller writes nothing).
 */
export function reconcileGrowing(growing: number[], runs: Record<string, number>): number[] {
  const owned = new Set(Object.values(runs))
  const kept = growing.filter(n => owned.has(n))

  return kept.length === growing.length ? growing : kept
}

/**
 * The runs whose agent is still inside a turn (`running` or `waiting`) in `agents`; ended, idle, pending and unlisted
 * ones are dropped. It returns the same object when nothing is dropped.
 */
export function pruneRuns(
  runs: Record<string, number>,
  agents: readonly { id: string; status: string }[],
): Record<string, number> {
  const active = new Set(agents.filter(a => a.status === 'running' || a.status === 'waiting').map(a => a.id))
  const kept: Record<string, number> = {}
  let dropped = false
  for (const [id, n] of Object.entries(runs)) {
    if (active.has(id)) kept[id] = n
    else dropped = true
  }

  return dropped ? kept : runs
}

/** After /ticker clear: the entries tied to the running turn `liveN` move to turn 1, every other entry is dropped (null drops all). */
export function renumberAfterClear(map: Record<string, number>, liveN: number | null): Record<string, number> {
  const kept: Record<string, number> = {}
  if (liveN === null) return kept
  for (const [id, n] of Object.entries(map)) if (n === liveN) kept[id] = 1

  return kept
}

/** The stored session summaries by id; items without a string `id` or a finite `total` are dropped. */
export function normalizeSummaries(raw: unknown): Record<string, SessionSummary> {
  const out: Record<string, SessionSummary> = {}
  if (!isObject(raw) || Array.isArray(raw)) return out
  for (const item of Object.values(raw)) {
    if (!isObject(item) || typeof item.id !== 'string' || !isNum(item.total)) continue
    const source = item.titleSource
    out[item.id] = {
      id: item.id,
      total: item.total,
      turns: isNum(item.turns) ? item.turns : 0,
      project: typeof item.project === 'string' ? item.project : '',
      branch: typeof item.branch === 'string' ? item.branch : null,
      title: typeof item.title === 'string' ? item.title : '',
      titleSource: source === 'claude' || source === 'prompt' ? source : 'none',
      startedAt: isNum(item.startedAt) ? item.startedAt : 0,
      updatedAt: isNum(item.updatedAt) ? item.updatedAt : 0,
    }
  }

  return out
}

/** The ten priciest sessions: by total, a tie keeping the older session first. */
export function topSessions(map: Record<string, SessionSummary>): SessionSummary[] {
  return Object.values(map)
    .sort((a, b) => (b.total !== a.total ? b.total - a.total : a.startedAt - b.startedAt))
    .slice(0, SUMMARIES_TOP)
}

/** Keeps the top-ten sessions and the sessions in `keepIds` (the sessions of the top-ten turns, the current one). */
export function pruneSummaries(map: Record<string, SessionSummary>, keepIds: string[]): Record<string, SessionSummary> {
  const keep = new Set<string>([...topSessions(map).map(s => s.id), ...keepIds])
  const out: Record<string, SessionSummary> = {}
  for (const [id, summary] of Object.entries(map)) {
    if (keep.has(id)) out[id] = summary
  }

  return out
}
