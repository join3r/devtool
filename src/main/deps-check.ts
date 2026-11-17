import fs from 'fs'
import path from 'path'

/**
 * Whether a linked `node_modules` is the right one to share. A worktree used
 * to link its source checkout's `node_modules` unconditionally, so a stream
 * whose lockfile moved ahead of `main` (a dependency upgrade) ran every task
 * against `main`'s old packages. These checks let worktree setup link only a
 * folder that matches the worktree's own lockfile.
 */

/** Lockfiles DevTool knows, by package manager. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const

/** `node_modules` or `<dir>/node_modules`: the entries whose sharing depends on a lockfile. */
export function isNodeModulesEntry(entry: string): boolean {
  return path.posix.basename(entry) === 'node_modules'
}

function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/**
 * The lockfiles that differ between `a` and `b` (both folders holding a
 * `node_modules`): present in one and not the other, or with other bytes.
 * Empty when they match, including when neither has a lockfile.
 */
export function lockfileDifferences(a: string, b: string): string[] {
  const differ: string[] = []
  for (const name of LOCKFILES) {
    const left = readOrNull(path.join(a, name))
    const right = readOrNull(path.join(b, name))
    if (left === null && right === null) continue
    if (left === null || right === null || !left.equals(right)) differ.push(name)
  }
  return differ
}

interface NpmLockEntry {
  version?: string
  link?: boolean
  optional?: boolean
  devOptional?: boolean
}

function npmPackages(file: string): Record<string, NpmLockEntry> | null {
  const bytes = readOrNull(file)
  if (!bytes) return null
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { packages?: unknown }
    return parsed.packages && typeof parsed.packages === 'object' ? parsed.packages as Record<string, NpmLockEntry> : null
  } catch {
    return null
  }
}

export type DepsState =
  | { state: 'match' }
  | { state: 'stale'; reason: string }
  /** No way to tell (no lockfile, a package manager without a record of what it installed): treated as a match. */
  | { state: 'unknown' }

/**
 * Whether `nodeModules` holds what the lockfile in `lockDir` asks for.
 * Only npm (v7+) leaves a record to check against: its hidden lockfile,
 * `node_modules/.package-lock.json`. Every package the lockfile installs
 * under `node_modules/` must be there at the locked version; optional ones
 * may be missing (another platform's binaries).
 */
export function nodeModulesState(lockDir: string, nodeModules: string): DepsState {
  const lock = npmPackages(path.join(lockDir, 'package-lock.json')) ?? npmPackages(path.join(lockDir, 'npm-shrinkwrap.json'))
  if (!lock) return { state: 'unknown' }
  if (!fs.existsSync(nodeModules)) return { state: 'stale', reason: 'node_modules is missing' }
  const installed = npmPackages(path.join(nodeModules, '.package-lock.json'))
  if (!installed) return { state: 'unknown' }
  let missing = 0
  let other = 0
  let example = ''
  for (const [key, entry] of Object.entries(lock)) {
    if (!key.startsWith('node_modules/') || entry.link) continue
    const have = installed[key]
    if (!have) {
      if (entry.optional || entry.devOptional) continue
      missing++
      example ||= `${key.slice('node_modules/'.length)} is missing`
    } else if (entry.version && have.version !== entry.version) {
      other++
      example ||= `${key.slice('node_modules/'.length)} is ${have.version}, the lockfile wants ${entry.version}`
    }
  }
  if (missing + other === 0) return { state: 'match' }
  const counts = [missing ? `${missing} missing` : '', other ? `${other} at another version` : ''].filter(Boolean).join(', ')
  return { state: 'stale', reason: `${counts} (${example})` }
}
