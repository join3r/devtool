/**
 * Secrets an agent asks the user for (`request_secret`, `devtool-mcp.ts`).
 *
 * The value goes from the masked field in a window to main, which writes it into
 * a file in the task's folder the agent names (a gitignored `.env` by default)
 * and, when the user ticks Remember, keeps it encrypted per project
 * (`main/secrets/secret-store.ts`). It never goes into the tool's answer, the
 * projects data, the logs or the phone. Chat views see `[secret NAME]` wherever
 * a known value would show (`redactSecrets`).
 */

/** A request a window shows: everything but the value, which nobody has yet. */
export interface SecretRequest {
  id: string
  projectId: string
  taskId: string
  tabId: string
  /** An env var name: `OPENAI_API_KEY`. */
  name: string
  /** Why the agent needs it, in its words. */
  reason: string
  /** Where the value goes, relative to the task's folder. */
  file: string
  /** A value for `name` is saved for this project: the prompt offers it. */
  saved: boolean
  createdAt: number
}

/** A window's answer to a request. */
export type SecretAnswer =
  | { kind: 'value'; value: string; remember: boolean }
  | { kind: 'saved' }
  | { kind: 'decline' }

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const SECRET_VALUE_MAX = 64 * 1024
export const SECRET_REASON_MAX = 300
export const DEFAULT_SECRET_FILE = '.env'

/** Values shorter than this are not redacted: they would hit ordinary words. */
export const REDACT_MIN_LENGTH = 8

export function validSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name)
}

/**
 * The file's path relative to the task's folder, normalized, or null when it
 * would leave the folder or land in `.git`. Plain string work, so it reads the
 * same on every platform.
 */
export function safeSecretFile(file: string): string | null {
  const raw = file.trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return null
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  if (parts.length === 0) return null
  // Any `.git`, at any depth and in any case (macOS and Windows folders ignore case).
  if (parts.some(part => part.toLowerCase() === '.git')) return null
  return parts.join('/')
}

/** A dotenv file (`.env`, `.env.local`, `prod.env`) gets `NAME=value`; any other file holds the value alone. */
export function isDotenvFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel
  return /^\.env(\..+)?$/.test(base) || base.endsWith('.env')
}

/** One dotenv value: bare when it is plain, quoted otherwise. */
export function dotenvValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:+@%,~^]*$/.test(value)) return value
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\$/g, '\\$')}"`
}

/**
 * `content` (a dotenv file, maybe empty) with `name` set to `value`: the first
 * line that sets it is replaced (keeping an `export ` prefix), any later ones
 * are dropped, and a new name goes at the end.
 */
export function upsertDotenv(content: string, name: string, value: string): string {
  const line = `${name}=${dotenvValue(value)}`
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content === '' ? [] : content.split(/\r?\n/)
  // A trailing newline leaves one empty last element; put it back at the end.
  const trailing = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailing) lines.pop()
  const setter = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
  let done = false
  const out: string[] = []
  for (const existing of lines) {
    const match = setter.exec(existing)
    if (!match) {
      out.push(existing)
      continue
    }
    if (done) continue
    out.push(`${match[1] ? 'export ' : ''}${line}`)
    done = true
  }
  if (!done) out.push(line)
  return out.join(eol) + eol
}

/** Known values by the name each one is shown as; longest first, so one inside another can't leave a piece. */
export type RedactionList = ReadonlyArray<{ name: string; value: string }>

export function redactionList(entries: Iterable<{ name: string; value: string }>): RedactionList {
  const seen = new Set<string>()
  const out: { name: string; value: string }[] = []
  for (const entry of entries) {
    if (entry.value.length < REDACT_MIN_LENGTH || seen.has(entry.value)) continue
    seen.add(entry.value)
    out.push(entry)
  }
  return out.sort((a, b) => b.value.length - a.value.length)
}

/** `text` with every known value replaced by `[secret NAME]`. */
export function redactSecrets(text: string, list: RedactionList): string {
  let out = text
  for (const { name, value } of list) {
    if (out.includes(value)) out = out.split(value).join(`[secret ${name}]`)
  }
  return out
}

/**
 * `value` with every string in it redacted, objects and arrays copied only
 * where something changed (so an untouched event stays the same object).
 */
export function redactDeep<T>(value: T, list: RedactionList): T {
  if (list.length === 0) return value
  return walk(value, list, 0) as T
}

function walk(value: unknown, list: RedactionList, depth: number): unknown {
  if (typeof value === 'string') return redactSecrets(value, list)
  if (depth > 64 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const next = walk(value[i], list, depth + 1)
      if (next !== value[i]) {
        copy ??= value.slice()
        copy[i] = next
      }
    }
    return copy ?? value
  }
  // Only plain objects: a Buffer or typed array (an image) is left alone.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  let copy: Record<string, unknown> | null = null
  for (const [key, item] of Object.entries(value)) {
    const next = walk(item, list, depth + 1)
    if (next !== item) {
      copy ??= { ...(value as Record<string, unknown>) }
      copy[key] = next
    }
  }
  return copy ?? value
}
