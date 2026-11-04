// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import Timeline from '../src/renderer/components/claude-chat/Timeline'
import { collectText, conversationSegments, drawnMatches, markdownTextWith } from '../src/renderer/components/claude-chat/chatFind'
import { renderChatMarkdown } from '../src/renderer/components/claude-chat/markdown'
import { chatSearchPattern, findInSegments } from '../src/shared/chat-search'
import type { ChatItem } from '../src/shared/claude-chat'

void React

afterEach(cleanup)

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Where is the config?', images: 0, at: 1000 },
  { kind: 'tool', id: 'r1', name: 'Bash', label: 'Find config', input: { command: 'ls config/' }, status: 'done', result: 'config.json', at: 2000 },
  { kind: 'text', id: 'a1', text: 'The **config** lives in `config/config.json`.', at: 3000 }
]

function timeline(reveal: { item: string; detail: boolean; seq: number } | null = null): React.ReactElement {
  return <Timeline items={items} busy={false} compacting={false} waiting={false} onOpenLink={() => {}} folded reveal={reveal} />
}

describe('collectText', () => {
  it('breaks lines between blocks but not inside one, and skips marked chrome', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>foo <b>bar</b></p><p>baz<span data-find-skip>3 of 4</span></p>'
    expect(collectText(div).text).toBe('foo bar\nbaz')
  })
})

describe('find in the drawn timeline', () => {
  it('marks what is drawn, and its counts match the data once everything is open', async () => {
    const { container, rerender } = render(timeline())
    const pattern = chatSearchPattern('config')!
    const closed = drawnMatches(container, pattern)
    // The work is folded away: only your message and the answer are drawn.
    expect([...closed.ranges.keys()]).toEqual(['u1', 'a1'])
    expect(closed.ranges.get('a1')?.map((r) => r.toString())).toEqual(['config', 'config', 'config'])

    // Find lands on the result inside the fold: the fold and the call open.
    const matches = findInSegments(conversationSegments(items, false, false, markdownTextWith(renderChatMarkdown)), 'config')
    const inResult = matches.find((m) => m.item === 'r1' && m.detail)!
    rerender(timeline({ item: inResult.item, detail: inResult.detail, seq: 1 }))
    await Promise.resolve()
    const open = drawnMatches(container, pattern)
    expect([...open.ranges.keys()]).toEqual(['u1', 'r1', 'a1'])
    for (const [anchor, ranges] of open.ranges) {
      expect(ranges).toHaveLength(matches.filter((m) => m.anchor === anchor).length)
    }
    expect(open.ranges.get('r1')![inResult.nth].toString()).toBe('config')
  })
})
