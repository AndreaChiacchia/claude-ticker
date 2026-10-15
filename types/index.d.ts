/** The four token counts a response reports. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** One finished turn of the main loop. */
export type Entry = {
  /** The turn number within the session, from 1. */
  n: number
  symbol: string
  prompt: string
  costUsd: number
  /** Input + cache read + cache write. */
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  model: string
  durationMs: number
  at: number
  /** How many distinct subagents answered during the turn. */
  agents: number
  isAborted: boolean
}

/** An all-time record: an entry and the session it came from. */
export type RecordEntry = Entry & { sessionId: string }

/** The turn that is running now. */
export type Live = {
  turnId: string
  symbol: string
  prompt: string
  startUsd: number | null
  startedAt: number
  main: Usage
  agent: Usage
  agentIds: string[]
  costUsd: number
  /** Spend read during this turn that belongs to other turns or to agents the mod could not tie to a turn. */
  foreignUsd: number
}

export type Tape = { sessionId: string | null; entries: Entry[] }

export type SessionRecord = { id: string; updatedAt: number; entries: Entry[] }

/** What the all-time lists show about a session. */
export type SessionSummary = {
  id: string
  /** The session cost ledger total. */
  total: number
  /** The turns listed on the tape. */
  turns: number
  /** The folder name of the project; empty when unknown. */
  project: string
  branch: string | null
  title: string
  /** Where the title came from: Claude Code's session title, the first prompt, or nowhere yet. */
  titleSource: 'claude' | 'prompt' | 'none'
  startedAt: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    claudeticker: {
      tape: Tape
      live: Live | null
      records: RecordEntry[]
      /** The latest session cost ledger total (what /cost shows), or null when unknown. */
      ledgerUsd: number | null
      /** Background agents: agent id to the number of the turn that launched it. */
      owners: Record<string, number>
      /** Numbers of finished turns that have an agent run in progress, by last activity (the most recent last). */
      growing: number[]
      /** Agent runs in progress (between the agent turn.start and its turn.complete): agent id to the number of the turn that owns it. */
      openRuns: Record<string, number>
      /** Session summaries for the all-time lists, by session id. */
      summaries: Record<string, SessionSummary>
    }
  }
}
