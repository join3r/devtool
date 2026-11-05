import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import {
  agentModeFor,
  callerClaudeMode,
  unrestrictedCaller,
  claudeMcpArgs,
  delegatedMode,
  codexMcpArgs,
  handleMcpMessage,
  lastReplyFromTranscript,
  liveTaskState,
  tail,
  TOOLS,
  waitUntilSettled,
  type DevtoolMcpDeps,
  type StartTaskInput
} from '../src/main/devtool-mcp'
import { HookServer, MCP_PATH } from '../src/main/hook-server'
import { HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER } from '../src/shared/hook-protocol'
import { hasMcpTools } from '../src/main/agent-context'
import { agentExtraArgs } from '../src/main/claude-chat/chat-manager'
import { emptyArchive, type ProjectArchive } from '../src/shared/archive'
import type { AgentActivity } from '../src/shared/agent-activity'
import type { ProjectsData, TabStatusValue, Task } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const chatTab = (id: string) => ({ id, type: 'claude-chat' as const, title: 'Claude', sessionId: `s-${id}` })

function fakeDeps(data: ProjectsData, archives: Record<string, ProjectArchive> = {}) {
  const statuses = new Map<string, TabStatusValue>()
  const activities = new Map<string, AgentActivity>()
  const listeners = new Set<() => void>()
  const started: StartTaskInput[] = []
  const sent: { taskId: string; text: string }[] = []
  let current = data
  let ids = 0
  const deps: DevtoolMcpDeps = {
    peek: () => current,
    archive: (projectId) => archives[projectId] ?? emptyArchive(),
    statusOf: (tabId) => statuses.get(tabId) ?? null,
    activityOf: (tabId) => activities.get(tabId) ?? null,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    startTask: async (input) => {
      started.push(input)
      const task = fixtureTask({ id: 'child', name: 'Child', tabs: { left: [chatTab('child-tab')] }, lastInteractedAt: Date.now(), autopilot: { phase: 'working' } })
      current = { ...current, projects: current.projects.map(p => p.id === input.projectId ? { ...p, streams: p.streams.map((s, i) => i === 0 ? { ...s, tasks: [...s.tasks, task] } : s) } : p) }
      return { ok: true, taskId: 'child', queued: false, ownWorktree: false, autopilot: input.autopilot }
    },
    sendToTask: async (_project, task, _tab, text) => { sent.push({ taskId: task.id, text }) },
    lastReply: async () => 'All done: added the button.',
    commit: (next) => {
      current = next
      listeners.forEach(listener => listener())
    },
    callerMode: () => 'auto',
    newId: () => `id-${++ids}`,
    now: () => Date.now()
  }
  return {
    deps,
    started,
    sent,
    set(tabId: string, status: TabStatusValue, activity?: Partial<AgentActivity>) {
      statuses.set(tabId, status)
      if (activity) activities.set(tabId, { subagents: 0, compacting: false, updatedAt: 0, ...activity } as AgentActivity)
      listeners.forEach(listener => listener())
    },
    replace(next: ProjectsData) {
      current = next
      listeners.forEach(listener => listener())
    }
  }
}

function data(): ProjectsData {
  const project = fixtureProject({
    id: 'p1',
    name: 'App',
    directory: '/tmp/app',
    tasks: [
      { id: 'parent', name: 'Parent', tabs: { left: [chatTab('parent-tab')] } },
      { id: 'other', name: 'Other', tabs: { left: [chatTab('other-tab')] }, delegatedFrom: { taskId: 'parent', name: 'Parent' } },
      { id: 'mine-not', name: 'Users own', tabs: { left: [chatTab('mine-not-tab')] } }
    ]
  })
  const elsewhere = fixtureProject({ id: 'p2', name: 'Secret', directory: '/tmp/secret', tasks: [{ id: 'secret', name: 'Secret', tabs: { left: [chatTab('secret-tab')] } }] })
  return { projects: [project, elsewhere] } as unknown as ProjectsData
}

async function call(deps: DevtoolMcpDeps, name: string, args: Record<string, unknown>, tabId = 'parent-tab') {
  const answer = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, { tabId }, deps) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  const text = answer.result.content[0].text
  return { isError: !!answer.result.isError, text, json: answer.result.isError ? null : JSON.parse(text) }
}

