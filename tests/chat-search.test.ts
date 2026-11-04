import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatToolItem } from '../src/shared/claude-chat'
import {
  chatSearchPattern,
  findInSegments,
  itemSegments,
  keepPlace,
  matchRanges,
  searchChatItems,
  stepMatch,
  toolDetailText
} from '../src/shared/chat-search'
import { conversationSegments } from '../src/renderer/components/claude-chat/chatFind'

function tool(id: string, name: string, input: Record<string, unknown> = {}, extra: Partial<ChatToolItem> = {}): ChatToolItem {
  return { kind: 'tool', id, name, label: `${name} label`, input, status: 'done', ...extra }
}
const user = (id: string, text: string, at?: number): ChatItem => ({ kind: 'user', id, text, images: 0, at })
const text = (id: string, body: string, at?: number): ChatItem => ({ kind: 'text', id, text: body, at })
const thinking = (id: string, body: string): ChatItem => ({ kind: 'thinking', id, text: body })

describe('chatSearchPattern', () => {
  it('is case-insensitive and literal', () => {
    const pattern = chatSearchPattern('a.b (c)')!
    expect(matchRanges('A.B (C) and axb (c)', pattern)).toEqual([[0, 7]])
    expect(matchRanges('Hello HELLO hello', chatSearchPattern('hello')!)).toEqual([[0, 5], [6, 11], [12, 17]])
  })

  it('has no pattern for an empty or blank query', () => {
    expect(chatSearchPattern('')).toBeNull()
    expect(chatSearchPattern('   ')).toBeNull()
  })

  it('folds case beyond ASCII', () => {
    expect(matchRanges('Žltý KÔŇ', chatSearchPattern('kôň')!)).toEqual([[5, 8]])
  })
})

describe('findInSegments', () => {
  it('numbers matches within each anchor, in segment order', () => {
    const matches = findInSegments([
      { anchor: 'a', text: 'foo foo' },
      { anchor: 'b', text: 'no' },
      { anchor: 'a', item: 'x', detail: true, text: 'FOO' }
    ], 'foo')
    expect(matches.map((m) => [m.anchor, m.item, m.detail, m.nth, m.start])).toEqual([
      ['a', 'a', false, 0, 0],
      ['a', 'a', false, 1, 4],
      ['a', 'x', true, 2, 0]
    ])
  })
})

