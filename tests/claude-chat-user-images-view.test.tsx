// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import Timeline from '../src/renderer/components/claude-chat/Timeline'
import type { ChatItem } from '../src/shared/claude-chat'

void React

afterEach(cleanup)

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }

function show(item: ChatItem, folded = false): HTMLElement {
  return render(<Timeline items={[item]} busy={false} compacting={false} waiting={false} onOpenLink={() => {}} folded={folded} />).container
}

describe('user message images', () => {
  it.each([false, true])('shows thumbnails you can click open (folded %s)', (folded) => {
    const container = show({ kind: 'user', id: 'u1', text: 'look', images: 2, pictures: [png, png] }, folded)
    expect(container.textContent).not.toContain('2 images')
    expect(container.querySelectorAll('img')).toHaveLength(2)
    fireEvent.click(screen.getAllByTitle('Show full size')[0])
    expect(container.querySelectorAll('img')).toHaveLength(3)
    fireEvent.click(screen.getAllByTitle('Hide')[0])
    expect(container.querySelectorAll('img')).toHaveLength(2)
  })

  it('counts images it has no data for', () => {
    expect(show({ kind: 'user', id: 'u1', text: 'old', images: 1 }).textContent).toContain('1 image')
    expect(show({ kind: 'user', id: 'u2', text: 'x', images: 3, pictures: [png] }).textContent).toContain('+2 more')
  })
})
