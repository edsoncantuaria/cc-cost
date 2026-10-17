import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
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

// 5 de outubro de 2026, meio-dia local.
const AGORA = new Date(2026, 9, 5, 12).getTime()
const HOJE = '2026-10-05'

const USOS: Record<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = {
  a: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 },
  b: { input_tokens: 200_000, output_tokens: 40_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 },
  // O resumo da compactação: relê a conversa inteira do cache e escreve o resumo.
  compactacao: { input_tokens: 0, output_tokens: 5000, cache_read_input_tokens: 168_000, cache_creation_input_tokens: 0 },
}

type Mundo = { sessionId: string; store: Map<string, unknown>; mensagens: unknown[] }

function preparar(
  on: On,
  opcoes: { store?: Record<string, unknown>; rateLimits?: SessionRateLimit[]; janela?: number; mensagens?: unknown[]; abaixo?: string } = {},
): Mundo {
  const mundo = { sessionId: 'sessao-a', store: new Map(Object.entries(opcoes.store ?? {})), mensagens: opcoes.mensagens ?? [] }
  mock.clock(on, { now: AGORA })
  // Store em memória à vista do teste, para conferir o que cada sessão gravou.
  on('store.get', (_$, e) => ({ value: mundo.store.get(e.key) }))
  on('store.set', (_$, e) => (mundo.store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$, e) => (mundo.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...mundo.store.keys()] }))
  // O que vem depois do mod na cadeia do AbovePrompt: vazio, ou o texto de outro mod.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    if (opcoes.abaixo === undefined) return h(Fragment, null) as never
    const { Text } = $.ui.resolve(e)

    return h(Text, null, opcoes.abaixo) as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: mundo.sessionId }))
  on('session.messages', () => ({ value: mundo.mensagens as never }))
  // Sem `janela`, o breakdown não vem e vale a janela do modelo (200k).
  on('session.usage', (_$, e) => {
    const breakdown = e.breakdown && opcoes.janela ? { breakdown: { rawMaxTokens: opcoes.janela } as never } : {}

    return { value: { startedAt: AGORA, context: { window: 200000, ...breakdown }, rateLimits: opcoes.rateLimits ?? [] } }
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
      usage: { ...USOS[e.model]!, model: e.model },
    }
  })

  return mundo
}

/** O "model" do passo escolhe qual uso de USOS a resposta falsa devolve. */
async function passo($: Engine, turnId: string, model: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // só consome
  }
}

