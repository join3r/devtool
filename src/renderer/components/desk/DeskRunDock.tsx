import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Play, RotateCw, ScrollText, Square, X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { findStreamRunCommand, streamRunKey, type StreamRunAction } from '../../../shared/stream-run'
import {
  controlStreamRun, dismissStreamRunCrash, openStreamRunLogs, useAllStreamRuns, useDismissedStreamRunCrashes
} from '../../streamRuns'
import ProjectTileBadge from '../ProjectTileBadge'
import { formatRelativeAge, inboxApps, type InboxApp } from '../inbox'
import { openBenchRun } from './benchState'
import { runDockFolds, runLogTaskId, statusRunLabel } from './statusBar'

/**
 * A run's log: in the Bench of its task, or of the task this window shows when
 * it is of the same project; else the logs window. The run dock and ⌘K.
 */
export function openRunLog(app: InboxApp, here: {
  selectedProjectId: string | null
  selectedTaskId: string | null
  switchToTask: (projectId: string, taskId: string) => void
}): void {
  const target = { projectId: app.project.id, streamId: app.stream.id, commandId: app.run.commandId }
  const taskId = runLogTaskId(app, { projectId: here.selectedProjectId, taskId: here.selectedTaskId })
  if (!taskId) {
    openStreamRunLogs(target)
    return
  }
  if (taskId !== here.selectedTaskId) here.switchToTask(app.project.id, taskId)
  openBenchRun(taskId, target)
}

/** The clock, every 30s: enough for "4m", "1h". */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/**
 * The stream commands that run or crashed, docked over the bottom of the Inbox
 * column (they used to sit in the status bar). Absent while nothing runs. Each
 * row opens its log; Restart and Stop while it runs, Run again and dismiss once
 * it crashed. More than three fold into a header that opens them.
 * `onHeight` lets the list leave room below its last row.
 */
export default function DeskRunDock({ onHeight }: { onHeight: (px: number) => void }): React.ReactElement | null {
  const { projects, selectedProjectId, selectedTaskId, switchToTask, effectiveTheme } = useApp()
  const projectIds = useMemo(() => projects.map(project => project.id), [projects])
  const runs = useAllStreamRuns(projectIds)
  const dismissed = useDismissedStreamRunCrashes()
  const apps = useMemo(() => inboxApps(projects, runs, dismissed), [projects, runs, dismissed])
  const now = useMinuteClock(apps.length > 0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const visible = apps.length > 0
  const folds = runDockFolds(apps.length)
  const showRows = !folds || open

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) { onHeight(0); return }
    const report = (): void => onHeight(el.offsetHeight + 16)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible, onHeight])

  if (!visible) return null
  const crashed = apps.filter(app => app.crashed).length
  const running = apps.length - crashed
  const here = { selectedProjectId, selectedTaskId, switchToTask }

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Running commands"
      className="absolute left-2 right-2 bottom-2 z-10 max-h-[50%] flex flex-col rounded-[10px] border border-hair bg-surface-2 shadow-[0_-10px_28px_rgba(0,0,0,0.35)] overflow-hidden text-xs"
      onClick={(e) => e.stopPropagation()}
      data-testid="desk-run-dock"
    >
      {folds && (
        <button
          type="button"
          className="shrink-0 flex items-center gap-2 px-2.5 py-2 bg-transparent border-0 text-left text-text-muted cursor-pointer hover:text-text"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          data-testid="desk-run-dock-toggle"
        >
          <span className={`size-[7px] shrink-0 rounded-full ${crashed > 0 ? 'bg-crashed' : 'bg-running'}`} />
          <span>
            {running > 0 && `${running} running`}
            {running > 0 && crashed > 0 && ' · '}
            {crashed > 0 && <span className="text-danger">{crashed} crashed</span>}
          </span>
          <span className="ml-auto text-text-subtle">{open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</span>
        </button>
      )}
      {showRows && (
        <div className="min-h-0 overflow-y-auto">
          {apps.map((app, index) => (
            <DockRow
              key={streamRunKey(app.stream.id, app.run.commandId)}
              app={app}
              now={now}
              theme={effectiveTheme}
              divided={folds || index > 0}
              onLog={() => openRunLog(app, here)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DockRow({ app, now, theme, divided, onLog }: {
  app: InboxApp
  now: number
  theme: 'dark' | 'light'
  divided: boolean
  onLog: () => void
}): React.ReactElement {
  const { project, stream, run, crashed } = app
  const canRun = !!findStreamRunCommand(project, stream, run.commandId)
  const act = (action: StreamRunAction): void => { void controlStreamRun(project.id, stream.id, run.commandId, action, run.taskId) }
  const where = stream.isMain ? project.name : `${project.name} › ${stream.name}`
  const age = formatRelativeAge(now - (crashed ? run.endedAt ?? run.startedAt : run.startedAt))
  const when = crashed ? `Exited ${run.exitCode ?? '?'} · ${age === 'now' ? 'just now' : `${age} ago`}` : age === 'now' ? 'just started' : age
  return (
    <div
      className={`group flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-sel ${divided ? 'border-t-[0.5px] border-hair' : ''}`}
      title={`${statusRunLabel(app)}\n${run.command}\nClick for its log`}
      onClick={onLog}
      data-testid="desk-status-run"
      data-app-state={crashed ? 'crashed' : 'running'}
    >
      <span className={`size-[7px] shrink-0 rounded-full ${crashed ? 'bg-crashed' : 'bg-running'}`} />
      <ProjectTileBadge project={project} theme={theme} size={20} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="font-mono text-text truncate">{run.name}</span>
        <span className={`truncate text-[11px] ${crashed ? 'text-danger' : 'text-text-subtle'}`}>{where} · {when}</span>
      </span>
      <span className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
        <DockButton title="Show its log" onClick={onLog}><ScrollText size={12} /></DockButton>
        {crashed ? (
          <>
            <DockButton title={canRun ? `Run ${run.name} again` : 'This command is no longer set'} disabled={!canRun} onClick={() => act('start')}><Play size={12} /></DockButton>
            <DockButton title="Dismiss until it runs again" onClick={() => dismissStreamRunCrash(stream.id, run)}><X size={12} /></DockButton>
          </>
        ) : (
          <>
            {canRun && <DockButton title={`Restart ${run.name}`} onClick={() => act('restart')}><RotateCw size={12} /></DockButton>}
            <DockButton title={`Stop ${run.name}`} onClick={() => act('stop')}><Square size={12} /></DockButton>
          </>
        )}
      </span>
    </div>
  )
}

function DockButton({ title, disabled, onClick, children }: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-center size-6 rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-sel disabled:opacity-40 disabled:cursor-default"
    >
      {children}
    </button>
  )
}
