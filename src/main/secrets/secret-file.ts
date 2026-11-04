import fs from 'fs'
import path from 'path'
import type { GitRunner } from '../git-runner'
import { isDotenvFile, upsertDotenv } from '../../shared/secrets'

/**
 * Where a secret lands on disk: a file in the task's folder the agent named.
 * A dotenv file (`.env`, `.env.local`, `prod.env`) gets a `NAME=value` line; any
 * other file holds the value alone. The file must not be tracked by git, and is
 * kept out of commits through the repo's `.git/info/exclude` (local, never
 * committed) when nothing ignores it yet.
 */

/**
 * Null when `full`'s folder, with every symlink resolved, is still inside
 * `dir`; else the error. A folder that doesn't exist yet passes (its nearest
 * existing parent is checked).
 */
function outsideDir(dir: string, full: string, rel: string): string | null {
  let root: string
  try {
    root = fs.realpathSync(dir)
  } catch {
    return `The task's folder is missing.`
  }
  let parent = path.dirname(full)
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent)
  let real: string
  try {
    real = fs.realpathSync(parent)
  } catch {
    return `Couldn't resolve ${rel}.`
  }
  return real === root || real.startsWith(root + path.sep) ? null : `${rel} leads outside the task's folder (through a symlink).`
}

/** An error to tell the agent before the user is asked anything, or null when the file can take a secret. */
export async function checkSecretFile(dir: string, rel: string, git: GitRunner): Promise<string | null> {
  const full = path.join(dir, rel)
  const outside = outsideDir(dir, full, rel)
  if (outside) return outside
  try {
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) return `${rel} is a symlink. Name a plain file.`
    if (!stat.isFile()) return `${rel} is not a file.`
  } catch {
    // Not there yet: it will be made.
  }
  const tracked = await git.run(['ls-files', '--error-unmatch', '--', rel], { cwd: dir })
  if (tracked.code === 0) return `${rel} is tracked by git, so the secret would be committed. Name a file git ignores (for example .env).`
  return null
}

/** Escapes gitignore pattern characters in a literal path. */
function literalPattern(rel: string): string {
  return rel.replace(/([\\*?[\]!#])/g, '\\$1')
}

/** Makes git ignore `rel` (relative to `dir`) when nothing does yet. True when it added a line. */
export async function excludeFromGit(dir: string, rel: string, git: GitRunner): Promise<boolean> {
  const ignored = await git.run(['check-ignore', '-q', '--', rel], { cwd: dir })
  // 0: ignored already. Anything but 1 (not ignored): no repo, or git failed.
  if (ignored.code !== 1) return false
  const [excludeOut, prefixOut] = await Promise.all([
    git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: dir }),
    git.run(['rev-parse', '--show-prefix'], { cwd: dir })
  ])
  if (excludeOut.code !== 0 || prefixOut.code !== 0) return false
  const excludeFile = path.resolve(dir, excludeOut.stdout.trim())
  const line = `/${literalPattern(prefixOut.stdout.trim() + rel)}`
  let current = ''
  try {
    current = fs.readFileSync(excludeFile, 'utf-8')
  } catch {
    // No exclude file yet.
  }
  if (current.split(/\r?\n/).includes(line)) return false
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(excludeFile, `${sep}# A secret DevTool wrote\n${line}\n`)
  return true
}

/** Writes `value` into `rel` under `dir` (see the module note). */
export async function writeSecretFile(dir: string, rel: string, name: string, value: string, git: GitRunner): Promise<{ excluded: boolean }> {
  // Ignored first: a landing that commits everything must never see it unignored.
  const excluded = await excludeFromGit(dir, rel, git).catch(() => false)
  const full = path.join(dir, rel)
  // Checked again here, not only before asking: the folders may have changed since.
  const before = outsideDir(dir, full, rel)
  if (before) throw new Error(before)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const after = outsideDir(dir, full, rel)
  if (after) throw new Error(after)
  // One handle for reading, checking and writing: O_NOFOLLOW refuses a symlink put
  // in its place, no O_TRUNC until it is known to be this folder's own plain file.
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(full, flags, 0o600)
  try {
    const stat = fs.fstatSync(fd)
    // A hard link would put the value into another file as well.
    if (!stat.isFile() || stat.nlink > 1) throw new Error(`${rel} is not a plain file of its own.`)
    let content = value
    if (isDotenvFile(rel)) {
      const current = stat.size > 0 ? readAll(fd, stat.size) : ''
      content = upsertDotenv(current, name, value)
    }
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, content, 0)
    try { fs.fchmodSync(fd, 0o600) } catch { /* not on every filesystem */ }
  } finally {
    fs.closeSync(fd)
  }
  return { excluded }
}

function readAll(fd: number, size: number): string {
  const buf = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const n = fs.readSync(fd, buf, read, size - read, read)
    if (n === 0) break
    read += n
  }
  return buf.subarray(0, read).toString('utf-8')
}
