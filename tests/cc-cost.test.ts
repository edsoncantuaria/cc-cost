import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement, SessionRateLimit } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// October 5, 2026, local noon.
const NOW = new Date(2026, 9, 5, 12).getTime()
const TODAY = '2026-10-05'

const USAGES: Record<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = {
  a: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 },
  b: { input_tokens: 200_000, output_tokens: 40_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 },
  // The compaction summary: rereads the whole conversation from cache and writes the summary.
  compaction: { input_tokens: 0, output_tokens: 5000, cache_read_input_tokens: 168_000, cache_creation_input_tokens: 0 },
}

type World = { sessionId: string; store: Map<string, unknown>; messages: unknown[]; clock: MockClock; window?: number; brokenStore?: boolean }

function setup(
  on: On,
  opts: {
    store?: Record<string, unknown>
    rateLimits?: SessionRateLimit[]
    window?: number
    messages?: unknown[]
    below?: string
    env?: Record<string, string>
    brokenStore?: boolean
  } = {},
): World {
  const clock = mock.clock(on, { now: NOW })
  const world: World = {
    sessionId: 'session-a',
    store: new Map(Object.entries(opts.store ?? {})),
    messages: opts.messages ?? [],
    clock,
    window: opts.window,
    brokenStore: opts.brokenStore,
  }
  // The language comes from the locale: the tests read the band in Portuguese, unless one asks for another.
  mock.env(on, opts.env ?? { LANG: 'pt_BR.UTF-8' })
  // In-memory store in the test's view, to check what each session wrote.
  on('store.get', (_$, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$, e) => {
    if (world.brokenStore) throw new Error('disk full')
    world.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_$, e) => (world.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...world.store.keys()] }))
  // What comes after the mod in the AbovePrompt chain: empty, or another mod's text.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    if (opts.below === undefined) return h(Fragment, null) as never
    const { Text } = $.ui.resolve(e)

    return h(Text, null, opts.below) as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.sessionId }))
  on('session.messages', () => ({ value: world.messages as never }))
  // Without `window` no breakdown comes and the model's window (200k) applies.
  on('session.usage', (_$, e) => {
    const breakdown = e.breakdown && world.window ? { breakdown: { rawMaxTokens: world.window } as never } : {}

    return { value: { startedAt: NOW, context: { window: 200000, ...breakdown }, rateLimits: opts.rateLimits ?? [] } }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...USAGES[e.model]!, model: e.model },
    }
  })

  return world
}

/** The step's "model" picks which entry of USAGES the fake response returns. */
async function step($: Engine, turnId: string, model: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // only drains
  }
}

async function turn($: Engine, turnId: string, ...models: string[]) {
  await $.turn.start({ text: '', turnId })
  for (const m of models) await step($, turnId, m)
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
  const text = (await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? ''
  await ui.unmount()

  return text
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('counts only new tokens: cache reads become a percentage', async ($, on) => {
  setup(on)
  await start($)
  await turn($, 't1', 'a')
  await turn($, 't2', 'b')
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 62 }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const text = await band($, surface)
    // New: 2,500 + 240,000; the 1,008,000 read from cache stays out.
    expect(text).toMatch(/243k tokens/)
    expect(text).toMatch(/↑ 202k {2}↓ 41k/)
    expect(text).toMatch(/cache 83%/)
    expect(text).toMatch(/hoje 243k/)
    expect(text).toMatch(/5h 62%/)
  }
})

