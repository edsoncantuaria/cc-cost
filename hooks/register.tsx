import type { Register } from 'claude-code'

import { add, BARS, compactionWindow, day, daySum, limits, prune, setAgent } from './accounting'
import { drawBand } from './band'
import { afterCompaction, warnOnRed } from './compaction'
import { runtime, safe } from './runtime'
import { EMPTY, readSpend, updateSpend, ZERO } from './state'
import { chooseLanguage } from './texts'

export const register: Register = (on, options) => {
  // A new load (mod reload, another option) starts its own write order; the data stays in $.state.
  const rt = runtime(options.language)

  on('session.start', async ($, e, next) => {
    await safe($, rt, 'session.start', () =>
      rt.enqueue(async () => {
        await chooseLanguage($, options.language)
        const now = await $.clock.now()
        await prune($, now)
        const current = (await readSpend($)) ?? EMPTY
        const today = day(now)
        const todayTotal = await daySum($, today, current.own)
        const { rateLimits, context } = await $.session.usage()
        const window = await compactionWindow($)
        await updateSpend($, a => ({
          ...(a ?? EMPTY),
          today: todayTotal,
          day: today,
          limits: rateLimits.length > 0 ? limits(rateLimits) : (a?.limits ?? []),
          context: context.tokens ?? a?.context ?? null,
          window,
          modelWindow: context.window,
          // On a mod reload the old list may hold an agent already done; those still running come back on their
          // next step, recognized by $.agent.list().
          agents: {},
        }))
      }),
    )

    return next(e)
  })

  // Only the main thread opens a turn: each turn is a bar. A subagent goes into the list of running ones.
  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    await safe($, rt, 'turn.start', () =>
      rt.enqueue(() =>
        id !== undefined
          ? setAgent($, id, current => current ?? 0)
          : updateSpend($, a => {
              const s = a ?? EMPTY

              return { ...s, turns: [...s.turns, 0].slice(-BARS), inTurn: true }
            }),
      ),
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    await safe($, rt, 'turn.complete', () =>
      rt.enqueue(() =>
        id === undefined
          ? updateSpend($, a => (a ? { ...a, inTurn: false } : a))
          : setAgent($, id, () => null),
      ),
    )

    return next(e)
  })

  // Each request to the model: main thread, subagent or an engine process (compaction).
  // Compaction comes with an agentId but no turn.start: it stays out of the list and counts as the main thread's.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage
    if (!usage) return response
    const id = e.agentId
    await safe($, rt, 'turn.step', () =>
      // Inside the queue: a subagent's turn.start that came before this step is already in the list.
      rt.enqueue(async () => {
        if (id === undefined) return add($, usage, true)
        // Out of the list: an engine fork (compaction), which $.agent.list() does not name, or a subagent
        // whose turn.start came before a mod reload, which it does and goes back into the list.
        const known = (await readSpend($))?.agents?.[id] !== undefined
        if (!known && !(await $.agent.list()).some(a => a.id === id)) return add($, usage, true)
        await add($, usage, false)
        const occupied = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        await setAgent($, id, () => occupied)
      }),
    )

    return response
  })

  on('session.measure', async ($, e, next) => {
    await safe($, rt, 'session.measure', () =>
      rt.enqueue(async () => {
        const current = (await readSpend($)) ?? EMPTY
        const today = day(await $.clock.now())
        const todayTotal = await daySum($, today, current.own)
        const context = e.context.tokens ?? current.context
        // /model (or a new autoCompactWindow) moves the model's window: the compaction window comes along, measured again.
        const window = e.context.window !== current.modelWindow ? await compactionWindow($) : current.window
        await updateSpend($, a => ({
          ...(a ?? EMPTY),
          today: todayTotal,
          day: today,
          limits: e.rateLimits.length > 0 ? limits(e.rateLimits) : (a?.limits ?? []),
          context: e.context.tokens ?? a?.context ?? null,
          window,
          modelWindow: e.context.window,
        }))
        await warnOnRed($, rt, current.context, context, window)
      }),
    )

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && r.messages) {
      await safe($, rt, 'session.compact', () => afterCompaction($, rt, e, r))
    }

    return r
  })
    // Should the hook fail anyway, the compaction goes on as the engine did it.
    .catch(($, e, next) => next(e))

  // /clear goes on in the same process with another id and no session.start: only the session resets.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await safe($, rt, 'session.end', () =>
        rt.enqueue(() =>
          updateSpend($, a => (a ? { ...a, session: ZERO, turns: [], inTurn: false, context: null, agents: {} } : a)),
        ),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await drawBand($, e, rt)
    if (band === null) return next(e)
    // Composes with whoever comes next in the chain: another mod's notice or controls must not vanish.
    const below = await next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
