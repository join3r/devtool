/**
 * The desk column's lists (2026-10-30 redesign): the inbox partition
 * (`partitionInbox`) regrouped into mail-style tabs. Pure, so the rules can be tested without a
 * renderer.
 *
 *  - Inbox: Needs you (a question, a permission, a landing that stopped, an
 *    Autopilot run handed back) ·
 *    Answered (the agent finished and you haven't replied) · Waiting on you
 *    (idle: you had the last word, or nothing ran yet).
 *  - Working: agents running, a landing being fixed by its agent and an
 *    Autopilot run between turns (Codex reviewing, landing) included, and
 *    Background: the turn ended but work it started still runs.
 *  - Snoozed: put away until they wake; a live agent still wins over snooze.
 *  - Done: archived tasks, read separately (see `doneEntries`).
 */
import type { DeskScope, DeskTab, Project, Stream, Task } from '../../../shared/types'
import { backgroundWork, type AgentActivity, type BackgroundWork } from '../../../shared/agent-activity'
import { statusTabs } from '../../../shared/inbox-state'
import type { ArchivedTask, ProjectArchive } from '../../../shared/archive'
import { autopilotNeedsYou } from '../../../shared/autopilot'
import { lastUsedStream } from '../../../shared/streams'
import { groupInboxByProject, landingNeedsYou, type InboxEntry, type InboxPartition, type InboxSource } from '../inbox'
import type { DelegationTree } from '../../../shared/delegation'
import type { DeskRowKind } from './DeskRow'

