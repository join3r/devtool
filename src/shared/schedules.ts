/**
 * Scheduled jobs: a prompt a project runs again and again ("every week, check
 * whether the Agent SDK usage bug is fixed"). Each run is a new Claude chat task
 * in the schedule's stream, started by main (`main/schedule-runner.ts`) with no
 * window needed. A run with nothing worth reporting says so through DevTool's
 * MCP tool `nothing_new` and closes itself; the others stay in the Inbox.
 *
 * Runs keep the first run's wall-clock time (weekly at Monday 9:00 stays Monday
 * 9:00 across daylight saving). Missed runs (DevTool wasn't running) collapse
 * into one catch-up run at the next launch.
 *
 * Every edit is data (`ScheduleOp`), applied by main for the windows, the phone
 * and the MCP tools alike.
 */
import type { Project, Schedule, ScheduleUnit } from './types'
import { findMainStream } from './streams'

export const SCHEDULE_UNITS: readonly ScheduleUnit[] = ['hour', 'day', 'week']
export const SCHEDULE_NAME_LIMIT = 120
export const SCHEDULE_PROMPT_LIMIT = 32000
/** At most this many of a unit between runs: a year's worth, give or take. */
export const SCHEDULE_EVERY_MAX: Record<ScheduleUnit, number> = { hour: 24 * 30, day: 365, week: 52 }
export const SCHEDULES_PER_PROJECT = 50

const HOUR_MS = 3_600_000

export type ScheduleOp =
  | { op: 'add'; schedule: Schedule }
  | { op: 'edit'; id: string; name?: string; prompt?: string; streamId?: string | null; every?: number; unit?: ScheduleUnit; startAt?: number; now: number }
  | { op: 'pause'; id: string; paused: boolean; now: number }
  | { op: 'remove'; id: string }

export type ScheduleRunResult = { ok: true; taskId: string } | { ok: false; error: string }

export function projectSchedules(project: Project): Schedule[] {
  return project.schedules ?? []
}

export function findSchedule(project: Project, id: string): Schedule | undefined {
  return projectSchedules(project).find(s => s.id === id)
}

function withSchedules(project: Project, schedules: Schedule[]): Project {
  const next = { ...project }
  if (schedules.length > 0) next.schedules = schedules
  else delete next.schedules
  return next
}

/** `at` plus `n` of the schedule's unit; days and weeks move on the local calendar. */
export function addUnits(at: number, n: number, unit: ScheduleUnit): number {
  if (unit === 'hour') return at + n * HOUR_MS
  const d = new Date(at)
  d.setDate(d.getDate() + n * (unit === 'week' ? 7 : 1))
  return d.getTime()
}

function approxUnitMs(unit: ScheduleUnit): number {
  return unit === 'hour' ? HOUR_MS : unit === 'day' ? 24 * HOUR_MS : 7 * 24 * HOUR_MS
}

/** The first run of `startAt` + k·every·unit (k ≥ 0) strictly after `after`. */
export function nextOccurrence(schedule: Pick<Schedule, 'startAt' | 'every' | 'unit'>, after: number): number {
  const { startAt, unit } = schedule
  const every = Math.max(1, Math.floor(schedule.every))
  if (startAt > after) return startAt
  // Jump close by elapsed time, then step on the calendar to land exactly.
  let k = Math.max(0, Math.floor((after - startAt) / (every * approxUnitMs(unit))) - 1)
  let at = addUnits(startAt, k * every, unit)
  while (at > after && k > 0) {
    k--
    at = addUnits(startAt, k * every, unit)
  }
  while (at <= after) {
    k++
    at = addUnits(startAt, k * every, unit)
  }
  return at
}

/** Does `schedule` want a run at `now`? */
export function scheduleDue(schedule: Schedule, now: number): boolean {
  return !schedule.paused && schedule.nextRunAt <= now
}

/** "every week", "every 2 days", "every hour". */
export function cadenceLabel(schedule: Pick<Schedule, 'every' | 'unit'>): string {
  return schedule.every === 1 ? `every ${schedule.unit}` : `every ${schedule.every} ${schedule.unit}s`
}

