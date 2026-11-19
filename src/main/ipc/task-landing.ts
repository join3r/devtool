import type { StreamMergeFixResult, StreamMergeResult, StreamPushResult, StreamPushStatus } from '../../shared/types'
import type { TaskLandingManager } from '../task-landing'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface TaskLandingIpcDeps {
  taskLanding: TaskLandingManager
  /** Closing a task that started others: stop them all, or let them run on (`HostServices.closeChildTasks`). */
  closeChildTasks(projectId: string, taskId: string, action: 'stop' | 'keep'): Promise<number>
  /** A closing stream's branch into its base branch (`stream-merge.ts`). */
  mergeStream(projectId: string, streamId: string): Promise<StreamMergeResult>
  /** A Claude task in the stream's worktree that merges the base branch in and resolves the conflicts (`stream-merge-fix.ts`). */
  fixStreamMerge(projectId: string, streamId: string, files: string[]): Promise<StreamMergeFixResult>
  /** Push the stream's branch to its remote (`stream-push.ts`). */
  pushStream(projectId: string, streamId: string): Promise<StreamPushResult>
  /** Unpushed commits of the stream's branch, as last fetched; null when it can't tell. */
  streamPushStatus(projectId: string, streamId: string): Promise<StreamPushStatus | null>
}

const landOptions = v.object({
  keepWorktree: v.optional(v.boolean())
})

const closeOptions = v.object({
  archive: v.optional(v.boolean())
})

/**
 * Landing a task's worktree into its stream (`task-landing.ts`). Ids only: main
 * looks up the worktrees and branches itself. Every change to `Task.landing`
 * also reaches the windows as `task-landing-state` (taskId, landing | null).
 */
export function registerTaskLandingHandlers(ipc: IpcRegistrar, deps: TaskLandingIpcDeps): void {
  ipc.handle('task-land', [safeId, safeId, v.optional(landOptions)], (_event, projectId, taskId, options) =>
    deps.taskLanding.landTask(projectId, taskId, options ?? {}))

  ipc.handle('task-landing-retry', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.retryLanding(projectId, taskId))

  ipc.handle('task-landing-set-aside', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.setAsideAndRetry(projectId, taskId))

  ipc.handle('task-landing-abort', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.abortLanding(projectId, taskId))

  ipc.handle('task-landing-fix', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.fixWithAgent(projectId, taskId))

  ipc.handle('task-update-from-stream', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.updateFromStream(projectId, taskId))

  ipc.handle('task-stream-ahead', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.streamAhead(projectId, taskId))

  ipc.handle('task-landing-preview', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.preview(projectId, taskId))

  ipc.handle('task-worktree-close', [safeId, safeId, v.literal('keep', 'discard'), v.optional(closeOptions)], (_event, projectId, taskId, mode, options) =>
    deps.taskLanding.closeWorktree(projectId, taskId, mode, options ?? {}))

  ipc.handle('task-close-children', [safeId, safeId, v.literal('stop', 'keep')], (_event, projectId, taskId, action) =>
    deps.closeChildTasks(projectId, taskId, action))

  ipc.handle('stream-merge', [safeId, safeId], (_event, projectId, streamId) =>
    deps.mergeStream(projectId, streamId))

  ipc.handle('stream-merge-fix', [safeId, safeId, v.array(v.string(), { max: 1000 })], (_event, projectId, streamId, files) =>
    deps.fixStreamMerge(projectId, streamId, files))

  ipc.handle('stream-push', [safeId, safeId], (_event, projectId, streamId) =>
    deps.pushStream(projectId, streamId))

  ipc.handle('stream-push-status', [safeId, safeId], (_event, projectId, streamId) =>
    deps.streamPushStatus(projectId, streamId))
}