test('compaction adds only the summary and leaves the bars alone', async ($, on) => {
  setup(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  await step($, 't1', 'a')
  await step($, 't1', 'a')
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await turn($, 't2', 'b')
  // /compact between turns: the engine's fork has an agentId but opens no turn.
  await step($, 'fork', 'compaction', 'fork-compaction')

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  // Two bars: t1 (2 × 2,500) and t2 (240,000, the largest).
  expect(await ui.find({ type: 'Text', text: '▁█  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  await ui.unmount()
  // 5,000 + 240,000 + 5,000 of the summary; the 168k reread from cache stay out.
  expect(await band($)).toMatch(/250k tokens/)
})

test('a subagent shows its own context and stays out of the rest of the band', async ($, on) => {
  setup(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  await step($, 't1', 'a')
  await context($, 97_000)
  await $.turn.start({ text: 'task', turnId: 'sub1', agentId: 'agent-1' })

  // Before its first response the subagent does not show yet.
  let ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  await ui.unmount()

  await step($, 'sub1', 'a', 'agent-1')
  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  // Input of the subagent's last response: 1,000 + 8,000 + 1,000.
  expect(await ui.find({ type: 'Text', text: 'agente ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^10k$/ }))?.props.color).toBe('green')
  // ctx stays the main thread's.
  expect(await ui.find({ type: 'Text', text: /^97k$/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: 'another', turnId: 'sub2', agentId: 'agent-2' })
  await step($, 'sub2', 'b', 'agent-2')
  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '2 agentes, maior ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^1,2M$/ }))?.props.color).toBe('red')
  await ui.unmount()

  for (const [turnId, agentId] of [['sub1', 'agent-1'], ['sub2', 'agent-2']] as const) {
    await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId })
  }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  // A single bar: subagents open no turn.
  expect(await ui.find({ type: 'Text', text: '█  ' })).toBeDefined()
  await ui.unmount()
  // Session and ↑↓ only the main thread's; today adds the subagents (2,500 + 2,500 + 240,000).
  const text = await band($)
  expect(text).toMatch(/2,5k tokens/)
  expect(text).toMatch(/↑ 2,0k {2}↓ 500/)
  expect(text).toMatch(/hoje 245k/)
})

test("a subagent step racing its turn.start still counts as the subagent's", async ($, on) => {
  setup(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })

  // Neither awaited before the other: the queue orders the step after the start.
  await Promise.all([
    $.turn.start({ text: 'task', turnId: 'sub1', agentId: 'agent-1' }),
    step($, 'sub1', 'b', 'agent-1'),
  ])

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'agente ' })).toBeDefined()
  await ui.unmount()
  const text = await band($)
  // Out of the session (the bar is t1's, still empty), into today.
  expect(text).toMatch(/▁ {2}0 tokens/)
  expect(text).toMatch(/hoje 240k/)
})

test('today adds the other sessions, resumes its own and prunes old days', async ($, on) => {
  const world = setup(on, {
    store: {
      [`novos:${TODAY}:other`]: 100_000,
      [`novos:${TODAY}:session-a`]: 50_000,
      'novos:2026-09-01:old': 1,
      'dia:2026-10-02': 0.93,
      'tokens:2026-10-05': 6_685_689,
      ultimoRecap: { texto: 'x', em: NOW },
    },
  })
  await start($)
  expect(world.store.has('novos:2026-09-01:old')).toBe(false)
  // Keys the mod no longer uses go away.
  expect([...world.store.keys()].some(k => k.startsWith('dia:') || k.startsWith('tokens:'))).toBe(false)
  expect(world.store.has('ultimoRecap')).toBe(false)

  await turn($, 't1', 'a')
  // Resuming session-a: goes on from the 50,000 written, neither from zero nor adding twice.
  expect(world.store.get(`novos:${TODAY}:session-a`)).toBe(52_500)
  expect(world.store.get(`novos:${TODAY}:other`)).toBe(100_000)
  expect(await band($)).toMatch(/hoje 153k/)
})

test("past midnight today drops to 0 until the next count, then starts the new day's sum", async ($, on) => {
  const world = setup(on)
  await start($)
  await turn($, 't1', 'a')
  expect(await band($)).toMatch(/hoje 2,5k/)

  await world.clock.set(new Date(2026, 9, 6, 0, 5).getTime())
  let text = await band($)
  // The session's own count stays; yesterday's total is not today's.
  expect(text).toMatch(/2,5k tokens/)
  expect(text).toMatch(/hoje 0/)

  await turn($, 't2', 'a')
  text = await band($)
  expect(text).toMatch(/hoje 2,5k/)
  expect(world.store.get('novos:2026-10-06:session-a')).toBe(2500)
})

test('/clear resets the session and keeps the day', async ($, on) => {
  const world = setup(on)
  await start($)
  await turn($, 't1', 'a')
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
  world.sessionId = 'session-b'

  let text = await band($)
  expect(text).toMatch(/^0 tokens/)
  expect(text).toMatch(/hoje 2,5k/)

  await turn($, 't2', 'a')
  text = await band($)
  expect(text).toMatch(/2,5k tokens/)
  expect(text).toMatch(/hoje 5,0k/)
  expect(world.store.get(`novos:${TODAY}:session-b`)).toBe(2500)
})

test('limits show from the start and drop to 0 when the window already rolled over', async ($, on) => {
  setup(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 90, resetsAt: new Date(NOW - 60_000).toISOString() },
    ],
  })
  await start($)

  const text = await band($)
  expect(text).toMatch(/5h 40%/)
  expect(text).toMatch(/7d 0%/)
})

