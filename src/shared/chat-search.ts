import type { ChatItem } from './claude-chat'
import { firstLine } from './agent-activity'
import { diffLines, editPairs } from './chat-diff'

/**
 * Find in a chat thread: the matching runs on the chat's items, not on what
 * happens to be drawn, so a fold that is shut, a tool call's input and output,
 * or a part of the thread the phone has not loaded yet all count.
 *
 * Each item becomes one or more segments of plain text. A segment's text is what
 * the item shows once it is open, in the order it shows it, so a match's number
 * here is the same match's number on screen.
 */

/** One piece of searchable text, and where it shows. */
export interface ChatSearchSegment {
  /** The element the text shows in (`data-chat-item` on the desktop). */
  anchor: string
  /** The item to open so the text shows; defaults to `anchor`. */
  item?: string
  /** The text shows only with the item's details open (a tool call's input and output). */
  detail?: boolean
  text: string
}

export interface ChatSearchMatch {
  anchor: string
  item: string
  detail: boolean
  /** Which match this is among the ones in the same anchor, from 0. */
  nth: number
  /** Where it is in its segment's text. */
  start: number
  end: number
}

/** Longest query that is searched; a longer one is cut there. */
export const CHAT_SEARCH_MAX_QUERY = 200

/** Case-insensitive, literal: what you typed, not a pattern. Null for an empty query. */
export function chatSearchPattern(query: string): RegExp | null {
  const text = query.slice(0, CHAT_SEARCH_MAX_QUERY)
  if (!text.trim()) return null
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
}

/** Every match of `pattern` in `text`: [start, end) pairs, not overlapping. */
export function matchRanges(text: string, pattern: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m[0].length === 0) { pattern.lastIndex++; continue }
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

/** Every match in the thread, in the order the segments come. */
export function findInSegments(segments: readonly ChatSearchSegment[], query: string): ChatSearchMatch[] {
  const pattern = chatSearchPattern(query)
  if (!pattern) return []
  const matches: ChatSearchMatch[] = []
  const perAnchor = new Map<string, number>()
  for (const segment of segments) {
    for (const [start, end] of matchRanges(segment.text, pattern)) {
      const nth = perAnchor.get(segment.anchor) ?? 0
      perAnchor.set(segment.anchor, nth + 1)
      matches.push({ anchor: segment.anchor, item: segment.item ?? segment.anchor, detail: segment.detail ?? false, nth, start, end })
    }
  }
  return matches
}

/** The match to go to after `current` (-1: none yet), wrapping around. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

/**
 * Keeps your place when the matches change under you (a new answer streams in,
 * or you type another letter): the match at or after where you were.
 */
export function keepPlace(previous: ChatSearchMatch | undefined, matches: readonly ChatSearchMatch[], order: (anchor: string) => number): number {
  if (matches.length === 0) return -1
  if (!previous) return 0
  const exact = matches.findIndex((m) => m.anchor === previous.anchor && m.start === previous.start && m.detail === previous.detail)
  if (exact >= 0) return exact
  const at = order(previous.anchor)
  const after = matches.findIndex((m) => {
    const o = order(m.anchor)
    return o > at || (o === at && m.nth >= previous.nth)
  })
  return after >= 0 ? after : matches.length - 1
}

/** Markdown as the text it reads as; the identity function when there is no renderer. */
export type MarkdownText = (markdown: string) => string

const plain: MarkdownText = (text) => text

/** A todo list's lines, as the list shows them. */
function todoLines(input: Record<string, unknown>): string[] {
  const todos = Array.isArray(input.todos) ? input.todos as Record<string, unknown>[] : []
  return todos.map((todo) => String((todo.status === 'in_progress' ? todo.activeForm : null) ?? todo.content ?? ''))
}

/**
 * A tool call's details as the desktop opens them: the diff for an edit, the
 * command for a shell, the path, the subagent's prompt, or the raw input; then
 * the result.
 */
export function toolDetailText(tool: Extract<ChatItem, { kind: 'tool' }>): string {
  const input = tool.input
  const pairs = editPairs(tool.name, input)
  const parts: string[] = []
  if (pairs) {
    if (typeof input.file_path === 'string') parts.push(input.file_path)
    for (const pair of pairs) parts.push(diffLines(pair.before, pair.after).map((line) => line.text).join('\n'))
  } else if ((tool.name === 'Bash' || tool.name === 'PowerShell') && typeof input.command === 'string') {
    parts.push(`$ ${input.command}`)
  } else if (typeof input.file_path === 'string' && Object.keys(input).length <= 3) {
    parts.push(input.file_path)
  } else if ((tool.name === 'Agent' || tool.name === 'Task') && typeof input.prompt === 'string') {
    parts.push(input.prompt)
  } else if (Object.keys(input).length > 0) {
    parts.push(JSON.stringify(input, null, 2))
  }
  if (tool.result && !(pairs && tool.status === 'done')) parts.push(tool.result)
  return parts.join('\n')
}

/**
 * An item's searchable text: what it shows closed, then (`detail`) what opening
 * it adds. `anchor` overrides where it shows (a live turn's work shows on its card).
 */
export function itemSegments(item: ChatItem, markdown: MarkdownText = plain, anchor?: string): ChatSearchSegment[] {
  const at = anchor !== undefined && anchor !== item.id ? { anchor, item: item.id } : { anchor: item.id }
  const seg = (text: string, detail = false): ChatSearchSegment[] => text ? [{ ...at, ...(detail ? { detail } : {}), text }] : []
  switch (item.kind) {
    case 'user':
    case 'notice':
      return seg(item.text)
    case 'text':
    case 'thinking':
      return item.text.trim() ? seg(markdown(item.text)) : []
    case 'tool':
      if (item.name === 'TodoWrite') return seg(todoLines(item.input).join('\n'))
      return [...seg(item.label), ...seg(toolDetailText(item), true)]
    case 'bash': {
      const parts = [
        item.command.includes('\n') ? `$ ${item.command}` : '',
        item.stdout ?? '',
        item.stderr ?? ''
      ].filter(Boolean)
      return [...seg(`! ${firstLine(item.command, 200) ?? ''}`), ...seg(parts.join('\n'), true)]
    }
  }
}

/** Every item's segments, in thread order: the phone's view, and the plain timeline. */
export function chatSearchSegments(items: readonly ChatItem[], markdown: MarkdownText = plain): ChatSearchSegment[] {
  return items.flatMap((item) => itemSegments(item, markdown))
}

/** How many times `query` occurs in each item, in thread order: the phone's search. */
export function searchChatItems(items: readonly ChatItem[], query: string): Array<{ itemId: string; count: number }> {
  const counts = new Map<string, number>()
  for (const match of findInSegments(chatSearchSegments(items), query)) counts.set(match.item, (counts.get(match.item) ?? 0) + 1)
  return [...counts].map(([itemId, count]) => ({ itemId, count }))
}
