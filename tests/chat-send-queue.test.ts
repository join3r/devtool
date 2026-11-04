import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { emptyChatState, reduceChat, type ChatEvent, type ChatState } from '../src/shared/claude-chat'
import { CHAT_QUEUE_LIMIT, ChatSendQueue, holdsSend, turnEnd } from '../src/shared/chat-send-queue'
import { ClaudeChatManager, type ChatManagerDeps } from '../src/main/claude-chat/chat-manager'
import { sendModeForKey } from '../src/renderer/components/claude-chat/Composer'

const image = { mediaType: 'image/png', data: 'AAAA' }

function queue(): ChatSendQueue {
  let n = 0
  return new ChatSendQueue(() => `q${++n}`)
}

describe('ChatSendQueue', () => {
  it('keeps messages in order with their pictures, and edits, takes and shifts them', () => {
    const q = queue()
    expect(q.add('first', [], 1)).toEqual({ id: 'q1', text: 'first', images: 0, at: 1 })
    q.add('second', [image], 2)
    q.add('third', [], 3)
    expect(q.view().map((m) => m.text)).toEqual(['first', 'second', 'third'])
    expect(q.view()[1].images).toBe(1)

    expect(q.edit('q1', 'first, edited')).toBe(true)
    expect(q.edit('q1', '  ')).toBe(false)
    expect(q.edit('nope', 'x')).toBe(false)
    expect(q.take('q3')).toEqual({ text: 'third', images: [] })
    expect(q.take('q3')).toBeNull()
    expect(q.shift()).toEqual({ text: 'first, edited', images: [] })
    expect(q.shift()).toEqual({ text: 'second', images: [image] })
    expect(q.shift()).toBeNull()
    expect(q.size).toBe(0)
  })

  it('refuses empty messages and a full queue; a picture alone is a message', () => {
    const q = queue()
    expect(q.add('  ', [], 1)).toBeNull()
    expect(q.add('', [image], 1)).not.toBeNull()
    expect(q.edit('q1', '')).toBe(true)
    for (let i = 1; i < CHAT_QUEUE_LIMIT; i++) q.add(`m${i}`, [], i)
    expect(q.add('one too many', [], 99)).toBeNull()
  })
})

describe('when a send waits', () => {
  it('holds only a queued send while a turn runs', () => {
    const idle = emptyChatState()
    const busy = { ...idle, busy: true }
    expect(holdsSend('queue', busy)).toBe(true)
    expect(holdsSend('steer', busy)).toBe(false)
    expect(holdsSend(undefined, busy)).toBe(false)
    expect(holdsSend('queue', idle)).toBe(false)
  })

  it('tells a turn that ran to its end from one Stop or a failure ended', () => {
    const busy: ChatState = { ...emptyChatState(), busy: true }
    const end: ChatEvent = { t: 'turn', state: 'end' }
    expect(turnEnd(busy, reduceChat(busy, end), end)).toBe('done')
    const stopped: ChatEvent = { t: 'turn', state: 'end', interrupted: true }
    expect(turnEnd(busy, reduceChat(busy, stopped), stopped)).toBe('stopped')
    const interrupting = { ...busy, interrupting: true }
    expect(turnEnd(interrupting, reduceChat(interrupting, end), end)).toBe('stopped')
    // Claude's turn ends with its `result`.
    const result: ChatEvent = { t: 'sdk', m: { type: 'result', subtype: 'success' } }
    expect(turnEnd(busy, reduceChat(busy, result), result)).toBe('done')
    const cancelled: ChatEvent = { t: 'sdk', m: { type: 'result', subtype: 'error_during_execution', errors: [] } }
    expect(turnEnd(busy, reduceChat(busy, cancelled), cancelled)).toBe('stopped')
    // A failed turn holds the queue too: you see the error before more goes out.
    const failed: ChatEvent = { t: 'turn', state: 'end', error: 'boom' }
    expect(turnEnd(busy, reduceChat(busy, failed), failed)).toBe('stopped')
    // Not a turn's end: the process dying, a turn starting, nothing running.
    const exited: ChatEvent = { t: 'process', state: 'exited' }
    expect(turnEnd(busy, reduceChat(busy, exited), exited)).toBeNull()
    const idle = emptyChatState()
    expect(turnEnd(idle, reduceChat(idle, end), end)).toBeNull()
  })

  it('keeps the queue in the state through /clear and drops the field when empty', () => {
    const items = [{ id: 'q1', text: 'later', images: 0, at: 1 }]
    const queued = reduceChat(emptyChatState(), { t: 'queue', items })
    expect(queued.queue).toEqual(items)
    expect(reduceChat(queued, { t: 'reset' }).queue).toEqual(items)
    expect(reduceChat(queued, { t: 'queue', items: [] })).not.toHaveProperty('queue')
  })
})

