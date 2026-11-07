import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { childProgress, childProgressLine, delegationTree, statusFrom, waitingOnChildren, type DelegationTree } from '../../../shared/delegation'
import { Check, Cog, MoreHorizontal, Plus, X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../../context/TabStatusContext'
import { isRemoteProject, isShellCommandProject, type GitBranchGraph, type GitDiffSummary, type GitPostureResult, type Project, type Stream, type Task, type TabStatusValue } from '../../../shared/types'
import { featureAvailable } from '../../../shared/project-features'
import { findMainStream, projectTasks, streamDirectory } from '../../../shared/streams'
import { archivedTasksOf, visibleArchive, type ArchivedTask } from '../../../shared/archive'
import { runsOfStream, streamOwnRunCommands, streamRunCommands, streamRunCrashed, streamRunTask, type StreamRunState } from '../../../shared/stream-run'
import { PROJECT_TILE_PALETTE, projectSwatch, projectTile } from '../../../shared/project-label'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { controlStreamRun, openStreamRunLogs, useAllStreamRuns } from '../../streamRuns'
import { serverName } from '../../serversState'
import { paletteEvents } from '../../palette/paletteEvents'
import { openEntityDialog } from '../../entityActions'
import { useGitPosture } from '../../hooks/useGitPosture'
import { useCommitHistory } from '../../hooks/useCommitHistory'
import { useProjectArchive } from '../../hooks/archiveStore'
import { formatLineCount, useTaskDiffSummaries } from '../../hooks/useTaskDiffSummaries'
import { EntityMenuPopup, type EntityMenuTarget } from '../menus/EntityMenus'
import ProjectTileBadge from '../ProjectTileBadge'
import { BranchGraph, projectBranchLabels, useBranchGraph } from '../BranchGraph'
import { CommitHeatmap } from '../CommitHeatmap'
import { ProjectTokensCard, tokenUsageAvailable } from '../TokenUsage'
import { ArchivedStreamsLine, DoneTaskItem } from './DoneItems'
import { SchedulesCard, schedulesShown } from './DeskSchedules'
import { StreamRunButtons } from '../StreamRunControls'
import { bucketByDay, formatRelativeTime, quartileBins } from '../projectStats'
import { taskAgentLabel, taskStatusChip, type TaskChipTone } from '../taskHeaderState'
import { projectHomeSummary } from '../projectHomeState'
import { aheadBehindLine, LANE_GEOMETRY, laneGeometry, plural, projectHostLabel, projectLanes, quietFor, recentWeeks, type CommitNote, type LaneTrack, type TrackItem } from './projectMap'

const GRAPH_LIMIT = 150
const HEAT_WEEKS = 16

const ghostCls = 'shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-border-strong bg-transparent text-sm text-text cursor-pointer hover:bg-sel transition-colors duration-(--motion-fast)'
const smallGhostCls = 'shrink-0 inline-flex items-center h-6 px-2 rounded-md border border-border-strong bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)'
const linkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-muted hover:text-text hover:underline'
const headCls = 'text-2xs font-semibold uppercase tracking-[0.07em] text-text-muted'

/** A tip card's colours: amber needs you, blue your turn, grey working (pulsing), quiet otherwise. */
const TIP: Record<TaskChipTone, { card: string; dot: string; text: string }> = {
  attention: {
    card: 'border-[color-mix(in_srgb,var(--color-needs)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-needs)_7%,var(--color-field))]',
    dot: 'bg-needs',
    text: 'text-needs'
  },
  turn: { card: 'border-[color-mix(in_srgb,var(--color-answered)_35%,transparent)] bg-field', dot: 'bg-answered', text: 'text-answered' },
  working: { card: 'border-border bg-field', dot: 'bg-text-muted desk-pulse', text: 'text-text-muted' },
  quiet: { card: 'border-border bg-field', dot: 'border border-border-strong', text: 'text-text-subtle' }
}

/** A lane's horizontal track, kept scrolled to its newest end whenever what it draws grows or shrinks. */
function useScrolledToEnd(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const content = el?.firstElementChild
    if (!el || !content) return
    const toEnd = () => { el.scrollLeft = el.scrollWidth }
    toEnd()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(toEnd)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  return ref
}

/**
 * A task's tip on its lane. A task that started others (`Task.delegatedFrom`)
 * says how they stand ("2 of 3 done"), and those in its lane sit under it,
 * small, instead of on the lane of their own.
 */
function TaskTip({ project, task, statuses, statusSince, now, diffs, tree, nested }: {
  project: Project
  task: Task
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diffs: ReadonlyMap<string, GitDiffSummary>
  tree: DelegationTree
  /** Its children in the same lane, drawn under it. */
  nested: readonly Task[]
}): React.ReactElement {
  const statusOf = statusFrom(statuses)
  const progress = childProgress(tree, task, statusOf)
  const tip = <TipCard project={project} task={task} statuses={statuses} statusSince={statusSince} now={now} diff={diffs.get(task.id)} waitingOn={waitingOnChildren(tree, task, statusOf)} progress={progress ? childProgressLine(progress) : null} />
  if (nested.length === 0) return tip
  return (
    <div className="relative z-[1] w-full flex flex-col gap-1">
      {tip}
      {nested.map(child => (
        <div key={child.id} className="ml-3 flex flex-col" data-testid={`map-child-${child.id}`}>
          <TipCard project={project} task={child} statuses={statuses} statusSince={statusSince} now={now} diff={diffs.get(child.id)} waitingOn={waitingOnChildren(tree, child, statusOf)} progress={null} small />
        </div>
      ))}
    </div>
  )
}

function TipCard({ project, task, statuses, statusSince, now, diff, waitingOn, progress, small = false }: {
  project: Project
  task: Task
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diff: GitDiffSummary | undefined
  waitingOn: number
  progress: string | null
  small?: boolean
}): React.ReactElement {
  const { switchToTask } = useApp()
  const chip = taskStatusChip(task, statuses, statusSince, now, waitingOn)
  const tone = chip?.tone ?? 'quiet'
  const agent = taskAgentLabel(task)
  const label = chip
    ? chip.tone === 'working' && agent && agent !== 'Claude' ? `${chip.label} · ${agent}` : chip.label
    : 'Open'
  return (
    <button
      type="button"
      className={`relative z-[1] ${small ? 'px-2 py-1' : 'w-full px-2.5 py-2'} flex flex-col gap-[3px] rounded-[9px] border text-left cursor-pointer hover:brightness-110 ${TIP[tone].card}`}
      title={`${task.name} · ${label}`}
      onClick={() => switchToTask(project.id, task.id)}
      data-testid={`map-task-${task.id}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${TIP[tone].dot}`} />
        <span className={`text-2xs ${TIP[tone].text} truncate`}>{label}</span>
      </span>
      <span className="text-xs font-medium text-text truncate">{task.name}</span>
      {progress && <span className="text-2xs text-text-muted truncate" data-testid="map-task-children">{progress}</span>}
      {diff && (diff.added > 0 || diff.deleted > 0) && (
        <span className="font-mono text-2xs text-text-subtle">
          <span className="text-running">+{formatLineCount(diff.added)}</span> <span className="text-crashed">−{formatLineCount(diff.deleted)}</span>
        </span>
      )}
    </button>
  )
}

/** One command at a lane's end: state dot, name, Run (Restart/Stop while it runs) and its Logs. */
function CommandRow({ project, stream, id, name, command, run, defined }: {
  project: Project
  stream: Stream
  id: string
  name: string
  command: string
  run: StreamRunState | undefined
  defined: boolean
}): React.ReactElement {
  const dot = run?.status === 'running' ? 'bg-running' : run && streamRunCrashed(run) ? 'bg-crashed' : 'bg-border-strong'
  const task = streamRunTask(stream, run)
  const state = run?.status === 'running' ? 'running' : run && streamRunCrashed(run) ? `crashed (${run.exitCode ?? '?'})` : run?.status ?? 'not running'
  return (
    <div className="flex items-center gap-2 min-w-0 text-xs" data-testid={`map-run-${stream.id}-${id}`}>
      <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dot}`} />
      <span className="flex-1 min-w-0 font-mono text-text truncate" title={`$ ${command} · ${state}${task ? ` · in ${task.name}` : ''}`}>
        {name}{task && <span className="text-text-subtle"> · {task.name}</span>}
      </span>
      <StreamRunButtons run={run} canRun={defined} name={name} onAction={(action) => void controlStreamRun(project.id, stream.id, id, action)} />
      {run && (
        <button type="button" className={smallGhostCls} onClick={() => openStreamRunLogs({ projectId: project.id, streamId: stream.id, commandId: id })}>
          Logs
        </button>
      )}
    </div>
  )
}

/**
 * The lane's end: the stream's commands. A non-main stream's
 * commands that only repeat the project's and never ran here fold into
 * "Inherits dev, test", which opens to their rows.
 */
function LaneEnd({ project, stream, runs }: {
  project: Project
  stream: Stream
  runs: readonly StreamRunState[]
}): React.ReactElement {
  const [showInherited, setShowInherited] = useState(false)
  const commands = streamRunCommands(project, stream)
  const own = new Set(streamOwnRunCommands(project, stream).map(c => c.name.trim().toLowerCase()))
  const ids = new Set(commands.map(c => c.id))
  const rows = [
    ...commands.map(c => ({ ...c, defined: true, inherited: !stream.isMain && !own.has(c.name.trim().toLowerCase()) })),
    // A command removed while it ran keeps its row until the run is gone.
    ...runs.filter(r => !ids.has(r.commandId)).map(r => ({ id: r.commandId, name: r.name, command: r.command, defined: false, inherited: false }))
  ]
  const runOf = (id: string) => runs.find(r => r.commandId === id)
  const folded = showInherited ? [] : rows.filter(r => r.inherited && !runOf(r.id))
  const shown = rows.filter(r => !folded.includes(r))
  const main = findMainStream(project)

  return (
    <div className="min-w-0 px-5 pt-1 pb-4 @min-[860px]:pt-4 @min-[860px]:flex-[0_0_260px] @min-[860px]:border-l border-hair flex flex-col gap-2 box-border">
      {shown.map(row => (
        <CommandRow key={row.id} project={project} stream={stream} id={row.id} name={row.name} command={row.command} run={runOf(row.id)} defined={row.defined} />
      ))}
      {folded.length > 0 && (
        <button type="button" className={`${linkCls} text-left`} onClick={() => setShowInherited(true)} title="Show them to run them in this stream">
          Inherits <span className="font-mono">{folded.map(r => r.name).join(', ')}</span>{main ? ` from ${main.name}` : ''}
        </button>
      )}
      {rows.length === 0 && <span className="text-xs text-text-subtle">No commands</span>}
    </div>
  )
}

/**
 * A stream's rail colour: main takes the project's own colour; the other
 * streams step around the palette from it, so neighbours differ.
 */
function streamColor(project: Project, stream: Stream, theme: 'light' | 'dark'): string {
  const tile = projectTile(project)
  const others = project.streams.filter(s => !s.isMain)
  const step = stream.isMain ? 0 : 3 * (others.indexOf(stream) + 1)
  return PROJECT_TILE_PALETTE[(tile.hue + step) % PROJECT_TILE_PALETTE.length][theme].fg
}

/** How a lane's rail begins: main's history runs in from the left, a worktree curves in from its base, a folder stream shares main's. */
type LaneFork = 'history' | 'shared' | { base: string; color: string }

/**
 * A lane's branch graph (`laneGeometry`): the rail with its commits older →
 * newer, the newest one ringed as the head, and each open task hanging below
 * on a stem from the commit it forked from. A done task's commit carries a
 * check; a merge commit shows the branch it took in curving into it; marks
 * on the rail say when a task closed without landing, or a stream closed or
 * was deleted. The "+ Task" node sits where the next commit would.
 */
function LaneGraph({ items, notes, color, colorOf, fork, now, addTitle, onAdd, after, renderTask }: {
  items: readonly TrackItem[]
  notes: ReadonlyMap<string, CommitNote>
  color: string
  /** The rail colour of a live stream by name, for a merge it made. */
  colorOf: (streamName: string) => string | undefined
  fork: LaneFork
  now: number
  addTitle: string
  onAdd: () => void
  /** Drawn after the "+ Task" node: the quiet line, the done chips. */
  after: React.ReactNode
  renderTask: (task: Task) => React.ReactNode
}): React.ReactElement {
  const g = LANE_GEOMETRY
  const ago = (iso: string) => formatRelativeTime(new Date(iso).getTime(), now)
  const rail = items.filter(item => item.kind !== 'task')
  const commitsIn = items.flatMap(item => item.kind === 'commit' ? [item.commit] : [])
  const headHash = commitsIn[commitsIn.length - 1]?.hash
  const oldestHash = commitsIn.length >= 4 ? commitsIn[0].hash : undefined
  const labelOf = (item: TrackItem): string | null => {
    if (item.kind === 'mark') return item.mark.label
    if (item.kind !== 'commit') return null
    const note = notes.get(item.commit.hash)
    const text = note?.kind === 'merged' ? `${note.name} merged${note.closed ? ' · closed' : ''}` : note?.kind === 'base' ? `${note.name} merged in` : null
    const time = item.commit.hash === headHash || item.commit.hash === oldestHash ? ago(item.commit.isoDate) : null
    return text && time && item.commit.hash === headHash ? `${text} · ${time}` : text ?? time
  }
  const geo = laneGeometry(items, labelOf)
  const fadeId = `lane-fade-${useId().replace(/:/g, '')}`
  const y = g.railY
  const owned = rail.length > 0
  const subtle = 'var(--color-text-subtle)'
  let cardRight = 0

  return (
    <div className="relative" style={{ width: geo.width, minHeight: geo.tasks.length > 0 ? undefined : y + 30 }}>
      <svg aria-hidden className="absolute left-0 top-0 overflow-visible pointer-events-none" width={geo.width} height={g.cardTop}>
        <defs>
          <linearGradient id={fadeId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={color} stopOpacity="0" />
            <stop offset="1" stopColor={color} stopOpacity="0.9" />
          </linearGradient>
        </defs>
        {fork === 'history' && <line x1={0} y1={y} x2={geo.railStart} y2={y} stroke={`url(#${fadeId})`} strokeWidth={2} />}
        {fork !== 'history' && (
          <path
            d={`M14 0 L14 ${y - 12} Q14 ${y} 26 ${y} L${geo.railStart} ${y}`}
            fill="none"
            stroke={typeof fork === 'object' ? fork.color : color}
            strokeWidth={2}
            strokeDasharray={fork === 'shared' ? '3 4' : undefined}
            opacity={0.9}
          />
        )}
        {owned
          ? <line x1={geo.railStart} y1={y} x2={geo.railEnd} y2={y} stroke={color} strokeWidth={2} opacity={0.9} />
          : <line x1={geo.railStart} y1={y} x2={geo.addX} y2={y} stroke={color} strokeWidth={2} strokeDasharray="3 4" opacity={0.6} />}
        {owned && <line x1={geo.railEnd} y1={y} x2={geo.addX} y2={y} stroke={color} strokeWidth={1.5} strokeDasharray="2 4" opacity={0.5} />}
        {geo.commits.map(({ commit, x }) => {
          const note = notes.get(commit.hash)
          if (note?.kind === 'merged') {
            // The branch it took in, rising into it from below.
            const c = colorOf(note.name) ?? subtle
            return <g key={commit.hash}><path d={`M${x - 16} ${y + 13} Q${x} ${y + 13} ${x} ${y}`} fill="none" stroke={c} strokeWidth={2} /><circle cx={x - 16} cy={y + 13} r={2} fill={c} /></g>
          }
          if (note?.kind === 'base') {
            const c = typeof fork === 'object' ? fork.color : subtle
            return <g key={commit.hash}><path d={`M${x - 16} ${y - 11} Q${x} ${y - 11} ${x} ${y}`} fill="none" stroke={c} strokeWidth={2} /><circle cx={x - 16} cy={y - 11} r={2} fill={c} /></g>
          }
          return null
        })}
        {geo.tasks.map(({ task, forkX, x }) => {
          // Down from the fork, along under the rail, then down into the card.
          const sx = x + g.stemInset
          const mid = (y + g.cardTop) / 2 + 2
          const r = Math.min(8, Math.abs(sx - forkX) / 2)
          const d = r < 1
            ? `M${forkX} ${y} V${g.cardTop}`
            : `M${forkX} ${y} V${mid - r} Q${forkX} ${mid} ${forkX + r} ${mid} H${sx - r} Q${sx} ${mid} ${sx} ${mid + r} V${g.cardTop}`
          return (
            <g key={task.id}>
              <path d={d} fill="none" stroke={color} strokeWidth={1.5} opacity={0.7} />
              {!geo.commits.some(c => c.x === forkX) && <circle cx={forkX} cy={y} r={2.5} fill={color} />}
            </g>
          )
        })}
      </svg>

      {/* Commits and marks get real elements for their tooltips. */}
      {geo.commits.map(({ commit, x }) => {
        const note = notes.get(commit.hash)
        const isHead = commit.hash === headHash
        const tip = `${commit.subject}\n${commit.hash.slice(0, 7)} · ${commit.author} · ${ago(commit.isoDate)}`
        if (note?.kind === 'task') {
          return (
            <span
              key={commit.hash}
              className="absolute flex items-center justify-center rounded-full cursor-default box-border"
              style={{ left: x, top: y, width: 15, height: 15, transform: 'translate(-50%, -50%)', background: color, border: isHead ? '2px solid var(--color-bg)' : undefined, boxShadow: isHead ? `0 0 0 1.5px ${color}` : undefined }}
              title={`✓ Done: ${note.name}\n${tip}`}
              data-testid={`map-commit-${commit.hash}`}
              data-done
            >
              <Check size={10} strokeWidth={3} color="var(--color-bg)" />
            </span>
          )
        }
        return (
          <span
            key={commit.hash}
            className="absolute rounded-full cursor-default box-border"
            style={{
              left: x,
              top: y,
              width: isHead ? 12 : 10,
              height: isHead ? 12 : 10,
              transform: 'translate(-50%, -50%)',
              background: isHead ? 'var(--color-bg)' : color,
              border: isHead ? `2.5px solid ${color}` : '2px solid var(--color-bg)'
            }}
            title={note?.kind === 'merged' ? `${note.name} merged into this stream${note.closed ? ', then closed' : ''}\n${tip}` : note?.kind === 'base' ? `${note.name} merged into this stream\n${tip}` : tip}
            data-testid={`map-commit-${commit.hash}`}
          />
        )
      })}
      {geo.marks.map(({ mark, x }) => (
        <span
          key={mark.key}
          className={`absolute flex items-center justify-center cursor-default box-border bg-bg text-text-subtle ${mark.kind === 'closed' ? 'rounded-[3px] border-[1.5px] border-text-subtle' : `rounded-full border-[1.5px] border-text-subtle ${mark.kind === 'deleted' ? 'border-dashed' : ''}`}`}
          style={{ left: x, top: y, width: mark.kind === 'closed' ? 10 : 13, height: mark.kind === 'closed' ? 10 : 13, transform: 'translate(-50%, -50%)' }}
          title={mark.title}
          data-testid={`map-mark-${mark.key}`}
        >
          {mark.kind === 'done' && <Check size={8} strokeWidth={3} />}
          {mark.kind === 'deleted' && <X size={8} strokeWidth={3} />}
        </span>
      ))}
      {geo.labels.map(label => (
        <span
          key={label.key}
          className={`absolute text-2xs whitespace-nowrap -translate-x-1/2 pointer-events-none ${label.key === headHash ? 'text-text-muted' : 'text-text-subtle'}`}
          style={{ left: label.x, top: y - 25 }}
        >
          {label.text}
        </span>
      ))}
      {typeof fork === 'object' && !geo.tasks.some(t => t.x < 96) && (
        <span className="absolute text-2xs text-text-subtle whitespace-nowrap pointer-events-none" style={{ left: 20, top: y + 6 }}>from <span className="font-mono">{fork.base}</span></span>
      )}

      <div className="absolute flex items-center gap-3 whitespace-nowrap -translate-y-1/2" style={{ left: geo.addX, top: y }}>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-dashed border-border-strong bg-bg text-xs text-text-subtle cursor-pointer hover:text-text hover:border-text-subtle"
          title={addTitle}
          onClick={onAdd}
        >
          <Plus size={12} /> Task
        </button>
        {after}
      </div>

      {geo.tasks.length > 0 && (
        <div className="flex items-start pb-4" style={{ paddingTop: g.cardTop }}>
          {geo.tasks.map(({ task, x }) => {
            const gap = x - cardRight
            cardRight = x + g.cardWidth
            return (
              <div key={task.id} className="shrink-0" style={{ marginLeft: gap, width: g.cardWidth }}>
                {renderTask(task)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** How many of a lane's latest done tasks show as chips after its "+ Task". */
const DONE_CHIPS = 3

/** The lane's latest done tasks as ✓ chips, then "+N more"; any of them opens the stream's Done list. */
function DoneChips({ done, total, now, onOpen }: {
  done: readonly ArchivedTask[]
  total: number
  now: number
  onOpen: () => void
}): React.ReactElement | null {
  if (done.length === 0) return null
  const more = Math.max(0, total - done.length)
  return (
    <span className="flex items-center gap-1.5 min-w-0 px-3 pb-3 overflow-hidden" data-testid="map-done-chips">
      {done.map(entry => (
        <button
          key={entry.task.id}
          type="button"
          className="inline-flex items-center gap-1 h-6 max-w-[180px] min-w-0 px-2 rounded-full border border-border bg-field text-xs text-text-muted cursor-pointer hover:text-text hover:border-border-strong"
          title={`✓ Done: ${entry.task.name}${entry.archivedAt > 0 ? ` · ${formatRelativeTime(entry.archivedAt, now)}` : ''}`}
          onClick={onOpen}
        >
          <Check size={11} strokeWidth={2.5} className="shrink-0 text-running" />
          <span className="truncate">{entry.task.name}</span>
        </button>
      ))}
      {more > 0 && <button type="button" className={`${linkCls} shrink-0`} onClick={onOpen}>+{more} done</button>}
    </span>
  )
}

/**
 * One stream as a lane (board Project.dc.html): the head names it, its branch
 * and where it lives, and how it stands against its base; the track draws its
 * commits older → newer with its open tasks as tips; the end runs its commands.
 */
function StreamLane({ project, stream, color, colorOf, graph, track, notes, local, folderPosture, statuses, statusSince, now, diffs, runs }: {
  project: Project
  stream: Stream
  /** The lane's rail colour. */
  color: string
  /** A live stream's rail colour by name. */
  colorOf: (streamName: string) => string | undefined
  graph: GitBranchGraph | null
  track: LaneTrack
  notes: ReadonlyMap<string, CommitNote>
  local: boolean
  folderPosture: GitPostureResult | null
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diffs: ReadonlyMap<string, GitDiffSummary>
  runs: readonly StreamRunState[]
}): React.ReactElement {
  const [menu, setMenu] = useState<EntityMenuTarget | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const archive = useProjectArchive(project.id, true)
  const ownPosture = useGitPosture(local && stream.workspace ? streamDirectory(project, stream) : '', local && !!stream.workspace, project.id)
  const posture = stream.workspace ? ownPosture : folderPosture
  const trackRef = useScrolledToEnd()
  const openMenu = (x: number, y: number) => setMenu({ x, y, kind: 'stream', projectId: project.id, streamId: stream.id })
  const doneCount = stream.archivedTaskCount ?? 0
  const doneTasks = archive ? archivedTasksOf(visibleArchive(archive, project), stream.id) : []
  const recentDone = doneTasks.slice(0, DONE_CHIPS)
  const baseStreamName = project.streams.find(s => s.workspace ? s.workspace.branchName === stream.workspace?.baseBranch : s.isMain)?.name ?? ''
  const quiet = stream.tasks.length === 0
  // Started tasks sit under the task that started them when both are in this lane.
  const tree = useMemo(() => delegationTree([project]), [project])
  const laneIds = new Set(stream.tasks.map(task => task.id))
  const nestedInLane = new Set(stream.tasks.filter(task => laneIds.has(tree.parentOf.get(task.id) ?? '')).map(task => task.id))
  const laneChildren = (taskId: string): Task[] => {
    const out: Task[] = []
    const walk = (id: string): void => {
      for (const childId of tree.childrenOf.get(id) ?? []) {
        const child = nestedInLane.has(childId) ? tree.tasks.get(childId) : undefined
        if (child && !out.includes(child)) { out.push(child); walk(childId) }
      }
    }
    walk(taskId)
    return out
  }

  // The state line: the project folder's dirty files and origin; a worktree's base and its own dirty files.
  const state: string[] = []
  if (posture?.isGitRepo) {
    if (stream.workspace) {
      const line = aheadBehindLine(track, stream.workspace.baseBranch)
      if (line) state.push(line)
    } else if (stream.isMain && posture.upstream) {
      state.push(posture.ahead === 0 && posture.behind === 0
        ? `even with ${posture.upstream}`
        : [posture.ahead > 0 && `${posture.ahead} ahead`, posture.behind > 0 && `${posture.behind} behind`].filter(Boolean).join(' · ') + ` ${posture.upstream}`)
    }
    if (stream.workspace || stream.isMain) state.unshift(posture.dirtyCount > 0 ? `${posture.dirtyCount} dirty ${plural(posture.dirtyCount, 'file')}` : 'clean')
  }
  const quietLine = [quiet && graph ? quietFor(track.newest?.isoDate, now) : null, quiet && !graph ? 'No open tasks' : null].filter(Boolean)[0]

  return (
    <div className="border-b border-hair" data-testid={`map-lane-${stream.id}`}>
      <div className={`flex flex-col @min-[860px]:flex-row ${quiet ? '@min-[860px]:min-h-[96px]' : '@min-[860px]:min-h-[124px]'}`}>
        <div
          className="min-w-0 px-5 pt-4 pb-1 @min-[860px]:pb-4 @min-[860px]:flex-[0_0_220px] flex flex-col gap-1 box-border"
          onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY) }}
        >
          <div className="flex items-center gap-1 min-w-0">
            <span className={`flex-1 min-w-0 font-mono text-[15px] font-medium truncate ${quiet ? 'text-text-muted' : 'text-text'}`} title={stream.name}>{stream.name}</span>
            <button
              type="button"
              className="shrink-0 flex items-center justify-center size-(--ctl-h-sm) rounded-md bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text hover:bg-sel"
              title={`${stream.name}: stream actions`}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              data-testid={`map-stream-menu-${stream.id}`}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4) }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          <span className="font-mono text-xs text-text-muted truncate" title={stream.workspace?.worktreePath ?? project.directory}>
            {track.branch && <>⎇ {track.branch} · </>}{stream.workspace ? 'own worktree' : 'project folder'}
          </span>
          {state.length > 0 && <span className="text-xs text-text-muted">{state.join(' · ')}</span>}
          {stream.workspace && !aheadBehindLine(track, stream.workspace.baseBranch) && (
            <span className="text-xs text-text-subtle">from <span className="font-mono">{stream.workspace.baseBranch}</span></span>
          )}
          {doneCount > 0 && (
            <button type="button" className={`${linkCls} self-start mt-0.5`} onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen}>
              Done {doneCount}
            </button>
          )}
          <EntityMenuPopup menu={menu} onClose={() => setMenu(null)} />
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={trackRef} className="min-w-0 overflow-x-auto [scrollbar-width:none]" data-testid={`map-track-${stream.id}`}>
            <LaneGraph
              items={track.items.filter(item => item.kind !== 'task' || !nestedInLane.has(item.task.id))}
              notes={notes}
              color={color}
              colorOf={colorOf}
              fork={stream.isMain ? 'history' : stream.workspace ? { base: stream.workspace.baseBranch, color: colorOf(baseStreamName) ?? 'var(--color-text-subtle)' } : 'shared'}
              now={now}
              addTitle={`New task in ${stream.name}`}
              onAdd={() => paletteEvents.emit('open-new-task-in', { projectId: project.id, streamId: stream.id })}
              after={quietLine && <span className="text-xs text-text-muted">{quietLine}</span>}
              renderTask={task => <TaskTip project={project} task={task} statuses={statuses} statusSince={statusSince} now={now} diffs={diffs} tree={tree} nested={laneChildren(task.id)} />}
            />
          </div>
          <DoneChips done={recentDone} total={doneCount} now={now} onOpen={() => setDoneOpen(true)} />
        </div>

        <LaneEnd project={project} stream={stream} runs={runs} />
      </div>
      {doneOpen && (
        <ul className="m-0 list-none px-5 pb-3 pt-0 flex flex-col gap-0.5 max-w-[520px]" aria-label={`${stream.name}: done tasks`}>
          {!archive && <li className="text-xs text-text-subtle">Loading…</li>}
          {doneTasks.map(entry => <DoneTaskItem key={entry.task.id} project={project} entry={entry} />)}
        </ul>
      )}
    </div>
  )
}

/** The last weeks of commits on the project's branch, in the project's colour. */
function RecentHeat({ project, commits }: { project: Project; commits: string[] }): React.ReactElement {
  const cols = useMemo(() => recentWeeks(bucketByDay(commits), new Date(), HEAT_WEEKS), [commits])
  const bin = useMemo(() => quartileBins(cols.flat().map(d => d.count).filter(c => c > 0)), [cols])
  const swatch = projectSwatch(projectTile(project), 'dark')
  const total = cols.flat().reduce((sum, d) => sum + d.count, 0)
  return (
    <div className="flex gap-[3px]" role="img" aria-label={`${total} commits over the last ${HEAT_WEEKS} weeks`}>
      {cols.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[3px]">
          {col.map(day => {
            const level = bin(day.count)
            return (
              <span
                key={day.iso}
                className="w-[10px] h-[10px] rounded-[2px]"
                style={{ background: level === 0 ? 'var(--color-surface-3)' : swatch.bg, opacity: level === 0 ? 1 : 0.25 + level * 0.1875 }}
                title={`${day.date.toLocaleDateString()} · ${day.count} ${plural(day.count, 'commit')}`}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * The desk's Project page (plan change 4): one lane per stream, then the
 * activity. It takes the place of ProjectHome's cards, Git card,
 * branch graph, activity cards and heatmap; the full graph and the year
 * heatmap open from Activity › History.
 */
export default function DeskProjectMap({ projectId }: { projectId: string }): React.ReactElement | null {
  const { projects, notes, effectiveTheme, config } = useApp()
  const project = projects.find(p => p.id === projectId)
  const local = project
    ? !isRemoteProject(project) && !isShellCommandProject(project) && featureAvailable(project, 'git-posture')
    : false
  const projectDir = local && project?.directory ? project.directory : ''
  const posture = useGitPosture(projectDir, local, project?.id)
  const { commits } = useCommitHistory(projectDir, local, project?.id)
  const branches = useMemo(() => project ? [...projectBranchLabels(project, null).keys()].sort() : [], [project])
  const graph = useBranchGraph(projectDir, branches, GRAPH_LIMIT, local && !!posture?.isGitRepo, project?.id)
  const statuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const allRuns = useAllStreamRuns(project ? [project.id] : [])
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState(false)
  const archive = useProjectArchive(project?.id ?? null, !!project)
  // "Needs you · 4m" counts up while the page stays open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const openTasks = useMemo(() => project ? project.streams.flatMap(stream => stream.tasks.map(task => ({ project, task }))) : [], [project])
  const diffs = useTaskDiffSummaries(openTasks)

  if (!project) return null

  const lanes = projectLanes(project, local ? graph : null, archive ? visibleArchive(archive, project) : null)
  const colors = new Map(project.streams.map(stream => [stream.name, streamColor(project, stream, effectiveTheme)]))
  const colorOf = (name: string) => colors.get(name)
  const runsByStream = new Map(project.streams.map(stream => [stream.id, runsOfStream(allRuns, stream.id)]))
  const running = [...runsByStream.values()].flat().filter(run => run.status === 'running').length
  const tasks = projectTasks(project)
  const summary = projectHomeSummary(project, statuses, statusSince, now)
  const lifetime = project.lifetimeStats ?? { tasksCreated: tasks.length, notesCreated: (notes[project.id] ?? []).length }
  const where = project.ssh ? project.ssh.remoteDir : project.directory
  const shellCommand = project.shellCommand?.command.trim()
  const shellName = config?.hosts?.find(h => h.kind === 'shell' && h.command.trim() === shellCommand)
  const host = projectHostLabel(project, project.host ? serverName(project.host) : undefined, shellName?.kind === 'shell' ? shellName.name : undefined)

  const stat = (n: number, label: string) => (
    <span><strong className="text-text text-[15px] font-semibold">{n}</strong> {label}</span>
  )

  return (
    <div className="@container flex-1 min-h-0 min-w-0 overflow-y-auto bg-bg text-text" data-testid="desk-project-map">
      <div className="px-7 pt-5 pb-4 flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-hair">
        <div className="flex items-center gap-3.5 min-w-0">
          <ProjectTileBadge project={project} theme={effectiveTheme} size={44} />
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em] truncate">{project.name}</h1>
            <span className="font-mono text-xs text-text-muted truncate" title={where}>{host}{where ? ` · ${where}` : ''}</span>
          </div>
        </div>
        <span className="flex-1" />
        <div className="flex flex-wrap gap-5 text-xs text-text-muted">
          {stat(project.streams.length, plural(project.streams.length, 'stream'))}
          {stat(tasks.length, plural(tasks.length, 'open task'))}
          {stat(running, running === 1 ? 'app running' : 'apps running')}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={`${ghostCls} border-transparent text-text-muted hover:text-text`} onClick={() => openEntityDialog({ kind: 'project-settings', projectId: project.id })} data-testid="map-project-settings">
            <Cog size={14} /> Settings
          </button>
          <button type="button" className={ghostCls} onClick={() => paletteEvents.emit('open-new-stream', project.id)} title={formatShortcutForApp('CmdOrCtrl+Alt+N')}>
            New stream
          </button>
          <button
            type="button"
            className={`${ghostCls} border-accent bg-accent text-accent-ink font-semibold hover:bg-accent hover:brightness-105`}
            onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id })}
            title={formatShortcutForApp('CmdOrCtrl+N')}
          >
            New task
          </button>
        </div>
      </div>

      <div className="hidden @min-[860px]:flex py-2.5 border-b border-hair">
        <span className={`${headCls} flex-[0_0_220px] px-5 box-border`}>Stream</span>
        <span className={`${headCls} flex-1 px-3`}>Branch · older → newer</span>
        <span className={`${headCls} flex-[0_0_260px] px-5 box-border`}>Apps</span>
      </div>

      {project.streams.map(stream => (
        <StreamLane
          key={stream.id}
          project={project}
          stream={stream}
          color={colors.get(stream.name) ?? streamColor(project, stream, effectiveTheme)}
          colorOf={colorOf}
          graph={local ? graph : null}
          track={lanes.get(stream.id)!.track}
          notes={lanes.get(stream.id)!.notes}
          local={local}
          folderPosture={posture}
          statuses={statuses}
          statusSince={statusSince}
          now={now}
          diffs={diffs}
          runs={runsByStream.get(stream.id) ?? []}
        />
      ))}
      <div className="px-5 py-2"><ArchivedStreamsLine project={project} /></div>

      <div className="flex flex-wrap gap-4 px-7 pt-2 pb-6">
        <div className="flex-[1_1_320px] min-w-0 self-start mt-2 border border-border rounded-[10px] bg-field px-4 py-3.5 flex flex-col gap-2.5" data-testid="map-activity">
          <div className="flex items-center gap-2">
            <span className={headCls}>Activity</span>
            <span className="flex-1" />
            {local && posture?.isGitRepo && (
              <button type="button" className={linkCls} onClick={() => setHistory(!history)} aria-expanded={history}>
                {history ? 'Hide history' : 'History'}
              </button>
            )}
          </div>
          {local && posture?.isGitRepo && <RecentHeat project={project} commits={commits} />}
          {posture?.lastCommit && (
            <span className="text-xs text-text-muted truncate" title={posture.lastCommit.subject}>
              Last commit: {posture.lastCommit.subject} · {formatRelativeTime(new Date(posture.lastCommit.isoDate).getTime(), now)} · {posture.lastCommit.author}
            </span>
          )}
          <span className="text-xs text-text-muted">
            {summary.agents.length > 0 ? `Agents: ${summary.agents.map(a => `${a.count} ${a.label}`).join(', ')} · ` : ''}
            {lifetime.tasksCreated} {plural(lifetime.tasksCreated, 'task')} created · {lifetime.notesCreated} {plural(lifetime.notesCreated, 'note')} written
          </span>
        </div>
        {tokenUsageAvailable(project) && <ProjectTokensCard project={project} />}
        {schedulesShown(project) && <SchedulesCard project={project} now={now} />}
      </div>

      {history && local && (
        <div className="px-7 pb-8 flex flex-col gap-3" data-testid="map-history">
          <BranchGraph project={project} projectDir={projectDir} enabled />
          <CommitHeatmap isoTimestamps={commits} />
        </div>
      )}
    </div>
  )
}
