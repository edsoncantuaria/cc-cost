import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, PluginOptions, Register, SessionMessage, SessionRateLimit } from 'claude-code'

import type { Limit, Mode, Spend, Tokens } from '../types'

const spend = atom({ plugin: 'cc-cost', key: 'spend' } as const, null)
const compacting = atom({ plugin: 'cc-cost', key: 'compacting' } as const, null)
const failing = atom({ plugin: 'cc-cost', key: 'failing' } as const, null)

const BARS = 12
const DAYS_KEPT = 7
const LEVELS = '▁▂▃▄▅▆▇█'
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const EMPTY: Spend = { session: ZERO, today: 0, day: '', own: { key: '', n: 0 }, turns: [], inTurn: false, limits: [], context: null, window: null, modelWindow: null, agents: {} }

// Headroom to the compaction window: red leaves ~30k to compact before autocompact.
const WARN_HEADROOM = 60_000
const SWITCH_HEADROOM = 30_000
// Window used for the thresholds until the engine's first reading: the default of 200k models.
const DEFAULT_WINDOW = 200_000
// Daily counters live under `novos:<day>:<sessionId>`; the prefix predates the English code and stays so stored totals survive.
const DAY_PREFIX = 'novos:'
// Keys the mod no longer uses: the old version's and the recap of the old "new session" button.
const STALE_KEYS = ['dia:', 'tokens:', 'ultimoRecap']

// From this share of the conversation in file reads on, micro is worth rewriting the whole cache.
const MICRO_SHARE = 0.4
// Rough figure for the ctx right after a micro compaction, which reports no size; the engine's next measure replaces it.
const CHARS_PER_TOKEN = 4
// The marker micro-compaction leaves in place of a file: what was already removed does not count again.
const ELIDED = / elided by compaction: /

type Language = 'en' | 'pt-BR' | 'es'
type Texts = {
  decimal: string
  today: string
  labels: Record<string, string>
  agent: string
  agents: (n: number) => string
  modes: Record<Mode, string>
  compacting: (mode: Mode) => string
  focus: string
  compactFailed: (error: string) => string
  red: (context: string, window: string | null, does: string) => string
  dropsReads: (percent: number) => string
  summarizes: string
  microBecameSummary: string
  failed: (error: string) => string
  stale: string
}

const TEXTS: Record<Language, Texts> = {
  en: {
    decimal: '.',
    today: 'today',
    labels: { five_hour: '5h', seven_day: '7d', spend_limit: 'limit' },
    agent: 'agent',
    agents: n => `${n} agents, largest`,
    modes: { micro: 'micro', summary: 'summary' },
    compacting: m => `compacting (${TEXTS.en.modes[m]})…`,
    focus:
      'Prioritize what is needed to continue the work: goal, changed files (with paths), ' +
      'decisions and why, current state (tests, what is broken), next steps and open items.',
    compactFailed: error => `Could not compact (${error}); the session stays as it is.`,
    red: (ctx, window, does) => `Context at ${ctx}${window ? ` of ${window}` : ''}: "compact" in the band (c) ${does}, before autocompact.`,
    dropsReads: pct => `removes the file reads, ~${pct}% of the conversation (micro)`,
    summarizes: 'summarizes the conversation',
    microBecameSummary: '/compact micro became a summary: the micro-compaction plugin is not active.',
    failed: error => `cc-cost: counting failed (${error}); the session goes on, the band may lag.`,
    stale: 'stale',
  },
  'pt-BR': {
    decimal: ',',
    today: 'hoje',
    labels: { five_hour: '5h', seven_day: '7d', spend_limit: 'limite' },
    agent: 'agente',
    agents: n => `${n} agentes, maior`,
    modes: { micro: 'micro', summary: 'resumo' },
    compacting: m => `compactando (${TEXTS['pt-BR'].modes[m]})…`,
    focus:
      'Priorize o que é preciso para continuar o trabalho: objetivo, arquivos alterados (com caminho), ' +
      'decisões e o porquê, estado atual (testes, o que está quebrado), próximos passos e pendências em aberto.',
    compactFailed: error => `Não consegui compactar (${error}); a sessão continua como está.`,
    red: (ctx, window, does) => `Contexto em ${ctx}${window ? ` de ${window}` : ''}: "compact" na faixa (c) ${does}, antes do autocompact.`,
    dropsReads: pct => `tira as leituras de arquivo, ~${pct}% da conversa (micro)`,
    summarizes: 'resume a conversa',
    microBecameSummary: 'O /compact micro virou resumo: o plugin micro-compaction não está ativo.',
    failed: error => `cc-cost: a contagem falhou (${error}); a sessão segue, a faixa pode atrasar.`,
    stale: 'desatualizada',
  },
  es: {
    decimal: ',',
    today: 'hoy',
    labels: { five_hour: '5h', seven_day: '7d', spend_limit: 'límite' },
    agent: 'agente',
    agents: n => `${n} agentes, mayor`,
    modes: { micro: 'micro', summary: 'resumen' },
    compacting: m => `compactando (${TEXTS.es.modes[m]})…`,
    focus:
      'Prioriza lo necesario para seguir el trabajo: objetivo, archivos modificados (con ruta), ' +
      'decisiones y el porqué, estado actual (tests, lo que está roto), próximos pasos y pendientes.',
    compactFailed: error => `No pude compactar (${error}); la sesión sigue como está.`,
    red: (ctx, window, does) => `Contexto en ${ctx}${window ? ` de ${window}` : ''}: "compact" en la franja (c) ${does}, antes del autocompact.`,
    dropsReads: pct => `quita las lecturas de archivo, ~${pct}% de la conversación (micro)`,
    summarizes: 'resume la conversación',
    microBecameSummary: 'El /compact micro se volvió resumen: el plugin micro-compaction no está activo.',
    failed: error => `cc-cost: el conteo falló (${error}); la sesión sigue, la franja puede atrasarse.`,
    stale: 'desactualizada',
  },
}

