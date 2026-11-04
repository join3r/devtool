import React, { useEffect, useRef, useState } from 'react'
import { CornerDownLeft, Image as ImageIcon, Pencil, X } from 'lucide-react'
import type { ChatQueueOp, ChatQueuedMessage } from '../../../shared/chat-send-queue'

interface Props {
  queue: ChatQueuedMessage[]
  busy: boolean
  /** The agent's name, for the heading. */
  label: string
  onOp: (op: ChatQueueOp) => void
}

const iconButton = 'w-6 h-6 shrink-0 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-text-subtle cursor-pointer hover:bg-surface-3 hover:text-text'

/**
 * Messages queued mid-turn, above the composer: each goes out on its own when
 * the turn ends, oldest first. Until then each can be edited, removed or sent
 * now (into the running turn). After Stop they wait for you.
 */
export default function QueuedMessages({ queue, busy, label, onOp }: Props): React.ReactElement | null {
  if (queue.length === 0) return null
  return (
    <div className="flex flex-col gap-1 rounded-lg border-[0.5px] border-border bg-surface-2 px-2 py-1.5" aria-label="Queued messages">
      <div className="px-1 text-xs text-text-subtle">
        {busy
          ? `Queued · sent when ${label} finishes`
          : 'Queued · on hold since the turn stopped. Send now or remove'}
      </div>
      {queue.map((message) => (
        <QueuedRow key={message.id} message={message} busy={busy} onOp={onOp} />
      ))}
    </div>
  )
}

function QueuedRow({ message, busy, onOp }: { message: ChatQueuedMessage; busy: boolean; onOp: (op: ChatQueueOp) => void }): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (draft === null) return
    const el = inputRef.current
    if (!el || document.activeElement === el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [draft])

  const save = (): void => {
    if (draft === null) return
    if (draft.trim() && draft !== message.text) onOp({ op: 'edit', id: message.id, text: draft })
    setDraft(null)
  }

  if (draft !== null) {
    return (
      <div className="flex items-start gap-1">
        <textarea
          ref={inputRef}
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null) }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save() }
          }}
          aria-label="Edit queued message"
          className="flex-1 min-w-0 resize-none rounded-md border-[0.5px] border-border-focus bg-field px-2 py-1 text-sm text-text outline-none leading-[1.45]"
        />
      </div>
    )
  }

  return (
    <div className="group flex items-start gap-1 rounded-md px-1 py-0.5 hover:bg-surface-3">
      <button
        type="button"
        title="Edit"
        onClick={() => setDraft(message.text)}
        className="flex-1 min-w-0 border-0 bg-transparent p-0 text-left text-sm text-text-muted cursor-text whitespace-pre-wrap break-words line-clamp-3"
      >
        {message.text}
        {message.images > 0 && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-text-subtle align-middle">
            <ImageIcon size={11} />{message.images}
          </span>
        )}
      </button>
      <button type="button" title="Edit" aria-label="Edit" onClick={() => setDraft(message.text)} className={iconButton}>
        <Pencil size={12} />
      </button>
      <button
        type="button"
        title={busy ? 'Steer now: send it into the running turn' : 'Send now'}
        aria-label={busy ? 'Steer now' : 'Send now'}
        onClick={() => onOp({ op: 'send', id: message.id })}
        className={iconButton}
      >
        <CornerDownLeft size={12} />
      </button>
      <button type="button" title="Remove" aria-label="Remove" onClick={() => onOp({ op: 'remove', id: message.id })} className={iconButton}>
        <X size={12} />
      </button>
    </div>
  )
}
