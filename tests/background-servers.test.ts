import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  childrenOf,
  detectServerTasks,
  findChatRoot,
  listeningInodes,
  parseLsofNames,
  parseLsofPids,
  parsePsCommands,
  subtree,
  taskIdOfOutput
} from '../src/main/claude-chat/background-servers'

describe('background server parsing', () => {
  const procs = parsePsCommands([
    '  100     1 /Applications/DevTool.app/Contents/MacOS/DevTool',
    '  200   100 claude --output-format stream-json --session-id=abc-123',
    '  201   200 /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh && eval npm run dev',
    '  202   201 node server.js',
    '  203   202 esbuild --service',
    '  300   100 claude --resume other-session',
    ''
  ].join('\n'))

  it('reads ps rows, commands with spaces kept', () => {
    expect(procs).toHaveLength(6)
    expect(procs[1]).toEqual({ pid: 200, ppid: 100, command: 'claude --output-format stream-json --session-id=abc-123' })
  })

  it("finds the chat's claude by its session, only among this process's children", () => {
    expect(findChatRoot(procs, 100, 'abc-123')).toBe(200)
    expect(findChatRoot(procs, 100, 'other-session')).toBe(300)
    expect(findChatRoot(procs, 999, 'abc-123')).toBeNull()
  })

  it('walks a subtree', () => {
    expect(childrenOf(procs, 200)).toEqual([201])
    expect(subtree(procs, 201).sort()).toEqual([201, 202, 203])
  })

  it("reads a task id from a background shell's output path", () => {
    expect(taskIdOfOutput('/private/tmp/claude-501/x/sess/tasks/ba79qg6gt.output')).toBe('ba79qg6gt')
    expect(taskIdOfOutput('/dev/null')).toBeNull()
    expect(taskIdOfOutput('pipe')).toBeNull()
  })

  it('reads lsof field output', () => {
    expect(parseLsofPids('p12\nf5\np34\nf7\n')).toEqual(new Set([12, 34]))
    expect(parseLsofNames('p12\nf1\nn/tmp/tasks/a.output\np34\nf1\nn/dev/null\n')).toEqual(new Map([[12, '/tmp/tasks/a.output'], [34, '/dev/null']]))
  })

  it('reads LISTEN sockets from /proc/net/tcp', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:14C5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0',
      '   1: 0100007F:9C40 0100007F:14C5 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0'
    ].join('\n')
    expect(listeningInodes(table)).toEqual(new Set(['55501']))
  })
})

const posix = process.platform === 'darwin' || process.platform === 'linux'

describe.skipIf(!posix)('detectServerTasks on real processes', () => {
  let root: ChildProcess | null = null
  let dir = ''

  afterEach(() => {
    if (root?.pid) {
      try { process.kill(-root.pid, 'SIGKILL') } catch { /* gone */ }
    }
    root = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('tells a background server from a background command', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-servers-'))
    fs.mkdirSync(path.join(dir, 'tasks'))
    const sessionId = `sess-${process.pid}-${Date.now()}`
    const server = `require('net').createServer().listen(0, '127.0.0.1')`
    // A stand-in for claude: two background shells, their stdout on the task files.
    const fake = path.join(dir, 'fake-claude.js')
    fs.writeFileSync(fake, `
      const { spawn } = require('child_process')
      const out = (id) => require('fs').openSync(${JSON.stringify(dir)} + '/tasks/' + id + '.output', 'w')
      spawn('/bin/sh', ['-c', ${JSON.stringify(`"${process.execPath}" -e "${server}"`)}], { stdio: ['ignore', out('bserver'), 'ignore'] })
      spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: ['ignore', out('bbuild'), 'ignore'] })
      setInterval(() => {}, 1000)
    `)
    root = spawn(process.execPath, [fake, `--session-id=${sessionId}`], { stdio: 'ignore', detached: true })

    let found: Set<string> | null = null
    for (let i = 0; i < 40; i++) {
      found = await detectServerTasks(sessionId, process.pid)
      if (found?.has('bserver')) break
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    expect(found).toEqual(new Set(['bserver']))
    expect(await detectServerTasks('no-such-session', process.pid)).toBeNull()
  }, 15_000)
})

describe('ChatSession background level with servers', () => {
  it('drops a server shell from the level it reports, keeps a build', async () => {
    const { ChatSession } = await import('../src/main/claude-chat/chat-session')
    const hooks: Record<string, unknown>[] = []
    let servers: Set<string> | null = new Set(['bserver'])
    const session = new ChatSession({
      cwd: '/tmp',
      sessionId: 's',
      resume: false,
      executable: 'claude',
      env: {},
      detectServers: async () => servers,
      onEvent: () => {},
      onHook: (body) => { hooks.push(body) },
      onPromptResolved: () => {},
      onExit: () => {},
      log: () => {}
    })
    const internals = session as unknown as {
      sdkBackground: { id: string; type: string; description: string }[]
      reportBackground(): void
      checkServers(): Promise<void>
      serverCheck: ReturnType<typeof setTimeout> | null
    }
    internals.sdkBackground = [
      { id: 'bserver', type: 'local_bash', description: 'Start dev server' },
      { id: 'bbuild', type: 'local_bash', description: 'Build' }
    ]
    internals.reportBackground()
    expect(hooks.at(-1)).toMatchObject({ count: 2 })

    await internals.checkServers()
    expect(hooks.at(-1)).toMatchObject({ count: 1, tasks: [{ id: 'bbuild' }] })

    // A failed look keeps what was known.
    servers = null
    if (internals.serverCheck) clearTimeout(internals.serverCheck)
    internals.serverCheck = null
    await internals.checkServers()
    expect(hooks.at(-1)).toMatchObject({ count: 1 })

    // It stopped listening: work again.
    servers = new Set()
    if (internals.serverCheck) clearTimeout(internals.serverCheck)
    internals.serverCheck = null
    await internals.checkServers()
    expect(hooks.at(-1)).toMatchObject({ count: 2 })
    if (internals.serverCheck) clearTimeout(internals.serverCheck)
  })
})
