import React, { useEffect, useMemo, useState } from 'react'
import { childProgress, childProgressLine, delegationTree, statusFrom, waitingOnChildren, type DelegationTree } from '../../../shared/delegation'
import { Check, Cog, MoreHorizontal, Plus } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../../context/TabStatusContext'
import { isRemoteProject, isShellCommandProject, type GitBranchGraph, type GitDiffSummary, type GitPostureResult, type Project, type Stream, type TabStatusValue } from '../../../shared/types'
import { featureAvailable } from '../../../shared/project-features'
import { findMainStream, projectTasks, streamDirectory } from '../../../shared/streams'
import { visibleArchive, type ArchivedTask, type ProjectArchive } from '../../../shared/archive'
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
import { projectBranchLabels, useBranchGraph } from '../BranchGraph'
import { CommitHeatmap } from '../CommitHeatmap'
import { ProjectTokensCard, tokenUsageAvailable } from '../TokenUsage'
import { ArchivedStreamsLine } from './DoneItems'
import { SchedulesCard, schedulesShown } from './DeskSchedules'
import { StreamRunButtons } from '../StreamRunControls'
import { bucketByDay, formatRelativeTime, quartileBins } from '../projectStats'
import { taskAgentLabel, taskStatusChip, type TaskChipTone } from '../taskHeaderState'
import { projectHomeSummary } from '../projectHomeState'
import { useDoneRowActions } from '../sidebar/doneActions'
import { ContextMenu, type ContextMenuItem } from '../ui'
import type { GraphSegment } from '../gitGraphLayout'
import { aheadBehindLine, plural, projectGraph, projectHostLabel, quietFor, recentWeeks, streamAheadBehind, streamTip, type GraphRow, type ProjectGraph } from './projectMap'
import { CommitHoverDetails, DoneHoverDetails, HoverCard, TaskHoverDetails, useHoverCard } from './GraphHoverCard'

const GRAPH_LIMIT = 150
/** The most commits the graph loads, however far back it is shown. */
const GRAPH_LIMIT_MAX = 20_000
/** Rows the graph shows with done tasks (without, it shows down to where its streams and tasks branch off), and how many more each "Show older" adds. */
const ROWS_DONE = 40
const ROWS_STEP = 40
const HEAT_WEEKS = 16

/** The graph's measures, in px. */
const ROW_H = 30
const LANE_W = 16

const ghostCls = 'shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-border-strong bg-transparent text-sm text-text cursor-pointer hover:bg-sel transition-colors duration-(--motion-fast)'
const smallGhostCls = 'shrink-0 inline-flex items-center h-6 px-2 rounded-md border border-border-strong bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)'
const linkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-muted hover:text-text hover:underline'
const headCls = 'text-2xs font-semibold uppercase tracking-[0.07em] text-text-muted'
/** Lines and nodes of commits no live stream owns. */
const NOBODY = 'var(--color-border-strong)'

/** A task's status pill: amber needs you, blue your turn, grey working (pulsing), quiet otherwise. */
const TIP: Record<TaskChipTone, { pill: string; dot: string; text: string }> = {
  attention: {
    pill: 'border-[color-mix(in_srgb,var(--color-needs)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-needs)_7%,var(--color-field))]',
    dot: 'bg-needs',
    text: 'text-needs'
  },
  turn: { pill: 'border-[color-mix(in_srgb,var(--color-answered)_35%,transparent)] bg-field', dot: 'bg-answered', text: 'text-answered' },
  working: { pill: 'border-border bg-field', dot: 'bg-text-muted desk-pulse', text: 'text-text-muted' },
  quiet: { pill: 'border-border bg-field', dot: 'border border-border-strong', text: 'text-text-subtle' }
}