/** Why `every`/`unit` can't be a schedule's, or null. */
export function cadenceError(every: unknown, unit: unknown): string | null {
  if (typeof unit !== 'string' || !SCHEDULE_UNITS.includes(unit as ScheduleUnit)) return '`unit` must be hour, day or week.'
  if (typeof every !== 'number' || !Number.isInteger(every) || every < 1) return '`every` must be a whole number, at least 1.'
  if (every > SCHEDULE_EVERY_MAX[unit as ScheduleUnit]) return `\`every\` is at most ${SCHEDULE_EVERY_MAX[unit as ScheduleUnit]} for ${unit}s.`
  return null
}

/** Why a name/prompt pair can't be a schedule's, or null. */
export function textError(name: string | undefined, prompt: string | undefined): string | null {
  if (name !== undefined && (!name.trim() || name.trim().length > SCHEDULE_NAME_LIMIT)) return `The name must be 1–${SCHEDULE_NAME_LIMIT} characters.`
  if (prompt !== undefined && (!prompt.trim() || prompt.trim().length > SCHEDULE_PROMPT_LIMIT)) return `The prompt must be 1–${SCHEDULE_PROMPT_LIMIT} characters.`
  return null
}

/** A schedule's stream when it is still open; else `main`. */
export function scheduleStreamId(project: Project, schedule: Schedule): string | undefined {
  if (schedule.streamId && project.streams.some(s => s.id === schedule.streamId)) return schedule.streamId
  return findMainStream(project)?.id
}

/** Can this project have schedules here? Only projects on this machine: SSH and server projects run elsewhere. */
export function schedulesSupported(project: Project): boolean {
  return !project.ssh && !project.host && !project.shellCommand && !project.ephemeral
}

export interface NewScheduleInput {
  id: string
  name: string
  prompt: string
  every: number
  unit: ScheduleUnit
  streamId?: string
  /** First run; absent: one period from now. */
  startAt?: number
  mode?: string
  createdBy?: { taskId: string; name: string }
  now: number
}

export function newSchedule(input: NewScheduleInput): Schedule {
  const startAt = input.startAt ?? addUnits(input.now, input.every, input.unit)
  return {
    id: input.id,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    every: input.every,
    unit: input.unit,
    startAt,
    nextRunAt: nextOccurrence({ startAt, every: input.every, unit: input.unit }, input.now - 1),
    createdAt: input.now,
    ...(input.streamId ? { streamId: input.streamId } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {})
  }
}

export function applyScheduleOp(project: Project, op: ScheduleOp): Project {
  const schedules = projectSchedules(project)
  switch (op.op) {
    case 'add':
      if (schedules.some(s => s.id === op.schedule.id)) return project
      return withSchedules(project, [...schedules, op.schedule])
    case 'remove':
      if (!schedules.some(s => s.id === op.id)) return project
      return withSchedules(project, schedules.filter(s => s.id !== op.id))
    case 'pause':
      return withSchedules(project, schedules.map(s => {
        if (s.id !== op.id) return s
        if (op.paused) return { ...s, paused: true as const }
        const { paused: _paused, ...rest } = s
        // Resumed: the runs it slept through don't fire now.
        return { ...rest, nextRunAt: nextOccurrence(s, op.now) }
      }))
    case 'edit':
      return withSchedules(project, schedules.map(s => {
        if (s.id !== op.id) return s
        const next: Schedule = { ...s }
        if (op.name !== undefined) next.name = op.name.trim()
        if (op.prompt !== undefined) next.prompt = op.prompt.trim()
        if (op.streamId === null) delete next.streamId
        else if (op.streamId !== undefined) next.streamId = op.streamId
        if (op.every !== undefined) next.every = op.every
        if (op.unit !== undefined) next.unit = op.unit
        if (op.startAt !== undefined) next.startAt = op.startAt
        if (op.every !== undefined || op.unit !== undefined || op.startAt !== undefined) {
          next.nextRunAt = nextOccurrence(next, op.now - 1)
        }
        return next
      }))
  }
}

/** Main's own updates to one schedule (run started, run outcome). No-op when it's gone. */
export function mapSchedule(project: Project, id: string, fn: (schedule: Schedule) => Schedule): Project {
  const schedules = projectSchedules(project)
  if (!schedules.some(s => s.id === id)) return project
  return withSchedules(project, schedules.map(s => (s.id === id ? fn(s) : s)))
}

