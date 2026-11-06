import type { AgentActivity } from '../shared/agent-activity'
import { describeActivity, isShellTask } from '../shared/agent-activity'
import type { ArchivedTask, ProjectArchive } from '../shared/archive'
import { autopilotActive, autopilotBusy, autopilotLine, autopilotNeedsYou, autopilotTab } from '../shared/autopilot'
import { landingNeedsYou, statusTabs, taskStatus } from '../shared/inbox-state'
import { mapTaskInProject, taskDirectory, taskTabs } from '../shared/streams'
import { AI_TAB_META, AI_TAB_TYPES, type AiTabType, type Project, type ProjectsData, type Schedule, type ScheduleUnit, type Stream, type Tab, type TabStatusValue, type Task } from '../shared/types'
import {
  applyScheduleOp,
  cadenceError,
  cadenceLabel,
  newSchedule,
  projectSchedules,
  scheduleStreamId,
  schedulesSupported,
  SCHEDULES_PER_PROJECT,
  textError
} from '../shared/schedules'
import { hasMcpTools } from './agent-context'
import { resolveModel, type AgentModel } from './agent-models'
import { DEFAULT_SECRET_FILE, SECRET_REASON_MAX, isDotenvFile, safeSecretFile, validSecretName } from '../shared/secrets'
import type { SecretOutcome } from './secrets/secret-requests'
import { childProgress, childProgressLine, delegationTree, waitingOnChildren } from '../shared/delegation'
import { validScore } from '../shared/loop'

/**
 * DevTool's MCP server: tools an agent DevTool started uses to run DevTool
 * itself, so one task can hand parts of its work to tasks of their own and
 * follow them. It speaks MCP's Streamable HTTP transport on the hook server's
 * `/mcp` (`hook-server.ts`), statelessly: every POST is one JSON-RPC message
 * (or a batch) answered with plain JSON, no event stream and no session.
 *
 * The caller is the tab named by the request's tab id and tab token, so a
 * leaked token acts as that one tab and nothing else.
 */

export const MCP_SERVER_NAME = 'devtool'

/** Where one tab's agent reaches the server: the URL, and the headers that say which tab it is. */
export interface DevtoolMcpEndpoint {
  url: string
  headers: Record<string, string>
}

/**
 * The tools an agent may use without asking: the read-only ones, and
 * `request_secret`, whose prompt is itself the user's say. Starting a task and
 * messaging one go through the tab's own permission mode (in auto mode Claude's
 * classifier decides, so an Autopilot run isn't stopped by them).
 */
export const MCP_ALLOWED_TOOLS = ['list_tasks', 'get_task', 'wait_for_tasks', 'request_secret', 'list_schedules', 'nothing_new', 'submit_score'] as const
export const MCP_ALLOW_RULES = MCP_ALLOWED_TOOLS.map(tool => `mcp__${MCP_SERVER_NAME}__${tool}`)

/** The server as Claude's MCP config (`--mcp-config`, the Agent SDK's `mcpServers`) names it. */
export function claudeMcpServers(endpoint: DevtoolMcpEndpoint): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  return { [MCP_SERVER_NAME]: { type: 'http', url: endpoint.url, headers: endpoint.headers } }
}

/**
 * `claude` flags for a terminal tab. Both take variadic values, so they use the
 * `--flag=value` form, which takes exactly one: a first prompt after them stays
 * the prompt.
 */
export function claudeMcpArgs(endpoint: DevtoolMcpEndpoint): string[] {
  return [`--mcp-config=${JSON.stringify({ mcpServers: claudeMcpServers(endpoint) })}`, `--allowedTools=${MCP_ALLOW_RULES.join(',')}`]
}

