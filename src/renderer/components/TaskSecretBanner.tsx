import React from 'react'
import { taskSecretRequest, useSecretRequests } from '../secretRequests'
import SecretPrompt from './SecretPrompt'

/** Above a task's panes while one of its agents waits on a secret (`request_secret`). */
export default function TaskSecretBanner({ taskId }: { taskId: string }): React.ReactElement | null {
  const request = taskSecretRequest(useSecretRequests(), taskId)
  // Keyed by request: a new request starts with an empty field.
  return request ? <SecretPrompt key={request.id} request={request} /> : null
}
