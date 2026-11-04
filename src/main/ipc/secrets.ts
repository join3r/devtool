import type { IpcRegistrar } from './registrar'
import { v } from './validate'
import { SECRET_NAME_RE, SECRET_VALUE_MAX, type SecretAnswer } from '../../shared/secrets'
import type { SecretRequests } from '../secrets/secret-requests'
import type { SavedSecretInfo, SecretStore } from '../secrets/secret-store'

export interface SecretIpcDeps {
  requests: Pick<SecretRequests, 'list' | 'answer'>
  store: Pick<SecretStore, 'list' | 'delete' | 'canSave'>
  projectExists: (projectId: string) => boolean
}

const id = v.string({ nonEmpty: true, max: 200 })
const name = v.string({ pattern: SECRET_NAME_RE, patternName: 'a secret name' })

const answer = v.union(
  v.object({ kind: v.literal('value'), value: v.string({ nonEmpty: true, max: SECRET_VALUE_MAX }), remember: v.boolean() }, 'reject'),
  v.object({ kind: v.literal('saved') }, 'reject'),
  v.object({ kind: v.literal('decline') }, 'reject')
)

/**
 * The windows' side of `request_secret`: the open prompts, the user's answer,
 * and Project settings' list of remembered secrets (names only; no channel
 * ever sends a value back to a window).
 */
export function registerSecretHandlers(ipc: IpcRegistrar, deps: SecretIpcDeps): void {
  ipc.handle('secret-requests-get', [], () => deps.requests.list())
  ipc.handle('secret-answer', [id, answer], (_ctx, requestId, reply) => deps.requests.answer(requestId, reply as SecretAnswer))
  ipc.handle('secrets-list', [id], (_ctx, projectId): { secrets: SavedSecretInfo[]; canSave: boolean } => ({
    secrets: deps.projectExists(projectId) ? deps.store.list(projectId) : [],
    canSave: deps.store.canSave()
  }))
  ipc.handle('secrets-delete', [id, name], (_ctx, projectId, secretName) => deps.store.delete(projectId, secretName))
}
