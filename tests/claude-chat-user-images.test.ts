import { describe, it, expect } from 'vitest'
import { emptyChatState, reduceChat, USER_IMAGE_LIMIT, type ChatEvent, type ChatItem } from '../src/shared/claude-chat'
import { toolImage } from '../src/main/mobile/chat-view'
import { piHistoryRows } from '../src/main/agent-chat/pi-translate'
import { codexItemRows } from '../src/main/agent-chat/codex-translate'

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }

function user(items: ChatItem[]): Extract<ChatItem, { kind: 'user' }> {
  const item = items.find((i) => i.kind === 'user')
  if (item?.kind !== 'user') throw new Error('no user item')
  return item
}

describe('user message images', () => {
  it('keeps the images you sent so the timeline can draw them', () => {
    const state = reduceChat(emptyChatState(), { t: 'sent', uuid: 'u1', text: 'look', images: 1, pictures: [png] })
    expect(user(state.items)).toMatchObject({ images: 1, pictures: [png] })
    expect(toolImage(state, 'u1', 0)).toEqual(png)
    expect(toolImage(state, 'u1', 1)).toBeNull()
  })

  it('reads them back from a transcript, up to the limit', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }
    const content = [...Array(USER_IMAGE_LIMIT + 2).fill(block), { type: 'text', text: 'see' }]
    const event: ChatEvent = { t: 'history', messages: [{ type: 'user', uuid: 'h1', message: { role: 'user', content } }] }
    const item = user(reduceChat(emptyChatState(), event).items)
    expect(item.images).toBe(USER_IMAGE_LIMIT + 2)
    expect(item.pictures).toHaveLength(USER_IMAGE_LIMIT)
    expect(item.text).toBe('see')
  })

  it('reads them from Pi and Codex history', () => {
    const pi = piHistoryRows([{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', data: png.data, mimeType: 'image/png' }] }])
    expect(user(pi).pictures).toEqual([png])
    const codex = codexItemRows({ id: 'c1', type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${png.data}` }, { type: 'localImage', path: '/a.png' }] })
    expect(user(codex)).toMatchObject({ images: 2, pictures: [png] })
  })
})
