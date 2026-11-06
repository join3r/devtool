import { describe, expect, it } from 'vitest'
import { lastReplyFromItems, type ChatItem } from '../src/shared/claude-chat'
import { parseScoreLine } from '../src/shared/loop'

describe('lastReplyFromItems', () => {
  it('returns every text after the last user message, in full', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u1', text: 'judge it', images: 0 },
      { kind: 'text', id: 't1', text: 'old reply' },
      { kind: 'user', id: 'u2', text: 'You ended your turn without a score.', images: 0 },
      { kind: 'text', id: 't2', text: 'Checking.' },
      { kind: 'thinking', id: 'h1', text: 'hmm' },
      { kind: 'text', id: 't3', text: `${'Findings. '.repeat(60)}\n\nSCORE: 6/10` }
    ]
    const reply = lastReplyFromItems(items)
    expect(reply?.startsWith('Checking.')).toBe(true)
    expect(reply).not.toContain('old reply')
    // A long reply keeps its lines, so a judge's closing score line still parses.
    expect(parseScoreLine(reply!)).toBe(6)
  })

  it('is null when the agent has not replied since the last message', () => {
    expect(lastReplyFromItems([{ kind: 'text', id: 't', text: 'a' }, { kind: 'user', id: 'u', text: 'b', images: 0 }])).toBeNull()
    expect(lastReplyFromItems([])).toBeNull()
  })
})
