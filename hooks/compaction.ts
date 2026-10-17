import type { EngineInterface, SessionCompacted, SessionCompactInput, SessionMessage } from 'claude-code'

import type { Mode } from '../types'
import { thresholds } from './accounting'
import type { Runtime } from './runtime'
import { message, texts } from './runtime'
import { readCompacting, updateCompacting, updateSpend } from './state'
import { short } from './texts'

/**
 * Everything this mod assumes about the micro-compaction plugin, which ships no types to depend on.
 * It answers only a typed `/compact micro`, in core's place, with the rewritten messages alone: no request
 * of its own (`usage`) and no size (`tokensAfter`). A file read it removed leaves `elided` in its result.
 * Should that plugin change any of this, here is the one place to follow it.
 */
const MICRO = {
  command: { command: 'compact', args: 'micro' },
  isAsked: (e: SessionCompactInput) => e.instructions?.trim().toLowerCase() === 'micro',
  elided: / elided by compaction: /,
  /** A "micro" that came back with a request or a size was core's summary: the plugin did not answer. */
  answeredByCore: (r: SessionCompacted) => r.usage !== undefined || r.tokensAfter !== undefined,
} as const

// From this share of the conversation in file reads on, micro is worth rewriting the whole cache.
const MICRO_SHARE = 0.4
// Rough figure for the ctx right after a micro compaction, which reports no size; the engine's next measure replaces it.
const CHARS_PER_TOKEN = 4

function chars(msgs: readonly SessionMessage[]): number {
  let n = 0
  for (const m of msgs) n += m.text.length + (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0)

  return n
}

/**
 * Share of the conversation's text held by file reads (Read) still whole: what /compact micro removes.
 * Characters against characters, so no token ratio is assumed.
 */
function readShare(msgs: readonly SessionMessage[]): number {
  const reads = new Set(msgs.flatMap(m => m.toolUses.filter(u => u.tool === 'Read').map(u => u.tool_use_id)))
  let readChars = 0
  for (const m of msgs) {
    for (const r of m.toolResults ?? []) {
      if (reads.has(r.tool_use_id) && !r.isError && !MICRO.elided.test(r.text)) readChars += r.text.length
    }
  }
  const total = chars(msgs)

  return total > 0 ? readChars / total : 0
}

/** Micro when the reads weigh on the conversation; otherwise the summary, which shrinks the conversation itself. */
function mode(share: number): Mode {
  return share >= MICRO_SHARE ? 'micro' : 'summary'
}

/**
 * Compacts the way that pays off most now. Micro goes as a typed /compact, the only trigger the plugin
 * answers. The summary goes directly, and ctx gets here the size it left, because this mod's
 * session.compact hook does not run on the call the mod makes itself.
 */
export async function compactNow($: EngineInterface, rt: Runtime) {
  if ((await readCompacting($)) !== null) return
  const t = await texts($, rt)
  try {
    const chosen = mode(readShare(await $.session.messages()))
    await updateCompacting($, () => chosen)
    if (chosen === 'micro') {
      await $.command.run(MICRO.command)
      return
    }
    const r = await $.session.compact({ instructions: t.focus })
    // Vetoed by a hook: the engine itself shows the line with the reason.
    if (r.skip !== undefined) return
    const after = r.tokensAfter ?? null
    await rt.enqueue(() => updateSpend($, a => (a ? { ...a, context: after } : a)))
  } catch (error) {
    $.ui.toast(t.compactFailed(message(error)))
  } finally {
    await updateCompacting($, () => null)
  }
}

/**
 * Only on the way up through the red threshold: after /clear or a compaction the context drops and the notice
 * applies again. Says what the button would do now.
 */
export async function warnOnRed($: EngineInterface, rt: Runtime, before: number | null, context: number | null, window: number | null) {
  const limit = thresholds(window).switch
  if (context === null || context < limit || (before !== null && before >= limit)) return
  const t = await texts($, rt)
  const share = readShare(await $.session.messages())
  const does = mode(share) === 'micro' ? t.dropsReads(Math.round(share * 100)) : t.summarizes
  $.ui.toast(t.red(short(context, t.decimal), window ? short(window, t.decimal) : null, does))
}

/**
 * After a compaction the engine only measures the context on the next response: until then, the size it left.
 * Micro does not report that size: the estimate of what left the messages stands in. Runs inside `safe`.
 */
export async function afterCompaction($: EngineInterface, rt: Runtime, e: SessionCompactInput, r: SessionCompacted) {
  const reported = r.tokensAfter
  const removed = Math.round((chars(e.messages) - chars(r.messages)) / CHARS_PER_TOKEN)
  await rt.enqueue(() =>
    updateSpend($, a => {
      if (!a) return a
      const estimated = a.context === null ? null : Math.max(0, a.context - removed)

      return { ...a, context: reported ?? estimated }
    }),
  )
  if (MICRO.isAsked(e) && MICRO.answeredByCore(r)) $.ui.toast((await texts($, rt)).microBecameSummary)
}
