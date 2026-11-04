import type { ChatEvent, ChatImage, ChatState } from './claude-chat'

/**
 * What a message sent mid-turn does. `steer` goes into the running turn now (the
 * agent reads it at its next step); `queue` waits in DevTool and goes out on its
 * own when the turn ends. With no turn running both just send.
 */
export type ChatSendMode = 'queue' | 'steer'

export const CHAT_SEND_MODES: readonly ChatSendMode[] = ['queue', 'steer']

export function isChatSendMode(value: unknown): value is ChatSendMode {
  return value === 'queue' || value === 'steer'
}

/** A queued message as every window (and the phone) sees it: no image bytes. */
export interface ChatQueuedMessage {
  id: string
  text: string
  /** Pictures attached; they go out with it. */
  images: number
  at: number
}

/** The most messages one chat holds back; past it a queued send is refused. */
export const CHAT_QUEUE_LIMIT = 20

/** What can be done to one queued message. */
export type ChatQueueOp =
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  /** Send it now: into the running turn, or as the next message when none runs. */
  | { op: 'send'; id: string }

interface Entry {
  id: string
  text: string
  images: ChatImage[]
  at: number
}

/**
 * One chat's queued messages, with their pictures. Main owns it (one per chat
 * runtime); windows and the phone see {@link view} through the chat state.
 */
export class ChatSendQueue {
  private entries: Entry[] = []

  constructor(private readonly newId: () => string) {}

  get size(): number {
    return this.entries.length
  }

  /** Null when the queue is full or the message is empty. */
  add(text: string, images: ChatImage[], at: number): ChatQueuedMessage | null {
    if (this.entries.length >= CHAT_QUEUE_LIMIT) return null
    if (!text.trim() && images.length === 0) return null
    const entry: Entry = { id: this.newId(), text, images, at }
    this.entries.push(entry)
    return summarize(entry)
  }

  /** False for an unknown id, or a blank text on a message without pictures. */
  edit(id: string, text: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    if (!text.trim() && entry.images.length === 0) return false
    entry.text = text
    return true
  }

  /** Take one message out (to remove it, or to send it now). */
  take(id: string): { text: string; images: ChatImage[] } | null {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index < 0) return null
    const [entry] = this.entries.splice(index, 1)
    return { text: entry.text, images: entry.images }
  }

  /** The oldest message, taken out; null when there is none. */
  shift(): { text: string; images: ChatImage[] } | null {
    const entry = this.entries.shift()
    return entry ? { text: entry.text, images: entry.images } : null
  }

  view(): ChatQueuedMessage[] {
    return this.entries.map(summarize)
  }

  clear(): void {
    this.entries = []
  }
}

function summarize(entry: Entry): ChatQueuedMessage {
  return { id: entry.id, text: entry.text, images: entry.images.length, at: entry.at }
}

/** Whether a send with `mode` waits in the queue rather than going out now. */
export function holdsSend(mode: ChatSendMode | undefined, state: ChatState): boolean {
  return mode === 'queue' && state.busy
}

/**
 * How `event` (folded from `prev` into `next`) ended a turn, if it did: `done`
 * when it ran to its end (the queue's next message goes out), `stopped` when
 * Stop or a failure ended it (the queue holds until the user acts, as Esc does
 * in the CLI). Only a turn's own end counts, not a process exiting or history loading.
 */
export function turnEnd(prev: ChatState, next: ChatState, event: ChatEvent): 'done' | 'stopped' | null {
  if (!prev.busy || next.busy) return null
  if (event.t !== 'sdk' && event.t !== 'turn') return null
  if (prev.interrupting) return 'stopped'
  if (event.t === 'turn' && (event.interrupted || event.error)) return 'stopped'
  if (event.t === 'sdk') {
    const m = event.m as { type?: unknown; subtype?: unknown; is_error?: unknown } | null
    if (m?.type === 'result' && ((m.subtype !== undefined && m.subtype !== 'success') || m.is_error === true)) return 'stopped'
  }
  const last = next.items[next.items.length - 1]
  if (last?.kind === 'notice' && last.text === 'Interrupted') return 'stopped'
  return 'done'
}
