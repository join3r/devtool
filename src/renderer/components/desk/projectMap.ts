/**
 * Pure logic behind the desk's Project map: the project's branches on one
 * graph, newest first. Streams are branches in their own colour; each open
 * task is an unfinished node at the tip of its branch (its own, or its
 * stream's when it has none). Runs of plain commits fold into one line, and
 * with done tasks shown each sits on the commit it landed (or at the time it
 * closed, when it landed none), with closed and deleted streams beside them.
 * Everything comes from one `GitBranchGraph` of the project's branches
 * (`git-branch-graph.ts`), so the graph only knows the commits that loaded.
 */
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task } from '../../../shared/types'
import type { ArchivedTask, ProjectArchive } from '../../../shared/archive'
import { layoutGraph, type GraphSegment } from '../gitGraphLayout'

/** Runs of at least this many plain commits fold into one "⋯ N commits" row. */
export const FOLD_MIN = 3

/** Rows shown past the oldest one a stream or task still branches from, before "Show older". */
export const FOCUS_CONTEXT = 2
/** The fewest rows the graph shows by default. */
export const FOCUS_MIN = 8

export type GraphItem =
  /** An open task: an unfinished node at the tip of its branch. `nested` under the task that started it. */
  | { kind: 'task'; key: string; task: Task; streamId: string; nested: boolean }
  /**
   * A commit, with the streams whose branch ends there, other branches git
   * knows that end there, and (with done tasks shown) the done tasks that landed it.
   */
  | { kind: 'commit'; key: string; commit: GitGraphCommit; heads: string[]; branches: string[]; done: ArchivedTask[] }
  /** A run of plain commits, folded. Its key opens it. */
  | { kind: 'fold'; key: string; commits: GitGraphCommit[] }
  /** With done tasks shown: one that landed no commit on the graph, at the time it closed. */
  | { kind: 'done'; key: string; entry: ArchivedTask }
  /** With done tasks shown: a stream that closed or was deleted, at the time it went. */
  | { kind: 'stream'; key: string; name: string; what: 'closed' | 'deleted'; at: number }

export interface GraphRow {
  item: GraphItem
  /** The node's column; null for a row that only passes lines through. */
  column: number | null
  segments: GraphSegment[]
  /** Columns drawn dotted: where a fold's commits are. */
  dotted: number[]
  merge: boolean
}

export interface ProjectGraph {
  rows: GraphRow[]
  /** Columns the widest drawn row uses. */
  width: number
  /** The stream each commit and task node belongs to, by hash: its colour. Others are nobody's. */
  owner: ReadonlyMap<string, string>
  /**
   * The stream a line belongs to: its newer commit's along a first parent
   * (a branch's own line, a fork curving off), else its older one's (a branch
   * curving into the merge that took it in).
   */
  edgeOwner: (segment: GraphSegment) => string | undefined
  /** Rows past `rowLimit` (or past the focus, without one) were left out. */
  cut: boolean
}

/** Every commit reachable from `tip` within the loaded graph. Reports whether a parent fell outside it. */
function ancestors(byHash: ReadonlyMap<string, GitGraphCommit>, tip: string | undefined): { set: Set<string>; cut: boolean } {
  const set = new Set<string>()
  let cut = false
  const stack = tip ? [tip] : []
  while (stack.length > 0) {
    const hash = stack.pop() as string
    if (set.has(hash)) continue
    const commit = byHash.get(hash)
    if (!commit) { cut = true; continue }
    set.add(hash)
    stack.push(...commit.parents)
  }
  return { set, cut }
}

/** The first-parent chain from `tip`, newest first, while `keep` says so and the graph has it. */
function firstParentChain(byHash: ReadonlyMap<string, GitGraphCommit>, tip: string | undefined, keep: (hash: string) => boolean = () => true): { chain: GitGraphCommit[]; cut: boolean } {
  const chain: GitGraphCommit[] = []
  let hash = tip
  const seen = new Set<string>()
  while (hash && keep(hash) && !seen.has(hash)) {
    seen.add(hash)
    const commit = byHash.get(hash)
    if (!commit) return { chain, cut: true }
    chain.push(commit)
    hash = commit.parents[0]
  }
  return { chain, cut: false }
}

