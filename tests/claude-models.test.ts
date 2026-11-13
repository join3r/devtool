import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ClaudeModels } from '../src/main/claude-models'
import { emptyChatState, type ChatModelOption } from '../src/shared/claude-chat'
import { modelOptions } from '../src/renderer/components/promptChips'

const LIST: ChatModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
  { value: 'opus[1m]', displayName: 'Opus (1M context)' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' }
]

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-models-')), 'claude-models.json')
}

describe('ClaudeModels', () => {
  it('keeps the list a Claude chat reports, across restarts', () => {
    const file = tmpFile()
    const store = new ClaudeModels(file)
    let heard = 0
    store.subscribe(() => { heard++ })
    store.observe('t1', { t: 'meta', models: LIST }, emptyChatState())
    expect(store.list().map(m => m.value)).toEqual(['default', 'opus', 'opus[1m]', 'haiku'])
    expect(heard).toBe(1)
    store.observe('t1', { t: 'meta', models: LIST }, emptyChatState())
    expect(heard).toBe(1)
    expect(new ClaudeModels(file).list()).toEqual(store.list())
  })

  it('ignores Codex and Pi lists and metas without models', () => {
    const store = new ClaudeModels(tmpFile())
    const codex = { ...emptyChatState(), info: { agent: 'codex' as const } }
    store.observe('t1', { t: 'meta', models: [{ value: 'gpt', displayName: 'GPT' }] }, codex)
    store.observe('t1', { t: 'meta', info: {} }, emptyChatState())
    expect(store.list()).toEqual([])
  })
})

describe('modelOptions', () => {
  it('lists every model Claude offered after Default', () => {
    expect(modelOptions(LIST).map(o => o.value)).toEqual(['', 'opus', 'opus[1m]', 'haiku'])
  })

  it('falls back to the aliases before any chat ran', () => {
    expect(modelOptions([]).map(o => o.value)).toEqual(['', 'opus', 'sonnet', 'haiku'])
  })
})
