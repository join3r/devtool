import fs from 'fs'
import os from 'os'
import path from 'path'

/** One model an agent offers, in the agent's own order (its first is its preferred). */
export interface AgentModel {
  id: string
  /** Kept out of the picker (`visibility: hide`): taken only when named exactly. */
  hidden?: boolean
}

/**
 * The models Codex offers this account, from the list it caches in
 * `$CODEX_HOME/models_cache.json` (sorted by its `priority`, best first). Null
 * when there is no readable cache: then nothing can be checked.
 */
export function readCodexModels(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): AgentModel[] | null {
  const home = env.CODEX_HOME || path.join(homeDir, '.codex')
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'))
  } catch {
    return null
  }
  const list = raw && typeof raw === 'object' ? (raw as { models?: unknown }).models : undefined
  if (!Array.isArray(list)) return null
  const models = list.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return []
    const { slug, visibility, priority } = entry as Record<string, unknown>
    if (typeof slug !== 'string' || !slug) return []
    return [{ id: slug, hidden: visibility === 'hide', rank: typeof priority === 'number' ? priority : 1000 + index }]
  })
  if (models.length === 0) return null
  return models.sort((a, b) => a.rank - b.rank).map(({ id, hidden }) => (hidden ? { id, hidden } : { id }))
}

export type ModelResolution =
  | { ok: true; model: string; note?: string }
  | { ok: false; error: string }

/**
 * The model id `asked` means among `models`: an exact id (any case), or else a
 * short name whose words are all words of an id (`luna` → `gpt-6-luna`), the
 * agent's preferred one when several fit. An unknown name is an error that
 * lists what there is.
 */
export function resolveModel(asked: string, models: readonly AgentModel[], agentLabel: string): ModelResolution {
  const wanted = asked.trim().toLowerCase()
  const exact = models.find(m => m.id.toLowerCase() === wanted)
  if (exact) return { ok: true, model: exact.id }
  const listed = models.filter(m => !m.hidden)
  const words = wanted.split(/[-_\s/]+/).filter(Boolean)
  const fits = words.length === 0 ? [] : listed.filter(m => {
    const own = m.id.toLowerCase().split('-')
    return words.every(w => own.includes(w))
  })
  if (fits.length === 0) {
    return { ok: false, error: `${agentLabel} has no model "${asked}". Its models: ${listed.map(m => m.id).join(', ')}.` }
  }
  const [model, ...others] = fits
  return {
    ok: true,
    model: model.id,
    note: `"${asked}" is ${model.id}${others.length > 0 ? ` (also fits: ${others.map(m => m.id).join(', ')}; name one of those to use it instead)` : ''}.`
  }
}