test('with no data yet, the band does not show', async ($, on) => {
  // The engine's own drawing, which the band lets through when it has nothing to show.
  setup(on, { below: 'engine' })
  await start($)

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

async function context($: Engine, tokens: number) {
  await $.session.measure({ context: { tokens, window: 200000 }, rateLimits: [], changed: ['context'] })
}

/** Presses the band's button, as the click or the c key does. */
async function press($: Engine) {
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compact' })
  await ui.unmount()
}

function collectToasts(on: On): string[] {
  const notices: string[] = []
  on('ui.toast', (_$, e) => (notices.push(typeof e === 'string' ? e : JSON.stringify(e)), { value: undefined }))

  return notices
}

test('the context indicator changes color at 140k and 170k', async ($, on) => {
  setup(on)
  await start($)

  for (const [tokens, color, label] of [[97_000, 'green', '97k'], [152_000, 'yellow', '152k'], [181_000, 'red', '181k']] as const) {
    await context($, tokens)
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    const value = await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })
    expect(value?.props.color).toBe(color)
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('compacting with light reads: summarizes with focus and ctx drops to what is left', async ($, on) => {
  setup(on)
  const requests: (string | undefined)[] = []
  on('session.compact', (_$, e) => (requests.push(e.instructions), { messages: SUMMARY, tokensBefore: 181_000, tokensAfter: 15_000 }))
  await start($)
  await context($, 181_000)

  await press($)

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatch(/pendências/)
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /^15k$/ }))?.props.color).toBe('green')
  await ui.unmount()
})

test('a failing compaction gives notice and leaves the context alone', async ($, on) => {
  setup(on)
  const notices = collectToasts(on)
  // With no hook from the test, the kit's core rejects the compaction (it has no conversation): the error path.
  await start($)
  await context($, 181_000)

  // The high-context notice came before the click: the test looks only at the button's.
  notices.splice(0)
  await press($)

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/Não consegui compactar/)
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '181k' })).toBeDefined()
  await ui.unmount()
})

test('the button goes away while the model works', async ($, on) => {
  setup(on)
  await start($)
  await context($, 181_000)

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: true } })
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '181k' })).toBeDefined()
  await ui.unmount()
})

const SUMMARY = [{ role: 'user', text: 'conversation summary', toolUses: [] }] as never

/** A file read of ~100k tokens (400 thousand characters), whole or already removed by micro, after `chat` of plain talk. */
function withRead(content = 'x'.repeat(400_000), chat = '') {
  return [
    { role: 'user', text: chat, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: content, isError: false }] },
  ] as never[]
}
const ELIDED = '[file contents elided by compaction: /a.ts, 9000 lines. Read it again if needed.]'

