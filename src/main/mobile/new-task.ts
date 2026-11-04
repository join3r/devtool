import { randomUUID } from 'crypto'
import { CLAUDE_CHAT_LABEL, createMainStream, isShellCommandProject, type Project, type ProjectsData, type Tab, type Task, type TaskQueuedStart } from '../../shared/types'
import { taskNameFromPrompt } from '../../shared/task-name'
import { AppErrorCode } from '../../../protocol/ts/index.ts'
import { addTaskToStream, canHaveMainTaskWorktrees, currentStreamId, resolveMainTabId, singlePane, streamGivesTaskWorktrees, withLastTask } from '../../shared/streams'
import { isVisibleOnMobile } from './inbox'

/**
 * `task.new` (SPEC.md §8.4): a new task at the end of one of a project's streams
 * (the phone's pick, else the stream the project was last used in, else `main`),
 * named after the first prompt, with one Claude chat tab in its only pane. The
 * stream becomes the project's most recently used one, so the phone's next New
 * task defaults to it. Main commits it itself, so no window has
 * to be open and none of them switches to it; sending the prompt is the caller's
 * next step.
 */

export type NewTaskResult =
  | { ok: true; data: ProjectsData; taskId: string; tabId: string }
  | { ok: false; code: string; message: string }

/** The project a phone may start a task in, or why it may not. */
export function newTaskProject(
  data: ProjectsData,
  projectId: string
): { ok: true; project: Project } | { ok: false; code: string; message: string } {
  const project = data.projects.find((p) => p.id === projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  // A shell-command project runs one command, not agents; its tab bar has no Claude button.
  if (isShellCommandProject(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This project runs a shell command, not Claude' }
  return { ok: true, project }
}

/**
 * What `task.new`'s `start` (§8.4) makes of the task: `queued` waits, snoozed,
 * until no other agent works in its folder (`main/queued-task-runner.ts`);
 * `ownWorktree` gives a `main` task a worktree of its own.
 */
export type NewTaskExtra = Pick<Task, 'queued' | 'ownWorktree'>

export function addTaskWithChat(
  data: ProjectsData,
  projectId: string,
  prompt: string,
  streamId?: string,
  ids: () => string = randomUUID,
  now: number = Date.now(),
  start?: { start?: 'queue' | 'worktree'; mode?: string }
): NewTaskResult {
  const found = newTaskProject(data, projectId)
  if (!found.ok) return found
  const { project } = found
  if (streamId !== undefined && !project.streams.some((stream) => stream.id === streamId)) {
    return { ok: false, code: AppErrorCode.NotFound, message: 'No such stream' }
  }
  let extra: NewTaskExtra | undefined
  if (start?.start === 'queue') {
    const queued: TaskQueuedStart = { prompt, ...(start.mode ? { mode: start.mode } : {}), at: now }
    extra = { queued }
  } else if (start?.start === 'worktree') {
    const target = project.streams.find((stream) => stream.id === (streamId ?? currentStreamId(project)))
    if (!target?.isMain) return { ok: false, code: AppErrorCode.BadRequest, message: 'Only a task in main can take a worktree of its own' }
    if (!canHaveMainTaskWorktrees(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This project\'s tasks can\'t have worktrees of their own' }
    // Main giving them anyway: every new task gets one, flag or not.
    if (!streamGivesTaskWorktrees(target)) extra = { ownWorktree: true }
  }
  return { ok: true, ...addChatTaskToProject(data, project, prompt, streamId, ids, now, extra) }
}

/**
 * The task itself, in `project` as it is in `data`: the phone's `task.new` and
 * the Project Home queue (`main/prompt-queue-runner.ts`) both start one this way.
 */
export function addChatTaskToProject(
  data: ProjectsData,
  project: Project,
  prompt: string,
  streamId?: string,
  ids: () => string = randomUUID,
  now: number = Date.now(),
  extra?: NewTaskExtra
): { data: ProjectsData; taskId: string; tabId: string } {
  const tab: Tab = { id: ids(), type: 'claude-chat', title: CLAUDE_CHAT_LABEL, sessionId: ids() }
  const mainTabId = resolveMainTabId([tab])
  const task: Task = {
    id: ids(),
    name: taskNameFromPrompt(prompt),
    panes: singlePane([tab]),
    ...(mainTabId ? { mainTabId } : {}),
    lastInteractedAt: now,
    ...(extra?.queued ? { queued: extra.queued } : {}),
    ...(extra?.ownWorktree ? { ownWorktree: true as const } : {})
  }
  const target = streamId ?? currentStreamId(project)
  const withTask: Project = withLastTask(
    target
      ? addTaskToStream(project, target, task)
      : { ...project, streams: [createMainStream(project.id, [task]), ...project.streams] },
    task.id
  )
  const stats = project.lifetimeStats ?? { tasksCreated: 0, notesCreated: 0 }
  const next: ProjectsData = {
    ...data,
    projects: data.projects.map((p) =>
      p !== project ? p : { ...withTask, lifetimeStats: { ...stats, tasksCreated: stats.tasksCreated + 1 } }
    )
  }
  return { data: next, taskId: task.id, tabId: tab.id }
}