async function turno($: Engine, turnId: string, ...modelos: string[]) {
  await $.turn.start({ text: '', turnId })
  for (const m of modelos) await passo($, turnId, m)
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

async function faixa($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
  const texto = (await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? ''
  await ui.unmount()

  return texto
}

async function iniciar($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('conta só tokens novos: leitura de cache vira percentual', async ($, on) => {
  preparar(on)
  await iniciar($)
  await turno($, 't1', 'a')
  await turno($, 't2', 'b')
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 62 }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const texto = await faixa($, surface)
    // novos: 2.500 + 240.000; o 1.008.000 lido do cache fica fora.
    expect(texto).toMatch(/243k tokens/)
    expect(texto).toMatch(/↑ 202k {2}↓ 41k/)
    expect(texto).toMatch(/cache 83%/)
    expect(texto).toMatch(/hoje 243k/)
    expect(texto).toMatch(/5h 62%/)
  }
})

test('compactação soma só o resumo e não mexe nas barras', async ($, on) => {
  preparar(on)
  await iniciar($)
  await $.turn.start({ text: '', turnId: 't1' })
  await passo($, 't1', 'a')
  await passo($, 't1', 'a')
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await turno($, 't2', 'b')
  // /compact entre turnos: o fork do engine tem agentId mas não abre turno.
  await passo($, 'fork', 'compactacao', 'fork-compactacao')

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  // Duas barras: t1 (2 × 2.500) e t2 (240.000, a maior).
  expect(await ui.find({ type: 'Text', text: '▁█  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  await ui.unmount()
  // 5.000 + 240.000 + 5.000 do resumo; os 168k relidos do cache não entram.
  expect(await faixa($)).toMatch(/250k tokens/)
})

test('subagente mostra o próprio contexto e fica fora do resto da faixa', async ($, on) => {
  preparar(on)
  await iniciar($)
  await $.turn.start({ text: '', turnId: 't1' })
  await passo($, 't1', 'a')
  await contexto($, 97_000)
  await $.turn.start({ text: 'tarefa', turnId: 'sub1', agentId: 'agente-1' })

  // Antes da primeira resposta o subagente ainda não aparece.
  let ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  await ui.unmount()

  await passo($, 'sub1', 'a', 'agente-1')
  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  // Entrada da última resposta do subagente: 1.000 + 8.000 + 1.000.
  expect(await ui.find({ type: 'Text', text: 'agente ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^10k$/ }))?.props.color).toBe('green')
  // O ctx segue o da thread principal.
  expect(await ui.find({ type: 'Text', text: /^97k$/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: 'outra', turnId: 'sub2', agentId: 'agente-2' })
  await passo($, 'sub2', 'b', 'agente-2')
  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '2 agentes, maior ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^1,2M$/ }))?.props.color).toBe('red')
  await ui.unmount()

  for (const [turnId, agentId] of [['sub1', 'agente-1'], ['sub2', 'agente-2']] as const) {
    await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId })
  }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /agente/ })).toBeUndefined()
  // Uma barra só: os subagentes não abrem turno.
  expect(await ui.find({ type: 'Text', text: '█  ' })).toBeDefined()
  await ui.unmount()
  // Sessão e ↑↓ só da thread principal; o hoje soma os subagentes (2.500 + 2.500 + 240.000).
  const texto = await faixa($)
  expect(texto).toMatch(/2,5k tokens/)
  expect(texto).toMatch(/↑ 2,0k {2}↓ 500/)
  expect(texto).toMatch(/hoje 245k/)
})

test('hoje soma as outras sessões, retoma a própria e poda dias velhos', async ($, on) => {
  const mundo = preparar(on, {
    store: {
      [`novos:${HOJE}:outra`]: 100_000,
      [`novos:${HOJE}:sessao-a`]: 50_000,
      'novos:2026-09-01:velha': 1,
      'dia:2026-10-02': 0.93,
      'tokens:2026-10-05': 6_685_689,
      ultimoRecap: { texto: 'x', em: AGORA },
    },
  })
  await iniciar($)
  expect(mundo.store.has('novos:2026-09-01:velha')).toBe(false)
  // Chaves que o mod não usa mais saem.
  expect([...mundo.store.keys()].some(k => k.startsWith('dia:') || k.startsWith('tokens:'))).toBe(false)
  expect(mundo.store.has('ultimoRecap')).toBe(false)

  await turno($, 't1', 'a')
  // Resume da sessao-a: continua dos 50.000 gravados, não começa do zero nem soma duas vezes.
  expect(mundo.store.get(`novos:${HOJE}:sessao-a`)).toBe(52_500)
  expect(mundo.store.get(`novos:${HOJE}:outra`)).toBe(100_000)
  expect(await faixa($)).toMatch(/hoje 153k/)
})

test('/clear zera a sessão e mantém o dia', async ($, on) => {
  const mundo = preparar(on)
  await iniciar($)
  await turno($, 't1', 'a')
  await $.session.end({ reason: 'clear', sessionId: 'sessao-a', resume: { id: 'sessao-a' } })
  mundo.sessionId = 'sessao-b'

  let texto = await faixa($)
  expect(texto).toMatch(/^0 tokens/)
  expect(texto).toMatch(/hoje 2,5k/)

  await turno($, 't2', 'a')
  texto = await faixa($)
  expect(texto).toMatch(/2,5k tokens/)
  expect(texto).toMatch(/hoje 5,0k/)
  expect(mundo.store.get(`novos:${HOJE}:sessao-b`)).toBe(2500)
})

test('limites aparecem desde o início e zeram quando a janela já virou', async ($, on) => {
  preparar(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(AGORA + 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 90, resetsAt: new Date(AGORA - 60_000).toISOString() },
    ],
  })
  await iniciar($)

  const texto = await faixa($)
  expect(texto).toMatch(/5h 40%/)
  expect(texto).toMatch(/7d 0%/)
})

test('sem nenhum dado ainda, a faixa não aparece', async ($, on) => {
  preparar(on)
  // O desenho do próprio engine, que a faixa deixa passar quando não tem o que mostrar.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  await iniciar($)

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

async function contexto($: Engine, tokens: number) {
  await $.session.measure({ context: { tokens, window: 200000 }, rateLimits: [], changed: ['context'] })
}

/** Aperta o botão da faixa, como o clique ou a tecla c. */
async function apertar($: Engine) {
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  await ui.press({ key: 'compactar' })
  await ui.unmount()
}

test('indicador de contexto muda de cor em 140k e 170k', async ($, on) => {
  preparar(on)
  await iniciar($)

  for (const [tokens, cor, rotulo] of [[97_000, 'green', '97k'], [152_000, 'yellow', '152k'], [181_000, 'red', '181k']] as const) {
    await contexto($, tokens)
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    const valor = await ui.find({ type: 'Text', text: new RegExp(`^${rotulo}$`) })
    expect(valor?.props.color).toBe(cor)
    expect(await ui.find({ type: 'Button', key: 'compactar' })).toBeDefined()
    await ui.unmount()
  }
})

test('compactar sem leituras pesando: resume com foco e o ctx cai para o que ficou', async ($, on) => {
  preparar(on)
  const pedidos: (string | undefined)[] = []
  on('session.compact', (_$, e) => (pedidos.push(e.instructions), { messages: RESUMO, tokensBefore: 181_000, tokensAfter: 15_000 }))
  await iniciar($)
  await contexto($, 181_000)

  await apertar($)

  expect(pedidos).toHaveLength(1)
  expect(pedidos[0]).toMatch(/pendências/)
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /^15k$/ }))?.props.color).toBe('green')
  await ui.unmount()
})

