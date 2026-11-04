import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem } from '../../../shared/claude-chat'
import { chatSearchPattern, findInSegments, keepPlace, stepMatch, type ChatSearchMatch } from '../../../shared/chat-search'
import { desktopPlatform } from '../../hostPlatform'
import { clearFindMarks, conversationSegments, drawnMatches, markdownTextWith, scrollIntoMiddle, setFindMarks } from './chatFind'
import { renderChatMarkdown } from './markdown'

/** Open this item (and, with `detail`, its input and output) so a match in it shows; a new `seq` asks again. */
export interface TimelineReveal {
  item: string
  detail: boolean
  seq: number
}

interface Options {
  tabId: string
  items: ChatItem[]
  busy: boolean
  background: boolean
  visible: boolean
  rootRef: React.RefObject<HTMLElement | null>
  scrollRef: React.RefObject<HTMLElement | null>
  /** Called before the find bar scrolls the thread: stop following the bottom. */
  onScrollAway: () => void
}

export interface ChatFind {
  open: boolean
  query: string
  setQuery: (query: string) => void
  count: number
  /** The match shown, from 0; -1 for none. */
  current: number
  reveal: TimelineReveal | null
  inputRef: React.RefObject<HTMLInputElement | null>
  next: () => void
  previous: () => void
  close: () => void
}

/** How long after a jump the thread keeps the match in view while folds open around it. */
const SETTLE_MS = 600

const markdown = markdownTextWith(renderChatMarkdown)

/** Cmd+F on macOS, Ctrl+F elsewhere (Ctrl+F on a Mac is the text field's forward-char). */
function isFindKey(e: KeyboardEvent): boolean {
  const mod = desktopPlatform() === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
}

function isFindAgainKey(e: KeyboardEvent): boolean {
  const mod = desktopPlatform() === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && e.key.toLowerCase() === 'g'
}

/**
 * Find in a chat thread: Cmd+F opens it while the chat has the focus (or nothing
 * else does). Matches come from the chat's items (see src/shared/chat-search.ts),
 * so folded work and calls you never opened count too; jumping to one opens what
 * hides it, then the drawn text gets marked and scrolled into view.
 */