/**
 * The commit a stream's branch ends at: a worktree stream's own branch, the
 * main stream's the project folder's. Another project-folder stream has none
 * of its own (it shares main's checkout).
 */
export function streamTip(graph: GitBranchGraph | null, stream: Stream): string | undefined {
  if (!graph) return undefined
  if (stream.workspace) return graph.tips[stream.workspace.branchName]
  return stream.isMain && graph.head ? graph.tips[graph.head] : undefined
}

export interface AheadBehind {
  ahead: number
  behind: number
  /** The counts stopped at the end of the loaded graph, so they may be higher. */
  partial: boolean
}

/** A worktree stream's commits its base lacks, and its base's it lacks; null without both branches. */
export function streamAheadBehind(graph: GitBranchGraph | null, stream: Stream): AheadBehind | null {
  const base = stream.workspace?.baseBranch
  const tip = streamTip(graph, stream)
  const baseTip = base ? graph?.tips[base] : undefined
  if (!graph || !tip || !baseTip) return null
  const byHash = new Map(graph.commits.map(c => [c.hash, c]))
  const onBase = ancestors(byHash, baseTip)
  const own = firstParentChain(byHash, tip, hash => !onBase.set.has(hash))
  const mine = ancestors(byHash, tip)
  return {
    ahead: own.chain.length,
    behind: [...onBase.set].filter(hash => !mine.set.has(hash)).length,
    partial: own.cut || onBase.cut || mine.cut
  }
}

/** "3 ahead of master · 1 behind", "up to date with master", "12+ ahead of master". */
export function aheadBehindLine(counts: AheadBehind | null, base: string): string | null {
  if (!counts) return null
  const plus = counts.partial ? '+' : ''
  if (counts.ahead === 0 && counts.behind === 0) return `up to date with ${base}`
  const parts: string[] = []
  if (counts.ahead > 0) parts.push(`${counts.ahead}${plus} ahead of ${base}`)
  if (counts.behind > 0) parts.push(`${counts.behind}${plus} behind${counts.ahead > 0 ? '' : ` ${base}`}`)
  return parts.join(' · ')
}

/**
 * Which stream each commit belongs to: main's first-parent history, then each
 * worktree stream's own commits on top of its base (bases first), then each
 * task branch's own commits, as its stream's.
 */
function commitOwners(project: Project, graph: GitBranchGraph, byHash: ReadonlyMap<string, GitGraphCommit>): Map<string, string> {
  const owner = new Map<string, string>()
  const claim = (tip: string | undefined, streamId: string, stop?: ReadonlySet<string>) => {
    for (const commit of firstParentChain(byHash, tip, hash => !owner.has(hash) && !stop?.has(hash)).chain) owner.set(commit.hash, streamId)
  }
  const main = project.streams.find(s => s.isMain)
  if (main) claim(streamTip(graph, main), main.id)
  const byBranch = new Map(project.streams.flatMap(s => s.workspace ? [[s.workspace.branchName, s] as const] : []))
  const depth = (stream: Stream, seen = new Set<string>()): number => {
    const base = stream.workspace?.baseBranch
    const parent = base ? byBranch.get(base) : undefined
    if (!parent || seen.has(parent.id)) return 0
    seen.add(stream.id)
    return 1 + depth(parent, seen)
  }
  const worktreeStreams = project.streams.filter(s => s.workspace).sort((a, b) => depth(a) - depth(b))
  for (const stream of worktreeStreams) {
    const baseTip = graph.tips[stream.workspace!.baseBranch]
    claim(streamTip(graph, stream), stream.id, baseTip ? ancestors(byHash, baseTip).set : undefined)
  }
  for (const stream of project.streams) {
    for (const task of stream.tasks) if (task.workspace) claim(graph.tips[task.workspace.branchName], stream.id)
  }
  return owner
}

/** The commits only open tasks' own branches have: their lines matter until they join a stream. */
function taskBranchCommits(project: Project, graph: GitBranchGraph, byHash: ReadonlyMap<string, GitGraphCommit>, streamOwned: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>()
  for (const stream of project.streams) {
    for (const task of stream.tasks) {
      if (!task.workspace) continue
      for (const commit of firstParentChain(byHash, graph.tips[task.workspace.branchName], hash => !streamOwned.has(hash) && !out.has(hash)).chain) out.add(commit.hash)
    }
  }
  return out
}