/** A row's name being edited in place (the row menu's Rename): the value typed so far and what Enter, blur and Escape do. */
export interface InboxRename {
  taskId: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

export interface DeskLists {
  needsYou: InboxEntry[]
  answered: InboxEntry[]
  waiting: InboxEntry[]
  working: InboxEntry[]
  snoozed: InboxEntry[]
}

/** Only the tasks inside `scope` (all of them when it is null). */
export function scopeSources(sources: readonly InboxSource[], scope: DeskScope | null | undefined): InboxSource[] {
  if (!scope) return [...sources]
  return sources.filter(({ project, stream }) =>
    project.id === scope.projectId && (!scope.streamId || stream.id === scope.streamId))
}

export function deskLists(partition: InboxPartition): DeskLists {
  const needsYou = [...partition.needsYou]
  const answered: InboxEntry[] = []
  const waiting: InboxEntry[] = []
  for (const entry of partition.ready) {
    if (landingNeedsYou(entry.task) || autopilotNeedsYou(entry.task)) needsYou.push(entry)
    else if (entry.yourTurn) answered.push(entry)
    else waiting.push(entry)
  }
  return { needsYou, answered, waiting, working: partition.working, snoozed: partition.snoozed }
}

/** The tab badges: Inbox counts unread rows only (like mail), Working counts rows; the rest show none. */
export function deskTabCounts(lists: DeskLists): Record<DeskTab, number | null> {
  const inboxRows = [...lists.needsYou, ...lists.answered, ...lists.waiting]
  return {
    inbox: inboxRows.filter(entry => entry.unread || entry.status === 'attention').length,
    working: lists.working.length,
    snoozed: lists.snoozed.length,
    done: null
  }
}

/** The rows a tab lists, in order (Done has its own source). */
export function deskTabEntries(lists: DeskLists, tab: DeskTab): InboxEntry[] {
  switch (tab) {
    case 'inbox': return [...lists.needsYou, ...lists.answered, ...lists.waiting]
    case 'working': return lists.working
    case 'snoozed': return lists.snoozed
    case 'done': return []
  }
}

/** A task in the Background state: which tab holds the work, and what runs. */
export interface TaskBackground extends BackgroundWork {
  tabId: string
}

/**
 * The task's Background state (redesign decision 6), or null when it is not in it:
 * some tab has work running past its turn, and no tab has a turn in flight or is
 * waiting on you (that is plain Working, or Needs you).
 */
export function taskBackground(task: Task, activities: Readonly<Record<string, AgentActivity>>): TaskBackground | null {
  let found: TaskBackground | null = null
  for (const tab of statusTabs(task)) {
    const activity = activities[tab.id]
    if (!activity) continue
    if (activity.turnStartedAt !== undefined || activity.waiting) return null
    const work = backgroundWork(activity)
    if (work && (!found || work.since < found.since)) found = { ...work, tabId: tab.id }
  }
  return found
}

export interface DoneEntry {
  project: Project
  entry: ArchivedTask
}

export const DONE_WINDOW_MS = 30 * 24 * 60 * 60_000

/**
 * Archived tasks of `projects`, newest first. Tasks closed on their own and the
 * tasks of closed streams both count. `since` cuts the list (the last 30 days,
 * until "Show older"); null keeps everything.
 */
export function doneEntries(
  projects: readonly Project[],
  archives: ReadonlyMap<string, ProjectArchive>,
  scope: DeskScope | null | undefined,
  since: number | null
): DoneEntry[] {
  const out: DoneEntry[] = []
  for (const project of projects) {
    if (scope && project.id !== scope.projectId) continue
    const archive = archives.get(project.id)
    if (!archive) continue
    const liveTaskIds = new Set(project.streams.flatMap(stream => stream.tasks.map(task => task.id)))
    const push = (entry: ArchivedTask): void => {
      if (liveTaskIds.has(entry.task.id)) return
      if (scope?.streamId && entry.streamId !== scope.streamId) return
      if (since !== null && entry.archivedAt < since) return
      out.push({ project, entry })
    }
    archive.tasks.forEach(push)
    for (const closed of archive.streams) {
      closed.doneTasks.forEach(push)
      for (const task of closed.stream.tasks) {
        push({ task, streamId: closed.stream.id, streamName: closed.stream.name, dir: closed.dir, archivedAt: closed.archivedAt })
      }
    }
  }
  return out.sort((a, b) => b.entry.archivedAt - a.entry.archivedAt)
}

/**
 * The scope as the column applies it: a project that is gone (deleted, or a
 * server's not loaded) reads as All, a stream that is gone (closed) as its
 * project. The stored scope stays, so it comes back with its project.
 */
export function liveScope(projects: readonly Project[], scope: DeskScope | null | undefined): DeskScope | null {
  if (!scope) return null
  const project = projects.find(p => p.id === scope.projectId)
  if (!project) return null
  if (!scope.streamId || project.streams.some(s => s.id === scope.streamId)) return scope
  return { projectId: project.id }
}

/** What the scope menu and compose chip say: "All projects", "devtool", "devtool › 0.7.0". */
export function scopeLabel(projects: readonly Project[], scope: DeskScope | null | undefined): string {
  if (!scope) return 'All projects'
  const project = projects.find(p => p.id === scope.projectId)
  if (!project) return 'All projects'
  const stream = scope.streamId ? project.streams.find(s => s.id === scope.streamId) : undefined
  return stream && !stream.isMain ? `${project.name} › ${stream.name}` : project.name
}

/**
 * Where compose sends a task by default: the scope's stream, else the stream
 * last fired into when it is in the scope's project (or there is no scope),
 * else that project's main stream.
 */
export function composeTarget(
  projects: readonly Project[],
  scope: DeskScope | null | undefined,
  last: DeskScope | null | undefined
): { project: Project; stream: Stream | undefined } | null {
  const pick = (id: string | null | undefined): Project | undefined => (id ? projects.find(p => p.id === id) : undefined)
  const project = pick(scope?.projectId) ?? pick(last?.projectId) ?? projects[0]
  if (!project) return null
  const find = (id: string | undefined): Stream | undefined => (id ? project.streams.find(s => s.id === id) : undefined)
  if (scope?.projectId === project.id && scope.streamId) return { project, stream: find(scope.streamId) }
  // The stream last fired into, else the one the project was last left in.
  if (last?.projectId === project.id) return { project, stream: find(last.streamId) }
  return { project, stream: lastUsedStream(project) }
}

export type RowKey = 'e' | 's' | 'w' | 'u'

/**
 * The row action a ⌘ chord asks for: ⌘E done, ⌘⇧S snooze, ⌘⇧W wake, ⌘⇧U unread
 * (Ctrl on Windows/Linux). These work from the composer too, where the bare letters type.
 */
export function rowChord(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): RowKey | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (!e.shiftKey) return key === 'e' ? 'e' : null
  return key === 's' || key === 'w' || key === 'u' ? key : null
}