/** One command in a stream's row: state dot, name, Run (Restart/Stop while it runs) and its Logs. */
function CommandItem({ project, stream, id, name, command, run, defined }: {
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
      <span className="min-w-0 max-w-[200px] font-mono text-text truncate" title={`$ ${command} · ${state}${task ? ` · in ${task.name}` : ''}`}>
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
 * A stream's commands, side by side. A non-main stream's commands that only
 * repeat the project's and never ran here fold into "Inherits dev, test",
 * which opens to them.
 */
function StreamCommands({ project, stream, runs }: {
  project: Project
  stream: Stream
  runs: readonly StreamRunState[]
}): React.ReactElement | null {
  const [showInherited, setShowInherited] = useState(false)
  const commands = streamRunCommands(project, stream)
  const own = new Set(streamOwnRunCommands(project, stream).map(c => c.name.trim().toLowerCase()))
  const ids = new Set(commands.map(c => c.id))
  const rows = [
    ...commands.map(c => ({ ...c, defined: true, inherited: !stream.isMain && !own.has(c.name.trim().toLowerCase()) })),
    // A command removed while it ran keeps its row until the run is gone.
    ...runs.filter(r => !ids.has(r.commandId)).map(r => ({ id: r.commandId, name: r.name, command: r.command, defined: false, inherited: false }))
  ]
  if (rows.length === 0) return null
  const runOf = (id: string) => runs.find(r => r.commandId === id)
  const folded = showInherited ? [] : rows.filter(r => r.inherited && !runOf(r.id))
  const shown = rows.filter(r => !folded.includes(r))
  const main = findMainStream(project)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 min-w-0">
      {shown.map(row => (
        <CommandItem key={row.id} project={project} stream={stream} id={row.id} name={row.name} command={row.command} run={runOf(row.id)} defined={row.defined} />
      ))}
      {folded.length > 0 && (
        <button type="button" className={`${linkCls} text-left text-text-subtle`} onClick={() => setShowInherited(true)} title="Show them to run them in this stream">
          Inherits <span className="font-mono">{folded.map(r => r.name).join(', ')}</span>{main ? ` from ${main.name}` : ''}
        </button>
      )}
    </div>
  )
}

/**
 * A stream's colour on the graph: main takes the project's own colour; the
 * other streams step around the palette from it, so neighbours differ.
 */
function streamColor(project: Project, stream: Stream, theme: 'light' | 'dark'): string {
  const tile = projectTile(project)
  const others = project.streams.filter(s => !s.isMain)
  const step = stream.isMain ? 0 : 3 * (others.indexOf(stream) + 1)
  return PROJECT_TILE_PALETTE[(tile.hue + step) % PROJECT_TILE_PALETTE.length][theme].fg
}

/**
 * One stream above the graph: its colour (its branch's on the graph), name
 * and menu, its branch and how it stands, its commands, and + Task.
 */
function StreamRow({ project, stream, color, graph, local, folderPosture, now, runs }: {
  project: Project
  stream: Stream
  color: string
  graph: GitBranchGraph | null
  local: boolean
  folderPosture: GitPostureResult | null
  now: number
  runs: readonly StreamRunState[]
}): React.ReactElement {
  const [menu, setMenu] = useState<EntityMenuTarget | null>(null)
  const ownPosture = useGitPosture(local && stream.workspace ? streamDirectory(project, stream) : '', local && !!stream.workspace, project.id)
  const posture = stream.workspace ? ownPosture : folderPosture
  const openMenu = (x: number, y: number) => setMenu({ x, y, kind: 'stream', projectId: project.id, streamId: stream.id })
  const branch = stream.workspace?.branchName ?? graph?.head ?? null
  const tip = streamTip(graph, stream)
  const tipDate = tip ? graph?.commits.find(c => c.hash === tip)?.isoDate : undefined
  const quiet = stream.tasks.length === 0

  // The state line: the folder's dirty files and origin; a worktree's base and its own dirty files.
  const state: string[] = []
  const vsBase = stream.workspace ? aheadBehindLine(streamAheadBehind(graph, stream), stream.workspace.baseBranch) : null
  if (posture?.isGitRepo) {
    if (stream.workspace || stream.isMain) state.push(posture.dirtyCount > 0 ? `${posture.dirtyCount} dirty ${plural(posture.dirtyCount, 'file')}` : 'clean')
    if (vsBase) state.push(vsBase)
    else if (stream.isMain && posture.upstream) {
      state.push(posture.ahead === 0 && posture.behind === 0
        ? `even with ${posture.upstream}`
        : [posture.ahead > 0 && `${posture.ahead} ahead`, posture.behind > 0 && `${posture.behind} behind`].filter(Boolean).join(' · ') + ` ${posture.upstream}`)
    }
  }
  if (stream.workspace && !vsBase) state.push(`from ${stream.workspace.baseBranch}`)
  const quietLine = quiet ? (graph ? quietFor(tipDate, now) : 'No open tasks') : null
  if (quietLine) state.push(quietLine)

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-7 py-2.5 border-b border-hair"
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY) }}
      data-testid={`map-lane-${stream.id}`}
    >
      <div className="flex items-center gap-2 min-w-0 w-[220px] max-w-full">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} aria-hidden />
        <span className={`min-w-0 font-mono text-[15px] font-medium truncate ${quiet ? 'text-text-muted' : 'text-text'}`} title={stream.name}>{stream.name}</span>
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
      <div className="flex-1 min-w-[220px] flex flex-col gap-0.5 text-xs text-text-muted">
        <span className="font-mono truncate" title={stream.workspace?.worktreePath ?? project.directory}>
          {branch && <>⎇ {branch} · </>}{stream.workspace ? 'own worktree' : 'project folder'}
        </span>
        {state.length > 0 && <span className="truncate">{state.join(' · ')}</span>}
      </div>
      <StreamCommands project={project} stream={stream} runs={runs} />
      <button
        type="button"
        className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-full border border-dashed border-border-strong bg-transparent text-xs text-text-subtle cursor-pointer hover:text-text hover:border-text-subtle"
        title={`New task in ${stream.name}`}
        onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id, streamId: stream.id })}
      >
        <Plus size={12} /> Task
      </button>
      <EntityMenuPopup menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