/** `codex` config overrides (`-c key=value`, TOML values; JSON strings are TOML strings). */
export function codexMcpArgs(endpoint: DevtoolMcpEndpoint): string[] {
  const headers = Object.entries(endpoint.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')
  return [
    '-c', `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(endpoint.url)}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.http_headers={ ${headers} }`,
    // Codex gives a tool call 60 s by default; waiting on tasks or on the user takes longer.
    '-c', `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${WAIT_MAX_S + 60}`,
    // Codex asks before any MCP tool not marked read-only; under its `never` approval policy (Autopilot, loop
    // judges) that ask is a refusal, so a judge could never call `submit_score`. Same allow list as Claude's.
    ...MCP_ALLOWED_TOOLS.flatMap(tool => ['-c', `mcp_servers.${MCP_SERVER_NAME}.tools.${tool}.approval_mode="approve"`])
  ]
}
const SERVER_VERSION = '1.0.0'
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL = '2025-06-18'

/** How much of a task's last reply a tool result carries; the end is kept (the summary is there). */
export const REPLY_LIMIT = 8000
const PROMPT_LIMIT = 100_000
const WAIT_DEFAULT_S = 600
const WAIT_MAX_S = 3600
/** A task that has shown no activity yet, this soon after it was made, is still starting. */
const STARTING_MS = 2 * 60_000

export interface StartTaskInput {
  /** The caller's own project: tasks start nowhere else. */
  projectId: string
  streamId?: string
  prompt: string
  /** The agent the task's chat runs. */
  agent: AiTabType
  /** The model it starts on; unset keeps the agent's default. */
  model?: string
  autopilot: boolean
  review: boolean
  /** The tab asking: the new task gets no looser a permission mode than it has. */
  callerTabId: string
  /** The task asking; the new task names it as where it came from. */
  from: { taskId: string; name: string }
}

export type StartTaskResult =
  | { ok: true; taskId: string; queued: boolean; ownWorktree: boolean; autopilot: boolean; mode?: string }
  | { ok: false; error: string }

export interface DevtoolMcpDeps {
  peek(): ProjectsData
  archive(projectId: string): ProjectArchive
  statusOf(tabId: string): TabStatusValue
  activityOf(tabId: string): AgentActivity | null
  /** Calls `listener` on any change to the projects or to a tab's status. */
  subscribe(listener: () => void): () => void
  startTask(input: StartTaskInput): Promise<StartTaskResult>
  /** Sends `text` to the task's agent, as typing it in would. */
  sendToTask(project: Project, task: Task, tab: Tab, text: string): Promise<void>
  /** The agent's last reply in `tab`, read from its transcript in `dir`; null when there is none. */
  lastReply(tab: Tab, dir: string): Promise<string | null>
  /**
   * Asks the user for a secret and waits (`request_secret`); an error string
   * when it can't be asked here. Absent: the tool says it isn't available.
   */
  requestSecret?(input: RequestSecretInput, signal?: AbortSignal): Promise<SecretOutcome | { status: 'error'; error: string }>
  /** Known secret values out of a reply an agent reads. */
  redact?(text: string): string
  /** Saves the projects (schedules, a quiet run's flag). */
  commit(data: ProjectsData): void
  /** The permission mode the agent in `tabId` runs in; null when main can't see it (a terminal tab). */
  callerMode(tabId: string): string | null
  newId(): string
  /**
   * A get_task or wait_for_tasks answer told the caller these tasks settled:
   * the wake-up message (`delegation-delivery.ts`) needn't tell it again.
   */
  reported?(taskIds: readonly string[]): void
  /** The models `agent` offers, its preferred first; null (or absent) when DevTool can't tell, and `model` goes through unchecked. */
  modelsFor?(agent: AiTabType): AgentModel[] | null
  now?(): number
}

export interface RequestSecretInput {
  project: Project
  task: Task
  tabId: string
  name: string
  reason: string
  /** Relative to the task's folder, already made safe. */
  file: string
}

/**
 * The permission mode a task an agent starts runs in: the caller's, never
 * looser. Auto and bypass give auto (no task is started bypassing); plan mode
 * would leave it unable to work, so it asks instead; a mode main can't see (a
 * terminal tab's) asks too.
 */
export function delegatedMode(callerMode: string | null): string {
  switch (callerMode) {
    case 'auto':
    case 'bypassPermissions':
      return 'auto'
    case 'acceptEdits':
    case 'dontAsk':
      return callerMode
    default:
      return 'default'
  }
}

/**
 * The caller's rights in Claude's terms, read from its own agent's mode: a
 * Claude chat's through `delegatedMode`; a Codex chat's presets by what they
 * let it do without asking (full access acts freely; auto and ask edit the
 * folder; read-only edits nothing); anything else (a terminal tab, whose mode
 * main can't see) asks.
 */
export function callerClaudeMode(callerTabType: string | undefined, callerMode: string | null): string {
  if (callerTabType === 'claude-chat') return delegatedMode(callerMode)
  if (callerTabType === 'codex-chat') {
    if (callerMode === 'full-access') return 'auto'
    if (callerMode === 'auto' || callerMode === 'ask') return 'acceptEdits'
  }
  return 'default'
}

/** A caller that already acts with no permission checks at all, so starting Pi (which has none) gives it nothing new. */
export function unrestrictedCaller(callerTabType: string | undefined, callerMode: string | null): boolean {
  return (callerTabType === 'claude-chat' && callerMode === 'bypassPermissions')
    || (callerTabType === 'codex-chat' && callerMode === 'full-access')
}

/**
 * The started agent's mode, from the caller's rights in Claude's terms
 * (`callerClaudeMode`): Claude's as is; Codex's strictest preset that still
 * allows as much (auto works without asking, acceptEdits edits the folder and
 * asks for the rest, anything else reads only); nothing for Pi, which has no modes.
 */
export function agentModeFor(agent: AiTabType, claudeMode: string): string | undefined {
  if (agent === 'claude') return claudeMode
  if (agent === 'codex') return claudeMode === 'auto' ? 'auto' : claudeMode === 'acceptEdits' ? 'ask' : 'read-only'
  return undefined
}

const MODEL_LIMIT = 200

// ---- finding things ------------------------------------------------------------------

interface LiveTask {
  kind: 'live'
  project: Project
  stream: Stream
  task: Task
}

interface ClosedTask {
  kind: 'closed'
  project: Project
  entry: ArchivedTask
}

type FoundTask = LiveTask | ClosedTask

function findTabOwner(data: ProjectsData, tabId: string): LiveTask | null {
  for (const project of data.projects) {
    for (const stream of project.streams ?? []) {
      const task = stream.tasks.find(t => taskTabs(t).some(tab => tab.id === tabId))
      if (task) return { kind: 'live', project, stream, task }
    }
  }
  return null
}

function findLiveTask(data: ProjectsData, taskId: string): LiveTask | null {
  for (const project of data.projects) {
    for (const stream of project.streams ?? []) {
      const task = stream.tasks.find(t => t.id === taskId)
      if (task) return { kind: 'live', project, stream, task }
    }
  }
  return null
}

function findClosedTask(data: ProjectsData, deps: DevtoolMcpDeps, taskId: string, projectId: string): ClosedTask | null {
  for (const project of data.projects) {
    if (project.id !== projectId) continue
    let archive: ProjectArchive
    try {
      archive = deps.archive(project.id)
    } catch {
      continue
    }
    const entry = archive.tasks.find(e => e.task.id === taskId)
      ?? archive.streams.flatMap(s => s.doneTasks).find(e => e.task.id === taskId)
    if (entry) return { kind: 'closed', project, entry }
  }
  return null
}

/** A task of project `projectId`, open or closed: an agent sees no other project's. */
function findTask(data: ProjectsData, deps: DevtoolMcpDeps, taskId: string, projectId: string): FoundTask | null {
  const live = findLiveTask(data, taskId)
  if (live) return live.project.id === projectId ? live : null
  return findClosedTask(data, deps, taskId, projectId)
}

/** The tab whose conversation stands for the task: Autopilot's chat, else its main or first agent tab. */
function conversationTab(task: Task): Tab | undefined {
  return autopilotTab(task) ?? statusTabs(task)[0]
}

// ---- a task's state ------------------------------------------------------------------

/**
 * Where a task is, in the words an agent acts on:
 *  - `starting`, `queued`, `working`: not done yet; wait.
 *  - `needs_you`: stopped on something only a person (or you) can answer.
 *  - `idle`: its agent finished its turn and waits for the next message.
 *  - `exited`: its agent's process is gone.
 *  - `done`: closed; with Autopilot that means its work landed.
 */
export type McpTaskState = 'starting' | 'queued' | 'working' | 'needs_you' | 'idle' | 'exited' | 'done'

export function settled(state: McpTaskState): boolean {
  return state !== 'starting' && state !== 'queued' && state !== 'working'
}

/**
 * `waitingOn`: tasks it started that still work (`waitingOnChildren`). A task
 * waiting for them is `working`, not idle: it isn't done until they are.
 */
export function liveTaskState(task: Task, deps: Pick<DevtoolMcpDeps, 'statusOf' | 'activityOf'>, now: number, waitingOn = 0): { state: McpTaskState; detail?: string } {
  if (task.queued) {
    return { state: 'queued', detail: task.queued.error ? `Its start failed: ${task.queued.error}` : 'Waits until no other agent works in its folder' }
  }
  const tabs = statusTabs(task)
  const statuses: Record<string, TabStatusValue> = {}
  for (const tab of tabs) statuses[tab.id] = deps.statusOf(tab.id)
  const status = taskStatus(task, statuses)
  const activityTab = tabs.find(tab => statuses[tab.id] === status) ?? tabs[0]
  const activity = activityTab ? deps.activityOf(activityTab.id) : null
  const said = describeActivity(activity ?? undefined, status)

  if (landingNeedsYou(task)) return { state: 'needs_you', detail: `Its landing stopped (${task.landing?.state})` }
  if (status === 'attention') return { state: 'needs_you', detail: said ?? 'Its agent waits on an answer' }
  if (status === 'working') return { state: 'working', ...(autopilotLine(task.autopilot) ?? said ? { detail: autopilotLine(task.autopilot) ?? said } : {}) }
  if (waitingOn > 0) return { state: 'working', detail: `Waiting for ${waitingOn} ${waitingOn === 1 ? 'task' : 'tasks'} it started` }
  if (autopilotBusy(task)) return { state: 'working', detail: autopilotLine(task.autopilot) ?? 'Autopilot is at work' }
  const shells = shellLine(tabs.map(tab => deps.activityOf(tab.id)))
  // Between a turn and Autopilot's next step (review, landing): it moves on by itself.
  if (autopilotActive(task)) return { state: 'working', detail: shells ? `Autopilot waits for ${shells}` : 'Autopilot is between steps' }
  if (status === 'exited') return { state: 'exited', detail: 'Its agent exited' }
  if (autopilotNeedsYou(task)) return { state: 'needs_you', detail: `Autopilot handed it back: ${task.autopilot?.reason ?? 'no reason given'}` }
  const seen = tabs.some(tab => deps.activityOf(tab.id) !== null)
  if (!seen && now - (task.lastInteractedAt ?? 0) < STARTING_MS) return { state: 'starting' }
  return { state: 'idle', detail: `Its agent finished its turn and waits for a message${shells ? `; ${shells} still runs` : ''}` }
}

/** "a background shell (npm test)", for shells still running past a finished turn; null when none. */
function shellLine(activities: ReadonlyArray<AgentActivity | null>): string | null {
  const shells = activities.flatMap(activity => (activity?.backgroundTasks ?? []).filter(isShellTask))
  if (shells.length === 0) return null
  const what = shells.length === 1 ? 'a background shell' : `${shells.length} background shells`
  return `${what} (${shells[0].label}${shells.length > 1 ? ', …' : ''})`
}

function closedDetail(entry: ArchivedTask): string {
  if (entry.task.autopilot?.phase === 'landing') return `Autopilot landed its work into ${entry.streamName || 'its stream'} and closed it`
  if (entry.task.landing) return `Closed (landing ${entry.task.landing.state})`
  return `Closed${entry.task.workspace ? ', its branch landed into ' + (entry.streamName || 'its stream') : ''}`
}

interface TaskSummary {
  taskId: string
  name: string
  project: string
  projectId: string
  stream: string
  streamId: string
  state: McpTaskState
  detail?: string
  branch?: string
  folder?: string
  autopilot?: string
  startedBy?: string
  /** "2 of 3 done": the tasks it started. */
  startedTasks?: string
  you?: true
}

/** How many tasks it started `task` waits for, by its project's tree. */
export function waitingOf(project: Project, task: Task, deps: Pick<DevtoolMcpDeps, 'statusOf'>): number {
  return waitingOnChildren(delegationTree([project]), task, deps.statusOf)
}

function summarize(found: FoundTask, deps: DevtoolMcpDeps, now: number, callerTaskId?: string): TaskSummary {
  if (found.kind === 'closed') {
    const { project, entry } = found
    return {
      taskId: entry.task.id,
      name: entry.task.name,
      project: project.name,
      projectId: project.id,
      stream: entry.streamName,
      streamId: entry.streamId,
      state: 'done',
      detail: closedDetail(entry),
      ...(entry.task.delegatedFrom ? { startedBy: `${entry.task.delegatedFrom.name} (${entry.task.delegatedFrom.taskId})` } : {})
    }
  }
  const { project, stream, task } = found
  const tree = delegationTree([project])
  const { state, detail } = liveTaskState(task, deps, now, waitingOnChildren(tree, task, deps.statusOf))
  const progress = childProgress(tree, task, deps.statusOf)
  const branch = task.workspace?.branchName ?? (stream.isMain ? undefined : stream.workspace?.branchName)
  return {
    taskId: task.id,
    name: task.name,
    project: project.name,
    projectId: project.id,
    stream: stream.name,
    streamId: stream.id,
    state,
    ...(detail ? { detail } : {}),
    ...(branch ? { branch } : {}),
    ...(project.ssh ? {} : { folder: taskDirectory(project, task) }),
    ...(task.autopilot ? { autopilot: task.autopilot.phase === 'stopped' ? `stopped: ${task.autopilot.reason ?? ''}` : task.autopilot.phase } : {}),
    ...(task.delegatedFrom ? { startedBy: `${task.delegatedFrom.name} (${task.delegatedFrom.taskId})` } : {}),
    ...(progress ? { startedTasks: childProgressLine(progress) } : {}),
    ...(task.id === callerTaskId ? { you: true as const } : {})
  }
}

function stateOf(found: FoundTask | null, deps: DevtoolMcpDeps, now: number): McpTaskState | null {
  if (!found) return null
  return found.kind === 'closed' ? 'done' : liveTaskState(found.task, deps, now, waitingOf(found.project, found.task, deps)).state
}

/** The end of `text`, at most `limit` characters. */
export function tail(text: string, limit = REPLY_LIMIT): string {
  return text.length > limit ? `…${text.slice(text.length - limit + 1)}` : text
}

async function withReply(summary: TaskSummary, found: FoundTask, deps: DevtoolMcpDeps): Promise<TaskSummary & { lastReply?: string }> {
  const task = found.kind === 'live' ? found.task : found.entry.task
  const tab = conversationTab(task)
  if (!tab) return summary
  const dir = found.kind === 'live' ? taskDirectory(found.project, task) : found.entry.dir
  let reply = await deps.lastReply(tab, dir).catch(() => null)
  reply = reply ?? (found.kind === 'live' ? deps.activityOf(tab.id)?.lastAnswer ?? null : null)
  if (reply && deps.redact) reply = deps.redact(reply)
  return reply ? { ...summary, lastReply: tail(reply) } : summary
}

// ---- transcript ----------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blocks(message: unknown): unknown[] | string | null {
  if (!isRecord(message)) return null
  const content = message.content
  if (typeof content === 'string' || Array.isArray(content)) return content
  return null
}