/** `pt_BR.UTF-8` → pt-BR, `es_AR` → es; anything else, English. */
function languageOfLocale(locale: string | undefined): Language {
  if (locale === undefined) return 'en'
  if (/^pt/i.test(locale)) return 'pt-BR'
  if (/^es/i.test(locale)) return 'es'

  return 'en'
}

/** The mod's `language` option; on `auto`, the system locale, as the rest of the terminal. */
async function resolveTexts($: EngineInterface, option: PluginOptions[string] | undefined): Promise<Texts> {
  if (option === 'en' || option === 'pt-BR' || option === 'es') return TEXTS[option]
  try {
    const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))

    return TEXTS[languageOfLocale(locale)]
  } catch {
    return TEXTS.en
  }
}

/** Local date YYYY-MM-DD; alphabetical order is chronological order. */
function day(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Cache reads stay out: it is the same context resent on every request, and adding it counts the conversation many times. */
function fresh(t: Tokens): number {
  return t.input + t.cacheWrite + t.output
}

/** 950 · 12.4k · 312k · 1.2M — one decimal place only below 10; the separator is the language's. */
function short(n: number, decimal: string): string {
  const [value, suffix] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  const places = suffix && value < 10 ? 1 : 0

  return value.toFixed(places).replace('.', decimal) + suffix
}

function sparkline(values: number[]): string {
  const largest = Math.max(1, ...values)

  return values.map(v => LEVELS[Math.min(LEVELS.length - 1, Math.floor((v / largest) * LEVELS.length))]).join('')
}

function color(pct: number): string {
  if (pct >= 85) return 'red'
  if (pct >= 60) return 'yellow'

  return 'green'
}

function thresholds(window: number | null): { warn: number; switch: number } {
  const total = window ?? DEFAULT_WINDOW

  return { warn: total - WARN_HEADROOM, switch: total - SWITCH_HEADROOM }
}

function contextColor(tokens: number, window: number | null): string {
  const t = thresholds(window)
  if (tokens >= t.switch) return 'red'
  if (tokens >= t.warn) return 'yellow'

  return 'green'
}

/** The compaction window (autoCompactWindow), not the model's; the `summary` breakdown is estimated locally, with no request. */
async function compactionWindow($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: 'summary' })

  return context.breakdown?.rawMaxTokens ?? context.window
}

/** Updates the list of running subagents; `null` drops the agent. Runs inside the queue. */
function setAgent($: EngineInterface, id: string, change: (current: number | undefined) => number | null | undefined) {
  return update($, spend, a => {
    const s = a ?? EMPTY
    const agents = { ...s.agents }
    const next = change(agents[id])
    if (next === undefined) return s
    if (next === null) delete agents[id]
    else agents[id] = next

    return { ...s, agents }
  })
}

function limits(windows: readonly SessionRateLimit[]): Limit[] {
  return windows.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))
}