describe('MCP protocol', () => {
  it('initializes with the version the client asks for, and lists the tools', async () => {
    const { deps } = fakeDeps(data())
    const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, { tabId: 'parent-tab' }, deps) as { result: Record<string, unknown> }
    expect(init.result.protocolVersion).toBe('2025-03-26')
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } })
    const odd = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { tabId: 'parent-tab' }, deps) as { result: Record<string, unknown> }
    expect(odd.result.protocolVersion).toBe('2025-06-18')
    const list = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { tabId: 'parent-tab' }, deps) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map(t => t.name)).toEqual(TOOLS.map(t => t.name))
  })

  it('answers nothing to notifications and drops them from a batch', async () => {
    const { deps } = fakeDeps(data())
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { tabId: 'parent-tab' }, deps)).toBeUndefined()
    const batch = await handleMcpMessage([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 9, method: 'ping' }
    ], { tabId: 'parent-tab' }, deps)
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 9, result: {} }])
  })

  it('refuses unknown methods and tools', async () => {
    const { deps } = fakeDeps(data())
    const method = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, { tabId: 'parent-tab' }, deps) as { error: { code: number } }
    expect(method.error.code).toBe(-32601)
    const tool = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm_rf' } }, { tabId: 'parent-tab' }, deps) as { error: { code: number } }
    expect(tool.error.code).toBe(-32602)
  })
})

