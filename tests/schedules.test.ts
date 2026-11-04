import { describe, it, expect } from 'vitest'
import {
  addUnits,
  applyScheduleOp,
  cadenceLabel,
  newSchedule,
  nextOccurrence,
  scheduleRequestToOp,
  scheduleStreamId
} from '../src/shared/schedules'
import { ScheduleRunner, type ScheduleRunnerDeps } from '../src/main/schedule-runner'
import type { McpTaskState } from '../src/main/devtool-mcp'
import type { Project, ProjectsData, Schedule, Task } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = new Date(2026, 10, 2, 9, 0, 0).getTime() // a Monday, 9:00 local

function schedule(over: Partial<Schedule> = {}): Schedule {
  return { id: 's1', name: 'SDK check', prompt: 'Check the bug', every: 1, unit: 'week', startAt: T0, nextRunAt: T0, createdAt: T0 - DAY, ...over }
}

describe('nextOccurrence', () => {
  it('is the first run when that is still ahead', () => {
    expect(nextOccurrence(schedule(), T0 - 1)).toBe(T0)
  })

  it('steps by the cadence, strictly after the given time', () => {
    expect(nextOccurrence(schedule(), T0)).toBe(addUnits(T0, 1, 'week'))
    expect(nextOccurrence(schedule({ every: 2, unit: 'day' }), T0 + 3 * DAY)).toBe(addUnits(T0, 4, 'day'))
    expect(nextOccurrence(schedule({ every: 6, unit: 'hour' }), T0 + 7 * HOUR)).toBe(T0 + 12 * HOUR)
  })

  it('collapses a long gap into the next future run', () => {
    const later = T0 + 100 * DAY + 5
    const next = nextOccurrence(schedule(), later)
    expect(next).toBeGreaterThan(later)
    expect(next - later).toBeLessThanOrEqual(7 * DAY + HOUR)
    // Same local wall-clock time as the first run, across any DST change.
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getDay()).toBe(1)
  })
})

