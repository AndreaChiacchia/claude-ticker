import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderNode, Timer } from 'claude-code'

import type { Entry, Live, SessionSummary, Tape, Usage } from '../types'
import {
  FOCUS_HOLD,
  FRAME_MS,
  advance,
  bump,
  createAnim,
  flashTool,
  isFocusSettled,
  isSettled,
  markFlow,
  syncFocus,
  syncTargets,
} from './anim'
import type { Anim, Scene } from './anim'
import { DEFAULT, DOWN, FLAT, LIVE, UP, encodeCells, hex, rampColor, runs } from './cells'
import {
  ZERO_USAGE,
  addUsage,
  cacheHit,
  entryFrom,
  formatCost,
  formatDelta,
  formatDuration,
  formatTokens,
  promptSnippet,
  rampSteps,
  sessionFigures,
  stamp,
  symbolFor,
  usageTotal,
} from './format'
import type { Source } from './format'
import {
  INDEX_KEY,
  RECORDS_KEY,
  SESSION_PREFIX,
  SUMMARIES_KEY,
  ENTRIES_KEPT,
  mergeRecord,
  normalizeRecords,
  normalizeSession,
  normalizeSummaries,
  pruneRuns,
  pruneSummaries,
  pushIndex,
  reconcileGrowing,
  renumberAfterClear,
  sameItems,
  topSessions,
  upsertRecord,
} from './history'
import { composeRow, normalizeSettings } from './row'
import type { Settings } from './row'

const PANE = 'ticker-table'
const RASTER_KEY = 'row'
/** The row is not drawn under this many columns. */
const MIN_COLS = 20
/** First blits refused this many times in a row (none ever accepted) switch the row to a still draw. */
const MAX_REFUSED_MOUNTS = 3
/** Columns the hint slot is indented by. */
const HINT_INDENT = 2
/** The width assumed when the surface has not measured. */
const DEFAULT_COLUMNS = 80

const tape = atom({ plugin: 'claudeticker', key: 'tape' } as const, { sessionId: null, entries: [] })
const live = atom({ plugin: 'claudeticker', key: 'live' } as const, null)
const records = atom({ plugin: 'claudeticker', key: 'records' } as const, [])
const ledger = atom({ plugin: 'claudeticker', key: 'ledgerUsd' } as const, null)
/** Background agents: agent id to the number of the turn that launched them. */
const owners = atom({ plugin: 'claudeticker', key: 'owners' } as const, {})
/** Numbers of finished turns that have an agent run in progress, by last activity (the most recent last). */
const growing = atom({ plugin: 'claudeticker', key: 'growing' } as const, [])
/** Agent runs in progress (between the agent turn.start and its turn.complete): agent id to the number of the turn that owns it. Session state, so it reloads together with `growing`. */
const openRuns = atom({ plugin: 'claudeticker', key: 'openRuns' } as const, {})
/** The session summaries of the all-time lists, by session id. */
const summaries = atom({ plugin: 'claudeticker', key: 'summaries' } as const, {})

const cutText = (s: string, n: number): string => Array.from(s).slice(0, n).join('')

// State of the running module. It is lost on a reload by design: the next render rebuilds it.
// `register` resets it, so a module instance shared by several loads starts each one clean.
let settings: Settings = normalizeSettings({})
let toastOn = false
let pendingSource: Source | null = null
let timer: Timer | null = null
let isBlitting = false
/** The mounted Raster the timer repaints: the render's request and the row width. */
let band: { requestId: string; cols: number } | null = null
/** What the row shows, as the last render read it. */
let scene: Scene | null = null
let anim: Anim = createAnim()
/** Blits accepted since the last render that drew the Raster. */
let framesSinceMount = 0
/**
 * The cells of the last blit the surface took since the Raster was drawn; null right after a draw, so the first
 * frame always goes out (it is the probe that tells a slot that refuses blits).
 */
let lastBlit: string | null = null
/** Fresh draws whose first blit was refused, while no blit has ever been accepted. */
let refusedMounts = 0
let everBlitted = false
/** Set when this slot keeps refusing the first blit: the row is drawn still from then on. */
let isStaticFallback = false
/** The last ledger reading a step's cost delta is measured from. */
let ledgerMark: number | null = null
/** `turn:agent` pairs already counted in a turn's agent count. */
const credited = new Set<string>()
/** Turn numbers that already raised the new-high toast. */
const toasted = new Set<number>()
/** Claude Code's title of the session, when its SessionStart input carried one. */
let claudeTitle: string | null = null
let projectName = ''
let branchName: string | null = null
let summariesLoaded = false

/** Forgets the module memory about agents (a load, a new session). The open runs are session state and stay. */
function resetAgents(): void {
  credited.clear()
  toasted.clear()
  ledgerMark = null
}