/**
 * The text of the agent's last reply in a Claude transcript (`getSessionMessages`
 * entries, oldest first): every main-thread assistant text after the last prompt
 * a person (or DevTool) typed. Tool results and subagents' messages don't count.
 */
export function lastReplyFromTranscript(entries: readonly unknown[]): string | null {
  const texts: string[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!isRecord(entry)) continue
    if (entry.isSidechain === true || (entry.parent_tool_use_id !== undefined && entry.parent_tool_use_id !== null)) continue
    const content = blocks(entry.message)
    if (entry.type === 'user') {
      const typed = typeof content === 'string' || (Array.isArray(content) && content.some(b => isRecord(b) && b.type === 'text'))
      if (typed) break
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    const text = content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      .map(b => (b.text as string).trim())
      .filter(Boolean)
      .join('\n\n')
    if (text) texts.unshift(text)
  }
  return texts.length > 0 ? texts.join('\n\n') : null
}

// ---- tools ---------------------------------------------------------------------------

interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_tasks',
    title: 'List DevTool tasks',
    description: 'Your project\'s streams (a stream is a branch line; `main` is the project folder\'s own branch) and its open tasks, each with its state. The task marked `you` is the one you are working in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'start_task',
    title: 'Start a DevTool task',
    description:
      'Start a new DevTool task in your project: a fresh agent (Claude by default, or Codex or Pi) working on `prompt` by itself, in the user\'s DevTool, alongside you. Use it to hand off a self-contained piece of work (a feature, a fix, an investigation) instead of doing it yourself, or to work on several things in parallel. ' +
      'The new agent sees nothing of this conversation: write the prompt as a complete brief (goal, where to look, what done means). ' +
      'It starts in your permission mode, or a stricter one. By default it runs on Autopilot when your mode allows (auto or bypass): it works without asking, and when it finishes DevTool checks files changed and lands its work into its stream as one commit, then closes the task (state `done`). ' +
      'It gets a git worktree of its own when the stream or project allows; if it would share a folder with an agent already working there, it gets its own worktree or waits its turn (state `queued`). ' +
      'Pi asks no permissions, so only an agent that runs with none either (Claude bypassing permissions, Codex full access) can start one. ' +
      'When it finishes (lands, goes idle, stops on a question, or fails) DevTool sends you a short message saying so, which starts your next turn: you can end your turn instead of waiting. wait_for_tasks and get_task still work. ' +
      'The user sees it under your task. Returns its taskId. Each task costs the user agent usage, so start one only for work worth a separate agent.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The new agent\'s first message: a complete, self-contained brief.' },
        streamId: { type: 'string', description: 'A stream from list_tasks. Default: your stream.' },
        agent: { type: 'string', enum: [...AI_TAB_TYPES], description: 'The agent that does the task. Default `claude`. `codex` and `pi` need turning on in DevTool\'s Settings.' },
        model: { type: 'string', description: 'The model it starts on, as that agent names it (Claude: an alias like `opus` or `sonnet`, or a full model id; Codex: a model id from its list, e.g. `gpt-6-luna`, or a short name like `luna` that DevTool turns into the best fitting id, and an unknown name is refused with the list; Pi: `provider/model` from its config). Default: the agent\'s own default.' },
        autopilot: { type: 'boolean', description: 'Default true. False leaves the finished task open for the user (state `idle`) instead of landing it.' },
        codexReview: { type: 'boolean', description: 'Autopilot only, default false: a Codex review of its diff before landing, its findings sent back to the agent once.' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'get_task',
    title: 'Get a DevTool task',
    description: 'A task\'s state and its agent\'s last reply (the end of it, when long), for a task in your project. Works for closed tasks too (state `done`).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'send_to_task',
    title: 'Message a DevTool task',
    description: 'Send a message to the agent of a task you started, as if the user typed it: an answer to its question, a correction, a follow-up. Sent while it works, it reaches the agent at its next step.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, message: { type: 'string' } },
      required: ['taskId', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'wait_for_tasks',
    title: 'Wait for DevTool tasks',
    description:
      'Block until tasks in your project have settled (state `idle`, `needs_you`, `exited` or `done`), or until the timeout. Returns each task\'s state and its last reply. ' +
      'A task in `needs_you` waits on an answer: read its last reply and answer with send_to_task, or tell the user.',
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
        until: { type: 'string', enum: ['all', 'any'], description: 'Default `all`: every task settled. `any`: the first one.' },
        timeoutSeconds: { type: 'number', description: `Default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}. Call again to keep waiting.` }
      },
      required: ['taskIds'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'request_secret',
    title: 'Ask the user for a secret',
    description:
      'Ask the user for a secret (API key, token, password) without it passing through this conversation. DevTool shows the user a masked field; ' +
      'the value is written to `file` in your task\'s folder (default `.env`, as `NAME=value`; any other file holds the value alone), and DevTool makes git ignore that file. ' +
      'You get back only where it is, never the value. Use it from there (dotenv, or `set -a; . ./.env; set +a; <command>` in one shell call). ' +
      'Do not print, echo, cat or log the value, and do not commit the file. Ask instead of telling the user to paste a secret into the chat. Blocks until the user answers (up to 30 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The env var name, e.g. OPENAI_API_KEY.' },
        reason: { type: 'string', description: 'One short line the user sees: what it is for.' },
        file: { type: 'string', description: `Where to put it, relative to your task's folder. Default \`${DEFAULT_SECRET_FILE}\`. Must not be tracked by git.` }
      },
      required: ['name', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'schedule_task',
    title: 'Schedule a recurring DevTool task',
    description:
      'Make a schedule in your project: DevTool starts a new task with `prompt` every `every` `unit`s (e.g. every 1 week), each run a fresh Claude agent that sees nothing of this conversation, so write the prompt as a complete brief. ' +
      'Use it when the user asks for something to be done or checked regularly ("check weekly whether X is fixed"). ' +
      'A run that finds nothing new closes itself quietly (DevTool tells it how); a run with something to report stays in the user\'s Inbox. ' +
      'Runs need DevTool to be running; missed ones become one run at the next launch. Runs start in your permission mode, or a stricter one. The user sees and edits schedules on the project\'s page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short title, shown in DevTool and on each run\'s task.' },
        prompt: { type: 'string', description: 'What each run does: a complete, self-contained brief, including what counts as worth reporting.' },
        every: { type: 'integer', minimum: 1, description: 'How many units between runs.' },
        unit: { type: 'string', enum: ['hour', 'day', 'week'] },
        firstRunAt: { type: 'string', description: 'ISO 8601 date-time of the first run; later runs keep its time of day. Default: one period from now.' },
        streamId: { type: 'string', description: 'A stream from list_tasks. Default: main.' }
      },
      required: ['name', 'prompt', 'every', 'unit'],
      additionalProperties: false
    }
  },
  {
    name: 'list_schedules',
    title: 'List DevTool schedules',
    description: 'Your project\'s schedules: each one\'s prompt, cadence, next run and its latest run\'s outcome.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'cancel_schedule',
    title: 'Delete a DevTool schedule',
    description: 'Delete one of your project\'s schedules (list_schedules names them). Runs already started are left alone.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'string' } },
      required: ['scheduleId'],
      additionalProperties: false
    },
    annotations: { destructiveHint: true }
  },
  {
    name: 'submit_score',
    title: 'Score an Autopilot loop round',
    description:
      'Only in a judge task of an Autopilot loop (your first message says so): your score for the round you judged. DevTool closes this task once your turn ends. Call it once, then end your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        score: { type: 'number', minimum: 0, maximum: 10, description: 'Your score from 1 to 10 against the rubric.' },
        findings: { type: 'string', description: 'What keeps it from 10, most important first, each one concrete: where, what is wrong, what to do. Markdown.' },
        rubric: { type: 'string', description: 'Round 0 only: the rubric as Markdown (3-5 criteria, and for each what you check and how).' }
      },
      required: ['score', 'findings'],
      additionalProperties: false
    }
  },
  {
    name: 'nothing_new',
    title: 'End a scheduled run quietly',
    description:
      'Only in a scheduled run (DevTool\'s context says so): you found nothing the user needs to see. DevTool closes this task once your turn ends, so it never reaches their Inbox, and keeps `note` as the run\'s outcome. Call it, then end your turn.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'One line: what you checked and found, e.g. "Issue #97074 still open, no fix released".' } },
      additionalProperties: false
    }
  }
]