test('compactação que falha avisa e não mexe no contexto', async ($, on) => {
  preparar(on)
  const avisos: string[] = []
  // Sem hook do teste, o núcleo do kit rejeita a compactação (não tem a conversa): é o caminho de erro.
  on('ui.toast', (_$, e) => (avisos.push(typeof e === 'string' ? e : JSON.stringify(e)), { value: undefined }))
  await iniciar($)
  await contexto($, 181_000)

  // O aviso de contexto alto veio antes do clique: o teste olha só o do botão.
  avisos.splice(0)
  await apertar($)

  expect(avisos).toHaveLength(1)
  expect(avisos[0]).toMatch(/Não consegui compactar/)
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '181k' })).toBeDefined()
  await ui.unmount()
})

test('botão some enquanto o modelo trabalha', async ($, on) => {
  preparar(on)
  await iniciar($)
  await contexto($, 181_000)

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: true } })
  expect(await ui.find({ type: 'Button', key: 'compactar' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '181k' })).toBeDefined()
  await ui.unmount()
})

const RESUMO = [{ role: 'user', text: 'resumo da conversa', toolUses: [] }] as never

/** Uma leitura de arquivo de ~100k tokens (400 mil caracteres), inteira ou já tirada pelo micro. */
function comLeitura(texto = 'x'.repeat(400_000)) {
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: texto, isError: false }] },
  ] as never[]
}
const TIRADA = '[file contents elided by compaction: /a.ts, 9000 lines. Read it again if needed.]'

test('compactação troca o contexto pelo tamanho que ela deixou', async ($, on) => {
  preparar(on)
  on('session.compact', (_$, e) => ({ messages: RESUMO, ...(e.trigger === 'precompute' ? {} : { tokensBefore: 190_000, tokensAfter: 12_000 }) }))
  await iniciar($)
  await contexto($, 190_000)

  // A pré-computação não instala nada: o contexto continua o mesmo.
  await $.session.compact({ trigger: 'precompute', messages: RESUMO } as never)
  const lido = async () => {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    const valor = await ui.find({ type: 'Text', text: /^\d+(,\d)?k$/ })
    await ui.unmount()

    return valor?.text
  }
  expect(await lido()).toBe('190k')

  await $.session.compact({ trigger: 'auto', messages: RESUMO } as never)
  expect(await lido()).toBe('12k')
})

