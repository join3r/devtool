import { useSyncExternalStore } from 'react'
import type { SecretRequest } from '../shared/secrets'

/**
 * The open `request_secret` prompts, as main has them (`secret-requests-get`
 * and the `secret-requests-changed` push). Shared by every component of a
 * window: the task view's banner and the Inbox row show the same requests.
 */

const EMPTY: SecretRequest[] = []
let requests: SecretRequest[] = EMPTY
let started = false
const listeners = new Set<() => void>()

function set(next: SecretRequest[] | undefined): void {
  if (!Array.isArray(next)) return
  requests = next
  for (const listener of [...listeners]) listener()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const api = window.api as Partial<typeof window.api> | undefined
  api?.onSecretRequestsChanged?.(set)
  void api?.secretRequestsGet?.().then(set).catch(() => {})
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): SecretRequest[] {
  ensureStarted()
  return requests
}

export function useSecretRequests(): SecretRequest[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The task's oldest open request, or null. */
export function taskSecretRequest(all: readonly SecretRequest[], taskId: string): SecretRequest | null {
  return all.find(request => request.taskId === taskId) ?? null
}