/** The task a row key acts on: the hovered row, else the selected one, when either is listed. */
export function keyTarget(entries: readonly InboxEntry[], hoveredTaskId: string | null, selectedTaskId: string | null): InboxEntry | null {
  const find = (id: string | null): InboxEntry | undefined => (id ? entries.find(entry => entry.task.id === id) : undefined)
  return find(hoveredTaskId) ?? find(selectedTaskId) ?? null
}


/** Pinned tasks first, the rest in their order: the board's "pins on top", inside each group. */
export function pinnedFirst(entries: readonly InboxEntry[], pinnedTaskIds: ReadonlySet<string>): InboxEntry[] {
  if (pinnedTaskIds.size === 0) return [...entries]
  return [...entries.filter(entry => pinnedTaskIds.has(entry.task.id)), ...entries.filter(entry => !pinnedTaskIds.has(entry.task.id))]
}

/**
 * Working tasks that are pinned: the Inbox tab keeps them (under Needs you) so a
 * task you are talking with does not leave the list each time its agent runs.
 */
export function pinnedWorking(lists: DeskLists, pinnedTaskIds: ReadonlySet<string>): InboxEntry[] {
  if (pinnedTaskIds.size === 0) return []
  return lists.working.filter(entry => pinnedTaskIds.has(entry.task.id))
}

/**
 * The rows in the order the column draws them, for ⌥↓ / ⌥↑: grouped by project
 * (pinned projects first) the list reads project by project, not status by status.
 */
export function shownRows(entries: readonly InboxEntry[], grouped: boolean, pinnedProjectIds: readonly string[]): InboxEntry[] {
  return grouped ? groupInboxByProject(entries, pinnedProjectIds).flatMap(group => group.entries) : [...entries]
}

/** ⌥↓ / ⌥↑: the row after (or before) the selected one, else the first (or last) row. */
export function stepRow(entries: readonly InboxEntry[], selectedTaskId: string | null, step: 1 | -1): InboxEntry | null {
  if (entries.length === 0) return null
  const index = selectedTaskId ? entries.findIndex(entry => entry.task.id === selectedTaskId) : -1
  if (index < 0) return step === 1 ? entries[0] : entries[entries.length - 1]
  return entries[index + step] ?? null
}

/** ⌘J: the next task that needs you after the selected one, wrapping round; null when none does. */
export function nextNeedsYou(needsYou: readonly InboxEntry[], selectedTaskId: string | null): InboxEntry | null {
  if (needsYou.length === 0) return null
  const index = selectedTaskId ? needsYou.findIndex(entry => entry.task.id === selectedTaskId) : -1
  return needsYou[(index + 1) % needsYou.length]
}

/**
 * A click on a row with the list's multi-select keys: ⌘-click toggles the row,
 * ⇧-click checks every row from `anchor` to it (in drawn order) on top of what
 * is checked. `anchor` falls back to the selected task, so ⇧-click right after
 * opening a task takes it along.
 */
export function checkRows(
  rows: readonly InboxEntry[],
  checked: ReadonlySet<string>,
  taskId: string,
  how: 'toggle' | 'range',
  anchor: string | null
): Set<string> {
  const next = new Set(checked)
  if (how === 'range' && anchor) {
    const from = rows.findIndex(entry => entry.task.id === anchor)
    const to = rows.findIndex(entry => entry.task.id === taskId)
    if (from >= 0 && to >= 0) {
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(rows[i].task.id)
      return next
    }
  }
  if (next.has(taskId)) next.delete(taskId)
  else next.add(taskId)
  return next
}