/** Writes the ledger only when it moved, so a repeated reading does not redraw. */
async function setLedger($: EngineInterface, usd: number | null): Promise<void> {
  if ((await read($, ledger)) !== usd) await update($, ledger, () => usd)
}

/** Loads the tape of the current session id when the tape holds another one's. */
async function ensureSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if ((await read($, tape)).sessionId === id) return
  const rec = normalizeSession(await $.store.get(SESSION_PREFIX + id), id)
  await update($, tape, () => ({ sessionId: id, entries: rec?.entries ?? [] }))
  await update($, live, () => null)
  await update($, owners, () => ({}))
  await update($, growing, () => [])
  await update($, openRuns, () => ({}))
  resetAgents()
}

async function saveSession($: EngineInterface, t: Tape): Promise<void> {
  const id = t.sessionId
  if (id === null) return
  await $.store.set(SESSION_PREFIX + id, { id, updatedAt: await $.clock.now(), entries: t.entries })
  const stored = await $.store.get(INDEX_KEY)
  const { index, dropped } = pushIndex(stored, id)
  if (!sameItems(stored, index)) await $.store.set(INDEX_KEY, index)
  for (const d of dropped) await $.store.delete(SESSION_PREFIX + d)
}

/** A turn whose helper starts working joins `growing` as the most recent. */
async function addGrowing($: EngineInterface, n: number): Promise<void> {
  const current = await read($, growing)
  if (!current.includes(n)) await update($, growing, old => (old.includes(n) ? old : [...old, n]))
}

/** A credited response is activity: its turn moves to the end of `growing` (no write when it is there already). */
async function touchGrowing($: EngineInterface, n: number): Promise<void> {
  const current = await read($, growing)
  if (current.includes(n) && current.at(-1) !== n) {
    await update($, growing, old => (old.includes(n) && old.at(-1) !== n ? [...old.filter(x => x !== n), n] : old))
  }
}

async function removeGrowing($: EngineInterface, n: number): Promise<void> {
  const current = await read($, growing)
  if (current.includes(n)) await update($, growing, old => (old.includes(n) ? old.filter(x => x !== n) : old))
}

// ---- where the session lives, and its summary ----------------------------------------------------

/** The folder name of the project, or empty when the host cannot say. */
async function readProject($: EngineInterface): Promise<string> {
  try {
    return (await $.session.root()).split(/[\\/]/).filter(x => x !== '').at(-1) ?? ''
  } catch {
    return ''
  }
}

/** The git branch of the project, as claudepeeker reads it; null without a repository, git, or a host that runs processes. */
async function readBranch($: EngineInterface): Promise<string | null> {
  try {
    if ((await $.session.repo()) === null) return null
    const root = await $.session.root()
    const head = await $.process.run(['git', '-C', root, '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 5000,
    })
    if (head.exitCode !== 0) return null
    const branch = head.stdout.trim()

    return branch === '' ? null : branch
  } catch {
    return null
  }
}

async function refreshWhere($: EngineInterface): Promise<void> {
  projectName = await readProject($)
  branchName = await readBranch($)
}

/** Loads the stored summaries into the atom once. */
async function loadSummaries($: EngineInterface): Promise<void> {
  if (summariesLoaded) return
  summariesLoaded = true
  const stored = normalizeSummaries(await $.store.get(SUMMARIES_KEY))
  await update($, summaries, old => ({ ...stored, ...old }))
}

type SummaryPatch = { total?: number; turns?: number; firstPrompt?: string }

/**
 * Applies `patch` to the summary of the current session and saves the lists (pruned). The summary is created on
 * the first call unless `create` is false; project, branch and Claude Code's title are taken from what is known now.
 */
async function updateSummary($: EngineInterface, patch: SummaryPatch, create = true): Promise<void> {
  await loadSummaries($)
  const id = (await read($, tape)).sessionId
  if (id === null) return
  const all = await read($, summaries)
  const prev = all[id]
  if (prev === undefined && !create) return
  const base: SessionSummary = prev ?? {
    id,
    total: 0,
    turns: 0,
    project: projectName,
    branch: branchName,
    title: '',
    titleSource: 'none',
    startedAt: (await $.session.usage()).startedAt,
    updatedAt: 0,
  }
  const next: SessionSummary = {
    ...base,
    total: patch.total ?? base.total,
    turns: patch.turns ?? base.turns,
    project: projectName !== '' ? projectName : base.project,
    branch: projectName !== '' ? branchName : base.branch,
    updatedAt: await $.clock.now(),
  }
  if (claudeTitle !== null) {
    next.title = claudeTitle
    next.titleSource = 'claude'
  } else if (next.titleSource !== 'claude' && next.title === '' && patch.firstPrompt !== undefined && patch.firstPrompt !== '') {
    next.title = cutText(patch.firstPrompt, 60)
    next.titleSource = 'prompt'
  }
  const kept = pruneSummaries({ ...all, [id]: next }, [id, ...(await read($, records)).map(r => r.sessionId)])
  await update($, summaries, () => kept)
  await $.store.set(SUMMARIES_KEY, kept)
}

