/**
 * Pure logic behind the desk's Project map (plan change 4, board Project.dc.html):
 * one lane per stream, its commits older → newer with the stream's open tasks
 * placed where they branched off, and the stream's ahead/behind against the
 * branch it was cut from. Everything comes from one `GitBranchGraph` of the
 * project's branches (`git-branch-graph.ts`), so a lane only knows the commits
 * that graph loaded.
 */
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task } from '../../../shared/types'
import { archivedTasksOf, type ProjectArchive } from '../../../shared/archive'

/** How many of a lane's newest commits it draws at first. */
export const LANE_COMMITS = 12

/** How many more commits a lane draws each time it is scrolled to its oldest end. */
export const LANE_COMMITS_STEP = 24

/**
 * Something that happened on a lane at a time rather than at a commit: a task
 * closed without its commit on the lane, a stream closed or deleted.
 */
export interface RailMark {
  key: string
  kind: 'done' | 'closed' | 'deleted'
  /** Epoch ms. */
  at: number
  /** Drawn above the rail; null draws none (the tooltip still says it). */
  label: string | null
  title: string
}

/** What a lane's track shows, older first. */
export type TrackItem =
  | { kind: 'commit'; commit: GitGraphCommit }
  | { kind: 'task'; task: Task }
  | { kind: 'mark'; mark: RailMark }

export interface LaneTrack {
  /** The branch the lane draws; null when the stream has none git knows. */
  branch: string | null
  /** The stream works in the project folder (no worktree of its own). */
  projectFolder: boolean
  items: TrackItem[]
  /**
   * Commits on the stream's branch that its base doesn't have (worktree
   * streams only); null when there is no base to count against.
   */
  ahead: number | null
  /** Commits on the base the stream doesn't have yet; null like `ahead`. */
  behind: number | null
  /** The counts stopped at the end of the loaded graph, so they may be higher. */
  partial: boolean
  /** The lane's newest commit, for "Quiet for 6 days". */
  newest: GitGraphCommit | null
  /** Every commit the lane owns in the loaded graph, newest first (`items` draws the newest few). */
  history: GitGraphCommit[]
  /** Merge commits on the lane that took its base in ("main merged into 0.8.0"). */
  baseMerges: Set<string>
  /**
   * The lane has older commits than it draws: loaded ones past `maxCommits`,
   * or its chain ran off the end of a graph that has more.
   */
  older: boolean
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
 * The stream's lane. The main stream draws the project folder's branch; a
 * worktree stream draws the commits it has on top of its base, with ahead and
 * behind counted against that base. Any other project-folder stream shares
 * main's checkout, so it draws no commits of its own, only its tasks.
 *
 * Open tasks with a branch of their own sit just after the lane commit they
 * branched off (at the start when that is older than what is drawn); the rest
 * sit at the newer end, in the stream's order.
 */
export function laneTrack(graph: GitBranchGraph | null, stream: Stream, maxCommits = LANE_COMMITS): LaneTrack {
  const projectFolder = !stream.workspace
  const branch = stream.workspace?.branchName ?? graph?.head ?? null
  const ownsHistory = !projectFolder || !!stream.isMain
  const byHash = new Map((graph?.commits ?? []).map(c => [c.hash, c]))
  const tip = branch ? graph?.tips[branch] : undefined

  let commits: GitGraphCommit[] = []
  let ahead: number | null = null
  let behind: number | null = null
  let partial = false
  let chainCut = false
  const baseMerges = new Set<string>()
  if (graph && ownsHistory && tip) {
    const base = stream.workspace?.baseBranch
    const baseTip = base ? graph.tips[base] : undefined
    if (stream.workspace && baseTip) {
      const onBase = ancestors(byHash, baseTip)
      const own = firstParentChain(byHash, tip, hash => !onBase.set.has(hash))
      const mine = ancestors(byHash, tip)
      commits = own.chain
      ahead = own.chain.length
      behind = [...onBase.set].filter(hash => !mine.set.has(hash)).length
      partial = own.cut || onBase.cut || mine.cut
      chainCut = own.cut
      for (const c of own.chain) if (c.parents.slice(1).some(parent => onBase.set.has(parent))) baseMerges.add(c.hash)
    } else {
      const own = firstParentChain(byHash, tip)
      commits = own.chain
      chainCut = own.cut
    }
  }
  const newest = commits[0] ?? null
  const shown = commits.slice(0, maxCommits).reverse()

  // Where each task goes: after the shown commit it forked from (-1: before them all), or at the end.
  const slotOf = new Map(shown.map((c, i) => [c.hash, i]))
  const allOwn = new Set(commits.map(c => c.hash))
  const atSlot = new Map<number, Task[]>()
  const atEnd: Task[] = []
  for (const task of stream.tasks) {
    const taskTip = task.workspace && graph ? graph.tips[task.workspace.branchName] : undefined
    let slot: number | null = null
    if (taskTip && shown.length > 0) {
      const { chain } = firstParentChain(byHash, taskTip)
      const fork = chain.find(c => slotOf.has(c.hash) || allOwn.has(c.hash))
      if (fork) slot = slotOf.get(fork.hash) ?? -1
    }
    // A fork at the lane's newest commit is the same as the end.
    if (slot === null || slot === shown.length - 1) atEnd.push(task)
    else atSlot.set(slot, [...(atSlot.get(slot) ?? []), task])
  }
  const items: TrackItem[] = (atSlot.get(-1) ?? []).map(task => ({ kind: 'task' as const, task }))
  shown.forEach((commit, i) => {
    items.push({ kind: 'commit', commit })
    for (const task of atSlot.get(i) ?? []) items.push({ kind: 'task', task })
  })
  for (const task of atEnd) items.push({ kind: 'task', task })

  const older = commits.length > shown.length || (chainCut && !!graph?.more)
  return { branch, projectFolder, items, ahead, behind, partial, newest, history: commits, baseMerges, older }
}

/**
 * The lane with `marks` on its rail by time: each after the newest drawn commit
 * not later than it. One older than every drawn commit goes first when the
 * lane's whole history is drawn, and is left out when older commits are not.
 */
export function placeMarks(track: LaneTrack, marks: readonly RailMark[]): LaneTrack {
  if (marks.length === 0) return track
  const shown = track.items.flatMap(item => item.kind === 'commit' ? [item.commit] : [])
  const cut = track.history.length > shown.length || track.partial
  const after = new Map<number, RailMark[]>()
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    let slot = -1
    shown.forEach((c, i) => { if (new Date(c.isoDate).getTime() <= mark.at) slot = i })
    if (slot === -1 && shown.length > 0 && cut) continue
    // With no commits drawn there is no time to place by: in order, at the start.
    after.set(slot, [...(after.get(slot) ?? []), mark])
  }
  const items: TrackItem[] = (after.get(-1) ?? []).map(mark => ({ kind: 'mark' as const, mark }))
  let i = -1
  for (const item of track.items) {
    items.push(item)
    if (item.kind === 'commit') {
      i++
      for (const mark of after.get(i) ?? []) items.push({ kind: 'mark', mark })
    }
  }
  return { ...track, items }
}

