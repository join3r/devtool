import type { Project, ProjectsData, Schedule, ScheduleLastRun, Task } from '../shared/types'
import { mapSchedule, nextOccurrence, projectSchedules, scheduleDue, schedulesSupported, type ScheduleRunResult } from '../shared/schedules'
import { findTaskInProject } from '../shared/streams'
import { settled, type McpTaskState } from './devtool-mcp'

export interface ScheduleRunnerDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  /** Calls `listener` on any change to the projects or to a tab's status. */
  subscribe(listener: () => void): () => void
  /** Where a live task is (`liveTaskState` in devtool-mcp.ts). */
  taskState(task: Task): McpTaskState
  /** Why a Claude chat can't start in the project now, or null. */
  blocker(project: Project): string | null
  /** Adds the run's task (stamped `scheduledFrom`) and sends it the schedule's prompt. */
  startRun(project: Project, schedule: Schedule, now: number): Promise<ScheduleRunResult>
  /** Closes a quiet run's task, landing its worktree when it has one. Resolves false when it stayed open. */
  closeQuietRun(project: Project, task: Task): Promise<boolean>
  log(message: string): void
  now?(): number
}

/** How often due schedules are looked for, besides every change to the projects. */
const TICK_MS = 30_000
/**
 * A run counts as finished once it was seen working and settled; one never seen
 * working (its agent's session started but no turn yet reads as idle) only after this.
 */
const START_GRACE_MS = 3 * 60_000
/** Settled for this long, not a flicker between a chat's start and its first turn. */
const SETTLE_MS = 5_000

function mapProject(data: ProjectsData, projectId: string, update: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? update(p) : p)) }
}

/**
 * Runs the projects' schedules (`shared/schedules.ts`): a due schedule starts a
 * new Claude chat task with its prompt, and its next run moves to the next
 * occurrence after now, so runs missed while DevTool was closed become one run
 * at launch. A run the previous one is still working through is skipped.
 *
 * It also follows each schedule's latest run to its outcome (`lastRun`), and
 * closes runs whose agent said `nothing_new` once their turn ends.
 *
 * Main is the one place this can live: every window sees the same projects, so a
 * window-side runner would start a run once per window.
 */
export class ScheduleRunner {
  /** Schedules with a start in flight (`projectId/scheduleId`). */
  private readonly starting = new Set<string>()
  /** Quiet runs being closed (task ids). */
  private readonly closing = new Set<string>()
  /** Run tasks seen working, so a settled state after it means the turn ended. */
  private readonly seenWorking = new Set<string>()
  /** Run tasks settled since when (cleared when they work again). */
  private readonly settledSince = new Map<string, number>()
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private queued = false

  constructor(private readonly deps: ScheduleRunnerDeps) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.subscribe(() => this.schedule())
    this.timer = setInterval(() => this.schedule(), TICK_MS)
    this.timer.unref?.()
    this.schedule()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Run Now: a run outside the schedule; the next scheduled one stays where it is. */
  async runNow(projectId: string, scheduleId: string): Promise<ScheduleRunResult> {
    const project = this.deps.peek().projects.find(p => p.id === projectId)
    if (!project) return { ok: false, error: 'No such project.' }
    const schedule = projectSchedules(project).find(s => s.id === scheduleId)
    if (!schedule) return { ok: false, error: 'No such schedule.' }
    return this.begin(project, schedule, false)
  }