/** The stream's open tasks, each one followed by those it started in the same stream. */
function tasksInOrder(stream: Stream): { task: Task; nested: boolean }[] {
  const ids = new Set(stream.tasks.map(t => t.id))
  const parentOf = (task: Task) => task.delegatedFrom && ids.has(task.delegatedFrom.taskId) ? task.delegatedFrom.taskId : null
  const out: { task: Task; nested: boolean }[] = []
  const placed = new Set<string>()
  const add = (task: Task, nested: boolean) => {
    if (placed.has(task.id)) return
    placed.add(task.id)
    out.push({ task, nested })
    for (const child of stream.tasks) if (parentOf(child) === task.id) add(child, true)
  }
  for (const task of stream.tasks) if (!parentOf(task)) add(task, false)
  // A loop of starters (shouldn't happen) still lists every task.
  for (const task of stream.tasks) add(task, false)
  return out
}

const timeOf = (commit: GitGraphCommit): number => new Date(commit.isoDate).getTime()

/** The lines a row without a node passes through: those entering the row below it, else leaving the row above. */
function passThrough(below: GraphRow | undefined, above: GraphRow | undefined): GraphSegment[] {
  const lanes = new Map<number, GraphSegment>()
  if (below) {
    for (const s of below.segments) {
      if (s.part === 'bottom') continue
      const lane = s.part === 'top' ? s.from : s.lane
      if (!lanes.has(lane)) lanes.set(lane, { ...s, from: lane, to: lane, part: 'full', lane })
    }
  } else if (above) {
    for (const s of above.segments) {
      if (s.part === 'top') continue
      const lane = s.part === 'bottom' ? s.to : s.lane
      if (!lanes.has(lane)) lanes.set(lane, { ...s, from: lane, to: lane, part: 'full', lane })
    }
  }
  return [...lanes.values()]
}

/** A commit with nothing on it in the middle of its lane, where no line joins or leaves. */
function isPlain(row: GraphRow): boolean {
  const { item } = row
  if (item.kind !== 'commit' || row.merge || item.heads.length > 0 || item.branches.length > 0 || item.done.length > 0) return false
  if (row.segments.some(s => s.from !== s.to)) return false
  const own = row.segments.filter(s => s.lane === row.column)
  return own.some(s => s.part === 'top') && own.some(s => s.part === 'bottom')
}

/**
 * The project's graph as rows, newest first: its open tasks on top, each
 * joined to the commit it works from, then the commits of every stream's and
 * task's branch. Plain runs fold unless their key is in `expanded`. With
 * `showDone`, done tasks sit on the commits they landed (by
 * `Task.landedCommits`, else a commit named after the task on its stream's
 * branch), or at the time they closed; closed and deleted streams likewise.
 * At most `rowLimit` rows; without one, down to a little past the oldest row
 * a stream or open task still branches from (the focus).
 */