/** The summary figures a tape gives: the ledger total (else the entries' sum), the listed turns, the first prompt. */
function summaryPatch(t: Tape, ledgerUsd: number | null): SummaryPatch {
  return {
    total: ledgerUsd ?? t.entries.reduce((s, x) => s + x.costUsd, 0),
    turns: t.entries.length,
    firstPrompt: t.entries[0]?.prompt,
  }
}

// ---- a finished turn that grew --------------------------------------------------------------------

function toastHigh($: EngineInterface, entry: Entry): void {
  const shown = cutText(entry.prompt, 30) + (Array.from(entry.prompt).length > 30 ? '…' : '')
  $.ui.toast(`Claude-Ticker: new session high ${formatCost(entry.costUsd)} · ${entry.symbol} "${shown}"`)
}

/**
 * Adds one step of a background agent to the finished turn `n` that launched it: its tokens, and `delta` dollars
 * (the ledger growth around the step). The tape, the saved session, the records and the summary follow.
 */
async function creditEntry($: EngineInterface, n: number, usage: Usage, delta: number, agentId: string): Promise<void> {
  const key = `${n}:${agentId}`
  const first = !credited.has(key)
  const hit: { entry?: Entry; others: number[] } = { others: [] }
  await update($, tape, old => {
    const at = old.entries.findIndex(x => x.n === n)
    const e = old.entries[at]
    if (e === undefined) return old
    const grown: Entry = {
      ...e,
      costUsd: e.costUsd + delta,
      tokensIn: e.tokensIn + usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      tokensOut: e.tokensOut + usage.output_tokens,
      cacheRead: e.cacheRead + usage.cache_read_input_tokens,
      cacheWrite: e.cacheWrite + usage.cache_creation_input_tokens,
      agents: e.agents + (first ? 1 : 0),
    }
    hit.entry = grown
    hit.others = old.entries.filter(x => x.n !== n).map(x => x.costUsd)

    return { sessionId: old.sessionId, entries: old.entries.map((x, i) => (i === at ? grown : x)) }
  })
  const entry = hit.entry
  if (entry === undefined) return
  await touchGrowing($, n)
  credited.add(key)
  const t = await read($, tape)
  await saveSession($, t)
  if (t.sessionId !== null) {
    const old = await read($, records)
    const merged = upsertRecord(old, { ...entry, sessionId: t.sessionId })
    if (!sameItems(old, merged)) {
      await update($, records, () => merged)
      await $.store.set(RECORDS_KEY, merged)
    }
  }
  if (toastOn && hit.others.length >= 3 && entry.costUsd > Math.max(...hit.others) && !toasted.has(n)) {
    toasted.add(n)
    toastHigh($, entry)
  }
  await updateSummary($, summaryPatch(t, await read($, ledger)))
}

/** The cost of the running turn: the ledger growth since it started, less what belongs to other turns. */
function liveCost(l: Live, usd: number | null, foreignUsd: number): number {
  return l.startUsd !== null && usd !== null ? Math.max(0, usd - l.startUsd - foreignUsd) : l.costUsd
}

async function clearTape($: EngineInterface): Promise<void> {
  const t = await read($, tape)
  const l = await read($, live)
  // Turn numbers start over: the running turn becomes #1 and keeps its agents; agents tied to a removed turn count in Σ only.
  const liveN = l === null ? null : (t.entries.at(-1)?.n ?? 0) + 1
  await update($, tape, old => ({ sessionId: old.sessionId, entries: [] }))
  await update($, growing, () => [])
  await update($, owners, old => renumberAfterClear(old, liveN))
  await update($, openRuns, old => renumberAfterClear(old, liveN))
  credited.clear()
  toasted.clear()
  if (t.sessionId === null) return
  await $.store.delete(SESSION_PREFIX + t.sessionId)
  const raw = await $.store.get(INDEX_KEY)
  const index = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x !== t.sessionId) : []
  await $.store.set(INDEX_KEY, index)
  await updateSummary($, { turns: 0 }, false)
}

/** The rows of a column another mod stacked under the hint, the hint first; else the hint alone. */
function stacked(drawn: RenderElement): RenderNode[] {
  if (drawn.type === 'Box' && drawn.props?.flexDirection === 'column' && drawn.children?.length) {
    return [...drawn.children]
  }

  return [drawn]
}

