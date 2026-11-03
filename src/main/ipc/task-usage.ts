import type { IpcRegistrar } from './registrar'
import type { MachineUsage, TaskUsageSnapshot } from '../../shared/task-usage'

/** CPU and memory per tab (the desk); changes come as `task-usage-changed`, or on a server as its own machine's. */
export function registerTaskUsageHandlers(ipc: IpcRegistrar, deps: { snapshot: () => TaskUsageSnapshot | MachineUsage }): void {
  ipc.handle('task-usage-get', [], () => deps.snapshot())
}