describe('tools', () => {
  it('list_tasks defaults to the caller\'s project and marks the caller', async () => {
    const { deps, set } = fakeDeps(data())
    set('parent-tab', 'working')
    const { json } = await call(deps, 'list_tasks', {})
    expect(json.project).toBe('App')
    expect(json.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(['parent', 'other', 'mine-not'])
    expect(json.streams).toEqual([{ streamId: 'main-p1', name: 'main', main: true, yours: true }])
    expect(json.tasks[0]).toMatchObject({ you: true, state: 'working' })
  })

  it('start_task starts in the caller\'s project and stream, on Autopilot, naming the caller', async () => {
    const { deps, started } = fakeDeps(data())
    const { json } = await call(deps, 'start_task', { prompt: '  Add a dark mode toggle  ' })
    expect(started).toEqual([{ projectId: 'p1', streamId: 'main-p1', prompt: 'Add a dark mode toggle', agent: 'claude', autopilot: true, review: false, callerTabId: 'parent-tab', from: { taskId: 'parent', name: 'Parent' } }])
    expect(json).toMatchObject({ taskId: 'child', autopilot: true })
  })

  it('start_task checks its arguments', async () => {
    const { deps, started } = fakeDeps(data())
    expect((await call(deps, 'start_task', {})).text).toMatch(/prompt/)
    expect((await call(deps, 'start_task', { prompt: 'x', streamId: 'nope' })).text).toMatch(/No such stream/)
    expect((await call(deps, 'start_task', { prompt: 'x', autopilot: 'yes' })).isError).toBe(true)
    expect((await call(deps, 'start_task', { prompt: 'x', agent: 'gemini' })).text).toMatch(/agent/)
    expect((await call(deps, 'start_task', { prompt: 'x', model: 'two words' })).text).toMatch(/model/)
    expect(started).toEqual([])
  })

  it('start_task passes the agent and model on', async () => {
    const { deps, started } = fakeDeps(data())
    const { json } = await call(deps, 'start_task', { prompt: 'Port it', agent: 'codex', model: ' gpt-5-codex ' })
    expect(started[0]).toMatchObject({ agent: 'codex', model: 'gpt-5-codex', autopilot: true })
    expect(json).toMatchObject({ agent: 'codex', model: 'gpt-5-codex' })
  })

  it('start_task turns a short Codex model name into its id and refuses an unknown one', async () => {
    const { deps, started } = fakeDeps(data())
    const models = [{ id: 'gpt-6.1-sol' }, { id: 'gpt-reserve', hidden: true }, { id: 'gpt-6-luna' }, { id: 'gpt-5.6-luna' }]
    deps.modelsFor = (agent) => (agent === 'codex' ? models : null)
    const { json } = await call(deps, 'start_task', { prompt: 'Port it', agent: 'codex', model: 'luna' })
    expect(started[0]).toMatchObject({ agent: 'codex', model: 'gpt-6-luna' })
    expect(json.model).toBe('gpt-6-luna')
    expect(json.note).toMatch(/"luna" is gpt-6-luna \(also fits: gpt-5.6-luna/)
    const refused = await call(deps, 'start_task', { prompt: 'Port it', agent: 'codex', model: 'nova' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Codex has no model "nova"\. Its models: gpt-6.1-sol, gpt-6-luna, gpt-5.6-luna\./)
    expect(started).toHaveLength(1)
    // Claude's models aren't listed here: its name goes through as given.
    await call(deps, 'start_task', { prompt: 'x', model: 'opus' })
    expect(started[1]).toMatchObject({ agent: 'claude', model: 'opus' })
  })

  it('send_to_task reaches only tasks the caller started', async () => {
    const { deps, sent } = fakeDeps(data())
    expect((await call(deps, 'send_to_task', { taskId: 'parent', message: 'hi' })).text).toMatch(/your own task/)
    expect((await call(deps, 'send_to_task', { taskId: 'mine-not', message: 'hi' })).text).toMatch(/only tasks you started/)
    expect((await call(deps, 'send_to_task', { taskId: 'secret', message: 'hi' })).text).toMatch(/No such task in your project/)
    const { json } = await call(deps, 'send_to_task', { taskId: 'other', message: 'Use the blue one' })
    expect(json.sent).toBe(true)
    expect(sent).toEqual([{ taskId: 'other', text: 'Use the blue one' }])
  })

  it('get_task reads a closed task from the archive, with its reply', async () => {
    const archived: Task = fixtureTask({ id: 'gone', name: 'Gone', tabs: { left: [chatTab('gone-tab')] }, autopilot: { phase: 'landing' } })
    const archive: ProjectArchive = { ...emptyArchive(), tasks: [{ task: archived, streamId: 'main-p1', streamName: 'main', dir: '/tmp/app', archivedAt: 1 }] }
    const { deps } = fakeDeps(data(), { p1: archive })
    const { json } = await call(deps, 'get_task', { taskId: 'gone' })
    expect(json).toMatchObject({ state: 'done', lastReply: 'All done: added the button.' })
    expect(json.detail).toMatch(/Autopilot landed/)
    expect((await call(deps, 'get_task', { taskId: 'never' })).text).toMatch(/No such task/)
  })

  it('wait_for_tasks returns once the task settles', async () => {
    const { deps, set } = fakeDeps(data())
    set('other-tab', 'working')
    const pending = call(deps, 'wait_for_tasks', { taskIds: ['other'], timeoutSeconds: 5 })
    await new Promise(resolve => setTimeout(resolve, 20))
    set('other-tab', null, { lastAnswer: 'x' })
    const { json } = await pending
    expect(json.timedOut).toBe(false)
    expect(json.tasks[0]).toMatchObject({ taskId: 'other', state: 'idle', lastReply: 'All done: added the button.' })
  })

  it('sees nothing outside the caller\'s project', async () => {
    const { deps } = fakeDeps(data())
    expect((await call(deps, 'get_task', { taskId: 'secret' })).text).toMatch(/No such task in your project/)
    expect((await call(deps, 'wait_for_tasks', { taskIds: ['secret'] })).text).toMatch(/No such task in your project/)
    const fromThere = await call(deps, 'list_tasks', {}, 'secret-tab')
    expect(fromThere.json.project).toBe('Secret')
  })

  it('answers only an agent tab in a task', async () => {
    const { deps, started } = fakeDeps(data())
    expect((await call(deps, 'list_tasks', {}, 'no-such-tab')).text).toMatch(/Only an agent in a DevTool task/)
    expect((await call(deps, 'start_task', { prompt: 'x' }, 'no-such-tab')).isError).toBe(true)
    expect(started).toEqual([])
  })

  it('wait_for_tasks refuses to wait on the caller', async () => {
    const { deps } = fakeDeps(data())
    expect((await call(deps, 'wait_for_tasks', { taskIds: ['parent'] })).text).toMatch(/your own task/)
  })
})

describe('liveTaskState', () => {
  const lookup = (statuses: Record<string, TabStatusValue>, seen = true) => ({
    statusOf: (tabId: string) => statuses[tabId] ?? null,
    activityOf: () => (seen ? { subagents: 0 } as unknown as AgentActivity : null)
  })
  const task = (extra: Partial<Task> = {}) => fixtureTask({ id: 't', tabs: { left: [chatTab('tab')] }, ...extra })

  it('reads queued, working, needs you and idle', () => {
    expect(liveTaskState(task({ queued: { prompt: 'p', at: 1 } }), lookup({}), 0).state).toBe('queued')
    expect(liveTaskState(task(), lookup({ tab: 'working' }), 0).state).toBe('working')
    expect(liveTaskState(task(), lookup({ tab: 'attention' }), 0).state).toBe('needs_you')
    expect(liveTaskState(task(), lookup({}), 0).state).toBe('idle')
  })

  it('keeps an Autopilot run working between its steps, and reads its hand-back', () => {
    expect(liveTaskState(task({ autopilot: { phase: 'working' } }), lookup({}), 0).state).toBe('working')
    expect(liveTaskState(task({ autopilot: { phase: 'reviewing' } }), lookup({}), 0)).toEqual({ state: 'working', detail: 'Autopilot · Codex reviewing' })
    const stopped = liveTaskState(task({ autopilot: { phase: 'stopped', reason: 'No files changed', stoppedAt: 10 }, lastInteractedAt: 5 }), lookup({}), 0)
    expect(stopped).toEqual({ state: 'needs_you', detail: 'Autopilot handed it back: No files changed' })
  })

  it('reads a task that has shown nothing yet as starting, for a while', () => {
    const fresh = task({ lastInteractedAt: 1000 })
    expect(liveTaskState(fresh, lookup({}, false), 2000).state).toBe('starting')
    expect(liveTaskState(fresh, lookup({}, false), 1000 + 3 * 60_000).state).toBe('idle')
  })
})

describe('waitUntilSettled', () => {
  it('times out, and stops when aborted', async () => {
    const { deps, set } = fakeDeps(data())
    set('other-tab', 'working')
    expect(await waitUntilSettled(['other'], 'all', 30, deps)).toBe(false)
    const aborter = new AbortController()
    const waiting = waitUntilSettled(['other'], 'all', 10_000, deps, aborter.signal)
    aborter.abort()
    expect(await waiting).toBe(false)
  })

  it('`any` returns at the first, `all` waits for every one', async () => {
    const { deps, set } = fakeDeps(data())
    set('other-tab', 'working')
    set('parent-tab', 'working')
    const any = waitUntilSettled(['other', 'parent'], 'any', 5000, deps)
    const all = waitUntilSettled(['other', 'parent'], 'all', 5000, deps)
    set('other-tab', null)
    expect(await any).toBe(true)
    let allDone = false
    void all.then(() => { allDone = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(allDone).toBe(false)
    set('parent-tab', 'attention')
    expect(await all).toBe(true)
  })

  it('counts a task that went away as settled', async () => {
    const { deps, set, replace } = fakeDeps(data())
    set('other-tab', 'working')
    const waiting = waitUntilSettled(['other'], 'all', 5000, deps)
    const next = data()
    next.projects[0].streams[0].tasks = next.projects[0].streams[0].tasks.filter(t => t.id !== 'other')
    replace(next)
    expect(await waiting).toBe(true)
  })
})

describe('lastReplyFromTranscript', () => {
  const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })
  const assistant = (...texts: string[]) => ({ type: 'assistant', message: { role: 'assistant', content: texts.map(text => ({ type: 'text', text })) } })

  it('joins the main-thread replies after the last typed prompt', () => {
    expect(lastReplyFromTranscript([
      user('first'),
      assistant('old answer'),
      user([{ type: 'text', text: 'second' }]),
      assistant('Looking.'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } },
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'file' }]),
      { ...assistant('subagent chatter'), parent_tool_use_id: 'agent-1' },
      { ...assistant('sidechain'), isSidechain: true },
      assistant('Done: it works.')
    ])).toBe('Looking.\n\nDone: it works.')
  })

  it('is null without a reply', () => {
    expect(lastReplyFromTranscript([])).toBeNull()
    expect(lastReplyFromTranscript([assistant('a'), user('next')])).toBeNull()
  })

  it('keeps the end of a long reply', () => {
    expect(tail('abcdef', 4)).toBe('…def')
    expect(tail('abc', 4)).toBe('abc')
  })
})

