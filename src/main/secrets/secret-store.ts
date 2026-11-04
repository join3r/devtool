import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import type { SecretEncryptor } from '../mobile/identity'
import { validSecretName } from '../../shared/secrets'

/**
 * Secrets the user chose to remember, per project: `<configDir>/secrets.json`
 * (mode 0600), each value encrypted on its own with the OS keychain's key
 * (Electron `safeStorage`). Names are kept in clear so the list shows without a
 * Keychain prompt; a value is decrypted only when it is used.
 *
 * Nothing is ever written unencrypted: without encryption, `set` refuses.
 */

interface StoredSecret {
  /** base64 of the encrypted value. */
  data: string
  savedAt: number
}

interface SecretsFile {
  version: 1
  projects: Record<string, Record<string, StoredSecret>>
}

export interface SavedSecretInfo {
  name: string
  savedAt: number
}

export class SecretStore {
  private readonly file: string
  private cache: SecretsFile | null = null

  constructor(
    private readonly dir: string,
    private readonly encryptor: SecretEncryptor,
    private readonly log: (message: string) => void = () => {}
  ) {
    this.file = path.join(dir, 'secrets.json')
  }

  /** Whether `set` can save on this machine. */
  canSave(): boolean {
    try {
      return this.encryptor.isAvailable()
    } catch {
      return false
    }
  }

  list(projectId: string): SavedSecretInfo[] {
    const entries = this.read().projects[projectId] ?? {}
    return Object.entries(entries)
      .map(([name, entry]) => ({ name, savedAt: entry.savedAt }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Any secret saved at all; reads the file only, never the keychain. */
  hasAny(): boolean {
    return Object.keys(this.read().projects).length > 0
  }

  has(projectId: string, name: string): boolean {
    return !!this.read().projects[projectId]?.[name]
  }

  /** The saved value, or null when there is none or it can't be decrypted. */
  get(projectId: string, name: string): string | null {
    const entry = this.read().projects[projectId]?.[name]
    if (!entry) return null
    try {
      return this.encryptor.decrypt(Buffer.from(entry.data, 'base64'))
    } catch (err) {
      this.log(`secretStore decrypt-failed project=${projectId} name=${name} error=${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** Every saved value that decrypts, in every project: what redaction must know from startup. */
  all(): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = []
    for (const [projectId, entries] of Object.entries(this.read().projects)) {
      for (const name of Object.keys(entries)) {
        const value = this.get(projectId, name)
        if (value !== null) out.push({ name, value })
      }
    }
    return out
  }

  /** Saves `value` encrypted; false (nothing written) when this machine can't encrypt. */
  set(projectId: string, name: string, value: string, now = Date.now()): boolean {
    if (!validSecretName(name)) throw new Error(`Not a secret name: ${name}`)
    if (!this.canSave()) return false
    const data = this.encryptor.encrypt(value).toString('base64')
    const file = this.read()
    const next: SecretsFile = {
      ...file,
      projects: { ...file.projects, [projectId]: { ...(file.projects[projectId] ?? {}), [name]: { data, savedAt: now } } }
    }
    this.write(next)
    return true
  }

  delete(projectId: string, name: string): boolean {
    const file = this.read()
    const entries = file.projects[projectId]
    if (!entries?.[name]) return false
    const { [name]: _gone, ...rest } = entries
    const projects = { ...file.projects }
    if (Object.keys(rest).length > 0) projects[projectId] = rest
    else delete projects[projectId]
    this.write({ ...file, projects })
    return true
  }

  /** Forgets every secret of a project (it was removed). */
  deleteProject(projectId: string): void {
    const file = this.read()
    if (!file.projects[projectId]) return
    const projects = { ...file.projects }
    delete projects[projectId]
    this.write({ ...file, projects })
  }

  private read(): SecretsFile {
    if (this.cache) return this.cache
    let parsed: SecretsFile = { version: 1, projects: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<SecretsFile>
      if (raw && raw.version === 1 && raw.projects && typeof raw.projects === 'object') parsed = { version: 1, projects: sanitize(raw.projects) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`secretStore unreadable error=${err instanceof Error ? err.message : String(err)}`)
    }
    this.cache = parsed
    return parsed
  }

  private write(next: SecretsFile): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(this.file, JSON.stringify(next, null, 2), 0o600)
    this.cache = next
  }
}

function sanitize(projects: Record<string, unknown>): SecretsFile['projects'] {
  const out: SecretsFile['projects'] = {}
  for (const [projectId, entries] of Object.entries(projects)) {
    if (!entries || typeof entries !== 'object') continue
    const kept: Record<string, StoredSecret> = {}
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      const e = entry as Partial<StoredSecret> | null
      if (!validSecretName(name) || !e || typeof e.data !== 'string') continue
      kept[name] = { data: e.data, savedAt: typeof e.savedAt === 'number' ? e.savedAt : 0 }
    }
    if (Object.keys(kept).length > 0) out[projectId] = kept
  }
  return out
}