/** What a commit on a lane stands for, beyond itself. */
export type CommitNote =
  | { kind: 'task'; name: string }
  /** Another branch merged into this lane; `name` is its stream's name when known, else the branch. */
  | { kind: 'merged'; name: string; closed?: true }
  /** The lane's base merged into it. */
  | { kind: 'base'; name: string }

/** The branch a merge commit's subject names: DevTool's own, git's and GitHub's wording. */
export function mergedBranch(subject: string): { stream?: string; branch?: string } | null {
  const own = /^Merge stream "(.+)" \((.+)\) into /.exec(subject)
  if (own) return { stream: own[1], branch: own[2] }
  const git = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject)
  if (git) return { branch: git[1] }
  const pr = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject)
  if (pr) return { branch: pr[1] }
  return null
}

/**
 * Notes for a lane's commits: the done task each landed commit belongs to (by
 * `Task.landedCommits`, else a commit named after the task, as a landing names
 * it), and who each merge commit took in. Each task claims one commit, the
 * newest that fits. Returns the notes and the done tasks no commit claimed.
 */
export function commitNotes(
  track: LaneTrack,
  done: readonly { task: Task }[],
  base: string | undefined,
  streamOfBranch: ReadonlyMap<string, string>
): { notes: Map<string, CommitNote>; unclaimed: Task[] } {
  const notes = new Map<string, CommitNote>()
  for (const c of track.history) {
    if (c.parents.length < 2) continue
    if (track.baseMerges.has(c.hash)) {
      notes.set(c.hash, { kind: 'base', name: base ?? 'base' })
      continue
    }
    const named = mergedBranch(c.subject)
    const name = named?.stream ?? (named?.branch ? streamOfBranch.get(named.branch) ?? named.branch : 'a branch')
    notes.set(c.hash, { kind: 'merged', name })
  }
  const unclaimed: Task[] = []
  for (const { task } of done) {
    const landed = new Set(task.landedCommits ?? [])
    const subject = task.name.trim()
    const hit = landed.size > 0
      ? track.history.find(c => landed.has(c.hash) && !notes.has(c.hash))
      : track.history.find(c => c.parents.length < 2 && c.subject === subject && !notes.has(c.hash))
    if (hit) notes.set(hit.hash, { kind: 'task', name: task.name })
    else unclaimed.push(task)
  }
  return { notes, unclaimed }
}