test('compaction swaps the context for the size it left', async ($, on) => {
  setup(on)
  on('session.compact', (_$, e) => ({ messages: SUMMARY, ...(e.trigger === 'precompute' ? {} : { tokensBefore: 190_000, tokensAfter: 12_000 }) }))
  await start($)
  await context($, 190_000)

  // Precompute installs nothing: the context stays the same.
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY } as never)
  const shown = async () => {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    const value = await ui.find({ type: 'Text', text: /^\d+(,\d)?k$/ })
    await ui.unmount()

    return value?.text
  }
  expect(await shown()).toBe('190k')

  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  expect(await shown()).toBe('12k')
})

test('the context thresholds come from the compaction window', async ($, on) => {
  setup(on, { window: 120_000 })
  await start($)

  // 120k window: yellow from 60k, red from 90k.
  for (const [tokens, color, label] of [[50_000, 'green', '50k'], [70_000, 'yellow', '70k'], [95_000, 'red', '95k']] as const) {
    await context($, tokens)
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) }))?.props.color).toBe(color)
    expect(await ui.find({ type: 'Text', text: '/120k' })).toBeDefined()
    await ui.unmount()
  }
})

test('a new model window measures the compaction window again', async ($, on) => {
  const world = setup(on)
  await start($)

  await context($, 150_000)
  let ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /^150k$/ }))?.props.color).toBe('yellow')
  await ui.unmount()

  // /model to a 1M model: the engine reports the new window on the next measure.
  world.window = 1_000_000
  await $.session.measure({ context: { tokens: 150_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /^150k$/ }))?.props.color).toBe('green')
  expect(await ui.find({ type: 'Text', text: '/1,0M' })).toBeDefined()
  await ui.unmount()
})

test('warns once on entering red and again after the context drops', async ($, on) => {
  setup(on)
  const notices = collectToasts(on)
  await start($)

  await context($, 150_000)
  expect(notices).toHaveLength(0)
  await context($, 172_000)
  await context($, 185_000)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/172k de 200k: .*resume a conversa/)

  // After compacting, the context drops; going up again warns once more.
  await context($, 20_000)
  await context($, 175_000)
  expect(notices).toHaveLength(2)
})

test('compacting with heavy reads: goes micro, as a typed /compact', async ($, on) => {
  setup(on, { messages: withRead() })
  const commands: string[] = []
  on('command.run', (_$, e) => (commands.push(`/${e.command} ${e.args}`), { text: '' }))
  const summaries: unknown[] = []
  on('session.compact', (_$, e) => (summaries.push(e), { messages: SUMMARY, tokensAfter: 15_000 }))
  await start($)
  await context($, 181_000)

  await press($)

  expect(commands).toEqual(['/compact micro'])
  expect(summaries).toHaveLength(0)
})

test('reads under 40% of the conversation go to the summary', async ($, on) => {
  // 400k characters of read against 700k of plain talk: ~36%.
  setup(on, { messages: withRead(undefined, 'y'.repeat(700_000)) })
  const commands: string[] = []
  on('command.run', (_$, e) => (commands.push(`/${e.command} ${e.args}`), { text: '' }))
  const requests: (string | undefined)[] = []
  on('session.compact', (_$, e) => (requests.push(e.instructions), { messages: SUMMARY, tokensAfter: 15_000 }))
  await start($)
  await context($, 181_000)

  await press($)

  expect(commands).toHaveLength(0)
  expect(requests).toHaveLength(1)
})

test("the red notice says the button goes micro and the reads' share", async ($, on) => {
  // 400k characters of read against 400k of plain talk: half the conversation.
  setup(on, { messages: withRead(undefined, 'y'.repeat(400_000)) })
  const notices = collectToasts(on)
  await start($)

  await context($, 181_000)

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/tira as leituras de arquivo, ~50% da conversa \(micro\)/)
})

test('micro reports no size: ctx subtracts what left the messages', async ($, on) => {
  setup(on)
  on('session.compact', () => ({ messages: withRead(ELIDED) }))
  await start($)
  await context($, 181_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: withRead() } as never)

  // 181k minus the ~100k of the read (the marker left behind is negligible).
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^81k$/ })).toBeDefined()
  await ui.unmount()
})

