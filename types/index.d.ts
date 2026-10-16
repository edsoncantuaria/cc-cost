export type Tokens = { entrada: number; saida: number; cacheLido: number; cacheEscrito: number }

/** micro: tira as leituras de arquivo (plugin micro-compaction); resumo: o /compact nativo. */
export type Modo = 'micro' | 'resumo'

export type Limite ={ kind: string; percentUsed: number; resetsAt?: string }

export type Gasto = {
  sessao: Tokens
  /** Tokens novos do dia, somando todas as sessões (chaves `novos:<dia>:*` do $.store). */
  hoje: number
  /** Chave do $.store desta sessão no dia e o quanto ela já gravou ali. */
  proprio: { chave: string; n: number }
  /** Tokens novos por turno da thread principal, os mais recentes, para a sparkline. */
  turnos: number[]
  /** Se um turno da thread principal está rodando: só então o uso entra na última barra. */
  emTurno: boolean
  limites: Limite[]
  /** Tokens do contexto atual (entrada da última resposta); null antes da primeira e depois do /clear. */
  contexto: number | null
  /** Janela de compactação (autoCompactWindow), de onde saem os limiares do ctx; null até a primeira leitura. */
  janela: number | null
  /** Contexto de cada subagente rodando (entrada da última resposta dele), 0 antes da primeira; o ctx é só da thread principal. */
  agentes?: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    /** `compactando`: qual compactação o botão está rodando; null fora dela. */
    'cc-cost': { tokens: Gasto | null; compactando: Modo | null }
  }
}
