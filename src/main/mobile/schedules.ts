import { randomUUID } from 'crypto'
import type { ProjectsData } from '../../shared/types'
import { applyScheduleOp, findSchedule, scheduleRequestToOp } from '../../shared/schedules'
import { AppErrorCode, type ScheduleRunParams, type ScheduleUpdateParams } from '../../../protocol/ts/index.ts'
import { mobileProject, type MobileOutcome } from './new-stream'

/**
 * `schedule.update` (SPEC.md §8.25): the phone's schedule edits, through the same
 * checks a window's and an agent's go through (`scheduleRequestToOp`).
 */

export type ScheduleUpdateOutcome = MobileOutcome<{ data: ProjectsData; scheduleId: string }>

const CODES: Record<'not-found' | 'bad-request' | 'unsupported', string> = {
  'not-found': AppErrorCode.NotFound,
  'bad-request': AppErrorCode.BadRequest,
  unsupported: AppErrorCode.Unsupported
}

export function updateScheduleInData(data: ProjectsData, params: ScheduleUpdateParams, ids: () => string = randomUUID, now: number = Date.now()): ScheduleUpdateOutcome {
  const found = mobileProject(data, params.projectId)
  if (!found.ok) return found
  const { projectId: _projectId, ...req } = params
  const outcome = scheduleRequestToOp(found.project, req, ids, now)
  if (!outcome.ok) return { ok: false, code: CODES[outcome.code], message: outcome.message }
  return {
    ok: true,
    data: { ...data, projects: data.projects.map((p) => (p.id === params.projectId ? applyScheduleOp(p, outcome.op) : p)) },
    scheduleId: outcome.scheduleId
  }
}

/** `schedule.run`'s checks before the runner: a project the phone sees, and a schedule it has. */
export function scheduleForRun(data: ProjectsData, params: ScheduleRunParams): MobileOutcome<object> {
  const found = mobileProject(data, params.projectId)
  if (!found.ok) return found
  if (!findSchedule(found.project, params.scheduleId)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such schedule' }
  return { ok: true }
}
