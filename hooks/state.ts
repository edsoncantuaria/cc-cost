import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Language, Mode, Spend, Tokens } from '../types'

// Everything the mod remembers lives here, in the session's $.state: per session, kept across hot reloads.
// The other files reach it only through these functions, since the engine's scan reads each atom where it is declared.
const spend = atom({ plugin: 'cc-cost', key: 'spend' } as const, null)
const compacting = atom({ plugin: 'cc-cost', key: 'compacting' } as const, null)
const failing = atom({ plugin: 'cc-cost', key: 'failing' } as const, null)
const warned = atom({ plugin: 'cc-cost', key: 'warned' } as const, false)
const language = atom({ plugin: 'cc-cost', key: 'language' } as const, null)

export const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const EMPTY: Spend = { session: ZERO, today: 0, day: '', own: { key: '', n: 0 }, turns: [], inTurn: false, limits: [], context: null, window: null, modelWindow: null, agents: {} }

export function readSpend($: EngineInterface) {
  return read($, spend)
}

export function updateSpend($: EngineInterface, change: (s: Spend | null) => Spend | null) {
  return update($, spend, change)
}

export function readCompacting($: EngineInterface) {
  return read($, compacting)
}

export function updateCompacting($: EngineInterface, change: (m: Mode | null) => Mode | null) {
  return update($, compacting, change)
}

export function readFailing($: EngineInterface) {
  return read($, failing)
}

export function updateFailing($: EngineInterface, change: (hooks: string[] | null) => string[] | null) {
  return update($, failing, change)
}

export function readWarned($: EngineInterface) {
  return read($, warned)
}

export function updateWarned($: EngineInterface, change: (w: boolean) => boolean) {
  return update($, warned, change)
}

export function readLanguage($: EngineInterface) {
  return read($, language)
}

export function updateLanguage($: EngineInterface, change: (l: Language | null) => Language | null) {
  return update($, language, change)
}