export function useChatFind({ tabId, items, busy, background, visible, rootRef, scrollRef, onScrollAway }: Options): ChatFind {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [current, setCurrent] = useState(-1)
  const [reveal, setReveal] = useState<TimelineReveal | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const revealSeq = useRef(0)
  const settleUntil = useRef(0)
  const lastMatch = useRef<ChatSearchMatch | undefined>(undefined)
  const onScrollAwayRef = useRef(onScrollAway)
  onScrollAwayRef.current = onScrollAway

  const segments = useMemo(
    () => open ? conversationSegments(items, busy, background, markdown) : [],
    [open, items, busy, background]
  )
  const matches = useMemo(() => findInSegments(segments, query), [segments, query])
  const order = useMemo(() => {
    const map = new Map<string, number>()
    segments.forEach((segment, index) => { if (!map.has(segment.anchor)) map.set(segment.anchor, index) })
    return (anchor: string) => map.get(anchor) ?? -1
  }, [segments])

  const goTo = useCallback((index: number, list: readonly ChatSearchMatch[]) => {
    setCurrent(index)
    const match = list[index]
    lastMatch.current = match
    if (!match) return
    onScrollAwayRef.current()
    settleUntil.current = performance.now() + SETTLE_MS
    revealSeq.current += 1
    setReveal({ item: match.item, detail: match.detail, seq: revealSeq.current })
  }, [])

  // The matches change under you (a new letter, a new answer): stay on the same
  // match, or the next one after where you were. A new query starts from the top
  // of what you are looking at.
  const lastQuery = useRef('')
  useEffect(() => {
    if (!open) return
    const queryChanged = lastQuery.current !== query
    lastQuery.current = query
    if (matches.length === 0) {
      setCurrent(-1)
      return
    }
    const previous = lastMatch.current
    if (!previous) {
      goTo(firstInView(matches, scrollRef.current), matches)
      return
    }
    const index = keepPlace(previous, matches, order)
    const same = matches[index]
    if (queryChanged || same.anchor !== previous.anchor || same.nth !== previous.nth) goTo(index, matches)
    else { setCurrent(index); lastMatch.current = same }
  }, [open, query, matches, order, goTo, scrollRef])

  const setQuery = useCallback((next: string) => {
    if (!next.trim()) lastMatch.current = undefined
    setQueryState(next)
  }, [])

  const next = useCallback(() => {
    if (matches.length > 0) goTo(stepMatch(current, matches.length, 1), matches)
  }, [current, matches, goTo])
  const previous = useCallback(() => {
    if (matches.length > 0) goTo(stepMatch(current, matches.length, -1), matches)
  }, [current, matches, goTo])

  const close = useCallback(() => {
    setOpen(false)
    setReveal(null)
    lastMatch.current = undefined
    clearFindMarks(tabId)
    rootRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [tabId, rootRef])

  // Cmd+F: the chat with the focus takes it, before a terminal's own find does.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) return
      const active = document.activeElement
      const ours = !active || active === document.body || root.contains(active)
      if (!ours) return
      if (isFindKey(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(true)
        // Already open: back to the field, its text selected for a new search.
        requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
      } else if (open && e.key === 'Escape' && (!active || active === document.body)) {
        // Focus left the field (a click in the thread): Escape still closes it.
        e.preventDefault()
        close()
      } else if (open && isFindAgainKey(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.shiftKey) previous()
        else next()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, rootRef, open, next, previous, close])

  // Mark what is drawn, after every change to the thread (a fold opening, text
  // streaming in) as well as to the search.
  const frame = useRef(0)
  const state = useRef({ query, current, matches })
  state.current = { query, current, matches }
  const refresh = useCallback(() => {
    frame.current = 0
    const scroller = scrollRef.current
    const pattern = chatSearchPattern(state.current.query)
    if (!scroller || !pattern) { clearFindMarks(tabId); return }
    const { elements, ranges } = drawnMatches(scroller, pattern)
    const match = state.current.matches[state.current.current]
    let target: Range | null = null
    if (match) {
      const own = ranges.get(match.anchor)
      if (own && own.length > 0) target = own[Math.min(match.nth, own.length - 1)]
    }
    setFindMarks(tabId, [...ranges.values()].flat(), target)
    if (match && performance.now() < settleUntil.current) {
      const rect = target?.getBoundingClientRect() ?? elements.get(match.anchor)?.getBoundingClientRect()
      if (rect) scrollIntoMiddle(scroller, rect)
    }
  }, [tabId, scrollRef])
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(refresh)
  }, [refresh])

  useEffect(() => {
    if (open && visible) schedule()
  }, [open, visible, query, current, matches, reveal, schedule])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!open || !visible || !scroller) return
    const observer = new MutationObserver(schedule)
    observer.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [open, visible, scrollRef, schedule])

  // A hidden tab keeps its search but not its marks.
  useEffect(() => {
    if (!open || !visible) clearFindMarks(tabId)
  }, [open, visible, tabId])
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current)
    clearFindMarks(tabId)
  }, [tabId])

  return { open, query, setQuery, count: matches.length, current, reveal, inputRef, next, previous, close }
}

/** The first match drawn at or below the top of the view; else the newest one. */
function firstInView(matches: readonly ChatSearchMatch[], scroller: HTMLElement | null): number {
  if (!scroller) return matches.length - 1
  const top = scroller.getBoundingClientRect().top
  const elements = new Map<string, Element>()
  for (const el of scroller.querySelectorAll('[data-chat-item]')) {
    const anchor = el.getAttribute('data-chat-item')
    if (anchor && !elements.has(anchor)) elements.set(anchor, el)
  }
  for (let i = 0; i < matches.length; i++) {
    const el = elements.get(matches[i].anchor)
    if (el && el.getBoundingClientRect().bottom >= top) return i
  }
  return matches.length - 1
}