/** What an agent sees of a schedule. */
function describeSchedule(project: Project, schedule: Schedule): Record<string, unknown> {
  const streamId = scheduleStreamId(project, schedule)
  return {
    scheduleId: schedule.id,
    name: schedule.name,
    cadence: cadenceLabel(schedule),
    stream: project.streams.find(s => s.id === streamId)?.name ?? 'main',
    ...(schedule.paused ? { paused: true } : { nextRunAt: new Date(schedule.nextRunAt).toISOString() }),
    prompt: schedule.prompt,
    ...(schedule.lastRun
      ? {
          lastRun: {
            at: new Date(schedule.lastRun.at).toISOString(),
            outcome: schedule.lastRun.outcome,
            ...(schedule.lastRun.taskId ? { taskId: schedule.lastRun.taskId } : {}),
            ...(schedule.lastRun.note ? { note: schedule.lastRun.note } : {})
          }
        }
      : {}),
    ...(schedule.createdBy ? { createdBy: `${schedule.createdBy.name} (${schedule.createdBy.taskId})` } : {})
  }
}

function mapProjectIn(data: ProjectsData, projectId: string, fn: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? fn(p) : p)) }
}

class ToolError extends Error {}

function str(args: Record<string, unknown>, key: string, required: true): string
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`\`${key}\` is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new ToolError(`\`${key}\` must be a string.`)
  return value
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ToolError(`\`${key}\` must be true or false.`)
  return value
}

