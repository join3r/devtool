import type { TaskForkResult } from '../../shared/types'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'

export interface TaskForkIpcDeps {
  forkTask(projectId: string, taskId: string, tabId: string, messageUuid: string): Promise<TaskForkResult>
}

/** Fork a task's chat at one of its agent's messages (`task-fork.ts`): ids only, main looks up the rest. */
export function registerTaskForkHandlers(ipc: IpcRegistrar, deps: TaskForkIpcDeps): void {
  ipc.handle('task-fork', [safeId, safeId, safeId, safeId], (_event, projectId, taskId, tabId, messageUuid) =>
    deps.forkTask(projectId, taskId, tabId, messageUuid))
}