export function projectGraph(
  project: Project,
  graph: GitBranchGraph | null,
  archive: ProjectArchive | null,
  opts: { showDone: boolean; expanded: ReadonlySet<string>; rowLimit?: number }
): ProjectGraph {
  const commits = graph?.commits ?? []
  const byHash = new Map(commits.map(c => [c.hash, c]))
  const owner = graph ? commitOwners(project, graph, byHash) : new Map<string, string>()
  // Before task nodes join `owner`: commits on task branches that no stream has yet.
  const onTaskBranch = graph ? taskBranchCommits(project, graph, byHash, new Map(owner)) : new Set<string>()
  const main = project.streams.find(s => s.isMain)
  const mainTip = main ? streamTip(graph, main) : undefined

  // Open tasks become nodes on top, each with the commit it works from as its parent.
  const taskNodes: GitGraphCommit[] = []
  const taskOf = new Map<string, { task: Task; streamId: string; nested: boolean }>()
  for (const stream of project.streams) {
    const from = streamTip(graph, stream) ?? mainTip
    for (const { task, nested } of tasksInOrder(stream)) {
      const hash = `task:${task.id}`
      const anchor = (task.workspace ? graph?.tips[task.workspace.branchName] : undefined) ?? from
      taskNodes.push({ hash, parents: anchor ? [anchor] : [], subject: task.name, author: '', isoDate: '' })
      taskOf.set(hash, { task, streamId: stream.id, nested })
      owner.set(hash, stream.id)
    }
  }
  const layout = layoutGraph([...taskNodes, ...commits])

  // Branch ends: streams' own, and branches git has that no stream or task claims.
  const heads = new Map<string, string[]>()
  for (const stream of project.streams) {
    const tip = streamTip(graph, stream)
    if (tip) heads.set(tip, [...(heads.get(tip) ?? []), stream.id])
  }
  const claimed = new Set<string>(project.streams.flatMap(s => [
    ...(s.workspace ? [s.workspace.branchName] : []),
    ...s.tasks.flatMap(t => t.workspace ? [t.workspace.branchName] : [])
  ]))
  if (main && graph?.head) claimed.add(graph.head)
  const branches = new Map<string, string[]>()
  for (const [name, sha] of Object.entries(graph?.tips ?? {})) {
    if (!claimed.has(name)) branches.set(sha, [...(branches.get(sha) ?? []), name])
  }

  // Done tasks on the commits they landed; the rest at the time they closed.
  const doneAt = new Map<string, ArchivedTask[]>()
  const events: { at: number; item: GraphItem }[] = []
  if (opts.showDone && archive) {
    const live = new Map(project.streams.map(s => [s.id, s]))
    // The stream whose branch a stream's tasks land on: its own, or main's for a project-folder stream.
    const branchOwner = (streamId: string) => {
      const stream = live.get(streamId)
      return stream ? (stream.workspace ? stream.id : main?.id) : undefined
    }
    const taken = new Set<string>()
    const done = [...archive.tasks, ...archive.streams.flatMap(e => e.doneTasks)].sort((a, b) => b.archivedAt - a.archivedAt)
    for (const entry of done) {
      const landed = new Set(entry.task.landedCommits ?? [])
      const name = entry.task.name.trim()
      const on = branchOwner(entry.streamId)
      const hit = landed.size > 0
        ? commits.find(c => landed.has(c.hash) && !taken.has(c.hash))
        : commits.find(c => c.parents.length < 2 && c.subject.trim() === name && !taken.has(c.hash) && (on === undefined || owner.get(c.hash) === on))
      if (hit) {
        taken.add(hit.hash)
        doneAt.set(hit.hash, [...(doneAt.get(hit.hash) ?? []), entry])
      } else if (entry.archivedAt > 0) {
        events.push({ at: entry.archivedAt, item: { kind: 'done', key: `done:${entry.task.id}`, entry } })
      }
    }
    for (const entry of archive.streams) {
      if (entry.archivedAt > 0) events.push({ at: entry.archivedAt, item: { kind: 'stream', key: `closed:${entry.stream.id}`, name: entry.stream.name, what: 'closed', at: entry.archivedAt } })
    }
    for (const d of archive.deletedStreams ?? []) {
      events.push({ at: d.deletedAt, item: { kind: 'stream', key: `deleted:${d.streamId}`, name: d.streamName, what: 'deleted', at: d.deletedAt } })
    }
    events.sort((a, b) => b.at - a.at)
  }

  let rows: GraphRow[] = layout.rows.map(row => {
    const task = taskOf.get(row.commit.hash)
    const item: GraphItem = task
      ? { kind: 'task', key: row.commit.hash, ...task }
      : { kind: 'commit', key: row.commit.hash, commit: row.commit, heads: heads.get(row.commit.hash) ?? [], branches: branches.get(row.commit.hash) ?? [], done: doneAt.get(row.commit.hash) ?? [] }
    return { item, column: row.column, segments: row.segments, dotted: [], merge: row.merge }
  })

  // Each event goes before the first commit older than it; one older than every loaded commit waits for more to load.
  if (events.length > 0) {
    const out: GraphRow[] = []
    let next = 0
    const place = (row: GraphRow | null) => {
      const at = row?.item.kind === 'commit' ? timeOf(row.item.commit) : null
      while (next < events.length && (row === null || (at !== null && Number.isFinite(at) && at < events[next].at))) {
        out.push({ item: events[next].item, column: null, segments: [], dotted: [], merge: false })
        next++
      }
    }
    for (const row of rows) {
      place(row)
      out.push(row)
    }
    if (!graph?.more) place(null)
    rows = out
  }

  // Fold runs of plain commits.
  const folded: GraphRow[] = []
  for (let i = 0; i < rows.length;) {
    let j = i
    while (j < rows.length && isPlain(rows[j])) j++
    const run = rows.slice(i, j)
    const first = run[0]
    if (run.length >= FOLD_MIN && first.item.kind === 'commit' && !opts.expanded.has(first.item.key)) {
      folded.push({
        item: { kind: 'fold', key: first.item.key, commits: run.flatMap(r => r.item.kind === 'commit' ? [r.item.commit] : []) },
        column: null,
        segments: passThrough(first, undefined),
        dotted: [...new Set(run.map(r => r.column as number))],
        merge: false
      })
      i = j
    } else if (run.length > 0) {
      folded.push(...run)
      i = j
    } else {
      folded.push(rows[i])
      i++
    }
  }

  // Rows without a node pass through the lines around them.
  for (let i = 0; i < folded.length; i++) {
    const row = folded[i]
    if (row.column !== null || row.item.kind === 'fold') continue
    const below = folded.slice(i + 1).find(r => r.column !== null || r.item.kind === 'fold')
    const above = [...folded.slice(0, i)].reverse().find(r => r.column !== null || r.item.kind === 'fold')
    row.segments = passThrough(below, below ? undefined : above)
  }

  const parentsOf = new Map<string, readonly string[]>([...taskNodes, ...commits].map(c => [c.hash, c.parents]))
  const edgeOwner = (s: GraphSegment) => parentsOf.get(s.child)?.[0] === s.parent ? owner.get(s.child) : owner.get(s.parent)

  // The focus: the last row a line of a live stream (not main's, which runs on) or an open task still runs into.
  const mainId = main?.id
  const live = (s: GraphSegment) => {
    if (s.child.startsWith('task:') || onTaskBranch.has(s.child)) return true
    const who = edgeOwner(s)
    return who !== undefined && who !== mainId
  }
  let focus = 0
  folded.forEach((row, i) => {
    const item = row.item
    if (item.kind === 'task' || (item.kind === 'commit' && item.heads.length > 0) || row.segments.some(s => s.part !== 'bottom' && live(s))) focus = i + 1
  })
  const limit = opts.rowLimit ?? Math.max(focus + FOCUS_CONTEXT, FOCUS_MIN)
  const shown = folded.slice(0, limit)
  let width = 0
  for (const row of shown) {
    width = Math.max(width, (row.column ?? -1) + 1, ...row.segments.map(s => Math.max(s.from, s.to, s.lane) + 1))
  }
  return { rows: shown, width, owner, edgeOwner, cut: folded.length > limit }
}

