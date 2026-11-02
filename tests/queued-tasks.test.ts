import { describe, expect, it } from 'vitest'
import { queuedTasksTakenOver, queuedTasksToStart, startQueuedNow } from '../src/shared/queued-tasks'
import { QueuedTaskRunner, type QueuedTaskRunnerDeps } from '../src/main/queued-task-runner'
import { isSnoozed } from '../src/shared/inbox-state'
import { createMainStream, type Project, type ProjectsData, type Stream, type TabStatusValue, type Task, type TaskQueuedStart, type WorkspaceConfig } from '../src/shared/types'
import { findTaskInProject, singlePane } from '../src/shared/streams'

function task(id: string, queued?: Partial<TaskQueuedStart>, extra?: Partial<Task>): Task {
  return {
    id,
    name: id,
    panes: singlePane([{ id: `${id}-tab`, type: 'claude-chat' as const, title: 'Claude', sessionId: `${id}-s` }]),
    ...(queued ? { queued: { prompt: `do ${id}`, at: 0, ...queued } } : {}),
    ...extra
  }
}

function project(main: Task[], streams: Stream[] = []): Project {
  return { id: 'p', name: 'p', directory: '/tmp/p', streams: [createMainStream('p', main), ...streams] }
}

const working = (...ids: string[]) => (tabId: string): TabStatusValue => (ids.some(id => `${id}-tab` === tabId) ? 'working' : null)
const ids = (tasks: Task[]): string[] => tasks.map(t => t.id)

describe('queuedTasksToStart', () => {
  it('waits while another agent works in the folder, then starts the oldest one', () => {
    const p = project([task('busy'), task('q2', { at: 2 }), task('q1', { at: 1 })])
    expect(queuedTasksToStart(p, working('busy'))).toEqual([])
    expect(ids(queuedTasksToStart(p, working()))).toEqual(['q1'])
  })

  it('does not wait on agents in another folder', () => {
    const ws: WorkspaceConfig = { worktreePath: '/tmp/p-x', branchName: 'x', baseBranch: 'main', relativeProjectPath: '' }
    const other: Stream = { id: 's', name: 'x', workspace: ws, tasks: [task('elsewhere')] }
    const p = project([task('q', { at: 1 })], [other])
    expect(ids(queuedTasksToStart(p, working('elsewhere')))).toEqual(['q'])
  })

  it('starts one asked to start now regardless, and holds back a failed one', () => {
    const p = project([task('busy'), task('failed', { at: 1, error: 'x' }), task('now', { at: 2, now: true })])
    expect(ids(queuedTasksToStart(p, working('busy')))).toEqual(['now'])
  })

  it('reads as snoozed, and Start now clears its error', () => {
    const p = startQueuedNow(project([task('q', { error: 'boom' })]), 'q')
    const q = findTaskInProject(p, 'q')!
    expect(q.queued).toMatchObject({ now: true })
    expect(q.queued?.error).toBeUndefined()
    expect(isSnoozed(q, Date.now())).toBe(true)
  })

  it('lets go of a queued task you started yourself', () => {
    const p = project([task('q', {})])
    expect(ids(queuedTasksTakenOver(p, working('q')))).toEqual(['q'])
  })
})

function harness(initial: Project, overrides: Partial<QueuedTaskRunnerDeps> = {}) {
  let data: ProjectsData = { projects: [initial], tags: [], projectOrder: [initial.id], pinnedItems: [] }
  const statuses = new Map<string, TabStatusValue>()
  let listener: ((tabId: string) => void) | null = null
  const projectListeners = new Set<() => void>()
  const sent: { taskId: string; prompt: string; mode?: string }[] = []
  const deps: QueuedTaskRunnerDeps = {
    peek: () => data,
    commit: (next) => {
      data = next
      for (const l of projectListeners) l()
    },
    subscribeProjects: (l) => { projectListeners.add(l); return () => { projectListeners.delete(l) } },
    statusOf: (tabId) => statuses.get(tabId) ?? null,
    subscribe: (l) => { listener = l; return () => { listener = null } },
    blocker: () => null,
    ensureWorktree: async () => ({ ok: true }),
    sendFirstPrompt: async (_projectId, taskId, _tabId, prompt, mode) => { sent.push({ taskId, prompt, ...(mode ? { mode } : {}) }) },
    log: () => {},
    ...overrides
  }
  const runner = new QueuedTaskRunner(deps)
  runner.start()
  const setStatus = (tabId: string, status: TabStatusValue) => {
    statuses.set(tabId, status)
    listener?.(tabId)
  }
  return { runner, sent, setStatus, project: () => data.projects[0] }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('QueuedTaskRunner', () => {
  it('starts queued tasks one after another as the folder frees up', async () => {
    const h = harness(project([task('busy'), task('q1', { at: 1, mode: 'auto' }), task('q2', { at: 2 })]))
    h.setStatus('busy-tab', 'working')
    await flush()
    expect(h.sent).toEqual([])

    h.setStatus('busy-tab', null)
    await flush()
    expect(h.sent).toEqual([{ taskId: 'q1', prompt: 'do q1', mode: 'auto' }])
    expect(findTaskInProject(h.project(), 'q1')?.queued).toBeUndefined()
    // q1 counts as working from its start, so q2 waits for it.
    expect(findTaskInProject(h.project(), 'q2')?.queued).toBeDefined()

    h.setStatus('q1-tab', 'working')
    await flush()
    expect(h.sent).toHaveLength(1)
    h.setStatus('q1-tab', null)
    await flush()
    expect(h.sent.map(s => s.taskId)).toEqual(['q1', 'q2'])
    h.runner.dispose()
  })

  it('puts a failed start back with its error, waiting for Start now', async () => {
    const h = harness(project([task('q', { at: 1 })]), {
      sendFirstPrompt: async () => { throw new Error('no claude') }
    })
    await flush()
    await flush()
    expect(findTaskInProject(h.project(), 'q')?.queued).toMatchObject({ prompt: 'do q', error: 'no claude' })
    h.runner.dispose()
  })
})