/** The checked rows still listed, in drawn order: a row that moved tab or went away drops out. */
export function checkedRows(rows: readonly InboxEntry[], checked: ReadonlySet<string>): InboxEntry[] {
  return checked.size === 0 ? [] : rows.filter(entry => checked.has(entry.task.id))
}

// ---- tasks started by other tasks --------------------------------------------------

/** A task listed under the task that started it, with the list it would sit in on its own. */
export interface NestedChild {
  entry: InboxEntry
  kind: DeskRowKind
}

export interface DeskNesting {
  /** The lists with only top-level rows left: a started task goes under its parent when that is listed. */
  lists: DeskLists
  /** Each listed parent's children, in the order they were started. */
  children: ReadonlyMap<string, readonly NestedChild[]>
  /** A row in Needs you only because a task under it needs you: that task. */
  bubbled: ReadonlyMap<string, InboxEntry>
}

const LIST_KINDS: ReadonlyArray<[keyof DeskLists, DeskRowKind]> = [
  ['needsYou', 'needsYou'], ['answered', 'answered'], ['waiting', 'waiting'], ['working', 'working'], ['snoozed', 'snoozed']
]

/**
 * Started tasks (`Task.delegatedFrom`) leave the lists and go under the task
 * that started them, as t3code's child threads live in their parent's row.
 * A task whose parent isn't listed (closed, or outside the scope) stays a row
 * of its own, so nothing is lost. A row whose task needs nothing but has a
 * task under it that does moves to Needs you, so that question is never
 * buried under a quiet parent. A pinned task (`topLevel`) keeps its own row,
 * so it stays in the Inbox while it works however busy its parent is.
 */
export function nestDeskLists(
  lists: DeskLists,
  tree: DelegationTree,
  /** Tasks that keep a row of their own (pinned ones), even with their parent listed. */
  topLevel: ReadonlySet<string> = new Set()
): DeskNesting {
  const kindOf = new Map<string, DeskRowKind>()
  const byId = new Map<string, InboxEntry>()
  for (const [list, kind] of LIST_KINDS) {
    for (const entry of lists[list]) {
      kindOf.set(entry.task.id, kind)
      byId.set(entry.task.id, entry)
    }
  }
  const children = new Map<string, NestedChild[]>()
  const nested = new Set<string>()
  for (const [parentId, childIds] of tree.childrenOf) {
    if (!byId.has(parentId)) continue
    const rows: NestedChild[] = []
    for (const childId of childIds) {
      const entry = byId.get(childId)
      if (!entry || topLevel.has(childId)) continue
      rows.push({ entry, kind: kindOf.get(childId)! })
      nested.add(childId)
    }
    if (rows.length > 0) children.set(parentId, rows)
  }

  const bubbled = new Map<string, InboxEntry>()
  const needing = (taskId: string, seen: Set<string>): InboxEntry | null => {
    for (const child of children.get(taskId) ?? []) {
      if (seen.has(child.entry.task.id)) continue
      seen.add(child.entry.task.id)
      if (child.kind === 'needsYou') return child.entry
      const deeper = needing(child.entry.task.id, seen)
      if (deeper) return deeper
    }
    return null
  }
  const roots = (list: readonly InboxEntry[]): InboxEntry[] => list.filter(entry => !nested.has(entry.task.id))
  const out: DeskLists = {
    needsYou: roots(lists.needsYou),
    answered: [],
    waiting: [],
    working: [],
    snoozed: []
  }
  for (const [list] of LIST_KINDS.slice(1)) {
    for (const entry of roots(lists[list])) {
      const child = needing(entry.task.id, new Set([entry.task.id]))
      if (child) {
        bubbled.set(entry.task.id, child)
        out.needsYou.push(entry)
      } else out[list].push(entry)
    }
  }
  return { lists: out, children, bubbled }
}