/**
 * Each session writes only its own key `novos:<day>:<sessionId>`: two open sessions
 * do not erase each other's sum, and resuming the same session picks up where it stopped.
 */
async function daySum($: EngineInterface, today: string, own: Spend['own']): Promise<number> {
  const prefix = `${DAY_PREFIX}${today}:`
  let sum = own.key.startsWith(prefix) ? own.n : 0
  for (const key of await $.store.keys()) {
    if (key.startsWith(prefix) && key !== own.key) sum += Number((await $.store.get(key)) ?? 0)
  }

  return sum
}

async function prune($: EngineInterface, now: number) {
  const cutoff = `${DAY_PREFIX}${day(now - DAYS_KEPT * 86_400_000)}`
  for (const key of await $.store.keys()) {
    const old = key.startsWith(DAY_PREFIX) ? key < cutoff : STALE_KEYS.some(p => key.startsWith(p))
    if (old) await $.store.delete(key)
  }
}

// Writes go one at a time: reading the store, adding and writing must not interleave
// between parallel steps (subagents), or one sum erases the other.
let queue: Promise<unknown> = Promise.resolve()
function enqueue(task: () => Promise<unknown>): Promise<void> {
  const turn = queue.then(task).then(() => undefined)
  queue = turn.catch(() => undefined)

  return turn
}

/** A subagent stays out of the session and the bars (which are the main thread's), but goes into `today`. Runs inside the queue. */
async function add($: EngineInterface, usage: ModelUsage, main: boolean) {
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
  const current = (await read($, spend)) ?? EMPTY
  const sameKey = current.own.key === key
  const before = sameKey ? current.own.n : Number((await $.store.get(key)) ?? 0)
  const own = { key, n: before + n }
  await $.store.set(key, own.n)
  // On the same key `today` already holds the other sessions: adding the step is enough. The other sessions
  // come in again on session.measure; scanning the store on every request only when the day or the session changed.
  const todayTotal = sameKey ? current.today + n : await daySum($, today, own)

  await update($, spend, a => {
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
      if (reads.has(r.tool_use_id) && !r.isError && !ELIDED.test(r.text)) readChars += r.text.length
    }
  }
  const total = chars(msgs)

  return total > 0 ? readChars / total : 0
}

/** Micro when the reads weigh on the conversation; otherwise the summary, which shrinks the conversation itself. */
function mode(share: number): Mode {
  return share >= MICRO_SHARE ? 'micro' : 'summary'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// State of the current load; register resets it on every load.
let languageOption: PluginOptions[string] | undefined
let texts: Promise<Texts> | null = null
let warned = false
// Hooks whose last run failed, mirrored in the `failing` atom only when the set changes.
let broken = new Set<string>()

function language($: EngineInterface): Promise<Texts> {
  return (texts ??= resolveTexts($, languageOption))
}

/** Mirrors `broken` in the band's state; a state that fails too leaves only the toast. */
async function markBroken($: EngineInterface, hook: string, failed: boolean) {
  if (broken.has(hook) === failed) return
  broken = new Set(broken)
  if (failed) broken.add(hook)
  else broken.delete(hook)
  const now = broken.size > 0 ? [...broken] : null
  try {
    await update($, failing, () => now)
  } catch {
    // The toast already went out (or will): the band just misses the marker.
  }
}

/**
 * The mod only observes: a failure of its own never takes down the turn or the session. The toast
 * goes out once per load; the band stays marked while `hook` keeps failing and clears on its next success.
 */
async function safe($: EngineInterface, hook: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
    await markBroken($, hook, false)
  } catch (error) {
    await markBroken($, hook, true)
    if (warned) return
    warned = true
    try {
      $.ui.toast((await language($)).failed(message(error)))
    } catch {
      // Not even the notice went out: there is no one left to tell.
    }
  }
}

/**
 * Compacts the way that pays off most now. Micro (micro-compaction plugin) goes as a typed /compact,
 * the only trigger the plugin answers. The summary goes directly, and ctx gets here the size it left,
 * because this mod's session.compact hook does not run on the call the mod makes itself.
 */
async function compactNow($: EngineInterface, t: Texts) {
  if ((await read($, compacting)) !== null) return
  try {
    const chosen = mode(readShare(await $.session.messages()))
    await update($, compacting, () => chosen)
    if (chosen === 'micro') {
      await $.command.run({ command: 'compact', args: 'micro' })
      return
    }
    const r = await $.session.compact({ instructions: t.focus })
    // Vetoed by a hook: the engine itself shows the line with the reason.
    if (r.skip !== undefined) return
    const after = r.tokensAfter ?? null
    await enqueue(() => update($, spend, a => (a ? { ...a, context: after } : a)))
  } catch (error) {
    $.ui.toast(t.compactFailed(message(error)))
  } finally {
    await update($, compacting, () => null)
  }
}

