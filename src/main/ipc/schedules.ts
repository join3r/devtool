import type { ScheduleRunResult, ScheduleUpdateRequest } from '../../shared/schedules'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface ScheduleIpcDeps {
  update(projectId: string, req: ScheduleUpdateRequest): { ok: true; scheduleId: string } | { ok: false; error: string }
  run(projectId: string, scheduleId: string): Promise<ScheduleRunResult>
}

const request = v.object({
  action: v.literal('add', 'edit', 'pause', 'remove'),
  scheduleId: v.optional(safeId),
  name: v.optional(v.string({ max: 1000 })),
  prompt: v.optional(v.string({ max: 100_000 })),
  every: v.optional(v.number({ int: true, min: 1 })),
  unit: v.optional(v.literal('hour', 'day', 'week')),
  streamId: v.optional(v.nullable(safeId)),
  startAt: v.optional(v.number({ min: 0 })),
  paused: v.optional(v.boolean()),
  mode: v.optional(v.string({ max: 64 }))
}) as (value: unknown, path: string) => ScheduleUpdateRequest

/**
 * Schedules (`shared/schedules.ts`): every edit is main's, so a window, the
 * phone and an agent's MCP call all go through the same checks, and Run now
 * starts the run in main (`schedule-runner.ts`).
 */
export function registerScheduleHandlers(ipc: IpcRegistrar, deps: ScheduleIpcDeps): void {
  ipc.handle('schedule-update', [safeId, request], (_event, projectId, req) => deps.update(projectId, req))
  ipc.handle('schedule-run', [safeId, safeId], (_event, projectId, scheduleId) => deps.run(projectId, scheduleId))
}
