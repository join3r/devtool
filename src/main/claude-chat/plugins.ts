import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import {
  parsePluginList,
  pluginActionArgs,
  type PluginAction,
  type PluginCatalog
} from '../../shared/claude-plugins'

export interface ClaudeCliDeps {
  /** The user's own `claude`, as chat tabs run it. */
  executable: () => string
  env: () => Record<string, string | undefined>
}

const LIST_TIMEOUT_MS = 60_000
/** An install can clone a git repository. */
const CHANGE_TIMEOUT_MS = 180_000

function run(deps: ClaudeCliDeps, cwd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(deps.executable(), args, {
      cwd,
      env: deps.env() as NodeJS.ProcessEnv,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const said = (stderr || stdout || '').trim().split('\n').slice(-6).join('\n')
      const why = (err as { killed?: boolean }).killed ? 'timed out' : err.message
      reject(new Error(said || why))
    })
    // Nothing to type: a question the CLI asks fails at once, not at the timeout.
    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}

/** Installed and marketplace plugins, as `cwd` sees them (project and local scopes depend on it). */
export async function listPlugins(deps: ClaudeCliDeps, cwd: string): Promise<PluginCatalog> {
  const stdout = await run(deps, cwd, ['plugin', 'list', '--json', '--available'], LIST_TIMEOUT_MS)
  // The CLI may record the real path (`/private/tmp/…` for `/tmp/…` on macOS).
  const dirs = [cwd, await realpath(cwd).catch(() => cwd)]
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('Claude did not return a plugin list. Update Claude Code, or run /plugin in a terminal.')
  }
  return parsePluginList(json, dirs)
}

/**
 * One `claude plugin` change. No `--yes`: a plugin that runs a marketplace
 * command to install fails here, and the user installs it in a terminal, where
 * the CLI shows the command first.
 */
export async function changePlugin(deps: ClaudeCliDeps, cwd: string, action: PluginAction, id: string, scope?: string): Promise<void> {
  await run(deps, cwd, pluginActionArgs(action, id, scope), CHANGE_TIMEOUT_MS)
}