describe('schedule ops', () => {
  const project = (): Project => fixtureProject({ id: 'p', directory: '/tmp/p' })

  it('adds through a checked request, its first run one period out by default', () => {
    const out = scheduleRequestToOp(project(), { action: 'add', name: ' Weekly ', prompt: 'Look', every: 1, unit: 'week' }, () => 'new', T0)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const next = applyScheduleOp(project(), out.op)
    expect(next.schedules).toHaveLength(1)
    expect(next.schedules![0]).toMatchObject({ id: 'new', name: 'Weekly', nextRunAt: addUnits(T0, 1, 'week') })
    expect(cadenceLabel(next.schedules![0])).toBe('every week')
  })

  it('refuses bad cadences, blank text, unknown ids and SSH projects', () => {
    const p = project()
    expect(scheduleRequestToOp(p, { action: 'add', name: 'x', prompt: 'y', every: 0, unit: 'day' }, () => 'n', T0)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(scheduleRequestToOp(p, { action: 'add', name: ' ', prompt: 'y', every: 1, unit: 'day' }, () => 'n', T0)).toMatchObject({ ok: false, code: 'bad-request' })
    expect(scheduleRequestToOp(p, { action: 'remove', scheduleId: 'nope' }, () => 'n', T0)).toMatchObject({ ok: false, code: 'not-found' })
    const ssh = { ...p, ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/' } }
    expect(scheduleRequestToOp(ssh, { action: 'add', name: 'x', prompt: 'y', every: 1, unit: 'day' }, () => 'n', T0)).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('resuming skips the runs it slept through; editing the cadence moves the next run', () => {
    const p = { ...project(), schedules: [schedule()] }
    const paused = applyScheduleOp(p, { op: 'pause', id: 's1', paused: true, now: T0 })
    expect(paused.schedules![0].paused).toBe(true)
    const resumed = applyScheduleOp(paused, { op: 'pause', id: 's1', paused: false, now: T0 + 20 * DAY })
    expect(resumed.schedules![0].paused).toBeUndefined()
    expect(resumed.schedules![0].nextRunAt).toBe(addUnits(T0, 3, 'week'))
    const edited = applyScheduleOp(p, { op: 'edit', id: 's1', every: 1, unit: 'day', now: T0 + HOUR })
    expect(edited.schedules![0].nextRunAt).toBe(addUnits(T0, 1, 'day'))
  })

  it('a closed stream sends runs to main', () => {
    const p = project()
    expect(scheduleStreamId(p, schedule({ streamId: 'gone' }))).toBe(p.streams[0].id)
  })

  it('newSchedule keeps the given first run', () => {
    expect(newSchedule({ id: 'a', name: 'n', prompt: 'p', every: 1, unit: 'day', startAt: T0 + HOUR, now: T0 }).nextRunAt).toBe(T0 + HOUR)
  })
})

describe('ScheduleRunner', () => {
  function setup(schedules: Schedule[], tasks: Partial<Task>[] = []) {
    let current: ProjectsData = {
      projects: [{ ...fixtureProject({ id: 'p', directory: '/tmp/p', tasks: tasks.map(t => ({ id: t.id!, ...t })) }), schedules }]
    } as unknown as ProjectsData
    let now = T0 + 5 * DAY
    const states = new Map<string, McpTaskState>()
    const listeners = new Set<() => void>()
    const started: string[] = []
    const closed: string[] = []
    const deps: ScheduleRunnerDeps = {
      peek: () => current,
      commit: (next) => { current = next; listeners.forEach(l => l()) },
      subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
      taskState: (task) => states.get(task.id) ?? 'working',
      blocker: () => null,
      startRun: async (project, s) => {
        const id = `run-${started.length + 1}`
        started.push(s.id)
        const task = fixtureTask({ id, scheduledFrom: { scheduleId: s.id, name: s.name } })
        current = { ...current, projects: current.projects.map(p => p.id === project.id ? { ...p, streams: p.streams.map((st, i) => i === 0 ? { ...st, tasks: [...st.tasks, task] } : st) } : p) }
        return { ok: true, taskId: id }
      },
      closeQuietRun: async (project, task) => {
        closed.push(task.id)
        current = { ...current, projects: current.projects.map(p => p.id === project.id ? { ...p, streams: p.streams.map(st => ({ ...st, tasks: st.tasks.filter(t => t.id !== task.id) })) } : p) }
        return true
      },
      log: () => {},
      now: () => now
    }
    const runner = new ScheduleRunner(deps)
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
    const sched = () => current.projects[0].schedules![0]
    return {
      runner, started, closed, states, flush, sched,
      tick: async () => { listeners.forEach(l => l()); await flush() },
      setNow: (t: number) => { now = t },
      setTask: (taskId: string, patch: Partial<Task>) => {
        current = { ...current, projects: current.projects.map(p => ({ ...p, streams: p.streams.map(st => ({ ...st, tasks: st.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t) })) })) }
      }
    }
  }

  it('fires a missed schedule once at launch and moves its next run to the future', async () => {
    const t = setup([schedule()])
    t.runner.start()
    await t.flush()
    t.runner.dispose()
    expect(t.started).toEqual(['s1'])
    expect(t.sched().nextRunAt).toBeGreaterThan(T0 + 5 * DAY)
    expect(t.sched().lastRun).toMatchObject({ outcome: 'running', taskId: 'run-1' })
  })

  it('leaves paused and not-yet-due schedules alone', async () => {
    const t = setup([schedule({ paused: true }), schedule({ id: 's2', nextRunAt: T0 + 6 * DAY })])
    t.runner.start()
    await t.flush()
    t.runner.dispose()
    expect(t.started).toEqual([])
  })

  it('marks a run reported once its turn ends, and skips a run while the previous one works', async () => {
    const t = setup([schedule()])
    t.runner.start()
    await t.flush()
    // Due again while run-1 still works: skipped, next run moved on.
    t.setNow(T0 + 12 * DAY + HOUR)
    await t.tick()
    expect(t.started).toEqual(['s1'])
    expect(t.sched().nextRunAt).toBeGreaterThan(T0 + 12 * DAY)
    t.states.set('run-1', 'idle')
    await t.tick()
    t.runner.dispose()
    expect(t.sched().lastRun?.outcome).toBe('reported')
  })

  it('takes a run as finished only once it stays settled for a moment', async () => {
    const t = setup([schedule()])
    t.runner.start()
    await t.flush()
    await t.tick() // seen working
    t.states.set('run-1', 'idle')
    t.setNow(T0 + 5 * DAY + 10_000)
    await t.tick()
    expect(t.sched().lastRun?.outcome).toBe('running')
    t.setNow(T0 + 5 * DAY + 16_000)
    await t.tick()
    t.runner.dispose()
    expect(t.sched().lastRun?.outcome).toBe('reported')
  })

  it('does not take a run that has not started its turn yet as finished', async () => {
    const t = setup([schedule()])
    t.states.set('run-1', 'idle')
    t.runner.start()
    await t.flush()
    await t.tick()
    expect(t.sched().lastRun?.outcome).toBe('running')
    t.setNow(T0 + 5 * DAY + 4 * 60_000)
    await t.tick()
    t.runner.dispose()
    expect(t.sched().lastRun?.outcome).toBe('reported')
  })

  it('closes a quiet run when its turn ends and keeps its note', async () => {
    const t = setup([schedule()])
    t.runner.start()
    await t.flush()
    t.setTask('run-1', { quietRun: { note: 'Still open' } })
    await t.tick()
    expect(t.closed).toEqual([])
    t.states.set('run-1', 'idle')
    await t.tick()
    await t.flush()
    t.runner.dispose()
    expect(t.closed).toEqual(['run-1'])
    expect(t.sched().lastRun).toMatchObject({ outcome: 'quiet', note: 'Still open' })
  })

  it('Run now starts a run without moving the next scheduled one', async () => {
    const t = setup([schedule({ nextRunAt: T0 + 9 * DAY })])
    const result = await t.runner.runNow('p', 's1')
    expect(result).toEqual({ ok: true, taskId: 'run-1' })
    expect(t.sched().nextRunAt).toBe(T0 + 9 * DAY)
  })
})
