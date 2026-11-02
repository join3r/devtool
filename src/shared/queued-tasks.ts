/**
 * Queued tasks: a task started from the same-folder warning's Queue waits,
 * listed as snoozed, until no other agent works in the folder it would start in
 * (the project folder, or a stream worktree its tasks share). Then main sends it
 * its first prompt (`main/queued-task-runner.ts`). The rules live here so they
 * can be tested without main.
 */
import type { Project, TabStatusValue, Task, TaskQueuedStart } from './types'
import { isAgentTabType, isChatTabType } from './types'
import { mapProjectTasks, taskDirectory, taskTabs } from './streams'
import { statusTabs } from './inbox-state'

export type QueueStatusOf = (tabId: string) => TabStatusValue | undefined

/** The chat tab a queued task's prompt goes to. */
export function queuedTaskTab(task: Task): { id: string; type: string } | undefined {
  return taskTabs(task).find(tab => isChatTabType(tab.type))
}

/** An agent tab of the task is mid-turn. */
function working(task: Task, statusOf: QueueStatusOf): boolean {
  return taskTabs(task).some(tab => isAgentTabType(tab.type) && statusOf(tab.id) === 'working')
}

/**
 * The queued tasks of `project` to start now, oldest first: one per folder once
 * nothing else works there, and every one asked to start now. A task that last
 * failed to start waits for Start now.
 */
export function queuedTasksToStart(project: Project, statusOf: QueueStatusOf): Task[] {
  const tasks = project.streams.flatMap(stream => stream.tasks)
  const queued = tasks.filter(task => task.queued && queuedTaskTab(task))
    .sort((a, b) => (a.queued?.at ?? 0) - (b.queued?.at ?? 0))
  if (queued.length === 0) return []
  const busy = new Set(tasks.filter(task => !task.queued && working(task, statusOf)).map(task => taskDirectory(project, task)))
  const out: Task[] = []
  for (const task of queued) {
    const dir = taskDirectory(project, task)
    if (task.queued?.now) {
      out.push(task)
      busy.add(dir)
    } else if (!task.queued?.error && !busy.has(dir)) {
      out.push(task)
      busy.add(dir)
    }
  }
  return out
}

/**
 * Queued tasks you started yourself meanwhile (typed into the chat): their agent
 * runs or asks, so they are queued no longer.
 */
export function queuedTasksTakenOver(project: Project, statusOf: QueueStatusOf): Task[] {
  return project.streams.flatMap(stream => stream.tasks)
    .filter(task => task.queued && statusTabs(task).some(tab => {
      const status = statusOf(tab.id)
      return status === 'working' || status === 'attention'
    }))
}

function mapQueued(project: Project, taskId: string, update: (queued: TaskQueuedStart) => TaskQueuedStart | null): Project {
  return mapProjectTasks(project, task => {
    if (task.id !== taskId || !task.queued) return task
    const next = update(task.queued)
    if (next) return { ...task, queued: next }
    const { queued: _queued, ...rest } = task
    return rest
  })
}

/** The task leaves the queue (it starts, or you started it). */
export function clearQueued(project: Project, taskId: string): Project {
  return mapQueued(project, taskId, () => null)
}

/** Start it with the next look, whoever else works in its folder. */
export function startQueuedNow(project: Project, taskId: string): Project {
  return mapQueued(project, taskId, queued => {
    const { error: _error, ...rest } = queued
    return { ...rest, now: true }
  })
}

/** Back on the queue after a failed start, waiting for Start now. */
export function requeueFailed(project: Project, taskId: string, queued: TaskQueuedStart, error: string): Project {
  return mapProjectTasks(project, task => {
    if (task.id !== taskId) return task
    const { now: _now, ...rest } = queued
    return { ...task, queued: { ...rest, error } }
  })
}

/** The queued tasks' line in the inbox: what they wait for. */
export function queuedLine(queued: TaskQueuedStart): string {
  return queued.error ? `Couldn’t start: ${queued.error}` : 'Queued · starts when the other agents here finish'
}
