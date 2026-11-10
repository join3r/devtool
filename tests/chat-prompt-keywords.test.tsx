// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Composer from '../src/renderer/components/claude-chat/Composer'
import { chatPromptKeywords, type ChatAgent } from '../src/shared/claude-chat'

void React

const noop = (): void => {}

function renderComposer(agent?: ChatAgent) {
  return render(
    <Composer
      agent={agent}
      busy={false}
      info={{} as any}
      models={[]}
      commands={[]}
      loadFiles={async () => []}
      onSend={noop}
      onSideQuestion={noop}
      onBash={noop}
      onPermissions={noop}
      onPlugins={noop}
      onLogin={noop}
      onLogout={noop}
      onStop={noop}
      onSetModel={noop}
      onSetMode={noop}
      onSetEffort={noop}
      onOpenInTerminal={noop}
      focusSignal={false}
    />
  )
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text, selectionStart: text.length } })
}

afterEach(cleanup)

describe('prompt keywords', () => {
  it('finds whole words in any case, in list order', () => {
    expect(chatPromptKeywords('please ultrathink about this').map((k) => k.word)).toEqual(['ultrathink'])
    expect(chatPromptKeywords('ULTRACODE: fix it, Ultrathink.').map((k) => k.word)).toEqual(['ultrathink', 'ultracode'])
    expect(chatPromptKeywords('ultrathinking ultracoder xultrathink ultra_think')).toEqual([])
    expect(chatPromptKeywords('')).toEqual([])
  })

  it('shows a label in a Claude chat while the draft has a keyword', () => {
    renderComposer()
    expect(screen.queryByText('Ultrathink')).toBeNull()
    type('ultrathink and ultracode')
    expect(screen.getByText('Ultrathink')).toBeTruthy()
    expect(screen.getByText('Workflow')).toBeTruthy()
    type('plain text')
    expect(screen.queryByText('Ultrathink')).toBeNull()
  })

  it('shows no label in a Codex chat or for a shell command', () => {
    renderComposer('codex')
    type('ultrathink')
    expect(screen.queryByText('Ultrathink')).toBeNull()
    cleanup()
    renderComposer()
    type('!echo ultrathink')
    expect(screen.queryByText('Ultrathink')).toBeNull()
  })
})
