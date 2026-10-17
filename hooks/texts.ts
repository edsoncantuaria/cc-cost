import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Language, Mode } from '../types'
import { readLanguage, updateLanguage } from './state'

export type Texts = {
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
async function resolve($: EngineInterface, option: PluginOptions[string] | undefined): Promise<Language> {
  if (option === 'en' || option === 'pt-BR' || option === 'es') return option
  try {
    const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))

    return languageOfLocale(locale)
  } catch {
    return 'en'
  }
}

/** Resolves the language again and keeps it in the session: session.start calls it on every load, so a new option takes. */
export async function chooseLanguage($: EngineInterface, option: PluginOptions[string] | undefined): Promise<Texts> {
  const chosen = await resolve($, option)
  await updateLanguage($, () => chosen)

  return TEXTS[chosen]
}

/** The texts of the language already chosen; resolves it first when nothing did yet. */
export async function textsOf($: EngineInterface, option: PluginOptions[string] | undefined): Promise<Texts> {
  const chosen = await readLanguage($)

  return chosen === null ? chooseLanguage($, option) : TEXTS[chosen]
}

/** 950 · 12.4k · 312k · 1.2M — one decimal place only below 10; the separator is the language's. */
export function short(n: number, decimal: string): string {
  const [value, suffix] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  const places = suffix && value < 10 ? 1 : 0

  return value.toFixed(places).replace('.', decimal) + suffix
}