describe('stepMatch', () => {
  it('wraps both ways and starts at an end', () => {
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(-1, 3, 1)).toBe(0)
    expect(stepMatch(-1, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(-1)
  })
})

describe('keepPlace', () => {
  const order = (anchor: string): number => ['a', 'b', 'c'].indexOf(anchor)
  const segs = [{ anchor: 'a', text: 'x x' }, { anchor: 'b', text: 'x' }, { anchor: 'c', text: 'x' }]

  it('stays on the same match when more arrive', () => {
    const before = findInSegments(segs.slice(0, 2), 'x')
    const after = findInSegments(segs, 'x')
    expect(keepPlace(before[2], after, order)).toBe(2)
  })

  it('goes to the next one after a match that is gone', () => {
    const before = findInSegments(segs, 'x')
    const after = findInSegments([segs[0], segs[2]], 'x')
    expect(after[keepPlace(before[2], after, order)].anchor).toBe('c')
  })

  it('starts at the first match without a place, and the last past the end', () => {
    const matches = findInSegments(segs, 'x')
    expect(keepPlace(undefined, matches, order)).toBe(0)
    expect(keepPlace({ anchor: 'z', item: 'z', detail: false, nth: 0, start: 0, end: 1 }, matches, (a) => a === 'z' ? 99 : order(a))).toBe(3)
  })
})

describe('itemSegments', () => {
  it('splits a tool call into its label and its details', () => {
    const bash = tool('t', 'Bash', { command: 'npm test' }, { label: 'Run tests', result: 'All 12 passed' })
    expect(itemSegments(bash)).toEqual([
      { anchor: 't', text: 'Run tests' },
      { anchor: 't', detail: true, text: '$ npm test\nAll 12 passed' }
    ])
  })

  it('reads an edit as its diff, without the result', () => {
    const edit = tool('e', 'Edit', { file_path: '/a.ts', old_string: 'one\ntwo', new_string: 'one\nthree' }, { result: 'File updated' })
    const detail = toolDetailText(edit)
    expect(detail).toContain('/a.ts')
    expect(detail).toContain('three')
    expect(detail).not.toContain('File updated')
    // Unchanged lines show once.
    expect(detail.match(/one/g)).toHaveLength(1)
  })

  it('reads a todo list as its lines', () => {
    const todos = tool('td', 'TodoWrite', { todos: [{ content: 'Write tests', status: 'pending' }, { content: 'Ship', activeForm: 'Shipping', status: 'in_progress' }] })
    expect(itemSegments(todos)).toEqual([{ anchor: 'td', text: 'Write tests\nShipping' }])
  })

  it('leaves out empty thinking, and puts work on a given anchor', () => {
    expect(itemSegments(thinking('th', '  '))).toEqual([])
    expect(itemSegments(text('m', 'hi'), undefined, 'card:x')).toEqual([{ anchor: 'card:x', item: 'm', text: 'hi' }])
  })

  it('reads a !command as its line, then its output', () => {
    const bash: ChatItem = { kind: 'bash', id: 'b', command: 'ls', stdout: 'README.md\n', exitCode: 0 }
    expect(itemSegments(bash)).toEqual([
      { anchor: 'b', text: '! ls' },
      { anchor: 'b', detail: true, text: 'README.md\n' }
    ])
  })

  it('runs Markdown through the renderer it is given', () => {
    expect(itemSegments(text('m', '**bold** word'), (md) => md.replace(/\*\*/g, ''))).toEqual([{ anchor: 'm', text: 'bold word' }])
  })
})

describe('conversationSegments', () => {
  const items: ChatItem[] = [
    user('u1', 'Fix the login bug', 1000),
    tool('r1', 'Read', { file_path: '/src/login.ts' }, { label: 'Read login.ts', at: 2000 }),
    thinking('th1', 'The login check is inverted'),
    text('a1', 'Fixed the login check.', 5000),
    user('u2', 'Now the logout', 6000),
    tool('r2', 'Bash', { command: 'grep logout' }, { label: 'Search for logout', at: 7000 })
  ]

  it('orders a finished turn as message, folded line, work, answer', () => {
    const segments = conversationSegments(items, false, false)
    expect(segments.map((s) => s.anchor)).toEqual([
      'u1', 'fold:u1', 'r1', 'r1', 'th1', 'a1',
      'u2', 'fold:u2', 'r2', 'r2'
    ])
    expect(segments[1].text).toMatch(/^Worked 4s · read 1 file/)
  })

  it('finds matches in work that is folded away', () => {
    const matches = findInSegments(conversationSegments(items, false, false), 'login')
    expect(matches.map((m) => m.item)).toEqual(['u1', 'r1', 'r1', 'th1', 'a1'])
    expect(matches.find((m) => m.detail)?.item).toBe('r1')
  })

  it('puts the running turn’s work on its card', () => {
    const segments = conversationSegments(items, true, false)
    const live = segments.filter((s) => s.anchor === 'card:u2')
    expect(live.map((s) => s.item)).toEqual(['r2', 'r2'])
    expect(segments.some((s) => s.anchor === 'fold:u2')).toBe(false)
  })

  it('searches a long thread', () => {
    const long: ChatItem[] = []
    for (let i = 0; i < 2000; i++) {
      long.push(user(`u${i}`, `question ${i}`), tool(`t${i}`, 'Bash', { command: `echo needle-${i}` }), text(`a${i}`, `answer ${i}`))
    }
    const matches = findInSegments(conversationSegments(long, false, false), 'NEEDLE-19')
    // needle-19, needle-190..199, needle-1900..1999
    expect(matches).toHaveLength(1 + 10 + 100)
    expect(matches[0].item).toBe('t19')
  })
})

describe('searchChatItems', () => {
  it('counts matches per item in thread order', () => {
    const items: ChatItem[] = [user('u', 'deploy'), tool('t', 'Bash', { command: 'deploy deploy' }, { label: 'Deploy' }), text('a', 'nothing')]
    expect(searchChatItems(items, 'DEPLOY')).toEqual([{ itemId: 'u', count: 1 }, { itemId: 't', count: 3 }])
    expect(searchChatItems(items, '')).toEqual([])
  })
})