/** "3 ahead of master · 1 behind", "up to date with master", "12+ ahead of master". */
export function aheadBehindLine(track: LaneTrack, base: string): string | null {
  if (track.ahead === null || track.behind === null) return null
  const plus = track.partial ? '+' : ''
  if (track.ahead === 0 && track.behind === 0) return `up to date with ${base}`
  const parts: string[] = []
  if (track.ahead > 0) parts.push(`${track.ahead}${plus} ahead of ${base}`)
  if (track.behind > 0) parts.push(`${track.behind}${plus} behind${track.ahead > 0 ? '' : ` ${base}`}`)
  return parts.join(' · ')
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

/** The lane graph's measures, in px. */
export const LANE_GEOMETRY = {
  /** Room before the oldest commit for the fork-in curve. */
  padLeft: 44,
  /** Between two commits on the rail. */
  step: 26,
  /** Rail's distance from the top of the track (time labels sit above it). */
  railY: 30,
  /** Where task cards start, below the rail. */
  cardTop: 64,
  cardWidth: 184,
  cardGap: 12,
  /** A stem enters its card this far from the card's left edge. */
  stemInset: 16,
  /** From the newest commit to the "+ Task" node on the rail. */
  addGap: 28,
  padRight: 24
} as const

export interface LaneGeometry {
  commits: { commit: GitGraphCommit; x: number }[]
  marks: { mark: RailMark; x: number }[]
  /** Text above the rail, centred on `x`. */
  labels: { key: string; text: string; x: number }[]
  /** Each task card: where it leaves the rail (`forkX`) and where its card's left edge sits. */
  tasks: { task: Task; forkX: number; x: number }[]
  /** The rail's oldest and newest points (the newest commit, or `railStart` with none). */
  railStart: number
  railEnd: number
  /** Where the "+ Task" node sits on the rail. */
  addX: number
  /** The track's full drawn width. */
  width: number
}

/** About how wide a label of `text` is drawn (text-2xs). */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * 5.6) + 4
}

/**
 * Where a lane's pieces go: commits and marks evenly on the rail older → newer,
 * spread wider where their labels would otherwise touch, then each
 * task card below the rail, as close under the commit it forked from as the
 * cards before it allow, joined to that commit by a stem. A task forked before
 * every drawn commit leaves the rail at its start.
 */
export function laneGeometry(
  items: readonly TrackItem[],
  labelOf: (item: TrackItem) => string | null = () => null,
  g: typeof LANE_GEOMETRY = LANE_GEOMETRY
): LaneGeometry {
  const commits: LaneGeometry['commits'] = []
  const marks: LaneGeometry['marks'] = []
  const labels: LaneGeometry['labels'] = []
  const tasks: LaneGeometry['tasks'] = []
  const railStart = g.padLeft - g.step / 2
  let lastX = railStart
  let railX: number | null = null
  let labelRight = -Infinity
  let cardRight = -Infinity
  for (const item of items) {
    if (item.kind !== 'task') {
      const text = labelOf(item)
      let x: number = railX === null ? g.padLeft : railX + g.step
      if (text) {
        const half = labelWidth(text) / 2
        x = Math.max(x, labelRight + 8 + half)
        labelRight = x + half
        labels.push({ key: item.kind === 'commit' ? item.commit.hash : item.mark.key, text, x })
      }
      railX = x
      if (item.kind === 'commit') {
        lastX = x
        commits.push({ commit: item.commit, x })
      } else {
        marks.push({ mark: item.mark, x })
      }
      continue
    }
    const forkX = lastX
    const x = Math.max(forkX - g.stemInset, cardRight + g.cardGap, 0)
    tasks.push({ task: item.task, forkX, x })
    cardRight = x + g.cardWidth
  }
  const railEnd = railX ?? railStart
  const addX = Math.max(railEnd + g.addGap, labelRight + 8)
  const width = Math.max(addX + 60, cardRight) + g.padRight
  return { commits, marks, labels, tasks, railStart, railEnd, addX, width }
}

