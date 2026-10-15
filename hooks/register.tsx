import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionMessage, SessionRateLimit } from 'claude-code'

import type { Gasto, Limite, Modo, Tokens } from '../types'

const gasto = atom({ plugin: 'gasto', key: 'tokens' } as const, null)
const compactando = atom({ plugin: 'gasto', key: 'compactando' } as const, null)

const BARRAS = 12
const DIAS_GUARDADOS = 7
const NIVEIS = '▁▂▃▄▅▆▇█'
const ROTULO: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'limite' }
const ZERO: Tokens = { entrada: 0, saida: 0, cacheLido: 0, cacheEscrito: 0 }
const VAZIO: Gasto = { sessao: ZERO, hoje: 0, proprio: { chave: '', n: 0 }, turnos: [], emTurno: false, limites: [], contexto: null, janela: null }

// Folga até a janela de compactação: o vermelho deixa ~30k para compactar antes do autocompact.
const FOLGA_ATENCAO = 60_000
const FOLGA_TROCAR = 30_000
// Chaves que o mod não usa mais: as da versão antiga e o recap do antigo botão "nova sessão".
const CHAVES_ANTIGAS = ['dia:', 'tokens:', 'ultimoRecap']

// A partir dessa parte do contexto em leituras de arquivo, o micro compensa regravar o cache inteiro.
const PARTE_MICRO = 0.4
// Aproximação para comparar partes do contexto, não para medir: a medida real vem do engine.
const CHARS_POR_TOKEN = 4
// O marcador que o micro-compaction deixa no lugar do arquivo: o que já foi tirado não conta de novo.
const ELIDIDO = / elided by compaction: /

const FOCO_COMPACTACAO =
  'Priorize o que é preciso para continuar o trabalho: objetivo, arquivos alterados (com caminho), ' +
  'decisões e o porquê, estado atual (testes, o que está quebrado), próximos passos e pendências em aberto.'

/** Data local AAAA-MM-DD; em ordem alfabética é ordem cronológica. */
function dia(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Leitura de cache fica de fora: é o mesmo contexto reenviado a cada requisição, e somá-la conta a conversa várias vezes. */
function novos(t: Tokens): number {
  return t.entrada + t.cacheEscrito + t.saida
}

/** 950 · 12,4k · 312k · 1,2M — uma casa decimal só abaixo de 10. */
function compacto(n: number): string {
  const [valor, sufixo] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  const casas = sufixo && valor < 10 ? 1 : 0

  return valor.toFixed(casas).replace('.', ',') + sufixo
}

function sparkline(valores: number[]): string {
  const maior = Math.max(1, ...valores)

  return valores.map(v => NIVEIS[Math.min(NIVEIS.length - 1, Math.floor((v / maior) * NIVEIS.length))]).join('')
}

function cor(pct: number): string {
  if (pct >= 85) return 'red'
  if (pct >= 60) return 'yellow'

  return 'green'
}

function limiares(janela: number | null): { atencao: number; trocar: number } {
  const total = janela ?? 200_000

  return { atencao: total - FOLGA_ATENCAO, trocar: total - FOLGA_TROCAR }
}

function corContexto(tokens: number, janela: number | null): string {
  const { atencao, trocar } = limiares(janela)
  if (tokens >= trocar) return 'red'
  if (tokens >= atencao) return 'yellow'

  return 'green'
}

/** A janela de compactação (autoCompactWindow), não a do modelo; o breakdown `summary` é estimado localmente, sem requisição. */
async function janelaCompactacao($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: 'summary' })

  return context.breakdown?.rawMaxTokens ?? context.window
}

function limites(janelas: readonly SessionRateLimit[]): Limite[] {
  return janelas.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))
}

/**
 * Cada sessão grava só a própria chave `novos:<dia>:<sessionId>`: duas sessões abertas
 * não apagam a soma uma da outra, e o resume da mesma sessão continua de onde parou.
 */