/** Every task under `taskId` in the nesting, depth first. */
export function nestedUnder(nesting: Pick<DeskNesting, 'children'>, taskId: string): NestedChild[] {
  const out: NestedChild[] = []
  const seen = new Set<string>([taskId])
  const walk = (id: string): void => {
    for (const child of nesting.children.get(id) ?? []) {
      if (seen.has(child.entry.task.id)) continue
      seen.add(child.entry.task.id)
      out.push(child)
      walk(child.entry.task.id)
    }
  }
  walk(taskId)
  return out
}

/** A row as the column draws it: a top-level row (no `kind`: its list says) or a child, `depth` levels in. */
export interface DrawnRow {
  entry: InboxEntry
  depth: number
  kind?: DeskRowKind
}

/** The rows with each expanded parent's children after it, in drawn order (for the row keys and ⌘1–9). */
export function withChildren(
  rows: readonly InboxEntry[],
  nesting: Pick<DeskNesting, 'children'>,
  expanded: (taskId: string) => boolean
): DrawnRow[] {
  const out: DrawnRow[] = []
  const seen = new Set<string>()
  const add = (entry: InboxEntry, depth: number, kind?: DeskRowKind): void => {
    if (seen.has(entry.task.id)) return
    seen.add(entry.task.id)
    out.push(kind ? { entry, depth, kind } : { entry, depth })
    if (!expanded(entry.task.id)) return
    for (const child of nesting.children.get(entry.task.id) ?? []) add(child.entry, depth + 1, child.kind)
  }
  for (const entry of rows) add(entry, 0)
  return out
}

/**
 * Whether a parent's children show: as toggled, else open while one of them
 * needs you or is the open task, so opening a child never hides it.
 */
export function childrenExpanded(
  taskId: string,
  nesting: Pick<DeskNesting, 'children'>,
  toggled: ReadonlyMap<string, boolean>,
  selectedTaskId: string | null
): boolean {
  const choice = toggled.get(taskId)
  if (choice !== undefined) return choice
  return nestedUnder(nesting, taskId).some(child => child.kind === 'needsYou' || child.entry.task.id === selectedTaskId)
}

/** A task a row's agent started that is not drawn under it: closed (in the archive), or open but listed elsewhere. */
export type StartedElsewhere =
  | { kind: 'open'; project: Project; task: Task }
  | { kind: 'closed'; done: DoneEntry }

/**
 * The tasks `task` started that its expanded row can't show as rows of their
 * own: closed ones (from the loaded archives), and open ones in another
 * project or pinned to a row of their own. In the order they were started.
 */
export function startedElsewhere(
  task: Task,
  nesting: Pick<DeskNesting, 'children'>,
  projects: readonly Project[],
  archives: ReadonlyMap<string, ProjectArchive>
): StartedElsewhere[] {
  const ids = (task.startedTaskIds ?? []).filter(id => id !== task.id)
  if (ids.length === 0) return []
  const drawn = new Set(nestedUnder(nesting, task.id).map(child => child.entry.task.id))
  const open = new Map<string, { project: Project; task: Task }>()
  for (const project of projects) {
    for (const stream of project.streams) for (const candidate of stream.tasks) open.set(candidate.id, { project, task: candidate })
  }
  let closed: Map<string, DoneEntry> | null = null
  const out: StartedElsewhere[] = []
  for (const id of new Set(ids)) {
    if (drawn.has(id)) continue
    const live = open.get(id)
    if (live) {
      out.push({ kind: 'open', ...live })
      continue
    }
    closed = closed ?? new Map(doneEntries(projects, archives, null, null).map(done => [done.entry.task.id, done]))
    const done = closed.get(id)
    if (done) out.push({ kind: 'closed', done })
  }
  return out
}