/** A schedule edit as a window or the phone asks for it (SPEC.md §8.25 `schedule.update`). */
export interface ScheduleUpdateRequest {
  action: 'add' | 'edit' | 'pause' | 'remove'
  scheduleId?: string
  name?: string
  prompt?: string
  every?: number
  unit?: ScheduleUnit
  /** A stream id; null (edit only) puts it back in `main`. */
  streamId?: string | null
  /** The first run (ms since epoch). */
  startAt?: number
  paused?: boolean
  mode?: string
}

export type ScheduleRequestOutcome =
  | { ok: true; op: ScheduleOp; scheduleId: string }
  | { ok: false; code: 'not-found' | 'bad-request' | 'unsupported'; message: string }

/** Checks a request against the project and turns it into an op. */
export function scheduleRequestToOp(project: Project, req: ScheduleUpdateRequest, newId: () => string, now: number): ScheduleRequestOutcome {
  const bad = (message: string): ScheduleRequestOutcome => ({ ok: false, code: 'bad-request', message })
  const streamOk = (id: string | null | undefined): boolean => id === undefined || id === null || project.streams.some(s => s.id === id)
  const mainId = findMainStream(project)?.id
  const startOk = (at: unknown): boolean => at === undefined || (typeof at === 'number' && Number.isFinite(at) && at > 0)
  switch (req.action) {
    case 'add': {
      if (!schedulesSupported(project)) return { ok: false, code: 'unsupported', message: 'Schedules run only in local projects that run Claude.' }
      if (projectSchedules(project).length >= SCHEDULES_PER_PROJECT) return bad(`A project has at most ${SCHEDULES_PER_PROJECT} schedules.`)
      if (req.name === undefined || req.prompt === undefined) return bad('`name` and `prompt` are required.')
      const text = textError(req.name, req.prompt)
      if (text) return bad(text)
      const cadence = cadenceError(req.every, req.unit)
      if (cadence) return bad(cadence)
      if (!startOk(req.startAt)) return bad('`startAt` must be a time.')
      if (!streamOk(req.streamId)) return { ok: false, code: 'not-found', message: 'No such stream' }
      const schedule = newSchedule({
        id: newId(),
        name: req.name,
        prompt: req.prompt,
        every: req.every as number,
        unit: req.unit as ScheduleUnit,
        ...(req.streamId && req.streamId !== mainId ? { streamId: req.streamId } : {}),
        ...(req.startAt !== undefined ? { startAt: req.startAt } : {}),
        ...(req.mode ? { mode: req.mode } : {}),
        now
      })
      return { ok: true, op: { op: 'add', schedule }, scheduleId: schedule.id }
    }
    case 'edit':
    case 'pause':
    case 'remove': {
      const id = req.scheduleId
      if (!id) return bad('`scheduleId` is required.')
      if (!findSchedule(project, id)) return { ok: false, code: 'not-found', message: 'No such schedule' }
      if (req.action === 'remove') return { ok: true, op: { op: 'remove', id }, scheduleId: id }
      if (req.action === 'pause') {
        if (typeof req.paused !== 'boolean') return bad('`paused` must be true or false.')
        return { ok: true, op: { op: 'pause', id, paused: req.paused, now }, scheduleId: id }
      }
      const text = textError(req.name, req.prompt)
      if (text) return bad(text)
      const current = findSchedule(project, id)!
      if (req.every !== undefined || req.unit !== undefined) {
        const cadence = cadenceError(req.every ?? current.every, req.unit ?? current.unit)
        if (cadence) return bad(cadence)
      }
      if (!startOk(req.startAt)) return bad('`startAt` must be a time.')
      if (!streamOk(req.streamId)) return { ok: false, code: 'not-found', message: 'No such stream' }
      const op: Extract<ScheduleOp, { op: 'edit' }> = { op: 'edit', id, now }
      if (req.name !== undefined) op.name = req.name
      if (req.prompt !== undefined) op.prompt = req.prompt
      if (req.every !== undefined) op.every = req.every
      if (req.unit !== undefined) op.unit = req.unit
      if (req.startAt !== undefined) op.startAt = req.startAt
      if (req.streamId !== undefined) op.streamId = req.streamId === mainId ? null : req.streamId
      return { ok: true, op, scheduleId: id }
    }
    default:
      return bad('Unknown action.')
  }
}
