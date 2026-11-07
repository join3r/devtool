import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import type { GitDiffSummary, GitGraphCommit, TabStatusValue, Task } from '../../../shared/types'
import type { AgentActivity } from '../../../shared/agent-activity'
import type { ArchivedTask } from '../../../shared/archive'
import { lastActivityAt, statusTabs, taskStatus } from '../../../shared/inbox-state'
import { useAllAgentActivity } from '../../agentActivity'
import { taskActivity } from '../inbox'
import { formatRelativeTime } from '../projectStats'
import { formatLineCount } from '../../hooks/useTaskDiffSummaries'
import { taskAgentLabel } from '../taskHeaderState'
import { menuCls } from '../ui'

/** How long (ms) the pointer rests on a row of the graph before its card opens. */
const OPEN_DELAY = 250
/** Within this long (ms) of one card closing the next opens at once, so moving down the graph reads each. */
const WARM = 400
let lastClosedAt = 0

export interface HoverAnchorProps<E extends HTMLElement> {
  onMouseEnter: (e: React.MouseEvent<E>) => void
  onMouseLeave: () => void
  onMouseDown: () => void
  onFocus: (e: React.FocusEvent<E>) => void
  onBlur: () => void
}

/**
 * Hover cards for the rows of the project graph. `anchor(target)` goes on the element
 * that shows `target`; `shown` is the target and where it sits while its card
 * is open. A card opens after a short rest (at once when another just
 * closed, or on keyboard focus) and closes on leave, click or any scroll.
 */
export function useHoverCard<T, E extends HTMLElement = HTMLElement>(): {
  shown: { target: T; rect: DOMRect } | null
  anchor: (target: T) => HoverAnchorProps<E>
  close: () => void
} {
  const [shown, setShown] = useState<{ target: T; rect: DOMRect } | null>(null)
  const timer = useRef(0)
  const open = useRef(false)
  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    if (!open.current) return
    open.current = false
    lastClosedAt = Date.now()
    setShown(null)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (!shown) return
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [shown, close])
  const show = (target: T, el: E, now: boolean) => {
    window.clearTimeout(timer.current)
    const place = () => { open.current = true; setShown({ target, rect: el.getBoundingClientRect() }) }
    if (now || Date.now() - lastClosedAt < WARM) place()
    else timer.current = window.setTimeout(place, OPEN_DELAY)
  }
  const anchor = (target: T): HoverAnchorProps<E> => ({
    onMouseEnter: (e) => show(target, e.currentTarget, false),
    onMouseLeave: close,
    onMouseDown: close,
    // Only keyboard focus: a click focuses a button too, and it is on its way elsewhere.
    onFocus: (e) => { if (e.currentTarget.matches(':focus-visible')) show(target, e.currentTarget, true) },
    onBlur: close
  })
  return { shown, anchor, close }
}

const CARD_W = 300
const MARGIN = 8

/**
 * The card itself: on the page's top layer (nothing scrolling clips it), under
 * the thing it is about, or over it when there is no room below.
 */
export function HoverCard({ rect, children, testId }: { rect: DOMRect; children: React.ReactNode; testId?: string }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Placed again when its content grows or shrinks (the agent moved on while it is open).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const h = el.offsetHeight
      const fitsBelow = rect.bottom + MARGIN + h <= window.innerHeight - MARGIN
      const top = fitsBelow || rect.top - MARGIN - h < MARGIN ? rect.bottom + MARGIN : rect.top - MARGIN - h
      const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - CARD_W - MARGIN))
      setPos(p => p && p.left === left && p.top === top ? p : { left, top })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [rect])
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={`fixed z-(--z-menu) pointer-events-none flex flex-col gap-2 px-3 py-2.5 text-xs text-text ${menuCls}`}
      style={{ width: CARD_W, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body
  )
}

/** One fact on a card: a quiet label, then its value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-2 min-w-0">
      <span className="w-[76px] shrink-0 text-text-subtle">{label}</span>
      <span className="flex-1 min-w-0 text-text-muted break-words">{children}</span>
    </div>
  )
}

function Facts({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex flex-col gap-1 pt-2 border-t-[0.5px] border-hair">{children}</div>
}

function Quote({ children, lines = 5 }: { children: React.ReactNode; lines?: number }): React.ReactElement {
  return <p className="m-0 text-text-muted leading-[1.45] break-words" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' }}>{children}</p>
}

const ago = (at: number, now: number): string => formatRelativeTime(at, now)
const stamp = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The newest activity among the task's agent tabs: its last prompt and answer. */
function newestActivity(task: Task, activities: Record<string, AgentActivity>): AgentActivity | undefined {
  let best: AgentActivity | undefined
  for (const tab of statusTabs(task)) {
    const activity = activities[tab.id]
    if (activity && (!best || activity.updatedAt > best.updatedAt)) best = activity
  }
  return best
}

/**
 * An open task's card: how it stands and what its agent does or last said,
 * then where it works, its changes, where it came from and when it was last active.
 */
