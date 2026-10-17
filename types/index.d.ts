export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** micro: drops the file reads (micro-compaction plugin); summary: the native /compact. */
export type Mode = 'micro' | 'summary'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Spend = {
  session: Tokens
  /** New tokens of the day, summed over every session (the `novos:<day>:*` keys in $.store). */
  today: number
  /** Local day (YYYY-MM-DD) `today` was summed for: past it, the band shows 0 until the next count. */
  day: string
  /** This session's $.store key for the day and how much it has written there. */
  own: { key: string; n: number }
  /** New tokens per main-thread turn, the most recent ones, for the sparkline. */
  turns: number[]
  /** Whether a main-thread turn is running: only then does usage go into the last bar. */
  inTurn: boolean
  limits: Limit[]
  /** Tokens of the current context (input of the last response); null before the first one and after /clear. */
  context: number | null
  /** Compaction window (autoCompactWindow) the ctx thresholds come from; null until the first reading. */
  window: number | null
  /** Context of each running subagent (input of its last response), 0 before the first; ctx is the main thread's only. */
  agents?: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    /** `compacting`: which compaction the button is running; null outside one. */
    'cc-cost': { spend: Spend | null; compacting: Mode | null }
  }
}