interface Caller {
  tabId: string
}

/**
 * The caller: a live task's agent tab of a kind DevTool gives these tools.
 * Everything it reaches is in its own project; a tab that is no such agent
 * reaches nothing.
 */
function callerTask(data: ProjectsData, tabId: string): LiveTask {
  const me = findTabOwner(data, tabId)
  const tab = me ? taskTabs(me.task).find(t => t.id === tabId) : undefined
  if (!me || !tab || !hasMcpTools(tab.type)) throw new ToolError('Only an agent in a DevTool task can use these tools.')
  return me
}

async function callTool(name: string, args: Record<string, unknown>, caller: Caller, deps: DevtoolMcpDeps, signal?: AbortSignal): Promise<unknown> {
  const now = deps.now?.() ?? Date.now()
  const data = deps.peek()
  const me = callerTask(data, caller.tabId)
  const { project } = me
  const find = (from: ProjectsData, taskId: string): FoundTask | null => findTask(from, deps, taskId, project.id)

  switch (name) {
    case 'list_tasks':
      return {
        project: project.name,
        streams: (project.streams ?? []).map(stream => ({
          streamId: stream.id,
          name: stream.name,
          ...(stream.isMain ? { main: true } : {}),
          ...(stream.workspace ? { branch: stream.workspace.branchName } : {}),
          ...(stream.id === me.stream.id ? { yours: true } : {})
        })),
        tasks: (project.streams ?? []).flatMap(stream =>
          stream.tasks.map(task => summarize({ kind: 'live', project, stream, task }, deps, now, me.task.id)))
      }

    case 'start_task': {
      const prompt = str(args, 'prompt', true).trim()
      if (!prompt) throw new ToolError('`prompt` is empty.')
      if (prompt.length > PROMPT_LIMIT) throw new ToolError(`\`prompt\` is longer than ${PROMPT_LIMIT} characters.`)
      const streamId = str(args, 'streamId') ?? me.stream.id
      if (!project.streams.some(s => s.id === streamId)) throw new ToolError('No such stream in your project. list_tasks names them.')
      const agentArg = str(args, 'agent') ?? 'claude'
      if (!(AI_TAB_TYPES as readonly string[]).includes(agentArg)) throw new ToolError(`\`agent\` must be one of: ${AI_TAB_TYPES.join(', ')}.`)
      const agent = agentArg as AiTabType
      const asked = str(args, 'model')?.trim() || undefined
      if (asked && (asked.length > MODEL_LIMIT || /[\s\0]/.test(asked))) throw new ToolError('`model` must be one model name, with no spaces.')
      // A name the agent doesn't know would start a task whose every turn fails; a short one ("luna") means its id.
      const known = asked ? deps.modelsFor?.(agent) ?? null : null
      const resolved = asked && known ? resolveModel(asked, known, AI_TAB_META[agent].label) : null
      if (resolved && !resolved.ok) throw new ToolError(resolved.error)
      const model = resolved?.ok ? resolved.model : asked
      const result = await deps.startTask({
        projectId: project.id,
        streamId,
        prompt,
        agent,
        ...(model ? { model } : {}),
        autopilot: bool(args, 'autopilot', true),
        review: bool(args, 'codexReview', false),
        callerTabId: caller.tabId,
        from: { taskId: me.task.id, name: me.task.name }
      })
      if (!result.ok) throw new ToolError(result.error)
      const found = find(deps.peek(), result.taskId)
      const notes = [
        resolved?.ok && resolved.note ? resolved.note : '',
        result.ownWorktree ? 'It works in a git worktree of its own.' : '',
        result.queued ? 'Another agent works in its folder, so it waits its turn (state `queued`).' : '',
        !result.autopilot && bool(args, 'autopilot', true)
          ? 'Autopilot is off: it needs auto or bypass permissions, and your mode is stricter. The finished task stays open for the user.'
          : ''
      ].filter(Boolean)
      return {
        ...(found ? summarize(found, deps, deps.now?.() ?? Date.now(), me.task.id) : { taskId: result.taskId }),
        agent,
        ...(model ? { model } : {}),
        autopilot: result.autopilot,
        ...(result.mode ? { permissionMode: result.mode } : {}),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      }
    }

    case 'get_task': {
      const taskId = str(args, 'taskId', true)
      const found = find(data, taskId)
      if (!found) throw new ToolError('No such task in your project. list_tasks names the open ones.')
      const summary = summarize(found, deps, now, me.task.id)
      if (settled(summary.state)) deps.reported?.([taskId])
      return withReply(summary, found, deps)
    }

    case 'send_to_task': {
      const taskId = str(args, 'taskId', true)
      const message = str(args, 'message', true)
      if (message.length > PROMPT_LIMIT) throw new ToolError(`\`message\` is longer than ${PROMPT_LIMIT} characters.`)
      if (me.task.id === taskId) throw new ToolError('That is your own task.')
      const found = find(data, taskId)
      if (!found) throw new ToolError('No such task in your project.')
      if (found.kind === 'closed') throw new ToolError('That task is closed.')
      // Only your own: another task's agent is the user's to direct.
      if (found.task.delegatedFrom?.taskId !== me.task.id) throw new ToolError('You can message only tasks you started.')
      // A loop's judges are DevTool's, not their worker's: it mustn't sway its own score.
      if (found.task.judgeOf) throw new ToolError('That task judges your work for DevTool; you can\'t message it.')
      if (found.task.queued) throw new ToolError('That task has not started yet (it is queued). Wait for it first.')
      const tab = conversationTab(found.task)
      if (!tab) throw new ToolError('That task has no agent to send to.')
      await deps.sendToTask(found.project, found.task, tab, message)
      return { sent: true, ...summarize(found, deps, deps.now?.() ?? Date.now(), me.task.id) }
    }

    case 'wait_for_tasks': {
      const raw = args.taskIds
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every(id => typeof id === 'string')) throw new ToolError('`taskIds` must be a list of task ids.')
      const taskIds = [...new Set(raw as string[])].slice(0, 50)
      if (taskIds.includes(me.task.id)) throw new ToolError('You can\'t wait for your own task.')
      const until = args.until === 'any' ? 'any' : 'all'
      const timeout = typeof args.timeoutSeconds === 'number' && args.timeoutSeconds > 0
        ? Math.min(args.timeoutSeconds, WAIT_MAX_S)
        : WAIT_DEFAULT_S
      for (const taskId of taskIds) {
        if (!find(data, taskId)) throw new ToolError(`No such task in your project: ${taskId}`)
      }
      const timedOut = !(await waitUntilSettled(taskIds, until, timeout * 1000, deps, signal, project.id))
      const after = deps.peek()
      const tasks = await Promise.all(taskIds.map(async taskId => {
        const found = find(after, taskId)
        if (!found) return { taskId, state: 'gone', detail: 'Deleted' }
        const summary = summarize(found, deps, deps.now?.() ?? Date.now(), me.task.id)
        return settled(summary.state) ? withReply(summary, found, deps) : summary
      }))
      deps.reported?.(tasks.filter(task => task.state === 'gone' || settled(task.state as McpTaskState)).map(task => task.taskId))
      return { timedOut, tasks }
    }

    case 'request_secret': {
      const secretName = str(args, 'name', true).trim()
      if (!validSecretName(secretName)) throw new ToolError('`name` must be an env var name: letters, digits and _, not starting with a digit.')
      const reason = str(args, 'reason', true).trim().slice(0, SECRET_REASON_MAX)
      const file = safeSecretFile(str(args, 'file') ?? DEFAULT_SECRET_FILE)
      if (!file) throw new ToolError('`file` must be a path inside your task\'s folder (not in .git).')
      if (!deps.requestSecret) throw new ToolError('DevTool can\'t ask for secrets here. Ask the user to put it in place themselves.')
      const outcome = await deps.requestSecret({ project, task: me.task, tabId: caller.tabId, name: secretName, reason, file }, signal)
      switch (outcome.status) {
        case 'error':
          throw new ToolError(outcome.error)
        case 'declined':
          throw new ToolError(`The user declined to give ${secretName}. Don't ask again for it unless they say so.`)
        case 'timeout':
          throw new ToolError(`The user didn't answer within 30 minutes. ${secretName} was not given.`)
        case 'cancelled':
          throw new ToolError(`The request for ${secretName} was cancelled.`)
        case 'provided': {
          const notes = [
            isDotenvFile(file)
              ? `${secretName} is set in ${file}. Load it from there; don't print or read its value.`
              : `${file} holds the value of ${secretName}. Read it from there in the command that needs it; don't print it.`,
            outcome.excluded ? `DevTool added ${file} to .git/info/exclude so git ignores it.` : ''
          ].filter(Boolean)
          return { provided: true, name: secretName, file, note: notes.join(' ') }
        }
      }
      throw new ToolError('DevTool failed to ask.')
    }

    case 'schedule_task': {
      if (!schedulesSupported(project)) throw new ToolError('Schedules run only in projects on this machine.')
      // Only a task the user started makes schedules: a run or a delegated task can't make more of itself.
      if (me.task.scheduledFrom || me.task.delegatedFrom) throw new ToolError('Only a task the user started can make schedules. Tell the user what to schedule instead.')
      const scheduleName = str(args, 'name', true)
      const prompt = str(args, 'prompt', true)
      const textProblem = textError(scheduleName, prompt)
      if (textProblem) throw new ToolError(textProblem)
      const cadence = cadenceError(args.every, args.unit)
      if (cadence) throw new ToolError(cadence)
      const streamId = str(args, 'streamId')
      if (streamId && !project.streams.some(s => s.id === streamId)) throw new ToolError('No such stream in your project. list_tasks names them.')
      if (projectSchedules(project).length >= SCHEDULES_PER_PROJECT) throw new ToolError(`A project has at most ${SCHEDULES_PER_PROJECT} schedules.`)
      const first = str(args, 'firstRunAt')
      let startAt: number | undefined
      if (first) {
        startAt = Date.parse(first)
        if (Number.isNaN(startAt)) throw new ToolError('`firstRunAt` must be an ISO 8601 date-time.')
        if (startAt < now - 60_000) throw new ToolError('`firstRunAt` is in the past.')
      }
      const mode = delegatedMode(deps.callerMode(caller.tabId))
      const schedule = newSchedule({
        id: deps.newId(),
        name: scheduleName,
        prompt,
        every: args.every as number,
        unit: args.unit as ScheduleUnit,
        ...(streamId && !project.streams.find(s => s.id === streamId)?.isMain ? { streamId } : {}),
        ...(startAt !== undefined ? { startAt } : {}),
        mode,
        createdBy: { taskId: me.task.id, name: me.task.name },
        now
      })
      deps.commit(mapProjectIn(deps.peek(), project.id, p => applyScheduleOp(p, { op: 'add', schedule })))
      return { ...describeSchedule(project, schedule), permissionMode: mode }
    }

    case 'list_schedules':
      return { project: project.name, schedules: projectSchedules(project).map(s => describeSchedule(project, s)) }

    case 'cancel_schedule': {
      const scheduleId = str(args, 'scheduleId', true)
      if (!projectSchedules(project).some(s => s.id === scheduleId)) throw new ToolError('No such schedule in your project. list_schedules names them.')
      deps.commit(mapProjectIn(deps.peek(), project.id, p => applyScheduleOp(p, { op: 'remove', id: scheduleId })))
      return { deleted: true, scheduleId }
    }

    case 'submit_score': {
      const judgeOf = me.task.judgeOf
      if (!judgeOf) throw new ToolError('Only a judge task of an Autopilot loop scores rounds.')
      const worker = findLiveTask(data, judgeOf.taskId)
      const judging = worker?.task.autopilot?.loop?.judging
      if (!worker || worker.project.id !== project.id || judging?.taskId !== me.task.id) {
        throw new ToolError('The loop isn\'t waiting for your score any more. End your turn.')
      }
      const score = args.score
      if (!validScore(score)) throw new ToolError('`score` must be a number from 0 to 10.')
      const findings = str(args, 'findings', true).trim()
      const rubric = str(args, 'rubric')?.trim()
      if (judgeOf.round === 0 && !rubric) throw new ToolError('Round 0 needs the `rubric` too.')
      if (findings.length > PROMPT_LIMIT || (rubric?.length ?? 0) > PROMPT_LIMIT) throw new ToolError(`Keep \`findings\` and \`rubric\` under ${PROMPT_LIMIT} characters.`)
      deps.commit(mapProjectIn(deps.peek(), project.id, p => mapTaskInProject(p, worker.task.id, task => {
        const loop = task.autopilot?.loop
        if (!task.autopilot || !loop?.judging || loop.judging.taskId !== me.task.id) return task
        return { ...task, autopilot: { ...task.autopilot, loop: { ...loop, judging: { ...loop.judging, score, findings, ...(rubric ? { rubric } : {}) } } } }
      })))
      return { recorded: true, score, note: 'DevTool closes this task once your turn ends. End your turn now with one short line.' }
    }

    case 'nothing_new': {
      if (!me.task.scheduledFrom) throw new ToolError('This task is not a scheduled run: report to the user instead.')
      const note = (str(args, 'note') ?? '').trim().slice(0, 300)
      deps.commit(mapProjectIn(deps.peek(), project.id, p => mapTaskInProject(p, me.task.id, task => ({ ...task, quietRun: note ? { note } : {} }))))
      return { ok: true, note: 'DevTool closes this task once your turn ends. End your turn now with one short line.' }
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`)
  }
}


/**
 * Resolves true once `until` of the tasks have settled, false at the timeout or
 * when `signal` aborts (the caller hung up). Closed tasks are looked up once:
 * a closed task stays closed.
 */
export function waitUntilSettled(
  taskIds: readonly string[],
  until: 'all' | 'any',
  timeoutMs: number,
  deps: DevtoolMcpDeps,
  signal?: AbortSignal,
  projectId?: string
): Promise<boolean> {
  const done = new Set<string>()
  const check = (): boolean => {
    const data = deps.peek()
    const now = deps.now?.() ?? Date.now()
    for (const taskId of taskIds) {
      if (done.has(taskId)) continue
      const live = findLiveTask(data, taskId)
      const found = live ?? (projectId ? findClosedTask(data, deps, taskId, projectId) : null)
      const state = stateOf(found, deps, now)
      if (state === null || settled(state)) done.add(taskId)
    }
    return until === 'any' ? done.size > 0 : done.size === taskIds.length
  }
  if (check()) return Promise.resolve(true)
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let finished = false
    let pending = false
    const finish = (result: boolean): void => {
      if (finished) return
      finished = true
      unsubscribe()
      clearTimeout(timer)
      clearInterval(poll)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish(false)
    // Coalesce a burst of changes into one look.
    const changed = (): void => {
      if (pending || finished) return
      pending = true
      queueMicrotask(() => {
        pending = false
        if (!finished && check()) finish(true)
      })
    }
    const unsubscribe = deps.subscribe(changed)
    const timer = setTimeout(() => finish(false), timeoutMs)
    // `starting` turns into `idle` with time alone, which no event announces.
    const poll = setInterval(changed, 15_000)
    signal?.addEventListener('abort', onAbort)
  })
}

// ---- JSON-RPC ------------------------------------------------------------------------

type JsonRpcId = string | number | null

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

function reply(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleOne(message: unknown, caller: Caller, deps: DevtoolMcpDeps, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A response from the client (we never ask it anything) or garbage.
    if (isRecord(message) && message.jsonrpc === '2.0' && message.method === undefined) return undefined
    return failure(null, -32600, 'Invalid request')
  }
  const isNotification = !('id' in message)
  const id = (message.id ?? null) as JsonRpcId
  const params = isRecord(message.params) ? message.params : {}
  if (isNotification) return undefined

  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: 'DevTool', version: SERVER_VERSION },
        instructions:
          'DevTool is the app that runs you. These tools start, follow and message other DevTool tasks (each one its own agent), ' +
          'so you can hand off self-contained work or run several pieces in parallel and collect their results. ' +
          'When you need a secret (API key, token, password), ask with request_secret instead of asking the user to paste it into the chat. ' +
          'Schedules (schedule_task, list_schedules, cancel_schedule) run a prompt again every hour, day or week as a new task, for work the user wants done or checked regularly.'
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!TOOLS.some(tool => tool.name === name)) return failure(id, -32602, `Unknown tool: ${name}`)
      const args = isRecord(params.arguments) ? params.arguments : {}
      try {
        const result = await callTool(name, args, caller, deps, signal)
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `DevTool failed: ${err instanceof Error ? err.message : String(err)}`
        return reply(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`)
  }
}

/**
 * One POST to `/mcp`: a JSON-RPC message or a batch. Undefined when nothing
 * needs an answer (notifications only), which the transport sends as 202.
 */
export async function handleMcpMessage(body: unknown, caller: Caller, deps: DevtoolMcpDeps, signal?: AbortSignal): Promise<unknown> {
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(message => handleOne(message, caller, deps, signal)))).filter(Boolean)
    return answers.length > 0 ? answers : undefined
  }
  return handleOne(body, caller, deps, signal)
}
