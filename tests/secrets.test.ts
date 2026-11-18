import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  dotenvValue,
  isDotenvFile,
  redactDeep,
  redactSecrets,
  redactionList,
  safeSecretFile,
  upsertDotenv,
  validSecretName
} from '../src/shared/secrets'
import { SecretStore } from '../src/main/secrets/secret-store'
import { SecretRequests, type SecretRequestInput } from '../src/main/secrets/secret-requests'
import { checkSecretFile, writeSecretFile } from '../src/main/secrets/secret-file'
import { LocalGitRunner } from '../src/main/git-runner'
import { reduceAgentActivity, describeActivity } from '../src/shared/agent-activity'
import { phoneActivityLabel } from '../src/main/mobile/inbox'

/** Reversible and visibly not plaintext, like safeStorage's output. */
function fakeEncryptor(available = true) {
  return {
    isAvailable: () => available,
    encrypt: (plaintext: string) => Buffer.from(`enc:${Buffer.from(plaintext).toString('hex')}`),
    decrypt: (ciphertext: Buffer) => {
      const text = ciphertext.toString()
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(text.slice(4), 'hex').toString()
    }
  }
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-secrets-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('names and files', () => {
  it('takes env var names only', () => {
    expect(validSecretName('OPENAI_API_KEY')).toBe(true)
    expect(validSecretName('_x1')).toBe(true)
    expect(validSecretName('1KEY')).toBe(false)
    expect(validSecretName('MY KEY')).toBe(false)
    expect(validSecretName('KEY=1')).toBe(false)
    expect(validSecretName('')).toBe(false)
  })

  it('keeps the file inside the task folder and out of .git', () => {
    expect(safeSecretFile('.env')).toBe('.env')
    expect(safeSecretFile('./config/.env.local')).toBe('config/.env.local')
    expect(safeSecretFile('a\\b.txt')).toBe('a/b.txt')
    expect(safeSecretFile('../.env')).toBeNull()
    expect(safeSecretFile('a/../../.env')).toBeNull()
    expect(safeSecretFile('/etc/passwd')).toBeNull()
    expect(safeSecretFile('C:/x/.env')).toBeNull()
    expect(safeSecretFile('.git/config')).toBeNull()
    expect(safeSecretFile('.GIT/config')).toBeNull()
    expect(safeSecretFile('sub/.Git/hooks/pre-commit')).toBeNull()
    expect(safeSecretFile('  ')).toBeNull()
  })

  it('knows dotenv files', () => {
    expect(isDotenvFile('.env')).toBe(true)
    expect(isDotenvFile('app/.env.local')).toBe(true)
    expect(isDotenvFile('prod.env')).toBe(true)
    expect(isDotenvFile('secrets/token.txt')).toBe(false)
  })
})

describe('dotenv', () => {
  it('quotes only what needs it', () => {
    expect(dotenvValue('sk-abc_123')).toBe('sk-abc_123')
    expect(dotenvValue('has space')).toBe("'has space'")
    expect(dotenvValue('a#b$c')).toBe("'a#b$c'")
    expect(dotenvValue("it's\nmulti")).toBe('"it\'s\\nmulti"')
    expect(dotenvValue('q"$x\'')).toBe('"q\\"\\$x\'"')
  })

  it('sets a new name at the end and replaces an existing one in place', () => {
    expect(upsertDotenv('', 'KEY', 'v1')).toBe('KEY=v1\n')
    expect(upsertDotenv('A=1\n', 'KEY', 'v1')).toBe('A=1\nKEY=v1\n')
    expect(upsertDotenv('A=1', 'KEY', 'v1')).toBe('A=1\nKEY=v1\n')
    expect(upsertDotenv('# c\nKEY=old\nB=2\nKEY=dup\n', 'KEY', 'new')).toBe('# c\nKEY=new\nB=2\n')
    expect(upsertDotenv('export KEY=old\n', 'KEY', 'new')).toBe('export KEY=new\n')
    expect(upsertDotenv('KEY_2=x\n', 'KEY', 'y')).toBe('KEY_2=x\nKEY=y\n')
    expect(upsertDotenv('A=1\r\n', 'KEY', 'v')).toBe('A=1\r\nKEY=v\r\n')
  })
})

describe('redaction', () => {
  const list = redactionList([
    { name: 'SHORT', value: 'abc' },
    { name: 'KEY', value: 'sk-live-123456789' },
    { name: 'LONG', value: 'sk-live-123456789-extra' }
  ])

  it('skips values too short to redact safely, longest first', () => {
    expect(list.map(e => e.name)).toEqual(['LONG', 'KEY'])
  })

  it('replaces every occurrence with the name', () => {
    expect(redactSecrets('a sk-live-123456789 b sk-live-123456789', list)).toBe('a [secret KEY] b [secret KEY]')
    expect(redactSecrets('x sk-live-123456789-extra', list)).toBe('x [secret LONG]')
    expect(redactSecrets('abc stays', list)).toBe('abc stays')
  })

  it('walks events and copies only what changed', () => {
    const untouched = { t: 'text', text: 'nothing here', nested: [{ a: 1 }] }
    expect(redactDeep(untouched, list)).toBe(untouched)
    const event = { t: 'tool', input: { command: 'curl -H "Authorization: sk-live-123456789"' }, other: { keep: true } }
    const out = redactDeep(event, list)
    expect(out).not.toBe(event)
    expect(out.input.command).toBe('curl -H "Authorization: [secret KEY]"')
    expect(out.other).toBe(event.other)
    expect(event.input.command).toContain('sk-live-123456789')
    expect(redactDeep(['sk-live-123456789'], list)).toEqual(['[secret KEY]'])
    expect(redactDeep(event, [])).toBe(event)
  })
})

describe('SecretStore', () => {
  it('saves encrypted, lists names, reads back and forgets', () => {
    const store = new SecretStore(dir, fakeEncryptor())
    expect(store.set('p1', 'KEY', 'sk-live-123456789', 1000)).toBe(true)
    store.set('p1', 'OTHER', 'value-two-123', 2000)
    store.set('p2', 'KEY', 'p2-value-123456')
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf-8')
    expect(raw).not.toContain('sk-live-123456789')
    expect(raw).toContain('"KEY"')
    expect((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777).toString(8)).toBe('600')

    const fresh = new SecretStore(dir, fakeEncryptor())
    expect(fresh.list('p1')).toEqual([{ name: 'KEY', savedAt: 1000 }, { name: 'OTHER', savedAt: 2000 }])
    expect(fresh.has('p1', 'KEY')).toBe(true)
    expect(fresh.get('p1', 'KEY')).toBe('sk-live-123456789')
    expect(fresh.get('p2', 'KEY')).toBe('p2-value-123456')
    expect(fresh.get('p1', 'NOPE')).toBeNull()

    expect(fresh.delete('p1', 'KEY')).toBe(true)
    expect(fresh.delete('p1', 'KEY')).toBe(false)
    expect(new SecretStore(dir, fakeEncryptor()).list('p1').map(s => s.name)).toEqual(['OTHER'])
    fresh.deleteProject('p2')
    expect(new SecretStore(dir, fakeEncryptor()).list('p2')).toEqual([])
  })

  it('never writes a value it cannot encrypt', () => {
    const store = new SecretStore(dir, fakeEncryptor(false))
    expect(store.canSave()).toBe(false)
    expect(store.set('p1', 'KEY', 'sk-live-123456789')).toBe(false)
    expect(fs.existsSync(path.join(dir, 'secrets.json'))).toBe(false)
  })

  it('answers null for a value it cannot decrypt', () => {
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, projects: { p1: { KEY: { data: 'garbage', savedAt: 1 }, 'bad name': { data: 'x' } } } }))
    const store = new SecretStore(dir, fakeEncryptor())
    expect(store.list('p1').map(s => s.name)).toEqual(['KEY'])
    expect(store.get('p1', 'KEY')).toBeNull()
  })
})

