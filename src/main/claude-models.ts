import fs from 'node:fs'
import type { ChatEvent, ChatModelOption, ChatState } from '../shared/claude-chat'
import { atomicWriteFileSync } from './atomic-write'

/**
 * The models Claude Code last offered (`supportedModels()`, carried by a Claude
 * chat's `meta` event), kept on disk so the New task box can list them all before
 * any chat of this run has started. Codex and Pi chats report their own lists and
 * don't count.
 */
export class ClaudeModels {
  private models: ChatModelOption[]
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string) {
    this.models = readModels(file)
  }

  observe(_tabId: string, event: ChatEvent, state: ChatState): void {
    if (event.t !== 'meta' || !event.models?.length || (state.info.agent ?? 'claude') !== 'claude') return
    const next = event.models.map(clean)
    if (JSON.stringify(next) === JSON.stringify(this.models)) return
    this.models = next
    try { atomicWriteFileSync(this.file, JSON.stringify(next, null, 2)) } catch { /* the list still serves this run */ }
    for (const listener of this.listeners) listener()
  }

  list(): ChatModelOption[] {
    return this.models
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

function clean(m: ChatModelOption): ChatModelOption {
  return {
    value: m.value,
    displayName: m.displayName,
    ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(m.supportedEffortLevels?.length ? { supportedEffortLevels: m.supportedEffortLevels } : {})
  }
}

function readModels(file: string): ChatModelOption[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.flatMap((m: unknown) => {
      const o = m as Partial<ChatModelOption> | null
      return o && typeof o.value === 'string' && typeof o.displayName === 'string' ? [clean(o as ChatModelOption)] : []
    })
  } catch {
    return []
  }
}
