/**
 * Tasks started by another task's agent (`Task.delegatedFrom`, DevTool's MCP
 * `start_task`), the parts every process reads alike: a started task lives
 * under the task that started it while that one is open, the parent counts
 * its children ("2 of 3 done"), and it waits for them while any still works.
 *
 * The desktop Inbox, the Project map, the task header, the phone's inbox
 * (`main/mobile/inbox.ts`), the MCP tools' task states and the wake-up
 * delivery (`main/delegation-delivery.ts`) all read these, so a parent never
 * shows as waiting in one place and idle in another.
 */
import { autopilotActive, autopilotNeedsYou } from './autopilot'
import { landingNeedsYou, taskStatus, statusTabs } from './inbox-state'
import type { Project, TabStatusValue, Task } from './types'

export type StatusOf = (tabId: string) => TabStatusValue

/** A status lookup over a renderer's status map. */
export function statusFrom(statuses: Readonly<Record<string, TabStatusValue>>): StatusOf {
  return (tabId) => statuses[tabId] ?? null
}

/** The task's own status: the strongest of its status tabs (`taskStatus`). */
export function ownStatus(task: Task, statusOf: StatusOf): TabStatusValue {
  const statuses: Record<string, TabStatusValue> = {}
  for (const tab of statusTabs(task)) statuses[tab.id] = statusOf(tab.id)
  return taskStatus(task, statuses)
}

/** Waits on the user: a question or permission, a stopped landing, an Autopilot run handed back. */
export function taskNeedsYou(task: Task, statusOf: StatusOf): boolean {
  return ownStatus(task, statusOf) === 'attention' || landingNeedsYou(task) || autopilotNeedsYou(task)
}

/**
 * The task itself is still at it: queued, its agent mid-turn, a landing
 * running or being fixed, or an Autopilot run not handed back. A task that
 * needs you is not.
 */
export function taskInFlight(task: Task, statusOf: StatusOf): boolean {
  if (task.queued) return true
  if (taskNeedsYou(task, statusOf)) return false
  const status = ownStatus(task, statusOf)
  if (status === 'working') return true
  if (status === 'exited') return false
  if (task.landing?.state === 'landing' || task.landing?.state === 'fixing') return true
  return autopilotActive(task)
}

/** Who started whom, among open tasks. */
export interface DelegationTree {
  /** Every open task by id. */
  tasks: ReadonlyMap<string, Task>
  /** An open task started by another open task of its project: that task's id. */
  parentOf: ReadonlyMap<string, string>
  /** An open task's open children, in project order. */
  childrenOf: ReadonlyMap<string, readonly string[]>
}

/**
 * The tree over `projects`' open tasks. A task whose parent is closed (or in
 * another project) is a root: it shows on its own, so nothing is lost.
 */
export function delegationTree(projects: readonly Project[]): DelegationTree {
  const tasks = new Map<string, Task>()
  const projectOf = new Map<string, string>()
  for (const project of projects) {
    for (const stream of project.streams ?? []) {
      for (const task of stream.tasks) {
        tasks.set(task.id, task)
        projectOf.set(task.id, project.id)
      }
    }
  }
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const [id, task] of tasks) {
    const parentId = task.delegatedFrom?.taskId
    if (!parentId || parentId === id || !tasks.has(parentId) || projectOf.get(parentId) !== projectOf.get(id)) continue
    parentOf.set(id, parentId)
  }
  // A loop (never made by start_task, but stored data can be anything) would hide
  // its tasks for good: cut it where it closes.
  for (const id of [...parentOf.keys()]) {
    const seen = new Set<string>([id])
    let at = parentOf.get(id)
    while (at !== undefined) {
      if (seen.has(at)) {
        parentOf.delete(id)
        break
      }
      seen.add(at)
      at = parentOf.get(at)
    }
  }
  for (const [id, parentId] of parentOf) {
    const list = childrenOf.get(parentId)
    if (list) list.push(id)
    else childrenOf.set(parentId, [id])
  }
  return { tasks, parentOf, childrenOf }
}

