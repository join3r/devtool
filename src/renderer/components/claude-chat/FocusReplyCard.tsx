import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { lastReplyFromItems, type ChatItem } from '../../../shared/claude-chat'
import { renderChatMarkdown } from './markdown'

/**
 * Above the prompt while a browser page has the task (Focus): whether the
 * agent is at work, else the start of its last reply, which opens in full.
 */
export default function FocusReplyCard({ items, busy, label, onOpenLink }: {
  items: ChatItem[]
  busy: boolean
  label: string
  onOpenLink: (url: string) => void
}): React.ReactElement | null {
  const reply = useMemo(() => (busy ? null : lastReplyFromItems(items)), [items, busy])
  const html = useMemo(() => (reply ? renderChatMarkdown(reply) : ''), [reply])
  const [expanded, setExpanded] = useState(false)
  // A new reply starts folded.
  useEffect(() => { setExpanded(false) }, [reply])

  if (busy) {
    return (
      <div className="self-start h-7 px-3 inline-flex items-center gap-2 rounded-full border-[0.5px] border-border bg-surface-2 shadow-pop text-sm text-text-muted" data-testid="focus-reply-working">
        <span className="size-1.5 rounded-full bg-status-working status-pulse" aria-hidden="true" />
        {label} is working…
      </div>
    )
  }
  if (!reply) return null
  return (
    <div className="rounded-lg border-[0.5px] border-border bg-surface-2 shadow-pop" data-testid="focus-reply">
      <div
        className={`note-preview chat-md text-sm text-text break-words px-3 pt-2 ${expanded ? 'max-h-[45vh] overflow-y-auto pb-2' : 'max-h-[4.5em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]'}`}
        onClick={(e) => {
          const anchor = (e.target as Element).closest('a')
          const href = anchor?.getAttribute('href')
          if (!anchor || !href) return
          e.preventDefault()
          if (/^https?:\/\//i.test(href)) onOpenLink(href)
        }}
        // Sanitized by DOMPurify in renderChatMarkdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <button
        type="button"
        className="w-full h-6 px-3 inline-flex items-center gap-1 bg-transparent border-0 border-t-[0.5px] border-border text-xs text-text-muted cursor-pointer hover:text-text"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        {expanded ? 'Fold the reply' : `${label}'s last reply`}
      </button>
    </div>
  )
}
