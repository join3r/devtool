import type { ChatItem } from '../../../shared/claude-chat'
import { itemSegments, matchRanges, type ChatSearchSegment, type MarkdownText } from '../../../shared/chat-search'
import { buildConversation, foldedLine } from './turns'

/**
 * Find in the desk chat: the thread's segments in the order the desk draws
 * them (src/shared/chat-search.ts does the matching), and the DOM side that
 * marks the matches the timeline has drawn.
 *
 * Anchors are `data-chat-item` values: an item's id, `fold:<turn>` for a
 * finished turn's folded line, and `card:<turn>` for the live turn's card,
 * which is where the work of a turn still running shows.
 */

/** The desk layout's segments: per turn your message, the folded line, the work, the answer. */
export function conversationSegments(items: ChatItem[], busy: boolean, background: boolean, markdown?: MarkdownText): ChatSearchSegment[] {
  const segments: ChatSearchSegment[] = []
  for (const block of buildConversation(items, busy, background)) {
    if (block.type === 'bash') {
      segments.push(...itemSegments(block.item, markdown))
      continue
    }
    const { turn } = block
    if (turn.user) segments.push(...itemSegments(turn.user, markdown))
    if (turn.live) {
      for (const item of turn.work) segments.push(...itemSegments(item, markdown, `card:${block.key}`))
    } else if (turn.work.length > 0) {
      segments.push({ anchor: `fold:${block.key}`, text: foldedLine(turn) })
      for (const item of turn.work) segments.push(...itemSegments(item, markdown))
    }
    for (const item of turn.answer) segments.push(...itemSegments(item, markdown))
    for (const item of turn.tail) segments.push(...itemSegments(item, markdown))
  }
  return segments
}

/** Elements whose text is a new line of its own: no match runs across one's edge. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'PRE', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'BUTTON',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'BR', 'SECTION', 'DETAILS', 'SUMMARY'
])

/** Chrome around the text that the search leaves out: counts, statuses, code-block buttons. */
const SKIP_SELECTOR = '[data-find-skip], .chat-code-actions'

export interface CollectedText {
  text: string
  /** Each text node and where its text starts in `text`. */
  nodes: Array<{ node: Text; start: number }>
}

function blockOf(node: Node, root: Node): Node {
  for (let el = node.parentNode; el && el !== root; el = el.parentNode) {
    if (el.nodeType === 1 && BLOCK_TAGS.has((el as Element).tagName)) return el
  }
  return root
}

/** The text under `root` as it reads, with a line break between blocks. */
export function collectText(root: Node): CollectedText {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, 0x5 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (node) => node.nodeType === 1 && (node as Element).matches(SKIP_SELECTOR) ? 2 /* REJECT */ : 1 /* ACCEPT */
  })
  let text = ''
  const nodes: CollectedText['nodes'] = []
  let lastBlock: Node | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== 3) continue
    const value = node.nodeValue ?? ''
    if (!value) continue
    const block = blockOf(node, root)
    if (lastBlock && block !== lastBlock && !text.endsWith('\n')) text += '\n'
    lastBlock = block
    nodes.push({ node: node as Text, start: text.length })
    text += value
  }
  return { text, nodes }
}

const MARKDOWN_CACHE_LIMIT = 4000
const markdownCache = new Map<string, string>()

/**
 * A message's Markdown as the text the chat shows for it, so the count matches
 * what is on screen. Parsed into an inert document: nothing in it loads.
 */
export function markdownTextWith(render: (markdown: string) => string): MarkdownText {
  return (markdown) => {
    const cached = markdownCache.get(markdown)
    if (cached !== undefined) return cached
    const doc = new DOMParser().parseFromString(render(markdown), 'text/html')
    const text = collectText(doc.body).text
    if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value as string)
    markdownCache.set(markdown, text)
    return text
  }
}

function rangeAt(nodes: CollectedText['nodes'], start: number, end: number): Range | null {
  let from: { node: Text; offset: number } | null = null
  let to: { node: Text; offset: number } | null = null
  for (const { node, start: at } of nodes) {
    const length = node.nodeValue?.length ?? 0
    if (!from && start < at + length) from = { node, offset: Math.max(0, start - at) }
    if (end <= at + length) { to = { node, offset: Math.max(0, end - at) }; break }
  }
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

/** The anchors drawn under `container`, and the matches in each, in order. */
export function drawnMatches(container: Element, pattern: RegExp): { elements: Map<string, Element>; ranges: Map<string, Range[]> } {
  const elements = new Map<string, Element>()
  const ranges = new Map<string, Range[]>()
  for (const el of container.querySelectorAll('[data-chat-item]')) {
    const anchor = el.getAttribute('data-chat-item')
    if (!anchor || elements.has(anchor)) continue
    elements.set(anchor, el)
    const collected = collectText(el)
    const found: Range[] = []
    for (const [start, end] of matchRanges(collected.text, pattern)) {
      const range = rangeAt(collected.nodes, start, end)
      if (range) found.push(range)
    }
    if (found.length > 0) ranges.set(anchor, found)
  }
  return { elements, ranges }
}

/**
 * The marks, through the CSS Custom Highlight API (no DOM changes, so the
 * timeline's own rendering is untouched). One registry for the window: each
 * chat tab with an open find bar adds its own.
 */
const marks = new Map<string, { all: Range[]; current: Range | null }>()

function paint(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return
  const all: Range[] = []
  const current: Range[] = []
  for (const mark of marks.values()) {
    for (const range of mark.all) if (range !== mark.current) all.push(range)
    if (mark.current) current.push(mark.current)
  }
  if (all.length > 0) CSS.highlights.set('chat-find', new Highlight(...all))
  else CSS.highlights.delete('chat-find')
  if (current.length > 0) CSS.highlights.set('chat-find-current', new Highlight(...current))
  else CSS.highlights.delete('chat-find-current')
}

export function setFindMarks(tabId: string, all: Range[], current: Range | null): void {
  if (all.length === 0 && !current) marks.delete(tabId)
  else marks.set(tabId, { all, current })
  paint()
}

export function clearFindMarks(tabId: string): void {
  if (!marks.delete(tabId)) return
  paint()
}

/** Scrolls `scroller` so `rect` sits in its middle third; left alone when it is already well in view. */
export function scrollIntoMiddle(scroller: HTMLElement, rect: DOMRect): void {
  const view = scroller.getBoundingClientRect()
  const top = rect.top - view.top
  const margin = view.height / 4
  if (top >= margin && top + rect.height <= view.height - margin) return
  scroller.scrollTop += top - (view.height - rect.height) / 2
}