describe('composer keys', () => {
  const key = (over: Partial<Parameters<typeof sendModeForKey>[0]> = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...over })

  it('Enter takes the picked mode, Cmd/Ctrl+Enter the other; Shift/Alt+Enter and IME are not sends', () => {
    expect(sendModeForKey(key(), 'queue')).toBe('queue')
    expect(sendModeForKey(key({ metaKey: true }), 'queue')).toBe('steer')
    expect(sendModeForKey(key({ ctrlKey: true }), 'queue')).toBe('steer')
    expect(sendModeForKey(key(), 'steer')).toBe('steer')
    expect(sendModeForKey(key({ metaKey: true }), 'steer')).toBe('queue')
    expect(sendModeForKey(key({ shiftKey: true }), 'queue')).toBeNull()
    expect(sendModeForKey(key({ altKey: true }), 'queue')).toBeNull()
    expect(sendModeForKey(key({ isComposing: true }), 'queue')).toBeNull()
    expect(sendModeForKey(key({ key: 'a' }), 'queue')).toBeNull()
  })
})

// The manager end to end, on the fake Pi: "hold" keeps a turn open until a steered "finish".
const dirs: string[] = []
const managers: ClaudeChatManager[] = []
afterEach(() => {
  for (const chats of managers.splice(0)) chats.closeAll()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function piChat() {
  const deps: ChatManagerDeps = {
    sendToClient: () => {},
    resolveLocalClaude: () => 'claude',
    resolveLocalAgent: () => path.resolve('tests/helpers/fake-pi.mjs'),
    wrapSpawn: (file, args) => ({ file: process.execPath, args: [file, ...args] }),
    localEnv: () => process.env,
    ensureSsh: async () => {},
    remoteCommand: () => { throw new Error('no ssh here') },
    bashSpawn: (config, command) => ({ file: '/bin/sh', args: ['-c', command], cwd: config.cwd }),
    claudeSpawn: () => { throw new Error('no claude here') },
    remoteExec: async () => '',
    onHook: () => {},
    onPromptResolved: () => {},
    onProcessChange: () => {},
    log: () => {}
  }
  const chats = new ClaudeChatManager(deps)
  managers.push(chats)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-send-queue-'))
  dirs.push(cwd)
  await chats.attach('win', 'tab', { agent: 'pi', cwd, sessionId: 'fresh', projectId: 'p' })
  await expect.poll(() => chats.snapshot('tab')?.state.process).toBe('running')
  const state = (): ChatState => chats.snapshot('tab')!.state
  const userTexts = (): string[] => state().items.flatMap((item) => (item.kind === 'user' ? [item.text] : []))
  return { chats, state, userTexts }
}

describe('ClaudeChatManager send modes', () => {
  it('queues mid-turn, sends the queue one by one when the turn ends, and steers at once', async () => {
    const { chats, state, userTexts } = await piChat()
    await chats.send('tab', 'hold')
    await expect.poll(() => state().busy).toBe(true)

    await chats.send('tab', 'queued one', [], 'queue')
    await chats.send('tab', 'queued two', [], 'queue')
    expect(state().queue?.map((m) => m.text)).toEqual(['queued one', 'queued two'])
    expect(userTexts()).toEqual(['hold'])

    // Steer goes into the running turn now (and here ends it).
    await chats.send('tab', 'finish', [], 'steer')
    await expect.poll(() => userTexts()).toEqual(['hold', 'finish', 'queued one', 'queued two'])
    await expect.poll(() => state().busy).toBe(false)
    expect(state()).not.toHaveProperty('queue')
  }, 20_000)

  it('sends a queued send at once when no turn runs', async () => {
    const { chats, state, userTexts } = await piChat()
    await chats.send('tab', 'right away', [], 'queue')
    expect(state()).not.toHaveProperty('queue')
    await expect.poll(() => userTexts()).toEqual(['right away'])
  }, 20_000)

  it('holds the queue after Stop; it can be edited, removed or sent now', async () => {
    const { chats, state, userTexts } = await piChat()
    await chats.send('tab', 'hold')
    await expect.poll(() => state().busy).toBe(true)
    await chats.send('tab', 'keep me', [], 'queue')
    await chats.send('tab', 'drop me', [], 'queue')
    const [keep, drop] = state().queue!

    await chats.interrupt('tab')
    await expect.poll(() => state().busy).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(userTexts()).toEqual(['hold'])
    expect(state().queue?.length).toBe(2)

    expect(await chats.queueOp('tab', { op: 'edit', id: keep.id, text: 'kept, edited' })).toBe(true)
    expect(await chats.queueOp('tab', { op: 'remove', id: drop.id })).toBe(true)
    expect(await chats.queueOp('tab', { op: 'remove', id: drop.id })).toBe(false)
    expect(state().queue).toEqual([{ ...keep, text: 'kept, edited' }])

    expect(await chats.queueOp('tab', { op: 'send', id: keep.id })).toBe(true)
    expect(state()).not.toHaveProperty('queue')
    await expect.poll(() => userTexts()).toEqual(['hold', 'kept, edited'])
  }, 20_000)

  it('sends a queued message now into the running turn', async () => {
    const { chats, state, userTexts } = await piChat()
    await chats.send('tab', 'hold')
    await expect.poll(() => state().busy).toBe(true)
    await chats.send('tab', 'finish', [], 'queue')
    const [finish] = state().queue!
    expect(await chats.queueOp('tab', { op: 'send', id: finish.id })).toBe(true)
    await expect.poll(() => state().busy).toBe(false)
    expect(userTexts()).toEqual(['hold', 'finish'])
  }, 20_000)
})