async function somaDoDia($: EngineInterface, hoje: string, proprio: Gasto['proprio']): Promise<number> {
  const prefixo = `novos:${hoje}:`
  let soma = proprio.chave.startsWith(prefixo) ? proprio.n : 0
  for (const chave of await $.store.keys()) {
    if (chave.startsWith(prefixo) && chave !== proprio.chave) soma += Number((await $.store.get(chave)) ?? 0)
  }

  return soma
}

async function podar($: EngineInterface, agora: number) {
  const corte = `novos:${dia(agora - DIAS_GUARDADOS * 86_400_000)}`
  for (const chave of await $.store.keys()) {
    const velha = chave.startsWith('novos:') ? chave < corte : CHAVES_ANTIGAS.some(p => chave.startsWith(p))
    if (velha) await $.store.delete(chave)
  }
}

// As escritas passam uma de cada vez: ler o store, somar e gravar não pode intercalar
// entre passos paralelos (subagentes), senão uma soma apaga a outra.
let fila: Promise<unknown> = Promise.resolve()
function enfileirar(tarefa: () => Promise<void>): Promise<void> {
  const vez = fila.then(tarefa)
  fila = vez.catch(() => undefined)

  return vez
}

async function somar($: EngineInterface, usage: ModelUsage) {
  const t: Tokens = {
    entrada: usage.input_tokens,
    saida: usage.output_tokens,
    cacheLido: usage.cache_read_input_tokens,
    cacheEscrito: usage.cache_creation_input_tokens,
  }
  const n = novos(t)
  if (n === 0 && t.cacheLido === 0) return

  const hoje = dia(await $.clock.now())
  const chave = `novos:${hoje}:${await $.session.id()}`
  const atual = (await read($, gasto)) ?? VAZIO
  const antes = atual.proprio.chave === chave ? atual.proprio.n : Number((await $.store.get(chave)) ?? 0)
  const proprio = { chave, n: antes + n }
  await $.store.set(chave, proprio.n)
  const totalHoje = await somaDoDia($, hoje, proprio)

  await update($, gasto, a => {
    const g = a ?? VAZIO
    // Subagentes do turno caem na barra dele; compactação e trabalho fora de turno só no total.
    const turnos = g.emTurno && g.turnos.length > 0
      ? [...g.turnos.slice(0, -1), (g.turnos.at(-1) ?? 0) + n]
      : g.turnos

    return {
      ...g,
      sessao: {
        entrada: g.sessao.entrada + t.entrada,
        saida: g.sessao.saida + t.saida,
        cacheLido: g.sessao.cacheLido + t.cacheLido,
        cacheEscrito: g.sessao.cacheEscrito + t.cacheEscrito,
      },
      hoje: totalHoje,
      proprio,
      turnos,
    }
  })
}

/** Tokens estimados das leituras de arquivo (Read) ainda inteiras: o que o /compact micro tira. */
function leituras(msgs: readonly SessionMessage[]): number {
  const lidos = new Set(msgs.flatMap(m => m.toolUses.filter(u => u.tool === 'Read').map(u => u.tool_use_id)))
  let chars = 0
  for (const m of msgs) {
    for (const r of m.toolResults ?? []) {
      if (lidos.has(r.tool_use_id) && !r.isError && !ELIDIDO.test(r.text)) chars += r.text.length
    }
  }

  return Math.round(chars / CHARS_POR_TOKEN)
}

/** Tokens estimados do texto das mensagens; serve para a diferença entre antes e depois de compactar. */
function tamanho(msgs: readonly SessionMessage[]): number {
  let chars = 0
  for (const m of msgs) chars += m.text.length + (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0)

  return Math.round(chars / CHARS_POR_TOKEN)
}

/** Micro quando as leituras pesam no contexto; senão o resumo, que encolhe a conversa em si. */
function modo(lidos: number, contexto: number | null): Modo {
  return contexto !== null && lidos >= contexto * PARTE_MICRO ? 'micro' : 'resumo'
}

