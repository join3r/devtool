import { useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { findStreamOfTask, findTaskInProject } from '../../shared/streams'
import type { Project, Task, TaskLandingResult } from '../../shared/types'
import { tabIdsOfTask } from '../hooks/appState/projectsData'
import { confirmAction } from '../confirmAction'
import {
  markTaskClosing,
  refreshStreamAhead,
  runLandingOp,
  setLandingNotice,
  type LandingNotice,
  type LandingOp
} from '../taskLanding'

/**
 * The line a landing call leaves on the task's banner, or null when the
 * banner already shows the outcome (a stopped landing is on `Task.landing`)
 * or there is nothing to say.
 */
export function landingResultNotice(result: TaskLandingResult, op: LandingOp, streamName: string): LandingNotice | null {
  switch (result.status) {
    case 'landed':
      return { tone: 'info', text: `Landed into ${streamName}.` }
    case 'updated':
      return { tone: 'info', text: `Updated from ${streamName}.` }
    case 'nothing':
      return { tone: 'info', text: op === 'update' ? `Already up to date with ${streamName}.` : `Nothing to land into ${streamName}.` }
    case 'working':
      return { tone: 'error', text: 'The agent is working. Try again once it stops.' }
    case 'failed':
      return { tone: 'error', text: result.error }
    default:
      return null
  }
}

/**
 * The landing actions of a task that has a worktree of its own: the task
 * menu's Land and Update from stream, and the banner's Ask agent to fix /
 * I'll fix it / Retry / Abort. Results show on the task's banner; a stop
 * selects the task so its banner is on screen.
 */
export function useTaskLandingActions(): {
  land: (project: Project, task: Task) => Promise<void>
  update: (project: Project, task: Task) => Promise<void>
  retry: (project: Project, task: Task) => Promise<void>
  setAside: (project: Project, task: Task) => Promise<void>
  abort: (project: Project, task: Task) => Promise<void>
  fix: (project: Project, task: Task) => Promise<void>
  fixByHand: (project: Project, task: Task) => void
} {
  const { switchToTask, addTab, confirmDiscardDirty, projects } = useApp()

  const settle = useCallback((project: Project, task: Task, op: LandingOp, result: TaskLandingResult) => {
    const streamName = findStreamOfTask(project, task.id)?.name ?? 'the stream'
    setLandingNotice(task.id, landingResultNotice(result, op, streamName))
    refreshStreamAhead(project.id, task.id)
    if (result.status === 'conflict' || result.status === 'blocked' || result.status === 'failed') switchToTask(project.id, task.id)
  }, [switchToTask])

  const run = useCallback(async (project: Project, task: Task, op: LandingOp, call: () => Promise<TaskLandingResult>) => {
    settle(project, task, op, await runLandingOp(task.id, op, call))
  }, [settle])

  const land = useCallback((project: Project, task: Task) =>
    run(project, task, 'land', () => window.api.taskLand(project.id, task.id, { keepWorktree: true })), [run])

  const update = useCallback((project: Project, task: Task) =>
    run(project, task, 'update', () => window.api.taskUpdateFromStream(project.id, task.id)), [run])

  const abort = useCallback((project: Project, task: Task) =>
    run(project, task, 'abort', () => window.api.taskLandingAbort(project.id, task.id)), [run])

  const fix = useCallback((project: Project, task: Task) =>
    run(project, task, 'fix', () => window.api.taskLandingFix(project.id, task.id)), [run])

  /** Picks the stopped landing up again; a close that lands now is archived by main, as closing would have been. */
  const retry = useCallback(async (project: Project, task: Task) => {
    const closing = (task.landing?.intent ?? 'close') === 'close'
    if (closing && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return
    const release = closing ? markTaskClosing(task.id) : null
    try {
      const result = await runLandingOp(task.id, 'retry', () => window.api.taskLandingRetry(project.id, task.id))
      if (closing && (result.status === 'landed' || result.status === 'nothing')) return
      settle(project, task, 'retry', result)
    } finally {
      release?.()
    }
  }, [confirmDiscardDirty, settle])

  /**
   * A landing blocked by untracked files in the stream's worktree: after a
   * confirm, main moves them into DevTool's set-aside folder and retries.
   */
  const setAside = useCallback(async (project: Project, task: Task) => {
    const streamName = findStreamOfTask(project, task.id)?.name ?? 'the stream'
    const count = task.landing?.untracked ?? 0
    const what = count === 1 ? '1 untracked file' : `${count} untracked files`
    const ok = await confirmAction(
      `Move ${what} out of ${streamName}'s folder and retry?\n\n`
        + `They were never committed there, and "${task.name}" brings in files at the same paths. `
        + 'DevTool moves them into its set-aside folder (in its config folder, under set-aside/), so nothing is deleted.',
      { confirmLabel: 'Move aside and retry' }
    )
    if (!ok) return
    const closing = (task.landing?.intent ?? 'close') === 'close'
    if (closing && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return
    const release = closing ? markTaskClosing(task.id) : null
    try {
      let movedTo: string | undefined
      const result = await runLandingOp(task.id, 'set-aside', async () => {
        const answer = await window.api.taskLandingSetAside(project.id, task.id)
        movedTo = answer.setAside
        return answer
      })
      if (closing && (result.status === 'landed' || result.status === 'nothing')) return
      settle(project, task, 'set-aside', result)
      if (movedTo && (result.status === 'landed' || result.status === 'nothing' || result.status === 'blocked')) {
        setLandingNotice(task.id, { tone: 'info', text: `Moved ${what} to ${movedTo}.` })
      }
    } finally {
      release?.()
    }
  }, [confirmDiscardDirty, settle])

  /** A terminal at the task's worktree root, where the rebase stopped. */
  const fixByHand = useCallback((project: Project, task: Task) => {
    const current = findTaskInProject(projects.find(p => p.id === project.id), task.id) ?? task
    const root = current.workspace?.worktreePath
    if (!root) return
    addTab(project.id, task.id, 'focused', 'terminal', { cwd: root })
  }, [addTab, projects])

  return { land, update, retry, setAside, abort, fix, fixByHand }
}