function stopTimer(): void {
  timer?.cancel()
  timer = null
}

function anyEffect(): boolean {
  const e = settings.effects

  return e.reacts || e.stock || e.celebrate || e.shimmer || e.grow
}

/** True while there is a row to repaint and something to move in it. */
function needsTimer(): boolean {
  if (band === null || scene === null || isStaticFallback || !anyEffect()) return false
  const motion = scene.live !== null && (settings.effects.reacts || settings.effects.shimmer)
  const helpers = scene.growing.length > 0 && (settings.effects.reacts || settings.effects.shimmer)

  // A held switch of the focus is pending: the timer runs until it has happened.
  return motion || helpers || !isSettled(anim) || !isFocusSettled(anim, scene)
}

function kick($: EngineInterface): void {
  if (timer === null && needsTimer()) timer = $.clock.every(FRAME_MS, () => void step($))
}

/** One frame: the animation advances and the Raster is repainted in place. */
async function step($: EngineInterface): Promise<void> {
  if (isBlitting || band === null || scene === null) return
  isBlitting = true
  try {
    const target = band
    advance(anim, settings.effects)
    // A hold may expire between renders: the focus is chosen again on every frame.
    syncFocus(anim, scene, settings.effects.stock, FOCUS_HOLD)
    const composed = composeRow(scene, anim, settings, target.cols, false)
    const cells = encodeCells(composed.cells)
    if (cells === lastBlit) {
      if (!needsTimer()) stopTimer()

      return
    }
    const r = await $.ui.blit({ requestId: target.requestId, key: RASTER_KEY, cells })
    if (r.deny === undefined) {
      everBlitted = true
      framesSinceMount += 1
      lastBlit = cells
      if (!needsTimer()) stopTimer()
    } else if (framesSinceMount === 0 && !everBlitted) {
      // The first blit after a fresh draw was refused: this slot may not take blits. A fresh mount retries.
      refusedMounts += 1
      stopTimer()
      if (refusedMounts >= MAX_REFUSED_MOUNTS) {
        isStaticFallback = true
        band = null
      }
      $.ui.invalidate('ui.render')
    } else {
      // Refused after earlier successes (a dialog, a resize, the prompt hidden): a later render restarts the timer.
      stopTimer()
    }
  } finally {
    isBlitting = false
  }
}