/** A row's lines and node: each line in its stream's colour, a task's still dashed. */
function RowLanes({ row, width, colorOf, edgeOwner, nodeOwner }: {
  row: GraphRow
  width: number
  colorOf: (streamId: string | undefined) => string
  edgeOwner: (segment: GraphSegment) => string | undefined
  nodeOwner: string | undefined
}): React.ReactElement {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  const color = colorOf(nodeOwner)
  const { item } = row
  const node = (() => {
    if (row.column === null) return null
    const cx = x(row.column)
    if (item.kind === 'task') {
      return <circle cx={cx} cy={mid} r={5.5} fill="var(--color-bg)" stroke={color} strokeWidth={1.75} strokeDasharray="2.5 2" />
    }
    if (item.kind !== 'commit') return null
    if (item.done.length > 0) {
      return (
        <g>
          <circle cx={cx} cy={mid} r={6.5} fill={color} />
          <path d={`M${cx - 3} ${mid} l2 2.2 l4 -4.4`} fill="none" stroke="var(--color-bg)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    }
    if (item.heads.length > 0) return <circle cx={cx} cy={mid} r={5} fill="var(--color-bg)" stroke={color} strokeWidth={2.5} />
    if (row.merge) return <circle cx={cx} cy={mid} r={3.5} fill="var(--color-bg)" stroke={color} strokeWidth={1.5} />
    return <circle cx={cx} cy={mid} r={3.5} fill={color} />
  })()
  return (
    <svg width={Math.max(1, width) * LANE_W} height={ROW_H} className="shrink-0 block overflow-visible" aria-hidden>
      {row.segments.map((s, i) => {
        const [y1, y2] = s.part === 'top' ? [0, mid] : s.part === 'bottom' ? [mid, ROW_H] : [0, ROW_H]
        const d = s.from === s.to
          ? `M${x(s.from)} ${y1} L${x(s.to)} ${y2}`
          : `M${x(s.from)} ${y1} C${x(s.from)} ${(y1 + y2) / 2} ${x(s.to)} ${(y1 + y2) / 2} ${x(s.to)} ${y2}`
        const pending = s.child.startsWith('task:')
        const dotted = row.dotted.includes(s.lane)
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={colorOf(edgeOwner(s))}
            strokeWidth={pending ? 1.5 : 2}
            strokeDasharray={dotted ? '1 4' : pending ? '3 3' : undefined}
            strokeLinecap={dotted ? 'round' : undefined}
            opacity={pending ? 0.8 : 0.9}
          />
        )
      })}
      {node}
    </svg>
  )
}

const chipCls = 'shrink-0 inline-flex items-center max-w-[180px] h-[18px] px-1.5 rounded-sm border font-mono text-2xs truncate'

/**
 * The project's branches on one graph, newest first: open tasks on top at
 * the tips of their branches, then the commits, plain runs folded. Each row
 * opens a card on hover; a task opens on click, a done task read-only.
 */
function GraphView({ project, model, archive, streamName, colorOf, statuses, statusSince, now, diffs, tree, onExpand }: {
  project: Project
  model: ProjectGraph
  archive: ProjectArchive | null
  streamName: (streamId: string) => string | undefined
  colorOf: (streamId: string | undefined) => string
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diffs: ReadonlyMap<string, GitDiffSummary>
  tree: DelegationTree
  onExpand: (key: string) => void
}): React.ReactElement {
  const { switchToTask } = useApp()
  const doneActions = useDoneRowActions()
  const hover = useHoverCard<string>()
  const [menu, setMenu] = useState<{ x: number; y: number; entry: ArchivedTask } | null>(null)
  const statusOf = statusFrom(statuses)
  const ago = (iso: string) => formatRelativeTime(new Date(iso).getTime(), now)

  const openDone = (entry: ArchivedTask) => doneActions.open({ projectId: project.id, kind: 'task', id: entry.task.id })
  const doneMenu = (e: React.MouseEvent, entry: ArchivedTask) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry }) }
  const menuItems = (entry: ArchivedTask): ContextMenuItem[] => {
    // Only a task closed from a live stream reopens or deletes on its own; a closed stream's go with it.
    const own = archive?.tasks.some(e => e.task.id === entry.task.id) ?? false
    return [
      { label: 'Open', onSelect: () => openDone(entry) },
      ...(own ? [
        { label: 'Reopen', onSelect: () => doneActions.reopenTask(project.id, entry.task.id) },
        { label: 'Delete permanently…', onSelect: () => doneActions.deleteTask(project.id, entry), danger: true }
      ] : [])
    ]
  }
  const doneLabel = (entries: readonly ArchivedTask[]) => (
    <>
      {entries.map((entry, i) => (
        <React.Fragment key={entry.task.id}>
          {i > 0 && <span className="text-text-subtle">, </span>}
          <button
            type="button"
            className="min-w-0 inline-flex items-center gap-1 bg-transparent border-0 p-0 text-sm text-text-muted cursor-pointer hover:text-text hover:underline truncate"
            onClick={() => openDone(entry)}
            onContextMenu={(e) => doneMenu(e, entry)}
          >
            <Check size={12} strokeWidth={2.5} className="shrink-0 text-running" />
            <span className="truncate">{entry.task.name}</span>
          </button>
        </React.Fragment>
      ))}
      {entries[0].archivedAt > 0 && <span className="shrink-0 text-xs text-text-subtle">closed {formatRelativeTime(entries[0].archivedAt, now)}</span>}
    </>
  )

  const card = (row: GraphRow): React.ReactNode => {
    const { item } = row
    if (item.kind === 'task') {
      const chip = taskStatusChip(item.task, statuses, statusSince, now, waitingOnChildren(tree, item.task, statusOf))
      const tone = chip?.tone ?? 'quiet'
      const agent = taskAgentLabel(item.task)
      const progress = childProgress(tree, item.task, statusOf)
      return (
        <TaskHoverDetails
          task={item.task}
          status={{ label: `${chip?.label ?? 'Open'}${agent ? ` · ${agent}` : ''}`, dot: TIP[tone].dot, text: TIP[tone].text }}
          statuses={statuses}
          diff={diffs.get(item.task.id)}
          progress={progress ? childProgressLine(progress) : null}
          now={now}
        />
      )
    }
    if (item.kind === 'commit') {
      if (item.done.length > 0) return <DoneHoverDetails name={item.done[0].task.name} entry={item.done[0]} commit={item.commit} now={now} />
      return <CommitHoverDetails commit={item.commit} heads={[...item.heads.flatMap(id => streamName(id) ?? []), ...item.branches]} now={now} />
    }
    if (item.kind === 'done') return <DoneHoverDetails name={item.entry.task.name} entry={item.entry} commit={undefined} now={now} />
    return null
  }
  const shownRow = hover.shown ? model.rows.find(r => r.item.key === hover.shown?.target) : undefined
  const shownCard = shownRow ? card(shownRow) : null

  return (
    <div className="flex flex-col min-w-0 pb-2" data-testid="map-graph">
      {model.rows.map(row => {
        const { item } = row
        const nodeOwner = row.column !== null ? model.owner.get(item.key) : undefined
        const lanes = <RowLanes row={row} width={model.width} colorOf={colorOf} edgeOwner={model.edgeOwner} nodeOwner={nodeOwner} />
        const rowCls = 'flex items-center gap-2.5 min-w-0 px-7'

        if (item.kind === 'task') {
          const { task } = item
          const chip = taskStatusChip(task, statuses, statusSince, now, waitingOnChildren(tree, task, statusOf))
          const tone = chip?.tone ?? 'quiet'
          const agent = taskAgentLabel(task)
          const label = chip
            ? chip.tone === 'working' && agent && agent !== 'Claude' ? `${chip.label} · ${agent}` : chip.label
            : 'Open'
          const progress = childProgress(tree, task, statusOf)
          const diff = diffs.get(task.id)
          return (
            <div key={item.key} className={`${rowCls} hover:bg-surface-3`} style={{ height: ROW_H }}>
              {lanes}
              <button
                type="button"
                className="flex-1 min-w-0 h-full flex items-center gap-2 bg-transparent border-0 p-0 text-left cursor-pointer"
                {...hover.anchor(item.key)}
                onClick={() => switchToTask(project.id, task.id)}
                data-testid={`map-task-${task.id}`}
              >
                <span className={`shrink-0 inline-flex items-center gap-1.5 h-5 px-2 rounded-full border text-2xs ${TIP[tone].pill} ${TIP[tone].text}`}>
                  <span className={`w-[6px] h-[6px] rounded-full shrink-0 ${TIP[tone].dot}`} />
                  {label}
                </span>
                {item.nested && <span className="shrink-0 text-text-subtle" aria-hidden>↳</span>}
                <span className="min-w-0 truncate text-sm font-medium text-text">{task.name}</span>
                {progress && <span className="shrink-0 text-xs text-text-muted" data-testid="map-task-children">{childProgressLine(progress)}</span>}
                {task.workspace && <span className="shrink-0 min-w-0 max-w-[200px] truncate font-mono text-2xs text-text-subtle">⎇ {task.workspace.branchName}</span>}
                {diff && (diff.added > 0 || diff.deleted > 0) && (
                  <span className="shrink-0 font-mono text-2xs">
                    <span className="text-running">+{formatLineCount(diff.added)}</span> <span className="text-crashed">−{formatLineCount(diff.deleted)}</span>
                  </span>
                )}
              </button>
            </div>
          )
        }

        if (item.kind === 'commit') {
          const { commit } = item
          const done = item.done.length > 0
          return (
            <div key={item.key} className={`${rowCls} hover:bg-surface-3`} style={{ height: ROW_H }} data-testid={`map-commit-${commit.hash}`} data-done={done || undefined}>
              {lanes}
              <div className="flex-1 min-w-0 h-full flex items-center gap-2" {...hover.anchor(item.key)}>
                {item.heads.map(id => (
                  <span key={id} className={`${chipCls} font-semibold text-text`} style={{ borderColor: colorOf(id) }}>{streamName(id)}</span>
                ))}
                {item.branches.map(name => <span key={name} className={`${chipCls} border-border-strong text-text-muted`}>{name}</span>)}
                {done
                  ? doneLabel(item.done)
                  : <span className={`min-w-0 truncate text-sm ${item.heads.length > 0 ? 'text-text' : 'text-text-muted'}`}>{commit.subject}</span>}
                <span className="flex-1" />
                <span className="shrink-0 text-xs text-text-subtle">{ago(commit.isoDate)}</span>
                <span className="shrink-0 font-mono text-2xs text-text-subtle w-[7ch] text-right">{commit.hash.slice(0, 7)}</span>
              </div>
            </div>
          )
        }

        if (item.kind === 'fold') {
          const times = item.commits.map(c => new Date(c.isoDate).getTime()).filter(Number.isFinite)
          const newest = times.length > 0 ? formatRelativeTime(Math.max(...times), now) : ''
          const oldest = times.length > 0 ? formatRelativeTime(Math.min(...times), now) : ''
          return (
            <div key={`fold:${item.key}`} className={rowCls} style={{ height: ROW_H }} data-testid="map-fold">
              {lanes}
              <button type="button" className={`${linkCls} text-text-subtle`} onClick={() => onExpand(item.key)} title="Show these commits">
                ⋯ {item.commits.length} commits
              </button>
              {newest && <span className="text-xs text-text-subtle">{newest === oldest ? newest : `${newest} – ${oldest}`}</span>}
            </div>
          )
        }

        if (item.kind === 'done') {
          return (
            <div key={item.key} className={`${rowCls} hover:bg-surface-3`} style={{ height: ROW_H }} data-testid={`map-done-${item.entry.task.id}`}>
              {lanes}
              <div className="flex-1 min-w-0 h-full flex items-center gap-2" {...hover.anchor(item.key)}>
                {doneLabel([item.entry])}
                <span className="shrink-0 text-xs text-text-subtle">· no commit</span>
              </div>
            </div>
          )
        }

        return (
          <div key={item.key} className={rowCls} style={{ height: ROW_H }} data-testid={`map-stream-event-${item.key}`}>
            {lanes}
            <span className="min-w-0 truncate text-xs text-text-subtle">
              Stream “{item.name}” {item.what} · {formatRelativeTime(item.at, now)}
            </span>
          </div>
        )
      })}
      {hover.shown && shownCard && <HoverCard rect={hover.shown.rect} testId="map-card">{shownCard}</HoverCard>}
      <ContextMenu menu={menu} items={menu ? menuItems(menu.entry) : []} onClose={() => setMenu(null)} />
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
 * The desk's Project page: its streams, each a row with its branch's state
 * and commands, then the project's branches on one graph with the open tasks
 * at their tips (done tasks on demand), then the activity. The year heatmap
 * opens from Activity › History.
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
  const [showDone, setShowDone] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  /** Null: the graph's own focus, or ROWS_DONE with done tasks shown. */
  const [rowLimit, setRowLimit] = useState<number | null>(null)
  const [graphLimit, setGraphLimit] = useState(GRAPH_LIMIT)
  useEffect(() => { setShowDone(false); setExpanded(new Set()); setRowLimit(null); setGraphLimit(GRAPH_LIMIT) }, [projectId])
  const graph = useBranchGraph(projectDir, branches, graphLimit, local && !!posture?.isGitRepo, project?.id)
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
  const visible = useMemo(() => project && archive ? visibleArchive(archive, project) : null, [project, archive])
  const shownGraph = local ? graph : null
  const model = useMemo(
    () => project ? projectGraph(project, shownGraph, visible, { showDone, expanded, rowLimit: rowLimit ?? (showDone ? ROWS_DONE : undefined) }) : null,
    [project, shownGraph, visible, showDone, expanded, rowLimit]
  )
  const tree = useMemo(() => delegationTree(project ? [project] : []), [project])

  if (!project || !model) return null

  const colors = new Map(project.streams.map(stream => [stream.id, streamColor(project, stream, effectiveTheme)]))
  const colorOf = (streamId: string | undefined) => (streamId && colors.get(streamId)) || NOBODY
  const streamName = (streamId: string) => project.streams.find(s => s.id === streamId)?.name
  const runsByStream = new Map(project.streams.map(stream => [stream.id, runsOfStream(allRuns, stream.id)]))
  const running = [...runsByStream.values()].flat().filter(run => run.status === 'running').length
  const tasks = projectTasks(project)
  const summary = projectHomeSummary(project, statuses, statusSince, now)
  const lifetime = project.lifetimeStats ?? { tasksCreated: tasks.length, notesCreated: (notes[project.id] ?? []).length }
  const where = project.ssh ? project.ssh.remoteDir : project.directory
  const shellCommand = project.shellCommand?.command.trim()
  const shellName = config?.hosts?.find(h => h.kind === 'shell' && h.command.trim() === shellCommand)
  const host = projectHostLabel(project, project.host ? serverName(project.host) : undefined, shellName?.kind === 'shell' ? shellName.name : undefined)
  const doneCount = visible ? visible.tasks.length + visible.streams.reduce((n, e) => n + e.doneTasks.length, 0) : 0
  const lastRow = model.rows[model.rows.length - 1]
  // A fold at the bottom already holds what is loaded: open it to go further back.
  const canShowOlder = model.cut || (!!shownGraph?.more && graphLimit < GRAPH_LIMIT_MAX && lastRow?.item.kind !== 'fold')
  const showOlder = () => {
    setRowLimit(model.rows.length + ROWS_STEP)
    if (!model.cut && shownGraph?.more) setGraphLimit(l => Math.min(l * 2, GRAPH_LIMIT_MAX))
  }

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

      <div className="px-7 pt-4 pb-1.5 border-b border-hair"><span className={headCls}>Streams</span></div>
      {project.streams.map(stream => (
        <StreamRow
          key={stream.id}
          project={project}
          stream={stream}
          color={colorOf(stream.id)}
          graph={shownGraph}
          local={local}
          folderPosture={posture}
          now={now}
          runs={runsByStream.get(stream.id) ?? []}
        />
      ))}
      <div className="px-6 py-2"><ArchivedStreamsLine project={project} /></div>

      <div className="flex items-center gap-3 px-7 pt-3 pb-1.5">
        <span className={headCls}>{shownGraph ? 'Branches · newest first' : 'Open tasks'}</span>
        <span className="flex-1" />
        {doneCount > 0 && (
          <button type="button" className={smallGhostCls} aria-pressed={showDone} onClick={() => { setShowDone(!showDone); setRowLimit(null) }} data-testid="map-show-done">
            {showDone ? 'Hide done tasks' : `Show done tasks · ${doneCount}`}
          </button>
        )}
      </div>
      {model.rows.length > 0
        ? (
          <GraphView
            project={project}
            model={model}
            archive={visible}
            streamName={streamName}
            colorOf={colorOf}
            statuses={statuses}
            statusSince={statusSince}
            now={now}
            diffs={diffs}
            tree={tree}
            onExpand={(key) => setExpanded(prev => new Set(prev).add(key))}
          />
        )
        : <div className="px-7 pb-3 text-xs text-text-subtle">No open tasks</div>}
      {canShowOlder && (
        <div className="px-7 pb-3">
          <button type="button" className={linkCls} onClick={showOlder} data-testid="map-show-older">Show older</button>
        </div>
      )}

      <div className="flex flex-wrap gap-4 px-7 pt-2 pb-6 border-t border-hair">
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
          <CommitHeatmap isoTimestamps={commits} />
        </div>
      )}
    </div>
  )
}