describe('SecretRequests', () => {
  function setup(write = async () => ({ excluded: true })) {
    const store = new SecretStore(dir, fakeEncryptor())
    const writes: { dir: string; file: string; name: string; value: string }[] = []
    const changes: number[] = []
    const opened: string[] = []
    const closed: string[] = []
    const requests = new SecretRequests({
      store,
      write: async (d, file, name, value) => { writes.push({ dir: d, file, name, value }); return write() },
      onChange: (list) => changes.push(list.length),
      onOpen: (r) => opened.push(r.name),
      onClose: (r) => closed.push(r.name)
    })
    return { store, requests, writes, changes, opened, closed }
  }
  const input: SecretRequestInput = { projectId: 'p1', taskId: 't1', tabId: 'tab1', name: 'KEY', reason: 'tests', file: '.env', dir: '/work/t1' }

  it('waits for the value, writes it, and learns it for redaction', async () => {
    const { requests, writes, opened, closed, changes } = setup()
    const pending = requests.request(input)
    const [open] = requests.list()
    expect(open).toMatchObject({ name: 'KEY', reason: 'tests', file: '.env', taskId: 't1', saved: false, canRemember: true })
    expect(JSON.stringify(open)).not.toContain('sk-')
    expect(opened).toEqual(['KEY'])
    expect(await requests.answer(open.id, { kind: 'value', value: 'sk-live-123456789', remember: false })).toEqual({ ok: true })
    expect(await pending).toEqual({ status: 'provided', file: '.env', excluded: true, remembered: false, rememberFailed: false, fromSaved: false })
    expect(writes).toEqual([{ dir: '/work/t1', file: '.env', name: 'KEY', value: 'sk-live-123456789' }])
    expect(requests.list()).toEqual([])
    expect(closed).toEqual(['KEY'])
    expect(changes).toEqual([1, 0])
    expect(redactSecrets('use sk-live-123456789', requests.redactionList())).toBe('use [secret KEY]')
  })

  it('remembers when asked, and offers the saved value next time', async () => {
    const { requests, store } = setup()
    const first = requests.request(input)
    await requests.answer(requests.list()[0].id, { kind: 'value', value: 'sk-live-123456789', remember: true })
    expect(await first).toMatchObject({ status: 'provided', remembered: true })
    expect(store.get('p1', 'KEY')).toBe('sk-live-123456789')

    const second = requests.request({ ...input, taskId: 't2', tabId: 'tab2' })
    expect(requests.list()[0].saved).toBe(true)
    await requests.answer(requests.list()[0].id, { kind: 'saved' })
    expect(await second).toMatchObject({ status: 'provided', fromSaved: true })
  })

  it('offers no Remember where nothing can be kept (a DevTool server)', async () => {
    const requests = new SecretRequests({ store: new SecretStore(dir, fakeEncryptor(false)), write: async () => ({ excluded: true }), onChange: () => {} })
    const pending = requests.request(input)
    expect(requests.list()[0]).toMatchObject({ canRemember: false, saved: false })
    await requests.answer(requests.list()[0].id, { kind: 'decline' })
    expect(await pending).toEqual({ status: 'declined' })
  })

  it('knows remembered values again after a restart', () => {
    const store = new SecretStore(dir, fakeEncryptor())
    expect(store.hasAny()).toBe(false)
    store.set('p1', 'KEY', 'sk-live-123456789')
    const restarted = new SecretRequests({ store: new SecretStore(dir, fakeEncryptor()), write: async () => ({ excluded: false }), onChange: () => {} })
    expect(restarted.redactionList()).toEqual([])
    restarted.learnSaved()
    expect(redactSecrets('x sk-live-123456789', restarted.redactionList())).toBe('x [secret KEY]')
  })

  it('declines, and keeps the prompt open on a failed write', async () => {
    const { requests } = setup(async () => { throw new Error('disk full') })
    const pending = requests.request(input)
    const id = requests.list()[0].id
    const failed = await requests.answer(id, { kind: 'value', value: 'sk-live-123456789', remember: false })
    expect(failed).toEqual({ ok: false, error: "Couldn't write .env: disk full" })
    expect(requests.list()).toHaveLength(1)
    // A value that never reached the file is not learned either.
    expect(requests.redactionList()).toEqual([])
    expect(await requests.answer(id, { kind: 'value', value: '', remember: false })).toEqual({ ok: false, error: 'Enter a value.' })
    expect(await requests.answer(id, { kind: 'decline' })).toEqual({ ok: true })
    expect(await pending).toEqual({ status: 'declined' })
    expect(await requests.answer(id, { kind: 'decline' })).toEqual({ ok: false, error: 'That request is gone.' })
  })

  it('closes when the agent goes away, the tab closes, or time runs out', async () => {
    const { requests } = setup()
    const aborter = new AbortController()
    const gone = requests.request(input, aborter.signal)
    aborter.abort()
    expect(await gone).toEqual({ status: 'cancelled' })
    expect(requests.list()).toEqual([])

    const closing = requests.request(input)
    requests.cancelTab('tab1')
    expect(await closing).toEqual({ status: 'cancelled' })

    expect(await requests.request(input, undefined, 5)).toEqual({ status: 'timeout' })
    expect(requests.list()).toEqual([])
  })

  it('shares one prompt when a tab asks for the same name twice', async () => {
    const { requests } = setup()
    const a = requests.request(input)
    const b = requests.request(input)
    expect(requests.list()).toHaveLength(1)
    await requests.answer(requests.list()[0].id, { kind: 'value', value: 'sk-live-123456789', remember: false })
    expect((await a).status).toBe('provided')
    expect((await b).status).toBe('provided')
  })
})