/** The open tasks under `taskId`, deepest first (grandchildren before their parent): the order to stop them in. */
export function openDescendants(tree: DelegationTree, taskId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([taskId])
  const walk = (id: string): void => {
    for (const child of tree.childrenOf.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      walk(child)
      out.push(child)
    }
  }
  walk(taskId)
  return out
}

/** The task at the top of `taskId`'s line: itself when nothing open started it. */
export function rootOf(tree: DelegationTree, taskId: string): string {
  let at = taskId
  const seen = new Set<string>()
  while (!seen.has(at)) {
    seen.add(at)
    const parent = tree.parentOf.get(at)
    if (parent === undefined) return at
    at = parent
  }
  return at
}

/**
 * A child is still at it when it is in flight itself, or when it waits for
 * children of its own that are.
 */
function busy(tree: DelegationTree, task: Task, statusOf: StatusOf, seen: Set<string>): boolean {
  if (taskInFlight(task, statusOf)) return true
  if (taskNeedsYou(task, statusOf)) return false
  for (const childId of tree.childrenOf.get(task.id) ?? []) {
    if (seen.has(childId)) continue
    seen.add(childId)
    const child = tree.tasks.get(childId)
    if (child && busy(tree, child, statusOf, seen)) return true
  }
  return false
}

/** How the tasks a task started stand. */
export interface ChildProgress {
  /** Every task it started, closed ones included. */
  total: number
  /** Closed, or finished and waiting for a message. */
  done: number
  /** Still at it (or waiting for tasks of their own). */
  working: number
  /** Waiting on the user. */
  needsYou: number
}

/** Null for a task that started none. */
export function childProgress(tree: DelegationTree, task: Task, statusOf: StatusOf): ChildProgress | null {
  const open = tree.childrenOf.get(task.id) ?? []
  const ids = new Set<string>([...(task.startedTaskIds ?? []), ...open])
  ids.delete(task.id)
  if (ids.size === 0) return null
  const progress: ChildProgress = { total: ids.size, done: 0, working: 0, needsYou: 0 }
  for (const id of ids) {
    const child = tree.parentOf.get(id) === task.id ? tree.tasks.get(id) : undefined
    if (!child) progress.done++
    else if (taskNeedsYou(child, statusOf)) progress.needsYou++
    else if (busy(tree, child, statusOf, new Set([task.id, child.id]))) progress.working++
    else progress.done++
  }
  return progress
}

/**
 * How many of the task's children it waits for: some still work while the
 * task's own agent is quiet (not mid-turn, not asking, its landing not
 * stopped). 0 when it isn't waiting.
 */
export function waitingOnChildren(tree: DelegationTree, task: Task, statusOf: StatusOf): number {
  const status = ownStatus(task, statusOf)
  if (status === 'working' || status === 'attention' || landingNeedsYou(task) || autopilotNeedsYou(task)) return 0
  if (task.landing?.state === 'landing' || task.landing?.state === 'fixing' || task.queued) return 0
  return childProgress(tree, task, statusOf)?.working ?? 0
}

/** "2 of 3 done", "1 needs you": the parent row's line about its children. */
export function childProgressLine(progress: ChildProgress): string {
  const parts = [`${progress.done} of ${progress.total} done`]
  if (progress.needsYou > 0) parts.push(`${progress.needsYou} ${progress.needsYou === 1 ? 'needs' : 'need'} you`)
  return parts.join(' · ')
}

/** "Waiting on 2 tasks". */
export function waitingLine(count: number): string {
  return `Waiting on ${count} ${count === 1 ? 'task' : 'tasks'}`
}

/**
 * The open tasks under `taskId` still at it, deepest first: what closing it
 * asks about (stop them too, or leave them running). Empty when there is
 * nothing to ask.
 */
export function workingDescendants(tree: DelegationTree, taskId: string, statusOf: StatusOf): string[] {
  return openDescendants(tree, taskId).filter(id => {
    const task = tree.tasks.get(id)
    return !!task && taskInFlight(task, statusOf)
  })
}