describe('agent wiring', () => {
  const endpoint = { url: 'http://127.0.0.1:5/mcp', headers: { 'X-Tab-Id': 't1', 'X-Devtool-Token': 'tok' } }

  it('claude flags take one value each, so a prompt after them stays the prompt', () => {
    const args = claudeMcpArgs(endpoint)
    expect(args).toHaveLength(2)
    expect(args[0].startsWith('--mcp-config=')).toBe(true)
    expect(JSON.parse(args[0].slice('--mcp-config='.length))).toEqual({ mcpServers: { devtool: { type: 'http', ...endpoint } } })
    expect(args[1]).toBe('--allowedTools=mcp__devtool__list_tasks,mcp__devtool__get_task,mcp__devtool__wait_for_tasks,mcp__devtool__request_secret,mcp__devtool__list_schedules,mcp__devtool__nothing_new')
  })

  it('starts a delegated task no looser than its caller', () => {
    expect(delegatedMode('auto')).toBe('auto')
    expect(agentModeFor('claude', 'acceptEdits')).toBe('acceptEdits')
    expect(agentModeFor('codex', 'auto')).toBe('auto')
    expect(agentModeFor('codex', 'acceptEdits')).toBe('ask')
    expect(agentModeFor('codex', 'default')).toBe('read-only')
    expect(agentModeFor('codex', 'dontAsk')).toBe('read-only')
    expect(agentModeFor('codex', 'plan')).toBe('read-only')
    // A Codex caller's preset is read as Codex's, not as a Claude mode.
    expect(callerClaudeMode('codex-chat', 'auto')).toBe('acceptEdits')
    expect(callerClaudeMode('codex-chat', 'full-access')).toBe('auto')
    expect(callerClaudeMode('codex-chat', 'read-only')).toBe('default')
    expect(callerClaudeMode('claude-chat', 'bypassPermissions')).toBe('auto')
    expect(callerClaudeMode('codex', null)).toBe('default')
    // Pi has no permissions: only callers with none either may start it.
    expect(unrestrictedCaller('claude-chat', 'auto')).toBe(false)
    expect(unrestrictedCaller('codex-chat', 'auto')).toBe(false)
    expect(unrestrictedCaller('claude-chat', 'bypassPermissions')).toBe(true)
    expect(unrestrictedCaller('codex-chat', 'full-access')).toBe(true)
    expect(agentModeFor('pi', 'auto')).toBeUndefined()
    expect(delegatedMode('bypassPermissions')).toBe('auto')
    expect(delegatedMode('acceptEdits')).toBe('acceptEdits')
    expect(delegatedMode('default')).toBe('default')
    expect(delegatedMode('plan')).toBe('default')
    expect(delegatedMode(null)).toBe('default')
  })

  it('codex gets the server as TOML config overrides', () => {
    expect(codexMcpArgs(endpoint)).toEqual([
      '-c', 'mcp_servers.devtool.url="http://127.0.0.1:5/mcp"',
      '-c', 'mcp_servers.devtool.http_headers={ "X-Tab-Id" = "t1", "X-Devtool-Token" = "tok" }',
      '-c', 'mcp_servers.devtool.tool_timeout_sec=3660'
    ])
  })

  it('names the tab kinds that get the tools', () => {
    expect(hasMcpTools('claude-chat')).toBe(true)
    expect(hasMcpTools('claude')).toBe(true)
    expect(hasMcpTools('pi')).toBe(false)
    expect(hasMcpTools('terminal')).toBe(false)
  })
})