export const register: Register = (on, options) => {
  settings = normalizeSettings(options)
  toastOn = options.newHighToast === 'on'

  // A fresh load starts from a clean state.
  stopTimer()
  pendingSource = null
  isBlitting = false
  band = null
  scene = null
  anim = createAnim()
  framesSinceMount = 0
  lastBlit = null
  refusedMounts = 0
  everBlitted = false
  isStaticFallback = false
  resetAgents()
  claudeTitle = null
  projectName = ''
  branchName = null
  summariesLoaded = false

  on('session.start', async ($, e, next) => {
    const stored = normalizeRecords(await $.store.get(RECORDS_KEY))
    await update($, records, () => stored)
    await ensureSession($)
    // Safety net: close the runs of agents that are no longer inside a turn (an end missed, for example during a
    // reload), then drop from `growing` every turn no open run holds. When the agent list is unavailable nothing is
    // pruned. A helper that answers again re-joins through the credit path in turn.step.
    let agents: { id: string; status: string }[] | null = null
    try {
      agents = await $.agent.list()
    } catch {
      agents = null
    }
    if (agents !== null) {
      const listed = agents
      const open = await read($, openRuns)
      if (pruneRuns(open, listed) !== open) await update($, openRuns, old => pruneRuns(old, listed))
    }
    const runs = await read($, openRuns)
    const held = await read($, growing)
    if (reconcileGrowing(held, runs) !== held) await update($, growing, old => reconcileGrowing(old, runs))
    await loadSummaries($)
    const u = await $.session.usage()
    await setLedger($, u.cost?.usd ?? null)
    await $.command.register({
      name: 'ticker',
      description: 'Open the per-turn cost table and all-time records, or clear the tape',
      argumentHint: '[clear]',
    })
    // Project and branch are read in the background; the summary of a session that already has one takes them when they arrive.
    void refreshWhere($)
      .then(() => updateSummary($, {}, false))
      .catch(() => undefined)

    return next(e)
  })

  // Claude Code's own title of the session, when it already has one (typically a resume).
  on('classic.SessionStart', async ($, e, next) => {
    const title = typeof e.session_title === 'string' ? e.session_title.trim() : ''
    if (title !== '') {
      claudeTitle = cutText(title, 60)
      await updateSummary($, {}, false)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined && e.isMeta !== true) {
      pendingSource = e.command
        ? { kind: 'command', name: e.command.name, args: e.command.args }
        : { kind: 'text', text: e.text }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Which turn launched a background agent: the live turn for a spawn from the main loop, the parent's turn for a nested one. A resumed agent (a message wakes it, under the same id) keeps the turn that launched it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const agentId = r.agentId
    if (agentId !== undefined) {
      let owner: number | undefined
      if (e.parentAgentId !== undefined) {
        owner = (await read($, owners))[e.parentAgentId]
      } else if ((await read($, live)) !== null) {
        owner = ((await read($, tape)).entries.at(-1)?.n ?? 0) + 1
      }
      if (owner !== undefined) {
        const n = owner
        if ((await read($, owners))[agentId] === undefined) {
          await update($, owners, old => (old[agentId] === undefined ? { ...old, [agentId]: n } : old))
        }
      }
    }

    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // An agent run begins: when its turn is already finished, that turn starts growing.
      const owner = (await read($, owners))[e.agentId]
      if (owner !== undefined) {
        const id = e.agentId
        if ((await read($, openRuns))[id] !== owner) {
          await update($, openRuns, old => (old[id] === owner ? old : { ...old, [id]: owner }))
        }
        if ((await read($, tape)).entries.some(x => x.n === owner)) await addGrowing($, owner)
      }
      if (settings.effects.reacts) bump(anim)
      kick($)

      return next(e)
    }
    await ensureSession($)
    const usage = await $.session.usage()
    const source: Source = pendingSource ?? { kind: 'text', text: e.text }
    pendingSource = null
    await setLedger($, usage.cost?.usd ?? null)
    ledgerMark = usage.cost?.usd ?? null
    const startedAt = await $.clock.now()
    await update($, live, () => ({
      turnId: e.turnId,
      symbol: symbolFor(source),
      prompt: promptSnippet(source),
      startUsd: usage.cost?.usd ?? null,
      startedAt,
      main: ZERO_USAGE,
      agent: ZERO_USAGE,
      agentIds: [],
      costUsd: 0,
      foreignUsd: 0,
    }))

    return next(e)
  })

  // Each response's usage joins the turn it belongs to: the live entry (the main loop's own, and the subagents the live
  // turn launched), or a finished entry whose background helper is still answering. The cost of a response is the
  // session ledger's growth around it. The streamed chunks pass through unchanged; each text, thinking, tool or input
  // chunk makes the current turn shimmer for a moment.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    ledgerMark = (await $.session.usage()).cost?.usd ?? ledgerMark
    const stream = next(e)
    for await (const chunk of stream) {
      if (
        settings.effects.shimmer &&
        (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'tool' || chunk.kind === 'input')
      ) {
        markFlow(anim)
      }
      yield chunk
    }
    const result = await stream.result
    const usage = result.usage
    const usd = (await $.session.usage()).cost?.usd ?? null
    let delta = 0
    if (usd !== null) {
      delta = ledgerMark === null ? 0 : Math.max(0, usd - ledgerMark)
      ledgerMark = usd
      await setLedger($, usd)
    }

    const [l, t, owned, runs] = await Promise.all([read($, live), read($, tape), read($, owners), read($, openRuns)])
    const liveN = l === null ? null : (t.entries.at(-1)?.n ?? 0) + 1
    const owner = agentId === undefined ? undefined : owned[agentId]
    let kind: 'live' | 'foreign' | 'unknown' | 'none'
    if (agentId === undefined) kind = l !== null && l.turnId === e.turnId ? 'live' : 'none'
    else if (owner !== undefined && liveN !== null && owner === liveN) kind = 'live'
    else if (owner !== undefined && t.entries.some(x => x.n === owner)) kind = 'foreign'
    else kind = 'unknown'

    if (kind === 'foreign' && owner !== undefined && agentId !== undefined) {
      // A run whose start this module did not see (a reload, or a start heard before its spawn was recorded) is open
      // from its first credited response: its turn grows until the run's turn.complete removes it.
      if (runs[agentId] === undefined) {
        const joined = owner
        await update($, openRuns, old => (old[agentId] === undefined ? { ...old, [agentId]: joined } : old))
        await addGrowing($, owner)
      }
      await creditEntry($, owner, usage ?? ZERO_USAGE, delta, agentId)
    }
    if (l !== null && kind !== 'none') {
      await update($, live, cur => {
        if (cur === null) return cur
        if (kind === 'live') {
          if (agentId === undefined) {
            return {
              ...cur,
              main: usage ? addUsage(cur.main, usage) : cur.main,
              costUsd: liveCost(cur, usd, cur.foreignUsd),
            }
          }

          return {
            ...cur,
            agent: usage ? addUsage(cur.agent, usage) : cur.agent,
            agentIds: cur.agentIds.includes(agentId) ? cur.agentIds : [...cur.agentIds, agentId],
            costUsd: liveCost(cur, usd, cur.foreignUsd),
          }
        }
        // Spend of another turn's helper, or of an agent no turn could be tied to: not part of this turn.
        const foreignUsd = cur.foreignUsd + delta

        return { ...cur, foreignUsd, costUsd: liveCost(cur, usd, foreignUsd) }
      })
    }
    if (settings.effects.reacts) bump(anim)
    kick($)

    return result
  })

  // The ledger follows every cost reading, also between turns; a running turn counts up from its start.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.cost) await setLedger($, e.cost.usd)
    const cost = e.cost
    if (cost && e.changed.includes('cost')) {
      const l = await read($, live)
      if (l !== null && l.startUsd !== null && liveCost(l, cost.usd, l.foreignUsd) !== l.costUsd) {
        await update($, live, cur => {
          if (cur === null || cur.startUsd === null) return cur
          const usd = liveCost(cur, cost.usd, cur.foreignUsd)

          return usd === cur.costUsd ? cur : { ...cur, costUsd: usd }
        })
      }
      const id = (await read($, tape)).sessionId
      const current = id === null ? undefined : (await read($, summaries))[id]
      if (current !== undefined && Math.abs(cost.usd - current.total) >= 0.005) await updateSummary($, { total: cost.usd }, false)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      // An agent run ends: its turn stops growing when no other run it owns is still open.
      const id = e.agentId
      const owner = (await read($, openRuns))[id]
      if (owner !== undefined) {
        await update($, openRuns, old => {
          if (old[id] === undefined) return old
          const { [id]: _closed, ...rest } = old

          return rest
        })
        if (!Object.values(await read($, openRuns)).includes(owner)) await removeGrowing($, owner)
      }

      return result
    }
    const l = await read($, live)
    if (l === null || l.turnId !== e.turnId) return result
    const usage = await $.session.usage()
    const cost = liveCost(l, usage.cost?.usd ?? null, l.foreignUsd)
    const finalMain = e.usage ?? l.main
    if (usage.cost) await setLedger($, usage.cost.usd)
    if (usageTotal(addUsage(finalMain, l.agent)) === 0 && cost === 0) {
      await update($, live, () => null)

      return result
    }
    const t = await read($, tape)
    const n = (t.entries.at(-1)?.n ?? 0) + 1
    const entry = entryFrom(l, finalMain, cost, e.usage?.model ?? '', e.durationMs, e.isAborted, n, await $.clock.now())
    const prevCount = t.entries.length
    const prevMax = t.entries.reduce((m, x) => Math.max(m, x.costUsd), 0)
    const nt: Tape = { sessionId: t.sessionId, entries: [...t.entries, entry].slice(-ENTRIES_KEPT) }
    await update($, tape, () => nt)
    await update($, live, () => null)
    await saveSession($, nt)
    if (t.sessionId !== null) {
      const old = await read($, records)
      const merged = mergeRecord(old, { ...entry, sessionId: t.sessionId })
      if (!sameItems(old, merged)) {
        await update($, records, () => merged)
        await $.store.set(RECORDS_KEY, merged)
      }
    }
    if (toastOn && prevCount >= 3 && entry.costUsd > prevMax) {
      toasted.add(n)
      toastHigh($, entry)
    }
    // The agents that answered during the turn are already in its agent count; helpers still running keep it growing.
    for (const id of l.agentIds) credited.add(`${n}:${id}`)
    if (Object.values(await read($, openRuns)).includes(n)) await addGrowing($, n)
    await refreshWhere($)
    await updateSummary($, summaryPatch(nt, usage.cost?.usd ?? null))

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tape, () => ({ sessionId: null, entries: [] }))
      await update($, live, () => null)
      await update($, ledger, () => null)
      await update($, owners, () => ({}))
      await update($, growing, () => [])
      await update($, openRuns, () => ({}))
      resetAgents()
      claudeTitle = null
      pendingSource = null
      anim = createAnim(anim.tick)
    }

    return next(e)
  })

  // Each tool call flashes its name in the row. A pass-through: nothing awaited before `next`, `e` untouched.
  on('tool.call', ($, e, next) => {
    if (settings.effects.reacts) {
      flashTool(anim, e.tool)
      kick($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ticker' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') {
      await clearTape($)

      return { text: 'Cleared the ticker tape for this session. All-time records are kept.' }
    }
    if (arg === '') {
      await $.ui.open({ id: PANE, title: 'Claude-Ticker', focus: true, closeOnEscape: true })

      return { text: 'Opened the ticker table.' }
    }

    return { text: 'Usage: /ticker [clear]' }
  })

  // The ticker row: the last row of the hint slot, after the hint line and whatever other mods
  // stacked under it, with one blank line between (setting `gapAbove`). It pads nothing (the slot is indented already) and flattens what it receives
  // one level, as claudepeeker does, so an outer claudepeeker still finds the hint first.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [t, l, lg, gr] = await Promise.all([read($, tape), read($, live), read($, ledger), read($, growing)])
    const drawn = await next(e)
    // Nothing to show: no turn yet, and no spend on the ledger to report (after /ticker clear the ledger still reads).
    if (l === null && t.entries.length === 0 && (lg === null || lg <= 0)) {
      stopTimer()
      band = null
      scene = null

      return drawn
    }
    const cols = Math.min(512, (e.viewport?.columns ?? DEFAULT_COLUMNS) - HINT_INDENT)
    if (cols < MIN_COLS) {
      stopTimer()
      band = null

      return drawn
    }
    const { Box, Text } = $.ui.resolve(e)
    scene = { entries: t.entries, live: l, ledger: lg, growing: gr }
    // Still frames (the desktop, the static fallback) and a row with every effect off have no clock: they pick the focus without a hold.
    const isStill = e.surface !== 'terminal' || isStaticFallback
    syncTargets(anim, scene, settings, t.sessionId, isStill || !anyEffect() ? 0 : FOCUS_HOLD)

    let node: RenderNode
    if (isStill) {
      // The desktop, or a slot that does not take blits: the same row, still, as colored Text runs.
      stopTimer()
      band = null
      node = (
        <Text wrap="truncate-end">
          {runs(composeRow(scene, anim, settings, cols, true).cells).map(r => (
            <Text color={hex(r.fg)} backgroundColor={hex(r.bg)}>
              {r.text}
            </Text>
          ))}
        </Text>
      )
    } else {
      const { Raster } = $.ui.resolve(e)
      const composed = composeRow(scene, anim, settings, cols, false)
      band = { requestId: e.requestId, cols }
      framesSinceMount = 0
      lastBlit = null
      node = <Raster key={RASTER_KEY} columns={cols} rows={1} cells={encodeCells(composed.cells)} />
      kick($)
    }

    // The blank line above the row (setting `gapAbove`) is the row's own margin, so it exists only when the row is drawn.
    // The wrapper has no key (a keyed Box is a hover scope) and no padding: the Raster keeps its key and width.
    return (
      <Box flexDirection="column">
        {stacked(drawn)}
        {settings.gapAbove ? (
          <Box flexDirection="column" marginTop={1}>
            {node}
          </Box>
        ) : (
          <Box flexDirection="column">{node}</Box>
        )}
      </Box>
    )
  })

  // The panel: this session's table, the priciest turn, the all-time top 10 turns and the top 10 sessions.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [t, l, all, lg, now, gr, sums] = await Promise.all([
      read($, tape),
      read($, live),
      read($, records),
      read($, ledger),
      $.clock.now(),
      read($, growing),
      read($, summaries),
    ])
    const offsetMin = -new Date(now).getTimezoneOffset()
    const { entries } = t
    const costs = entries.map(x => x.costUsd)
    const ramp = rampSteps(costs)
    const { sigma, count, avg } = sessionFigures(entries, lg)
    const sum = costs.reduce((s, x) => s + x, 0)
    const outside = lg !== null && lg - sum >= 0.0005 ? lg - sum : null
    const newest = entries.map((x, i) => ({ x, prev: entries[i - 1] })).reverse()
    const liveRow = (() => {
      if (l === null) return null
      const u = addUsage(l.main, l.agent)
      const tokensIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

      return (
        '  ' +
        '●'.padStart(4) +
        '  ' +
        l.symbol.padEnd(7) +
        formatCost(l.costUsd).padStart(8) +
        ''.padStart(8) +
        formatTokens(tokensIn).padStart(7) +
        formatTokens(u.output_tokens).padStart(7) +
        `${cacheHit({ tokensIn, cacheRead: u.cache_read_input_tokens })}%`.padStart(6) +
        formatDuration(now - l.startedAt).padStart(7) +
        '  ' +
        l.prompt
      )
    })()
    const priciest = entries.reduce<(typeof entries)[number] | null>(
      (best, x) => (best === null || x.costUsd > best.costUsd ? x : best),
      null,
    )
    const where = (s: SessionSummary): string =>
      s.project === '' ? (s.branch ?? '') : s.branch === null ? s.project : `${s.project}/${s.branch}`
    const topSessionList = topSessions(sums)

    // Two leading cells line the header and the live row up with the swatch column of the session rows.
    const header =
      '  ' +
      '#'.padStart(4) +
      '  ' +
      'SYM'.padEnd(7) +
      'COST'.padStart(8) +
      'Δ'.padStart(8) +
      'IN'.padStart(7) +
      'OUT'.padStart(7) +
      'CACHE'.padStart(6) +
      'TIME'.padStart(7) +
      '  ' +
      'PROMPT'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>This session</Text>
          <Text dimColor>
            {count === 0
              ? ` · no turns yet · Σ ${formatCost(sigma)}`
              : ` · ${count} ${count === 1 ? 'turn' : 'turns'} · Σ ${formatCost(sigma)} · avg ${formatCost(avg)}`}
          </Text>
        </Box>
        {outside === null ? null : (
          <Text dimColor wrap="truncate-end">
            {`Outside listed turns: ${formatCost(outside)}  (spend no turn or helper could be tied to, and turns removed by /ticker clear)`}
          </Text>
        )}
        <Text dimColor>{header}</Text>
        {liveRow === null ? null : (
          <Text color={hex(LIVE)} wrap="truncate-end">
            {liveRow}
          </Text>
        )}
        {newest.map(({ x, prev }) => {
          const swatch = rampColor(ramp(x.costUsd))
          const delta = formatDelta(x.costUsd, prev?.costUsd)
          const deltaColor = delta === null ? DEFAULT : delta.dir === 'up' ? UP : delta.dir === 'down' ? DOWN : FLAT
          const number = String(x.n) + (gr.includes(x.n) ? '◐' : '')

          return (
            <Text wrap="truncate-end">
              <Text color={hex(swatch)}>█</Text>
              <Text>{' ' + number.padStart(4) + '  '}</Text>
              <Text>{x.symbol.padEnd(7)}</Text>
              <Text>{formatCost(x.costUsd).padStart(8)}</Text>
              <Text color={hex(deltaColor)}>{(delta?.text ?? '').padStart(8)}</Text>
              <Text>
                {formatTokens(x.tokensIn).padStart(7) +
                  formatTokens(x.tokensOut).padStart(7) +
                  `${cacheHit(x)}%`.padStart(6) +
                  formatDuration(x.durationMs).padStart(7) +
                  '  ' +
                  x.prompt}
              </Text>
            </Text>
          )
        })}
        {entries.length === 0 ? <Text dimColor>No turns yet. The tape starts with your next prompt.</Text> : null}
        {priciest === null ? null : (
          <Text wrap="truncate-end">
            <Text bold>Priciest:</Text>
            <Text>{` #${priciest.n} ${priciest.symbol} `}</Text>
            <Text>{formatCost(priciest.costUsd)}</Text>
            <Text>{` "${priciest.prompt}"`}</Text>
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>All-time top 10</Text>
          {all.length === 0 ? (
            <Text dimColor>No records yet.</Text>
          ) : (
            all.map((r, i) => {
              const s = sums[r.sessionId]
              const prompt = cutText(r.prompt, 30) + (Array.from(r.prompt).length > 30 ? '…' : '')
              const detail =
                s === undefined
                  ? null
                  : ' ' +
                    [where(s), `session ${formatCost(s.total)}`, cutText(s.title, 40)].filter(x => x !== '').join(' · ')

              return (
                <Text wrap="truncate-end">
                  {`${i + 1}`.padStart(3) +
                    '. ' +
                    r.symbol.padEnd(7) +
                    formatCost(r.costUsd).padStart(8) +
                    '  ' +
                    stamp(r.at, offsetMin) +
                    '  ' +
                    prompt}
                  {detail === null ? null : <Text dimColor>{'  │'}</Text>}
                  {detail}
                </Text>
              )
            })
          )}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>All-time top 10 sessions</Text>
          {topSessionList.length === 0 ? (
            <Text dimColor>No sessions yet.</Text>
          ) : (
            topSessionList.map((s, i) => (
              <Text wrap="truncate-end">
                {`${i + 1}`.padStart(2) +
                  '. ' +
                  formatCost(s.total).padStart(8) +
                  '  ' +
                  `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}`.padStart(10) +
                  '  ' +
                  stamp(s.startedAt, offsetMin) +
                  '  ' +
                  [where(s), cutText(s.title, 40)].filter(x => x !== '').join('  ')}
                {s.id === t.sessionId ? <Text dimColor>{' · this session'}</Text> : null}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="row" marginTop={1} columnGap={1}>
          <Button key="clear" onPress={() => clearTape($)}>
            Clear tape
          </Button>
          <Button key="close" role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
        <Text dimColor>Costs are Claude Code's own estimates, the figures /cost shows.</Text>
      </Box>
    )
  })
}