test('limiares do contexto saem da janela de compactação', async ($, on) => {
  preparar(on, { janela: 120_000 })
  await iniciar($)

  // Janela de 120k: amarelo a partir de 60k, vermelho a partir de 90k.
  for (const [tokens, cor, rotulo] of [[50_000, 'green', '50k'], [70_000, 'yellow', '70k'], [95_000, 'red', '95k']] as const) {
    await contexto($, tokens)
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${rotulo}$`) }))?.props.color).toBe(cor)
    expect(await ui.find({ type: 'Text', text: '/120k' })).toBeDefined()
    await ui.unmount()
  }
})

test('avisa uma vez ao entrar no vermelho e de novo depois que o contexto cai', async ($, on) => {
  preparar(on)
  const avisos: string[] = []
  on('ui.toast', (_$, e) => (avisos.push(typeof e === 'string' ? e : JSON.stringify(e)), { value: undefined }))
  await iniciar($)

  await contexto($, 150_000)
  expect(avisos).toHaveLength(0)
  await contexto($, 172_000)
  await contexto($, 185_000)
  expect(avisos).toHaveLength(1)
  expect(avisos[0]).toMatch(/172k de 200k: .*resume a conversa/)

  // Depois de compactar, o contexto cai; subir de novo avisa outra vez.
  await contexto($, 20_000)
  await contexto($, 175_000)
  expect(avisos).toHaveLength(2)
})

test('compactar com leituras pesando: vai de micro, como /compact digitado', async ($, on) => {
  preparar(on, { mensagens: comLeitura() })
  const comandos: string[] = []
  on('command.run', (_$, e) => (comandos.push(`/${e.command} ${e.args}`), { text: '' }))
  const resumos: unknown[] = []
  on('session.compact', (_$, e) => (resumos.push(e), { messages: RESUMO, tokensAfter: 15_000 }))
  await iniciar($)
  // ~100k de leitura em 181k de contexto: passa dos 40%.
  await contexto($, 181_000)

  await apertar($)

  expect(comandos).toEqual(['/compact micro'])
  expect(resumos).toHaveLength(0)
})

test('aviso do vermelho diz que o botão vai de micro e quanto tira', async ($, on) => {
  preparar(on, { mensagens: comLeitura() })
  const avisos: string[] = []
  on('ui.toast', (_$, e) => (avisos.push(typeof e === 'string' ? e : JSON.stringify(e)), { value: undefined }))
  await iniciar($)

  await contexto($, 181_000)

  expect(avisos).toHaveLength(1)
  expect(avisos[0]).toMatch(/tira ~100k de leituras de arquivo \(micro\)/)
})

test('micro não informa o tamanho: o ctx desconta o que saiu das mensagens', async ($, on) => {
  preparar(on)
  on('session.compact', () => ({ messages: comLeitura(TIRADA) }))
  await iniciar($)
  await contexto($, 181_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: comLeitura() } as never)

  // 181k menos os ~100k da leitura (o marcador que fica é desprezível).
  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^81k$/ })).toBeDefined()
  await ui.unmount()
})

test('micro sem o plugin vira resumo do núcleo e avisa', async ($, on) => {
  preparar(on)
  const avisos: string[] = []
  on('ui.toast', (_$, e) => (avisos.push(typeof e === 'string' ? e : JSON.stringify(e)), { value: undefined }))
  on('session.compact', () => ({ messages: RESUMO, tokensBefore: 181_000, tokensAfter: 12_000 }))
  await iniciar($)
  await contexto($, 150_000)

  await $.session.compact({ trigger: 'manual', instructions: 'micro', messages: comLeitura() } as never)

  expect(avisos).toHaveLength(1)
  expect(avisos[0]).toMatch(/micro-compaction não está ativo/)
})

test('mantém o que outro mod desenha abaixo da faixa', async ($, on) => {
  preparar(on, { abaixo: 'aviso de outro mod' })
  await iniciar($)
  await turno($, 't1', 'a')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? '').toMatch(/tokens/)
    expect((await ui.find({ type: 'Text', text: /aviso de outro mod/ }))?.text).toBe('aviso de outro mod')
    await ui.unmount()
  }
})

test('com a cadeia abaixo vazia, a faixa aparece sozinha', async ($, on) => {
  preparar(on)
  await iniciar($)
  await turno($, 't1', 'a')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cc-cost', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text ?? '').toMatch(/tokens/)
    expect(await ui.find({ type: 'Text', text: /aviso de outro mod/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('com pesquisa aberta, só passa adiante', async ($, on) => {
  preparar(on, { abaixo: 'aviso de outro mod' })
  await iniciar($)
  await turno($, 't1', 'a')

  const ui = await $.ui.mount({ plugin: 'cc-cost', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /aviso de outro mod/ }))?.text).toBe('aviso de outro mod')
  await ui.unmount()
})