describe('secret files', () => {
  const git = new LocalGitRunner()
  function repo(): string {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  it('writes a dotenv line and makes git ignore the file', async () => {
    repo()
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
    expect(await checkSecretFile(dir, '.env', git)).toBeNull()
    expect(await writeSecretFile(dir, '.env', 'KEY', 'sk-live-123456789', git)).toEqual({ excluded: true })
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('A=1\nKEY=sk-live-123456789\n')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe('')
    // Already ignored: nothing more is added.
    expect(await writeSecretFile(dir, '.env', 'KEY', 'sk-live-999999999', git)).toEqual({ excluded: false })
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('A=1\nKEY=sk-live-999999999\n')
  })

  it('writes the bare value to any other file, made 0600', async () => {
    repo()
    await writeSecretFile(dir, 'secrets/token.txt', 'TOKEN', 'tok-123456789', git)
    const full = path.join(dir, 'secrets/token.txt')
    expect(fs.readFileSync(full, 'utf-8')).toBe('tok-123456789')
    expect((fs.statSync(full).mode & 0o777).toString(8)).toBe('600')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe('')
  })

  it('refuses a file git tracks, and a symlink', async () => {
    repo()
    fs.writeFileSync(path.join(dir, 'config.env'), 'A=1\n')
    execFileSync('git', ['add', 'config.env'], { cwd: dir })
    expect(await checkSecretFile(dir, 'config.env', git)).toContain('tracked by git')
    fs.symlinkSync('/etc/hosts', path.join(dir, '.env'))
    expect(await checkSecretFile(dir, '.env', git)).toContain('symlink')
  })

  it('refuses a folder that is a symlink out of the task folder', async () => {
    repo()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-outside-'))
    try {
      fs.symlinkSync(outside, path.join(dir, 'config'))
      expect(await checkSecretFile(dir, 'config/.env', git)).toContain('outside')
      await expect(writeSecretFile(dir, 'config/.env', 'KEY', 'v', git)).rejects.toThrow('outside')
      expect(fs.existsSync(path.join(outside, '.env'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a hard link, leaving the other file alone', async () => {
    repo()
    const other = path.join(dir, 'other.txt')
    fs.writeFileSync(other, 'keep me')
    fs.linkSync(other, path.join(dir, 'token.txt'))
    await expect(writeSecretFile(dir, 'token.txt', 'TOKEN', 'tok-123456789', git)).rejects.toThrow('plain file')
    expect(fs.readFileSync(other, 'utf-8')).toBe('keep me')
  })

  it('works outside a git repo', async () => {
    expect(await checkSecretFile(dir, '.env', git)).toBeNull()
    expect(await writeSecretFile(dir, '.env', 'KEY', 'v', git)).toEqual({ excluded: false })
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('KEY=v\n')
  })
})

describe('waiting on a secret', () => {
  it('shows as needing you until the prompt is answered', () => {
    const asked = reduceAgentActivity(undefined, { hook_event_name: 'DevtoolSecretRequested', tool_use_id: 'secret:1', name: 'KEY' }, 10)
    expect(asked.statusEvent).toBe('hook-needs-input')
    expect(asked.activity.waiting).toEqual({ kind: 'secret', label: 'KEY', toolUseId: 'secret:1', since: 10 })
    expect(describeActivity(asked.activity, 'attention')).toBe('Needs secret KEY')
    expect(phoneActivityLabel(asked.activity, 'attention')).toBe('Needs secret KEY. Answer on desktop')

    // A parallel tool's permission prompt doesn't hide it.
    const permission = reduceAgentActivity(asked.activity, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, 11)
    expect(permission.activity.waiting?.kind).toBe('secret')

    const answered = reduceAgentActivity(asked.activity, { hook_event_name: 'DevtoolPromptResolved', tool_use_id: 'secret:1' }, 12)
    expect(answered.statusEvent).toBe('hook-input-resolved')
    expect(answered.activity.waiting).toBeUndefined()
  })
})