describe('HookServer /mcp', () => {
  let server: HookServer

  beforeEach(async () => {
    server = new HookServer()
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  function post(body: unknown, headers: Record<string, string>, method = 'POST'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request({ hostname: '127.0.0.1', port: server.getPort(), path: MCP_PATH, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      if (method === 'POST') req.write(data)
      req.end()
    })
  }

  it('answers only the tab\'s own token, as that tab', async () => {
    const seen: string[] = []
    server.setMcpHandler(async (tabId, body) => {
      seen.push(tabId)
      return { jsonrpc: '2.0', id: (body as { id: number }).id, result: {} }
    })
    const shared = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { [HOOK_TAB_ID_HEADER]: 'tab-1', [HOOK_TOKEN_HEADER]: server.getToken() })
    expect(shared.status).toBe(401)
    const other = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { [HOOK_TAB_ID_HEADER]: 'tab-2', [HOOK_TOKEN_HEADER]: server.tabToken('tab-1') })
    expect(other.status).toBe(401)
    const own = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { [HOOK_TAB_ID_HEADER]: 'tab-1', [HOOK_TOKEN_HEADER]: server.tabToken('tab-1') })
    expect(own).toEqual({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' })
    expect(seen).toEqual(['tab-1'])
  })

  it('sends 202 for notifications, 405 for GET, 400 for bad JSON', async () => {
    server.setMcpHandler(async () => undefined)
    const headers = { [HOOK_TAB_ID_HEADER]: 'tab-1', [HOOK_TOKEN_HEADER]: server.tabToken('tab-1') }
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status).toBe(202)
    expect((await post(null, headers, 'GET')).status).toBe(405)
    const bad = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.getPort(), path: MCP_PATH, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end('{nope')
    })
    expect(bad).toBe(400)
  })
})