  private schedule(): void {
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      this.advance()
    })
  }

  private advance(): void {
    const now = this.now()
    for (const project of this.deps.peek().projects) {
      // A server's projects are run by the server's own runner.
      if (project.host) continue
      this.closeQuietRuns(project)
      if (!project.schedules?.length) continue
      for (const schedule of project.schedules) {
        this.follow(project, schedule, now)
        if (!scheduleDue(schedule, now) || this.starting.has(`${project.id}/${schedule.id}`)) continue
        if (this.stillRunning(project, schedule)) {
          this.deps.log(`schedule skip project=${project.id} schedule=${schedule.id} (previous run still at work)`)
          this.commitSchedule(project.id, schedule.id, s => ({ ...s, nextRunAt: nextOccurrence(s, now) }))
          continue
        }
        void this.begin(project, schedule, true)
      }
    }
  }

  private commitSchedule(projectId: string, scheduleId: string, fn: (schedule: Schedule) => Schedule): void {
    const data = this.deps.peek()
    const next = mapProject(data, projectId, p => mapSchedule(p, scheduleId, fn))
    if (next.projects.some((p, i) => p !== data.projects[i])) this.deps.commit(next)
  }

  private setLastRun(projectId: string, scheduleId: string, lastRun: ScheduleLastRun): void {
    this.commitSchedule(projectId, scheduleId, s => ({ ...s, lastRun }))
  }

  /** The latest run's task is still open and not settled. */
  private stillRunning(project: Project, schedule: Schedule): boolean {
    const taskId = schedule.lastRun?.outcome === 'running' ? schedule.lastRun.taskId : undefined
    const task = findTaskInProject(project, taskId)
    return !!task && !settled(this.deps.taskState(task))
  }

  /** A `running` latest run: `reported` once its turn ended (or the user closed it); quiet ones are `closeQuietRuns`'. */
  private follow(project: Project, schedule: Schedule, now: number): void {
    const last = schedule.lastRun
    if (last?.outcome !== 'running') return
    if (last.taskId && this.closing.has(last.taskId)) return
    const task = findTaskInProject(project, last.taskId)
    if (!task) {
      this.deps.log(`schedule reported (task gone) schedule=${schedule.id} task=${last.taskId}`)
      this.setLastRun(project.id, schedule.id, { ...last, outcome: 'reported' })
      return
    }
    if (task.quietRun) return
    const state = this.deps.taskState(task)
    if (state === 'working') this.seenWorking.add(task.id)
    if (!settled(state)) {
      this.settledSince.delete(task.id)
      return
    }
    const since = this.settledSince.get(task.id) ?? now
    this.settledSince.set(task.id, since)
    if ((this.seenWorking.has(task.id) && now - since >= SETTLE_MS) || now - last.at > START_GRACE_MS) {
      this.deps.log(`schedule reported schedule=${schedule.id} task=${task.id} state=${state} settledFor=${now - since}ms`)
      this.seenWorking.delete(task.id)
      this.settledSince.delete(task.id)
      this.setLastRun(project.id, schedule.id, { ...last, outcome: 'reported' })
    }
  }

  private closeQuietRuns(project: Project): void {
    for (const stream of project.streams) {
      for (const task of stream.tasks) {
        if (!task.quietRun || this.closing.has(task.id)) continue
        // nothing_new is called mid-turn, so the turn is under way: settled means it ended.
        if (!settled(this.deps.taskState(task))) continue
        this.closing.add(task.id)
        const scheduleId = task.scheduledFrom?.scheduleId
        const note = task.quietRun.note
        this.deps.log(`schedule quiet close project=${project.id} task=${task.id}`)
        void this.deps.closeQuietRun(project, task).then(closed => {
          if (!scheduleId) return
          const schedule = this.deps.peek().projects.find(p => p.id === project.id)?.schedules?.find(s => s.id === scheduleId)
          if (schedule?.lastRun?.taskId !== task.id) return
          this.setLastRun(project.id, scheduleId, {
            ...schedule.lastRun,
            outcome: closed ? 'quiet' : 'reported',
            ...(note ? { note } : {})
          })
        }).catch((err: unknown) => {
          this.deps.log(`schedule quiet close task=${task.id} error=${err instanceof Error ? err.message : String(err)}`)
        }).finally(() => {
          this.closing.delete(task.id)
        })
      }
    }
  }

  private async begin(project: Project, schedule: Schedule, scheduled: boolean): Promise<ScheduleRunResult> {
    const key = `${project.id}/${schedule.id}`
    if (this.starting.has(key)) return { ok: false, error: 'A run of this schedule is already starting.' }
    this.starting.add(key)
    const now = this.now()
    try {
      // The next run moves first, so no later look starts this one twice.
      if (scheduled) this.commitSchedule(project.id, schedule.id, s => ({ ...s, nextRunAt: nextOccurrence(s, now) }))
      const blocked = !schedulesSupported(project)
        ? 'Schedules run only in projects on this machine.'
        : this.deps.blocker(project)
      if (blocked) {
        this.setLastRun(project.id, schedule.id, { at: now, outcome: 'failed', note: blocked })
        return { ok: false, error: blocked }
      }
      const current = this.deps.peek().projects.find(p => p.id === project.id) ?? project
      const result = await this.deps.startRun(current, projectSchedules(current).find(s => s.id === schedule.id) ?? schedule, now)
      this.deps.log(`schedule run project=${project.id} schedule=${schedule.id} ${scheduled ? 'scheduled' : 'now'} ${result.ok ? `task=${result.taskId}` : `error=${result.error}`}`)
      this.setLastRun(project.id, schedule.id, result.ok
        ? { at: now, outcome: 'running', taskId: result.taskId }
        : { at: now, outcome: 'failed', note: result.error })
      return result
    } finally {
      this.starting.delete(key)
    }
  }
}
