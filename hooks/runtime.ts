import type { EngineInterface, PluginOptions } from 'claude-code'

import { readFailing, readWarned, updateFailing, updateWarned } from './state'
import type { Texts } from './texts'
import { textsOf } from './texts'

export type Runtime = {
  /** Runs `task` after every task enqueued before it. */
  enqueue: (task: () => Promise<unknown>) => Promise<void>
  /** The mod's `language` option of this load. */
  language: PluginOptions[string] | undefined
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Updates the hooks whose last run failed; a state that fails too leaves only the toast. */
async function markFailing($: EngineInterface, hook: string, failed: boolean) {
  try {
    if (((await readFailing($)) ?? []).includes(hook) === failed) return
    await updateFailing($, list => {
      const rest = (list ?? []).filter(h => h !== hook)
      const next = failed ? [...rest, hook] : rest

      return next.length > 0 ? next : null
    })
  } catch {
    // The toast already went out (or will): the band just misses the marker.
  }
}

/**
 * One per load of the module, built by `register`: the session's data lives in $.state, so the only thing
 * kept here is the order of the writes. Reading the store, adding and writing must not interleave between
 * parallel steps (subagents), or one sum erases the other; and a subagent's turn.start must land before its step.
 */
export function runtime(language: PluginOptions[string] | undefined): Runtime {
  let queue: Promise<unknown> = Promise.resolve()

  return {
    language,
    enqueue(task) {
      const turn = queue.then(task).then(() => undefined)
      queue = turn.catch(() => undefined)

      return turn
    },
  }
}

export function texts($: EngineInterface, rt: Runtime): Promise<Texts> {
  return textsOf($, rt.language)
}

/**
 * The mod only observes: a failure of its own never takes down the turn or the session. The toast goes out
 * once per session; the band stays marked while `hook` keeps failing and clears on its next success.
 */
export async function safe($: EngineInterface, rt: Runtime, hook: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
    await markFailing($, hook, false)
  } catch (error) {
    await markFailing($, hook, true)
    try {
      if (await readWarned($)) return
      await updateWarned($, () => true)
      $.ui.toast((await texts($, rt)).failed(message(error)))
    } catch {
      // Not even the notice went out: there is no one left to tell.
    }
  }
}