describe('agentExtraArgs (Codex and Pi chats)', () => {
  const mcp = { url: 'http://127.0.0.1:1/mcp', headers: { 'X-Tab': 't' } }
  it('gives Codex the MCP server and DevTool\'s note, Pi the note, ahead of the project\'s args', () => {
    const codex = agentExtraArgs('codex', mcp, 'Note "x"', ['-c', 'model="o"'], 'darwin')!
    expect(codex.slice(-4)).toEqual(['-c', 'developer_instructions="Note \\"x\\""', '-c', 'model="o"'])
    expect(codex[1]).toMatch(/^mcp_servers\.devtool\.url=/)
    expect(agentExtraArgs('pi', mcp, 'Note', ['--thinking', 'high'], 'darwin')).toEqual(['--append-system-prompt', 'Note', '--thinking', 'high'])
  })
  it('leaves the note out on Windows', () => {
    expect(agentExtraArgs('pi', null, 'Note', undefined, 'win32')).toBeUndefined()
    expect(agentExtraArgs('codex', null, 'Note', ['a'], 'win32')).toEqual(['a'])
  })
})

describe('request_secret', () => {
  it('asks through DevTool and answers with where the value went, never the value', async () => {
    const { deps } = fakeDeps(data())
    const asked: unknown[] = []
    deps.requestSecret = async (input) => {
      asked.push({ project: input.project.id, task: input.task.id, tabId: input.tabId, name: input.name, reason: input.reason, file: input.file })
      return { status: 'provided', file: input.file, excluded: true, remembered: false, rememberFailed: false, fromSaved: false }
    }
    const result = await call(deps, 'request_secret', { name: 'OPENAI_API_KEY', reason: 'Call the API in tests' })
    expect(result.isError).toBe(false)
    expect(asked).toEqual([{ project: 'p1', task: 'parent', tabId: 'parent-tab', name: 'OPENAI_API_KEY', reason: 'Call the API in tests', file: '.env' }])
    expect(result.json).toMatchObject({ provided: true, name: 'OPENAI_API_KEY', file: '.env' })
    expect(result.json.note).toContain('.git/info/exclude')
  })

  it('refuses a bad name or a file outside the task folder before asking', async () => {
    const { deps } = fakeDeps(data())
    let asked = 0
    deps.requestSecret = async () => { asked++; return { status: 'declined' } }
    expect((await call(deps, 'request_secret', { name: 'my key', reason: 'x' })).isError).toBe(true)
    expect((await call(deps, 'request_secret', { name: 'KEY', reason: 'x', file: '../outside/.env' })).isError).toBe(true)
    expect((await call(deps, 'request_secret', { name: 'KEY', reason: 'x', file: '.git/config' })).isError).toBe(true)
    expect(asked).toBe(0)
  })

  it('reports a decline and a missing host as errors', async () => {
    const { deps } = fakeDeps(data())
    expect((await call(deps, 'request_secret', { name: 'KEY', reason: 'x' })).text).toContain("can't ask for secrets")
    deps.requestSecret = async () => ({ status: 'declined' })
    const declined = await call(deps, 'request_secret', { name: 'KEY', reason: 'x' })
    expect(declined.isError).toBe(true)
    expect(declined.text).toContain('declined')
  })

  it('takes known secrets out of a reply another agent reads', async () => {
    const { deps } = fakeDeps(data())
    deps.lastReply = async () => 'I used sk-live-123456789 to call it.'
    deps.redact = (text) => text.split('sk-live-123456789').join('[secret KEY]')
    const result = await call(deps, 'get_task', { taskId: 'other' })
    expect(result.json.lastReply).toBe('I used [secret KEY] to call it.')
  })
})

