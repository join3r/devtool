import React, { useMemo } from 'react'
import { CHAT_PERMISSION_MODES, type ChatModelOption } from '../../shared/claude-chat'
import { useClaudeModels } from '../claudeModels'
import { isChatTabType, type PromptBoxAgent } from '../../shared/types'
import ChipMenu from './claude-chat/ChipMenu'
import { MODE_HELP } from './claude-chat/Composer'
import { PROMPT_BOX_AGENT_LABEL } from './promptBox'

/**
 * The chips under a first-prompt box — agent, model, mode, effort — shared by an
 * empty task's prompt box and the New task composer.
 */

// Before any Claude chat has run, Claude Code's own list (`supportedModels()`) is
// unknown, so the box offers the aliases every version accepts.
const ALIAS_MODELS: ChatModelOption[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' }
]

/** The model chip's options: Default, then every model Claude Code last offered (as the chat's picker lists them). */
export function modelOptions(models: ChatModelOption[]): { value: string; label: string; description?: string }[] {
  const pickable = models.filter((m) => m.value !== 'default')
  return [
    { value: '', label: 'Default', description: 'What your Claude settings pick' },
    ...(pickable.length ? pickable : ALIAS_MODELS).map((m) => ({ value: m.value, label: m.displayName, ...(m.description ? { description: m.description } : {}) }))
  ]
}

export function useModelOptions(): { value: string; label: string; description?: string }[] {
  const models = useClaudeModels()
  return useMemo(() => modelOptions(models), [models])
}
export const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({ value: level, label: level }))
]
export const MODE_OPTIONS = [
  { value: '', label: 'Default', description: 'Whatever your Claude settings choose' },
  ...CHAT_PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: MODE_HELP[m.value] }))
]
const MODE_CYCLE = ['', 'default', 'acceptEdits', 'plan', 'auto']

/** Shift+Tab's next permission mode. */
export function nextMode(mode: string): string {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]
}

export function modeLabel(mode: string): string {
  return MODE_OPTIONS.find((m) => m.value === mode)?.label ?? 'Default'
}

/** The agent chip: like ChipMenu, but it stands out, since it decides what Enter starts. */
export function AgentMenu({ agents, value, onChange, placement }: {
  agents: PromptBoxAgent[]
  value: PromptBoxAgent
  onChange: (agent: PromptBoxAgent) => void
  placement?: 'up' | 'down'
}): React.ReactElement {
  if (agents.length === 1) {
    return <span className="inline-flex items-center h-5 px-1.5 rounded-md bg-surface-3 text-xs text-text">{PROMPT_BOX_AGENT_LABEL[value]}</span>
  }
  return (
    <div className="[&>div>button]:bg-surface-3 [&>div>button]:text-text">
      <ChipMenu
        label={PROMPT_BOX_AGENT_LABEL[value]}
        title="Agent"
        placement={placement}
        options={agents.map((a) => ({ value: a, label: PROMPT_BOX_AGENT_LABEL[a], description: isChatTabType(a) ? 'Chat view' : 'Terminal view' }))}
        value={value}
        onChange={(next) => onChange(next as PromptBoxAgent)}
      />
    </div>
  )
}