export interface ProjectLane {
  track: LaneTrack
  notes: Map<string, CommitNote>
}

const when = (at: number): string => new Date(at).toLocaleString()

/**
 * Every live stream's lane with what the archive knows: its done tasks (a
 * check on the commit each landed, a mark when none did), and closed and
 * deleted streams as marks on the lane they were cut from (main when that
 * one is gone). A closed stream whose merge commit is on that lane says so on
 * the merge instead.
 */
export function projectLanes(
  project: Project,
  graph: GitBranchGraph | null,
  archive: ProjectArchive | null,
  /** How many commits each lane draws, by stream id (`LANE_COMMITS` when unset). */
  depthOf: (streamId: string) => number = () => LANE_COMMITS
): Map<string, ProjectLane> {
  const streamOfBranch = new Map<string, string>()
  for (const d of archive?.deletedStreams ?? []) if (d.branchName) streamOfBranch.set(d.branchName, d.streamName)
  for (const e of archive?.streams ?? []) if (e.stream.workspace) streamOfBranch.set(e.stream.workspace.branchName, e.stream.name)
  for (const s of project.streams) if (s.workspace) streamOfBranch.set(s.workspace.branchName, s.name)

  const main = project.streams.find(s => s.isMain) ?? project.streams[0]
  const laneOf = (base: string | undefined): Stream | undefined => project.streams.find(s => !!base && s.workspace?.branchName === base) ?? main

  const lanes = new Map<string, ProjectLane & { marks: RailMark[] }>()
  for (const stream of project.streams) {
    const track = laneTrack(graph, stream, depthOf(stream.id))
    const done = archive ? archivedTasksOf(archive, stream.id) : []
    const { notes, unclaimed } = commitNotes(track, done, stream.workspace?.baseBranch, streamOfBranch)
    const closedAt = new Map(done.map(entry => [entry.task.id, entry.archivedAt]))
    const marks: RailMark[] = unclaimed.flatMap(task => {
      const at = closedAt.get(task.id) ?? 0
      return at > 0 ? [{ key: `done-${task.id}`, kind: 'done' as const, at, label: null, title: `✓ Done: ${task.name}\nClosed ${when(at)}, no commit of its own here` }] : []
    })
    lanes.set(stream.id, { track, notes, marks })
  }

  for (const entry of archive?.streams ?? []) {
    const lane = lanes.get(laneOf(entry.stream.workspace?.baseBranch)?.id ?? '')
    if (!lane || entry.archivedAt <= 0) continue
    const merge = [...lane.notes].find(([, note]) => note.kind === 'merged' && note.name === entry.stream.name)
    if (merge) lane.notes.set(merge[0], { kind: 'merged', name: entry.stream.name, closed: true })
    else lane.marks.push({ key: `closed-${entry.stream.id}`, kind: 'closed', at: entry.archivedAt, label: `${entry.stream.name} closed`, title: `Stream ${entry.stream.name} closed ${when(entry.archivedAt)}` })
  }
  for (const d of archive?.deletedStreams ?? []) {
    const lane = lanes.get(laneOf(d.baseBranch)?.id ?? '')
    if (!lane) continue
    lane.marks.push({ key: `deleted-${d.streamId}`, kind: 'deleted', at: d.deletedAt, label: `${d.streamName} deleted`, title: `Stream ${d.streamName} deleted ${when(d.deletedAt)}${d.closedAt > 0 ? ` (closed ${when(d.closedAt)})` : ''}` })
  }

  return new Map([...lanes].map(([id, { track, notes, marks }]) => [id, { track: placeMarks(track, marks), notes }]))
}