describe('schedule tools', () => {
  it('schedule_task adds a schedule in the caller\'s project, in its mode; list and cancel see it', async () => {
    const fake = fakeDeps(data())
    const made = await call(fake.deps, 'schedule_task', { name: 'SDK check', prompt: 'Check whether the bug is fixed', every: 1, unit: 'week' })
    expect(made.isError).toBe(false)
    expect(made.json).toMatchObject({ name: 'SDK check', cadence: 'every week', permissionMode: 'auto', createdBy: 'Parent (parent)' })
    const project = fake.deps.peek().projects.find(p => p.id === 'p1')!
    expect(project.schedules).toHaveLength(1)
    expect(project.schedules![0].mode).toBe('auto')
    const listed = await call(fake.deps, 'list_schedules', {})
    expect(listed.json.schedules.map((s: { name: string }) => s.name)).toEqual(['SDK check'])
    const cancelled = await call(fake.deps, 'cancel_schedule', { scheduleId: made.json.scheduleId })
    expect(cancelled.json).toMatchObject({ deleted: true })
    expect(fake.deps.peek().projects.find(p => p.id === 'p1')!.schedules).toBeUndefined()
  })

  it('schedule_task refuses a bad cadence or a past first run', async () => {
    const { deps } = fakeDeps(data())
    expect((await call(deps, 'schedule_task', { name: 'x', prompt: 'y', every: 1, unit: 'month' })).isError).toBe(true)
    expect((await call(deps, 'schedule_task', { name: 'x', prompt: 'y', every: 1, unit: 'day', firstRunAt: '2001-01-01T00:00:00Z' })).isError).toBe(true)
  })

  it('nothing_new marks only a scheduled run quiet', async () => {
    const d = data()
    d.projects[0].streams[0].tasks[0] = { ...d.projects[0].streams[0].tasks[0], scheduledFrom: { scheduleId: 's', name: 'S' } }
    const fake = fakeDeps(d)
    const quiet = await call(fake.deps, 'nothing_new', { note: 'Still open' })
    expect(quiet.isError).toBe(false)
    expect(fake.deps.peek().projects[0].streams[0].tasks[0].quietRun).toEqual({ note: 'Still open' })
    expect((await call(fake.deps, 'nothing_new', {}, 'other-tab')).isError).toBe(true)
  })
})

describe('schedule_task callers', () => {
  it('refuses scheduled runs and delegated tasks', async () => {
    const d = data()
    d.projects[0].streams[0].tasks[0] = { ...d.projects[0].streams[0].tasks[0], scheduledFrom: { scheduleId: 's', name: 'S' } }
    const { deps } = fakeDeps(d)
    const args = { name: 'x', prompt: 'y', every: 1, unit: 'day' }
    expect((await call(deps, 'schedule_task', args)).isError).toBe(true)
    expect((await call(deps, 'schedule_task', args, 'other-tab')).isError).toBe(true)
  })
})
