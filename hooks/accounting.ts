import type { EngineInterface, ModelUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Spend, Tokens } from '../types'
import { EMPTY, readSpend, updateSpend } from './state'

export const BARS = 12
const DAYS_KEPT = 7

// Headroom to the compaction window: red leaves ~30k to compact before autocompact.
const WARN_HEADROOM = 60_000
const SWITCH_HEADROOM = 30_000
// Window used for the thresholds until the engine's first reading: the default of 200k models.
const DEFAULT_WINDOW = 200_000
// Daily counters live under `novos:<day>:<sessionId>`; the prefix predates the English code and stays so stored totals survive.
const DAY_PREFIX = 'novos:'
// Keys the mod no longer uses: the old version's and the recap of the old "new session" button.
const STALE_KEYS = ['dia:', 'tokens:', 'ultimoRecap']

/** Local date YYYY-MM-DD; alphabetical order is chronological order. */
export function day(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Cache reads stay out: it is the same context resent on every request, and adding it counts the conversation many times. */
export function fresh(t: Tokens): number {
  return t.input + t.cacheWrite + t.output
}

export function thresholds(window: number | null): { warn: number; switch: number } {
  const total = window ?? DEFAULT_WINDOW

  return { warn: total - WARN_HEADROOM, switch: total - SWITCH_HEADROOM }
}

/** The compaction window (autoCompactWindow), not the model's; the `summary` breakdown is estimated locally, with no request. */
export async function compactionWindow($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: 'summary' })

  return context.breakdown?.rawMaxTokens ?? context.window
}

/** Updates the list of running subagents; `null` drops the agent. Runs inside the queue. */
export function setAgent($: EngineInterface, id: string, change: (current: number | undefined) => number | null | undefined) {
  return updateSpend($, a => {
    const s = a ?? EMPTY
    const agents = { ...s.agents }
    const next = change(agents[id])
    if (next === undefined) return s
    if (next === null) delete agents[id]
    else agents[id] = next

    return { ...s, agents }
  })
}

export function limits(windows: readonly SessionRateLimit[]): Limit[] {
  return windows.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))
}

/**
 * Each session writes only its own key `novos:<day>:<sessionId>`: two open sessions
 * do not erase each other's sum, and resuming the same session picks up where it stopped.
 */
export async function daySum($: EngineInterface, today: string, own: Spend['own']): Promise<number> {
  const prefix = `${DAY_PREFIX}${today}:`
  let sum = own.key.startsWith(prefix) ? own.n : 0
  for (const key of await $.store.keys()) {
    if (key.startsWith(prefix) && key !== own.key) sum += Number((await $.store.get(key)) ?? 0)
  }

  return sum
}

export async function prune($: EngineInterface, now: number) {
  const cutoff = `${DAY_PREFIX}${day(now - DAYS_KEPT * 86_400_000)}`
  for (const key of await $.store.keys()) {
    const old = key.startsWith(DAY_PREFIX) ? key < cutoff : STALE_KEYS.some(p => key.startsWith(p))
    if (old) await $.store.delete(key)
  }
}

/** A subagent stays out of the session and the bars (which are the main thread's), but goes into `today`. Runs inside the queue. */
export async function add($: EngineInterface, usage: ModelUsage, main: boolean) {
  const t: Tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  const n = fresh(t)
  if (n === 0 && t.cacheRead === 0) return

  const today = day(await $.clock.now())
  const key = `${DAY_PREFIX}${today}:${await $.session.id()}`
  const current = (await readSpend($)) ?? EMPTY
  const sameKey = current.own.key === key
  const before = sameKey ? current.own.n : Number((await $.store.get(key)) ?? 0)
  const own = { key, n: before + n }
  await $.store.set(key, own.n)
  // On the same key `today` already holds the other sessions: adding the step is enough. The other sessions
  // come in again on session.measure; scanning the store on every request only when the day or the session changed.
  const todayTotal = sameKey ? current.today + n : await daySum($, today, own)

  await updateSpend($, a => {
    const s = a ?? EMPTY
    if (!main) return { ...s, today: todayTotal, day: today, own }
    // Compaction and work outside a turn go into the total only.
    const turns = s.inTurn && s.turns.length > 0
      ? [...s.turns.slice(0, -1), (s.turns.at(-1) ?? 0) + n]
      : s.turns

    return {
      ...s,
      session: {
        input: s.session.input + t.input,
        output: s.session.output + t.output,
        cacheRead: s.session.cacheRead + t.cacheRead,
        cacheWrite: s.session.cacheWrite + t.cacheWrite,
      },
      today: todayTotal,
      day: today,
      own,
      turns,
    }
  })
}
