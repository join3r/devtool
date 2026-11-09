/**
 * `/plugins` in a Claude chat tab: DevTool shows its own plugin manager, because
 * the CLI's `/plugin` menu is terminal UI. The data comes from
 * `claude plugin list --json --available`, and changes go through
 * `claude plugin install|uninstall|enable|disable`.
 */

/** The scopes `claude plugin` can write to. */
export const PLUGIN_SCOPES = ['user', 'project', 'local'] as const
export type PluginScope = typeof PLUGIN_SCOPES[number]

export const PLUGIN_ACTIONS = ['install', 'uninstall', 'enable', 'disable'] as const
export type PluginAction = typeof PLUGIN_ACTIONS[number]

export interface InstalledPlugin {
  /** `name@marketplace`. */
  id: string
  name: string
  marketplace: string
  version?: string
  /** `user`, `project`, `local`, or a scope DevTool cannot change (`managed`, `synced`). */
  scope: string
  enabled: boolean
  /** Warnings the CLI attached, such as a plugin that another one shadows. */
  notes?: string[]
}

export interface AvailablePlugin {
  id: string
  name: string
  marketplace: string
  description?: string
  installCount?: number
}

export interface PluginCatalog {
  installed: InstalledPlugin[]
  /** Marketplace plugins, the most installed first. */
  available: AvailablePlugin[]
}

/** A plugin id DevTool passes to `claude plugin`: a name, optionally `@marketplace`. */
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/

export function isPluginId(value: string): boolean {
  return value.length <= 300 && PLUGIN_ID_PATTERN.test(value)
}

export function isPluginScope(value: string): value is PluginScope {
  return (PLUGIN_SCOPES as readonly string[]).includes(value)
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function trimSlash(dir: string): string {
  return dir.replace(/[\\/]+$/u, '')
}

/**
 * The CLI's JSON, cut down to what the sheet shows. Rows without an id are
 * dropped. The CLI lists project and local installs for every project it knows,
 * each with its `projectPath`: only the rows for `projectDirs` stay.
 */
export function parsePluginList(json: unknown, projectDirs?: string[]): PluginCatalog {
  const here = projectDirs ? new Set(projectDirs.map(trimSlash)) : null
  const root = (json && typeof json === 'object' ? json : {}) as { installed?: unknown; available?: unknown }
  // An older CLI without `--available` prints the installed array alone.
  const installedRows = Array.isArray(json) ? json : Array.isArray(root.installed) ? root.installed : []
  const availableRows = Array.isArray(root.available) ? root.available : []

  const installed: InstalledPlugin[] = []
  for (const row of installedRows as Record<string, unknown>[]) {
    const id = text(row?.id)
    if (!id) continue
    const projectPath = text(row.projectPath)
    if (here && projectPath && !here.has(trimSlash(projectPath))) continue
    const notes = Array.isArray(row.notes) ? row.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : []
    const version = text(row.version)
    installed.push({
      id,
      ...splitId(id),
      ...(version && version !== 'unknown' ? { version } : {}),
      scope: text(row.scope) ?? 'user',
      enabled: row.enabled !== false,
      ...(notes.length > 0 ? { notes } : {})
    })
  }
  installed.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))

  const available: AvailablePlugin[] = []
  const seen = new Set<string>()
  for (const row of availableRows as Record<string, unknown>[]) {
    const id = text(row?.pluginId) ?? text(row?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const parts = splitId(id)
    const description = text(row.description)
    const installCount = typeof row.installCount === 'number' && Number.isFinite(row.installCount) ? row.installCount : undefined
    available.push({
      id,
      name: text(row.name) ?? parts.name,
      marketplace: text(row.marketplaceName) ?? parts.marketplace,
      ...(description ? { description } : {}),
      ...(installCount !== undefined ? { installCount } : {})
    })
  }
  available.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name))
  return { installed, available }
}

/**
 * The `claude plugin …` arguments for one change. A scope DevTool cannot write
 * (`managed`, `synced`) is left out, so the CLI picks the scope itself.
 */
export function pluginActionArgs(action: PluginAction, id: string, scope?: string): string[] {
  if (!isPluginId(id)) throw new Error(`Not a plugin id: ${id}`)
  const args = ['plugin', action, id]
  if (scope && isPluginScope(scope)) args.push('--scope', scope)
  return args
}

/** Marketplace plugins that match a search, best match first. */
export function searchPlugins(plugins: AvailablePlugin[], query: string, limit = 50): AvailablePlugin[] {
  const q = query.trim().toLowerCase()
  if (!q) return plugins.slice(0, limit)
  const rank = (plugin: AvailablePlugin): number => {
    const name = plugin.name.toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q)) return 1
    if (name.includes(q)) return 2
    if (plugin.description?.toLowerCase().includes(q)) return 3
    return 4
  }
  return plugins
    .map((plugin, index) => ({ plugin, index, rank: rank(plugin) }))
    .filter((row) => row.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.plugin)
}

/**
 * The marketplace search of `/plugins`. The CLI leaves installed plugins out of
 * its marketplace list, so a search also finds them, and they are marked installed.
 */
export function searchCatalog(catalog: PluginCatalog, query: string, limit = 50): (AvailablePlugin & { installed: boolean })[] {
  const installedIds = new Set(catalog.installed.map((p) => p.id))
  const listed = new Set(catalog.available.map((p) => p.id))
  const extra = catalog.installed
    .filter((p) => p.marketplace && !listed.has(p.id) && isPluginScope(p.scope))
    .filter((p, index, all) => all.findIndex((other) => other.id === p.id) === index)
    .map((p): AvailablePlugin => ({ id: p.id, name: p.name, marketplace: p.marketplace }))
  const pool = query.trim() ? [...catalog.available, ...extra] : catalog.available
  return searchPlugins(pool, query, limit).map((p) => ({ ...p, installed: installedIds.has(p.id) }))
}
