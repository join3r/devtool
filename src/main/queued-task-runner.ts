import type { Project, ProjectsData, TabStatusValue, Task, TaskQueuedStart } from '../shared/types'
import { clearQueued, queuedTaskTab, queuedTasksTakenOver, queuedTasksToStart, requeueFailed } from '../shared/queued-tasks'

export interface QueuedTaskRunnerDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  subscribeProjects(listener: () => void): () => void
  statusOf(tabId: string): TabStatusValue
  subscribe(listener: (tabId: string) => void): () => void
  /** Why a Claude chat can't start in the project now (Claude off), or null. */
  blocker(project: Project): string | null
  ensureWorktree(projectId: string, taskId: string): Promise<{ ok: true } | { ok: false; error: string }>
  sendFirstPrompt(projectId: string, taskId: string, tabId: string, prompt: string, mode: string | undefined, model?: string): Promise<void>
  log(message: string): void
}

/** How long a just-started task counts as working before its agent says so. */
const START_GRACE_MS = 60_000

function mapProject(data: ProjectsData, projectId: string, update: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? update(p) : p)) }
}

/**
 * Starts queued tasks (`Task.queued`, see `shared/queued-tasks.ts`): whenever the
 * projects or a tab's status change, a queued task whose folder has no other
 * agent working in it gets its first prompt. One per folder at a time; the one it
 * started counts as working until its agent reports in, so the next queued task
 * in that folder waits for it to finish too.
 *
 * Main is the one place this can live: every window sees the same projects, so a
 * window-side runner would start a task once per window.
 */
export class QueuedTaskRunner {
  /** Tabs just sent their first prompt: tabId → until when they count as working. */
  private readonly starting = new Map<string, number>()
  private unsubscribe: (() => void)[] = []
  private scheduled = false
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: QueuedTaskRunnerDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [
      this.deps.subscribe(tabId => {
        if (this.deps.statusOf(tabId) !== null) this.starting.delete(tabId)
        this.schedule()
      }),
      this.deps.subscribeProjects(() => this.schedule())
    ]
    this.schedule()
  }

  dispose(): void {
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.advance()
    })
  }

  private statusOf = (tabId: string): TabStatusValue => {
    const until = this.starting.get(tabId)
    if (until !== undefined) {
      if (Date.now() < until) return 'working'
      this.starting.delete(tabId)
    }
    return this.deps.statusOf(tabId)
  }

  private advance(): void {
    for (const project of this.deps.peek().projects) {
      // A server's projects are run by the server's own runner.
      if (project.host) continue
      for (const task of queuedTasksTakenOver(project, tabId => this.deps.statusOf(tabId))) {
        this.deps.commit(mapProject(this.deps.peek(), project.id, p => clearQueued(p, task.id)))
      }
      for (const task of queuedTasksToStart(project, this.statusOf)) {
        const tab = queuedTaskTab(task)
        if (!tab || !task.queued) continue
        // Claude off: it waits, and starts with a later change.
        if (tab.type === 'claude-chat' && this.deps.blocker(project)) continue
        this.begin(project.id, task, tab.id, task.queued)
      }
    }
  }

  private begin(projectId: string, task: Task, tabId: string, queued: TaskQueuedStart): void {
    this.starting.set(tabId, Date.now() + START_GRACE_MS)
    this.armGraceTimer()
    // Off the queue first, so no later look starts it twice.
    this.deps.commit(mapProject(this.deps.peek(), projectId, p => clearQueued(p, task.id)))
    this.deps.log(`queued-task start project=${projectId} task=${task.id}`)
    void (async () => {
      const worktree = await this.deps.ensureWorktree(projectId, task.id)
      if (!worktree.ok) throw new Error(`Couldn't create the task's worktree: ${worktree.error}`)
      await this.deps.sendFirstPrompt(projectId, task.id, tabId, queued.prompt, queued.mode, queued.model)
    })().catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      this.starting.delete(tabId)
      this.deps.log(`queued-task start task=${task.id} error=${error}`)
      this.deps.commit(mapProject(this.deps.peek(), projectId, p => requeueFailed(p, task.id, queued, error)))
    })
  }

  /** A start whose agent never reported in stops holding its folder once the grace runs out. */
  private armGraceTimer(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      this.schedule()
    }, START_GRACE_MS + 100)
  }
}
