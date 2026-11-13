import { useSyncExternalStore } from 'react'
import type { ChatModelOption } from '../shared/claude-chat'

/**
 * The models Claude Code last offered on this machine, as main keeps them
 * (`claude-models-get` and the `claude-models-changed` push). Empty until a
 * Claude chat has started once.
 */

let models: ChatModelOption[] = []
let started = false
const listeners = new Set<() => void>()

function set(next: ChatModelOption[] | undefined): void {
  // A stubbed api (tests) may answer nothing.
  if (!Array.isArray(next)) return
  models = next
  for (const listener of [...listeners]) listener()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const api = window.api as Partial<typeof window.api> | undefined
  api?.onClaudeModelsChanged?.(set)
  void api?.claudeModelsGet?.().then(set).catch(() => {})
}

function getModels(): ChatModelOption[] {
  ensureStarted()
  return models
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useClaudeModels(): ChatModelOption[] {
  return useSyncExternalStore(subscribe, getModels)
}