export const register: Register = (on, options) => {
  // A new load (mod reload, another option) resolves the language and the failure notice again.
  languageOption = options.language
  texts = null
  warned = false
  broken = new Set()

  on('session.start', async ($, e, next) => {
    await safe($, 'session.start', () =>
      enqueue(async () => {
        const now = await $.clock.now()
        await prune($, now)
        const current = (await read($, spend)) ?? EMPTY
        const today = day(now)
        const todayTotal = await daySum($, today, current.own)
        const { rateLimits, context } = await $.session.usage()
        const window = await compactionWindow($)
        await update($, spend, a => ({
          ...(a ?? EMPTY),
          today: todayTotal,
          day: today,
          limits: rateLimits.length > 0 ? limits(rateLimits) : (a?.limits ?? []),
          context: context.tokens ?? a?.context ?? null,
          window,
          modelWindow: context.window,
          // On a mod reload the old list may hold an agent already done; those still running come back on their next step.
          agents: {},
        }))
      }),
    )

    return next(e)
  })

  // Only the main thread opens a turn: each turn is a bar. A subagent goes into the list of running ones.
  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    await safe($, 'turn.start', () =>
      enqueue(() =>
        id !== undefined
          ? setAgent($, id, current => current ?? 0)
          : update($, spend, a => {
              const s = a ?? EMPTY

              return { ...s, turns: [...s.turns, 0].slice(-BARS), inTurn: true }
            }),
      ),
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    await safe($, 'turn.complete', () =>
      enqueue(() =>
        id === undefined
          ? update($, spend, a => (a ? { ...a, inTurn: false } : a))
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
    await safe($, 'turn.step', () =>
      // Inside the queue: a subagent's turn.start that came before this step is already in the list.
      enqueue(async () => {
        if (id === undefined || (await read($, spend))?.agents?.[id] === undefined) return add($, usage, true)
        await add($, usage, false)
        const occupied = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        await setAgent($, id, () => occupied)
      }),
    )

    return response
  })

  on('session.measure', async ($, e, next) => {
    await safe($, 'session.measure', () =>
      enqueue(async () => {
        const current = (await read($, spend)) ?? EMPTY
        const today = day(await $.clock.now())
        const todayTotal = await daySum($, today, current.own)
        const context = e.context.tokens ?? current.context
        // /model (or a new autoCompactWindow) moves the model's window: the compaction window comes along, measured again.
        const window = e.context.window !== current.modelWindow ? await compactionWindow($) : current.window
        await update($, spend, a => ({
          ...(a ?? EMPTY),
          today: todayTotal,
          day: today,
          limits: e.rateLimits.length > 0 ? limits(e.rateLimits) : (a?.limits ?? []),
          context: e.context.tokens ?? a?.context ?? null,
          window,
          modelWindow: e.context.window,
        }))

        // Only on the way up through the threshold: after /clear or a compaction the context drops and the notice applies again.
        const limit = thresholds(window).switch
        if (context !== null && context >= limit && (current.context === null || current.context < limit)) {
          const t = await language($)
          const share = readShare(await $.session.messages())
          const does = mode(share) === 'micro' ? t.dropsReads(Math.round(share * 100)) : t.summarizes
          $.ui.toast(t.red(short(context, t.decimal), window ? short(window, t.decimal) : null, does))
        }
      }),
    )

    return next(e)
  })

  // After a compaction the engine only measures the context on the next response: until then, the size it left.
  // Micro does not report that size: the estimate of what left the messages stands in.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && r.messages) {
      const afterIt = r.messages
      await safe($, 'session.compact', async () => {
        const reported = r.tokensAfter
        const removed = Math.round((chars(e.messages) - chars(afterIt)) / CHARS_PER_TOKEN)
        await enqueue(() =>
          update($, spend, a => {
            if (!a) return a
            const estimated = a.context === null ? null : Math.max(0, a.context - removed)

            return { ...a, context: reported ?? estimated }
          }),
        )
        // micro-compaction answers in core's place with the rewritten messages alone: no request of its own
        // (`usage`) and no size (`tokensAfter`). Either one on a "micro" means core summarized instead.
        const coreSummarized = r.usage !== undefined || reported !== undefined
        if (e.instructions?.trim().toLowerCase() === 'micro' && coreSummarized) {
          $.ui.toast((await language($)).microBecameSummary)
        }
      })
    }

    return r
  })
    // Should the hook fail anyway, the compaction goes on as the engine did it.
    .catch(($, e, next) => next(e))

  // /clear goes on in the same process with another id and no session.start: only the session resets.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await safe($, 'session.end', () =>
        enqueue(() =>
          update($, spend, a => (a ? { ...a, session: ZERO, turns: [], inTurn: false, context: null, agents: {} } : a)),
        ),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let s: Spend | null
    let t: Texts
    let now: number
    let running: Mode | null
    let stale: boolean
    try {
      s = await read($, spend)
      t = await language($)
      now = await $.clock.now()
      running = await read($, compacting)
      stale = (await read($, failing)) !== null
    } catch {
      // Without the data the band has nothing to show: the chain goes on without it.
      return next(e)
    }
    if (e.props.hasSurvey || s === null) return next(e)

    const ss = s.session
    const inputTotal = ss.input + ss.cacheRead + ss.cacheWrite
    if (inputTotal + ss.output === 0 && s.today === 0 && s.limits.length === 0 && s.context === null && !stale) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const k = (n: number) => short(n, t.decimal)
    const busy = e.props.isWorking || running !== null
    const cache = inputTotal > 0 ? Math.round((ss.cacheRead / inputTotal) * 100) : 0
    // Past midnight with no count yet: yesterday's total is not today's.
    const today = s.day === day(now) ? s.today : 0
    const dot = <Text dimColor>  ·  </Text>
    // Before its first response a subagent has no measured context yet.
    const agents = Object.values(s.agents ?? {}).filter(n => n > 0)
    const largest = Math.max(0, ...agents)
    const limit = thresholds(s.window)

    const band = (
      <Box paddingX={1} flexDirection="row">
        <Text wrap="truncate-end">
          {stale && <Text color="yellow">{`⚠ ${t.stale}  `}</Text>}
          {s.turns.length > 0 && <Text color="cyan">{sparkline(s.turns)}  </Text>}
          <Text bold>{k(fresh(ss))}</Text>
          <Text dimColor> tokens</Text>
          {dot}
          <Text dimColor>↑ </Text>
          <Text>{k(ss.input + ss.cacheWrite)}</Text>
          <Text dimColor>  ↓ </Text>
          <Text>{k(ss.output)}</Text>
          {dot}
          <Text dimColor>cache </Text>
          <Text>{cache}%</Text>
          {dot}
          <Text dimColor>{`${t.today} `}</Text>
          <Text bold>{k(today)}</Text>
          {s.limits.map(l => {
            // The window already rolled over and no new response brought the value: do not show the old one.
            const pct = l.resetsAt && Date.parse(l.resetsAt) <= now ? 0 : l.percentUsed

            return (
              <Text key={l.kind}>
                {dot}
                <Text dimColor>{t.labels[l.kind] ?? l.kind} </Text>
                <Text color={color(pct)}>{Math.round(pct)}%</Text>
              </Text>
            )
          })}
        </Text>
        {/* Outside the truncating text: on a narrow terminal the context is the last to go. */}
        {s.context !== null && (
          <Text>
            {dot}
            <Text dimColor>ctx </Text>
            <Text color={contextColor(s.context, s.window)}>{k(s.context)}</Text>
            {s.window !== null && <Text dimColor>/{k(s.window)}</Text>}
          </Text>
        )}
        {agents.length > 0 && (
          <Text>
            {dot}
            <Text dimColor>{`${agents.length === 1 ? t.agent : t.agents(agents.length)} `}</Text>
            <Text color={contextColor(largest, s.window)}>{k(largest)}</Text>
          </Text>
        )}
        <Text>  </Text>
        {busy ? (
          e.props.isWorking || running === null ? null : <Text dimColor>{t.compacting(running)}</Text>
        ) : (
          <Button
            key="compact"
            label="compact"
            hotkey="c"
            variant={s.context !== null && s.context >= limit.switch ? 'primary' : undefined}
            dimColor={s.context === null || s.context < limit.warn}
            onPress={() => safe($, 'compact', () => compactNow($, t))}
          />
        )}
      </Box>
    )
    // Composes with whoever comes next in the chain: another mod's notice or controls must not vanish.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