/** "Quiet for 6 days", "Quiet since yesterday", null within the day or with nothing to go on. */
export function quietFor(isoDate: string | undefined, now: number): string | null {
  if (!isoDate) return null
  const at = new Date(isoDate).getTime()
  if (!Number.isFinite(at)) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days < 1) return null
  if (days === 1) return 'Quiet since yesterday'
  if (days < 60) return `Quiet for ${days} days`
  return `Quiet for ${Math.floor(days / 30)} months`
}

/** "This Mac", the server's name, "user@host" for SSH, or the custom shell's name from Settings › Hosts. */
export function projectHostLabel(project: Project, serverName?: string, shellName?: string): string {
  if (project.ssh) return project.ssh.username ? `${project.ssh.username}@${project.ssh.host}` : project.ssh.host
  if (project.host) return serverName ?? 'Server'
  if (project.shellCommand) return shellName || 'Custom shell'
  return 'This Mac'
}

/** `one` or `many` by count. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

export interface HeatDay {
  /** Local `YYYY-MM-DD`. */
  iso: string
  date: Date
  count: number
}

/**
 * The last `weeks` weeks as columns of seven days (Monday first), oldest week
 * first, ending with the week of `now`; days after `now` are left out.
 */
export function recentWeeks(dayCounts: ReadonlyMap<string, number>, now: Date, weeks: number): HeatDay[][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
  const cols: HeatDay[][] = []
  for (let week = 0; week < weeks; week++) {
    const col: HeatDay[] = []
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(monday)
      date.setDate(monday.getDate() + week * 7 + dow)
      if (date > today) break
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      col.push({ iso, date, count: dayCounts.get(iso) ?? 0 })
    }
    cols.push(col)
  }
  return cols
}