/**
 * Compacta do jeito que mais rende agora. O micro (plugin micro-compaction) vai como /compact digitado,
 * o único gatilho que o plugin atende. O resumo vai direto, e o ctx recebe aqui o tamanho que ele deixou,
 * porque o hook session.compact deste mod não roda na chamada que o próprio mod faz.
 */
async function compactar($: EngineInterface) {
  if ((await read($, compactando)) !== null) return
  const escolhido = modo(leituras(await $.session.messages()), (await read($, gasto))?.contexto ?? null)
  await update($, compactando, () => escolhido)
  try {
    if (escolhido === 'micro') {
      await $.command.run({ command: 'compact', args: 'micro' })
      return
    }
    const r = await $.session.compact({ instructions: FOCO_COMPACTACAO })
    // Vetada por um hook: o próprio engine mostra a linha com o motivo.
    if (r.skip !== undefined) return
    const depois = r.tokensAfter ?? null
    await enfileirar(() => update($, gasto, a => (a ? { ...a, contexto: depois } : a)).then(() => undefined))
  } catch (erro) {
    $.ui.toast(`Não consegui compactar (${erro instanceof Error ? erro.message : String(erro)}); a sessão continua como está.`)
  } finally {
    await update($, compactando, () => null)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await enfileirar(async () => {
      const agora = await $.clock.now()
      await podar($, agora)
      const atual = (await read($, gasto)) ?? VAZIO
      const hoje = await somaDoDia($, dia(agora), atual.proprio)
      const { rateLimits, context } = await $.session.usage()
      const janela = await janelaCompactacao($)
      await update($, gasto, a => ({
        ...(a ?? VAZIO),
        hoje,
        limites: rateLimits.length > 0 ? limites(rateLimits) : (a?.limites ?? []),
        contexto: context.tokens ?? a?.contexto ?? null,
        janela,
      }))
    })

    return next(e)
  })

  // Só a thread principal abre turno: cada turno é uma barra.
  on('turn.start', async ($, e, next) => {
    await enfileirar(() =>
      update($, gasto, a => {
        const g = a ?? VAZIO

        return { ...g, turnos: [...g.turnos, 0].slice(-BARRAS), emTurno: true }
      }).then(() => undefined),
    )

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await enfileirar(() => update($, gasto, a => (a ? { ...a, emTurno: false } : a)).then(() => undefined))
    }

    return next(e)
  })

  // Cada requisição ao modelo: thread principal, subagente ou processo do engine (compactação).
  on('turn.step', async function* ($, e, next) {
    const resposta = yield* next(e)
    const usage = resposta.usage
    if (usage) await enfileirar(() => somar($, usage))

    return resposta
  })

  on('session.measure', async ($, e, next) => {
    await enfileirar(async () => {
      const atual = (await read($, gasto)) ?? VAZIO
      const hoje = await somaDoDia($, dia(await $.clock.now()), atual.proprio)
      const contexto = e.context.tokens ?? atual.contexto
      await update($, gasto, a => ({
        ...(a ?? VAZIO),
        hoje,
        limites: e.rateLimits.length > 0 ? limites(e.rateLimits) : (a?.limites ?? []),
        contexto: e.context.tokens ?? a?.contexto ?? null,
      }))

      // Só na subida pelo limiar: depois do /clear ou de uma compactação o contexto cai e o aviso volta a valer.
      const { trocar } = limiares(atual.janela)
      if (contexto !== null && contexto >= trocar && (atual.contexto === null || atual.contexto < trocar)) {
        const de = atual.janela ? ` de ${compacto(atual.janela)}` : ''
        const lidos = leituras(await $.session.messages())
        const faz = modo(lidos, contexto) === 'micro' ? `tira ~${compacto(lidos)} de leituras de arquivo (micro)` : 'resume a conversa'
        $.ui.toast(`Contexto em ${compacto(contexto)}${de}: "compactar" na faixa (c) ${faz}, antes do autocompact.`)
      }
    })

    return next(e)
  })

  // Depois da compactação o engine só mede o contexto na próxima resposta: até lá, o tamanho que ela deixou.
  // O micro não informa esse tamanho: vale a estimativa do que saiu das mensagens.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && r.messages) {
      const informado = r.tokensAfter
      const saiu = tamanho(e.messages) - tamanho(r.messages)
      await enfileirar(() =>
        update($, gasto, a => {
          if (!a) return a
          const estimado = a.contexto === null ? null : Math.max(0, a.contexto - saiu)

          return { ...a, contexto: informado ?? estimado }
        }).then(() => undefined),
      )
      // Só o resumo do núcleo informa o tamanho: "micro" com tamanho é o núcleo resumindo, sem o plugin.
      if (e.instructions?.trim().toLowerCase() === 'micro' && informado !== undefined) {
        $.ui.toast('O /compact micro virou resumo: o plugin micro-compaction não está ativo.')
      }
    }

    return r
  })

  // O /clear segue no mesmo processo com outro id e sem session.start: zera só a sessão.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await enfileirar(() =>
        update($, gasto, a => (a ? { ...a, sessao: ZERO, turnos: [], emTurno: false, contexto: null } : a)).then(() => undefined),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await read($, gasto)
    if (e.props.hasSurvey || g === null) return next(e)

    const s = g.sessao
    const entradaTotal = s.entrada + s.cacheLido + s.cacheEscrito
    if (entradaTotal + s.saida === 0 && g.hoje === 0 && g.limites.length === 0 && g.contexto === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const agora = await $.clock.now()
    const emCurso = await read($, compactando)
    const ocupado = e.props.isWorking || emCurso !== null
    const cache = entradaTotal > 0 ? Math.round((s.cacheLido / entradaTotal) * 100) : 0
    const ponto = <Text dimColor>  ·  </Text>

    return (
      <Box paddingX={1} flexDirection="row">
        <Text wrap="truncate-end">
          {g.turnos.length > 0 && <Text color="cyan">{sparkline(g.turnos)}  </Text>}
          <Text bold>{compacto(novos(s))}</Text>
          <Text dimColor> tokens</Text>
          {ponto}
          <Text dimColor>↑ </Text>
          <Text>{compacto(s.entrada + s.cacheEscrito)}</Text>
          <Text dimColor>  ↓ </Text>
          <Text>{compacto(s.saida)}</Text>
          {ponto}
          <Text dimColor>cache </Text>
          <Text>{cache}%</Text>
          {ponto}
          <Text dimColor>hoje </Text>
          <Text bold>{compacto(g.hoje)}</Text>
          {g.limites.map(l => {
            // A janela já virou e nenhuma resposta nova trouxe o valor: não mostrar o antigo.
            const pct = l.resetsAt && Date.parse(l.resetsAt) <= agora ? 0 : l.percentUsed

            return (
              <Text key={l.kind}>
                {ponto}
                <Text dimColor>{ROTULO[l.kind] ?? l.kind} </Text>
                <Text color={cor(pct)}>{Math.round(pct)}%</Text>
              </Text>
            )
          })}
        </Text>
        {/* Fora do texto que trunca: em terminal estreito o contexto é o último a sumir. */}
        {g.contexto !== null && (
          <Text>
            {ponto}
            <Text dimColor>ctx </Text>
            <Text color={corContexto(g.contexto, g.janela)}>{compacto(g.contexto)}</Text>
            {g.janela !== null && <Text dimColor>/{compacto(g.janela)}</Text>}
          </Text>
        )}
        <Text>  </Text>
        {ocupado ? (
          e.props.isWorking ? null : <Text dimColor>compactando ({emCurso})…</Text>
        ) : (
          <Button
            key="compactar"
            label="compactar"
            hotkey="c"
            variant={g.contexto !== null && g.contexto >= limiares(g.janela).trocar ? 'primary' : undefined}
            dimColor={g.contexto === null || g.contexto < limiares(g.janela).atencao}
            onPress={() => compactar($)}
          />
        )}
      </Box>
    )
  })
}