test('micro without the plugin becomes a core summary and gives notice', async ($, on) => {
  setup(on)
  const notices = collectToasts(on)
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 181_000, tokensAfter: 12_000 }))
  await start($)
  await context($, 150_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: withRead() } as never)

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/micro-compaction não está ativo/)
})

test("a core summary that only reports its request's usage still counts as one", async ($, on) => {
  setup(on)
  const notices = collectToasts(on)
  on('session.compact', () => ({ messages: SUMMARY, usage: { ...USAGES.compaction!, model: 'compaction' } }))
  await start($)
  await context($, 150_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: withRead() } as never)

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/micro-compaction não está ativo/)
})

test('micro done by the plugin gives no notice', async ($, on) => {
  setup(on)
  const notices = collectToasts(on)
  on('session.compact', () => ({ messages: withRead(ELIDED) }))
  await start($)
  await context($, 150_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: withRead() } as never)

  expect(notices).toHaveLength(0)
})

test('keeps what another mod draws below the band', async ($, on) => {
  setup(on, { below: 'another mod notice' })
  await start($)
  await turn($, 't1', 'a')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? '').toMatch(/tokens/)
    expect((await ui.find({ type: 'Text', text: /another mod notice/ }))?.text).toBe('another mod notice')
    await ui.unmount()
  }
})

test('with an empty chain below, the band shows alone', async ($, on) => {
  setup(on)
  await start($)
  await turn($, 't1', 'a')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? '').toMatch(/tokens/)
    expect(await ui.find({ type: 'Text', text: /another mod notice/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with a survey open, it only passes along', async ($, on) => {
  setup(on, { below: 'another mod notice' })
  await start($)
  await turn($, 't1', 'a')

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /another mod notice/ }))?.text).toBe('another mod notice')
  await ui.unmount()
})

test('with no Portuguese or Spanish locale, the band comes out in English', async ($, on) => {
  setup(on, { env: { LANG: 'en_US.UTF-8' } })
  await start($)
  await turn($, 't1', 'a')
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'spend_limit', percentUsed: 10 }],
    changed: ['rateLimits'],
  })

  const text = await band($)
  expect(text).toMatch(/2\.5k tokens/)
  expect(text).toMatch(/today 2\.5k/)
  expect(text).toMatch(/limit 10%/)
})

test('a Spanish locale turns the band Spanish', async ($, on) => {
  setup(on, { env: { LC_ALL: 'es_AR.UTF-8', LANG: 'en_US.UTF-8' } })
  await start($)
  await turn($, 't1', 'a')

  expect(await band($)).toMatch(/hoy 2,5k/)
})

test('the language option beats the locale', { options: { language: 'en' } }, async ($, on) => {
  setup(on)
  await start($)
  await turn($, 't1', 'a')

  expect(await band($)).toMatch(/today 2\.5k/)
})

test('a failing store warns once and does not take down the turn', async ($, on) => {
  setup(on, { brokenStore: true })
  const notices = collectToasts(on)
  await start($)

  // Both turns finish: the mod's failure does not reach the answer.
  await turn($, 't1', 'a')
  await turn($, 't2', 'a')

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatch(/a contagem falhou/)
})

test('the band stays marked while counting fails and clears once it works again', async ($, on) => {
  const world = setup(on, { brokenStore: true })
  collectToasts(on)
  await start($)

  await turn($, 't1', 'a')
  await turn($, 't2', 'a')
  // Nothing counted yet, but the band shows to say so.
  expect(await band($)).toMatch(/^⚠ desatualizada {2}.*0 tokens/)

  world.brokenStore = false
  await turn($, 't3', 'a')
  const text = await band($)
  expect(text).not.toMatch(/⚠/)
  expect(text).toMatch(/hoje 2,5k/)
})
