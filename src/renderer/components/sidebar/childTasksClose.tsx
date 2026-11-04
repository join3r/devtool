import React, { useEffect, useSyncExternalStore } from 'react'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import { delegationTree, workingDescendants, type StatusOf } from '../../../shared/delegation'
import type { Project } from '../../../shared/types'

/**
 * Closing a task whose agent started tasks that still work (MCP `start_task`):
 * stop them too (grandchildren included), or leave them running as top-level
 * tasks. The question is one window-wide dialog (`ChildTasksCloseHost`, mounted
 * by App), so every close path (the Inbox's ✓ Done and Remove, the header, the
 * row menu, a bulk Done) asks it the same way.
 */
export type ChildTasksChoice = 'stop' | 'keep' | 'cancel'

interface Question {
  taskName: string
  count: number
  resolve: (choice: ChildTasksChoice) => void
}

let current: Question | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach(listener => listener())

function ask(taskName: string, count: number): Promise<ChildTasksChoice> {
  current?.resolve('cancel')
  return new Promise(resolve => {
    current = { taskName, count, resolve }
    notify()
  })
}

function settle(choice: ChildTasksChoice): void {
  const question = current
  current = null
  notify()
  question?.resolve(choice)
}

/**
 * Before a task closes: when tasks it started still work, asks what to do with
 * them and does it. False when the close should not go on (Cancel).
 */
export async function settleChildTasks(projects: readonly Project[], projectId: string, taskId: string, statusOf: StatusOf): Promise<boolean> {
  const project = projects.find(p => p.id === projectId)
  if (!project) return true
  const tree = delegationTree([project])
  const working = workingDescendants(tree, taskId, statusOf)
  // Nothing working under it: the rest become top-level tasks by themselves, but its agent shouldn't be woken while it closes.
  if (working.length === 0) {
    if (tree.childrenOf.has(taskId)) await window.api.taskCloseChildren(projectId, taskId, 'keep').catch(() => 0)
    return true
  }
  const choice = await ask(tree.tasks.get(taskId)?.name ?? 'this task', working.length)
  if (choice === 'cancel') return false
  await window.api.taskCloseChildren(projectId, taskId, choice).catch(() => 0)
  return true
}

function useQuestion(): Question | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current
  )
}

export default function ChildTasksCloseHost(): React.ReactElement | null {
  const question = useQuestion()
  useEffect(() => {
    if (!question) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settle('cancel')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [question])
  if (!question) return null
  const tasks = question.count === 1 ? 'a task' : `${question.count} tasks`
  return (
    <Modal
      title={`Close “${question.taskName}”?`}
      width="w-[460px]"
      onClose={() => settle('cancel')}
      footer={
        <>
          <LinkBtn onClick={() => settle('cancel')}>Cancel</LinkBtn>
          <LinkBtn onClick={() => settle('keep')}>Leave {question.count === 1 ? 'it' : 'them'} running</LinkBtn>
          <PrimaryButton onClick={() => settle('stop')}>Stop {question.count === 1 ? 'it' : 'them'}</PrimaryButton>
        </>
      }
    >
      <div className="text-base text-text" data-testid="child-tasks-close">
        It started {tasks} that {question.count === 1 ? 'is' : 'are'} still working.
      </div>
      <HelperText>
        Stopped tasks close without landing; a branch of their own stays. Tasks left running show on their own in the Inbox.
      </HelperText>
    </Modal>
  )
}
