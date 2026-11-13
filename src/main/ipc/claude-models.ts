import type { IpcRegistrar } from './registrar'
import type { ChatModelOption } from '../../shared/claude-chat'

export interface ClaudeModelsIpcDeps {
  list: () => ChatModelOption[]
}

/** The models Claude Code last offered (the New task box); changes come as `claude-models-changed`. */
export function registerClaudeModelsHandlers(ipc: IpcRegistrar, deps: ClaudeModelsIpcDeps): void {
  ipc.handle('claude-models-get', [], () => deps.list())
}
