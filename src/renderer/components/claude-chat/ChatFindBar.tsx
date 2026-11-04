import React from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { ChatFind } from './useChatFind'

/** The chat's find bar: sits with the pills at the top right of the thread. */
export default function ChatFindBar({ find }: { find: ChatFind }): React.ReactElement {
  const { query, count, current, inputRef } = find
  const status = !query.trim() ? '' : count === 0 ? 'No matches' : `${current + 1} of ${count}`
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (e.shiftKey) find.previous()
      else find.next()
    } else if (e.key === 'Escape') {
      // Escape here closes the search; it must not also stop the turn.
      e.preventDefault()
      e.stopPropagation()
      find.close()
    }
  }
  return (
    <div
      role="search"
      data-testid="chat-find"
      className="h-7 pl-2.5 pr-1 inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-surface-2 text-xs text-text-muted shadow-pop"
    >
      <Search size={12} className="shrink-0 text-text-subtle" aria-hidden />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={query}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        spellCheck={false}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-44 min-w-0 bg-transparent border-0 outline-none text-sm text-text placeholder:text-text-subtle"
      />
      <span className={`shrink-0 tabular-nums ${count === 0 && query.trim() ? 'text-danger' : 'text-text-subtle'}`} aria-live="polite" data-testid="chat-find-count">
        {status}
      </span>
      <FindButton label="Previous match (Shift+Enter)" disabled={count === 0} onClick={find.previous}><ChevronUp size={13} /></FindButton>
      <FindButton label="Next match (Enter)" disabled={count === 0} onClick={find.next}><ChevronDown size={13} /></FindButton>
      <FindButton label="Close (Esc)" onClick={find.close}><X size={12} /></FindButton>
    </div>
  )
}

function FindButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Keep the caret in the field: Enter keeps working after a click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex items-center justify-center size-5 rounded-full bg-transparent border-0 cursor-pointer text-text-muted hover:text-text hover:bg-surface-3 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent transition-colors duration-(--motion-fast)"
    >
      {children}
    </button>
  )
}