export function TaskHoverDetails({ task, status, statuses, diff, progress, now }: {
  task: Task
  /** The tip's status line and its tone's dot and text classes. */
  status: { label: string; dot: string; text: string }
  statuses: Record<string, TabStatusValue>
  diff: GitDiffSummary | undefined
  /** "2 of 3 done" for a task that started others. */
  progress: string | null
  now: number
}): React.ReactElement {
  const activities = useAllAgentActivity()
  const activity = newestActivity(task, activities)
  // What it does now, or what it waits on you for; between turns the answer below says it.
  const live = taskStatus(task, statuses)
  const doing = live === 'working' || live === 'attention' ? taskActivity(task, statuses, activities).line : undefined
  const answer = activity?.lastAnswer ?? task.inbox?.preview ?? activity?.lastMessage
  const active = lastActivityAt(task)
  return (
    <>
      <span className="flex items-center gap-1.5">
        <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${status.dot}`} />
        <span className={`text-2xs ${status.text}`}>{status.label}</span>
      </span>
      <span className="text-sm font-medium leading-snug break-words">{task.name}</span>
      {doing && <span className="text-text-muted break-words">{doing}</span>}
      {task.queued && <Quote lines={3}>Queued: {task.queued.prompt}</Quote>}
      {activity?.lastPrompt && <Quote lines={2}><span className="text-text-subtle">You: </span>{activity.lastPrompt}</Quote>}
      {answer && <Quote>{answer}</Quote>}
      <Facts>
        <Fact label="Works in">
          {task.workspace ? <><span className="font-mono">⎇ {task.workspace.branchName}</span> · own worktree</> : 'the stream’s folder'}
        </Fact>
        {diff && (diff.added > 0 || diff.deleted > 0) && (
          <Fact label="Changes">
            <span className="font-mono"><span className="text-running">+{formatLineCount(diff.added)}</span> <span className="text-crashed">−{formatLineCount(diff.deleted)}</span></span>
            {diff.files ? ` · ${diff.files} ${diff.files === 1 ? 'file' : 'files'}` : ''}
          </Fact>
        )}
        {progress && <Fact label="Its tasks">{progress}</Fact>}
        {task.delegatedFrom && <Fact label="Started by">{task.delegatedFrom.name}</Fact>}
        {task.forkedFrom && <Fact label="Forked from">{task.forkedFrom.name}</Fact>}
        {task.scheduledFrom && <Fact label="Schedule">{task.scheduledFrom.name}</Fact>}
        {active > 0 && <Fact label="Last active">{ago(active, now)}</Fact>}
      </Facts>
    </>
  )
}

/** The commit's subject (unless the card already says it), hash, author and time. */
function CommitFacts({ commit, subject, now }: { commit: GitGraphCommit; subject: boolean; now: number }): React.ReactElement {
  const at = new Date(commit.isoDate).getTime()
  return (
    <Facts>
      {subject && <Fact label="Commit">{commit.subject}</Fact>}
      <Fact label={subject ? 'Hash' : 'Commit'}><span className="font-mono">{commit.hash.slice(0, 7)}</span></Fact>
      <Fact label="Author">{commit.author}</Fact>
      <Fact label="When">{Number.isFinite(at) ? `${ago(at, now)} · ${stamp(commit.isoDate)}` : commit.isoDate}</Fact>
    </Facts>
  )
}

/**
 * A done task's card: when it closed, what its agent last said, and the
 * commit it landed (or that it has none on the graph).
 */
export function DoneHoverDetails({ name, entry, commit, now }: {
  name: string
  entry: ArchivedTask | undefined
  /** The commit it landed; none when it closed without one on the graph. */
  commit: GitGraphCommit | undefined
  now: number
}): React.ReactElement {
  const agent = entry ? taskAgentLabel(entry.task) : null
  const preview = entry?.task.inbox?.preview
  const landings = entry?.task.landedCommits?.length ?? 0
  return (
    <>
      <span className="flex items-center gap-1.5 text-2xs text-running">
        <Check size={11} strokeWidth={3} className="shrink-0" />
        Done{entry && entry.archivedAt > 0 ? <span className="text-text-muted"> · closed {ago(entry.archivedAt, now)}</span> : null}
      </span>
      <span className="text-sm font-medium leading-snug break-words">{name}</span>
      {preview && <Quote>{preview}</Quote>}
      {commit
        ? <CommitFacts commit={commit} subject={commit.subject.trim() !== name.trim()} now={now} />
        : <Facts><Fact label="Commit">None on these branches</Fact></Facts>}
      {(agent || landings > 1) && (
        <div className="flex flex-col gap-1">
          {agent && <Fact label="Agent">{agent}</Fact>}
          {landings > 1 && <Fact label="Landed">{landings} times</Fact>}
        </div>
      )}
    </>
  )
}

/** A commit's card: which branches end there, its subject, hash, author and time. */
export function CommitHoverDetails({ commit, heads, now }: {
  commit: GitGraphCommit
  /** The streams and branches that end at it. */
  heads: string[]
  now: number
}): React.ReactElement {
  const kind = heads.length > 0
    ? `Newest commit on ${heads.join(', ')}`
    : commit.parents.length > 1 ? 'Merge' : null
  return (
    <>
      {kind && <span className="text-2xs text-text-muted">{kind}</span>}
      <span className="text-sm font-medium leading-snug break-words">{commit.subject}</span>
      <CommitFacts commit={commit} subject={false} now={now} />
    </>
  )
}
