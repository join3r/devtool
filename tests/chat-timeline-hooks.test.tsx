// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import Timeline from '../src/renderer/components/claude-chat/Timeline'
import type { ChatItem, ChatTask } from '../src/shared/claude-chat'

void React

afterEach(() => {
  cleanup()
})

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Fix the bug', images: 0, at: 1000 },
  { kind: 'text', id: 'a1', text: 'Fixed it.', at: 2000 }
]
const review: ChatTask = { id: 'hook:h1', kind: 'hook', description: 'Stop hook', background: true, status: 'running', startedAt: Date.now() }
const shell: ChatTask = { id: 'b1', kind: 'shell', description: 'npm test', background: true, status: 'running', startedAt: Date.now() }

function renderWith(tasks: ChatTask[], onStopTask = vi.fn()): void {
  render(<Timeline items={items} busy={false} compacting={false} waiting={false} onOpenLink={() => {}} folded backgroundTasks={tasks} onStopTask={onStopTask} />)
}

describe('Timeline: hooks after the answer', () => {
  it('says the finished-looking turn still waits for its hooks, with no Stop', () => {
    renderWith([review])
    expect(screen.getByTestId('progress-card').textContent).toContain('Waiting for hooks')
    expect(screen.getByText('Stop hook')).toBeTruthy()
    expect(screen.queryByTestId('progress-card-stop')).toBeNull()
  })

  it('stays Background when other work runs beside the hook', () => {
    renderWith([review, shell])
    const card = screen.getByTestId('progress-card')
    expect(card.textContent).toContain('Background')
    expect(card.textContent).not.toContain('Waiting for hooks')
    expect(screen.getAllByTestId('progress-card-stop')).toHaveLength(1)
  })
})
