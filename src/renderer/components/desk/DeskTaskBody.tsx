import React, { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, FolderOpen, GitCompare, Globe, SquareTerminal, StickyNote, X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Project, Task } from '../../../shared/types'
import { findTabLocation } from '../../../shared/panes'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import TaskPanes from '../TaskPanes'
import StreamRunLogs from '../StreamRunLogs'
import { useStreamRun, type StreamRunLogsTarget } from '../../streamRuns'
import { streamRunCrashed } from '../../../shared/stream-run'
import { FileBrowserBody, hasLocalFileTabs } from '../FileBrowserPanel'
import { setFocusedPane, useFocusedPane } from '../paneFocus'
import {
  benchCurrentItem,
  benchNewTabPane,
  benchPanes,
  benchTabOfType,
  conversationTabId,
  taskTabIds,
  type BenchItem,
  type BenchPane,
  type BenchView
} from './benchLayout'
import { closeBenchRun, getBench, openBench, openBenchRun, setBench, useBench } from './benchState'
import { browserSideLayout, exitBrowserFocus, focusBrowser, setBrowserSide, showInSide, useBrowserSide, useSideShare } from './browserSide'

const ITEM_LABEL: Record<BenchItem, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  files: 'Files',
  changes: 'Changes',
  notes: 'Notes'
}

const ITEM_ICON: Record<BenchItem, typeof Globe> = {
  terminal: SquareTerminal,
  browser: Globe,
  files: FolderOpen,
  changes: GitCompare,
  notes: StickyNote
}

/**
 * One task's body (decision 9 of the redesign): the first Claude chat tab is
 * the conversation, full width, and everything else sits in the Bench: a
 * drawer under it, closed by default, behind the strip "▴ Terminal Browser
 * Files Changes Notes". Files, Changes (the git panel) and Notes are Bench
 * tabs, and a run opened from the status bar shows its log here too. A task
 * without a chat tab shows the Bench full size. Browser tabs of a task with a
 * conversation aren't on the Bench: they show in the Side, right of the
 * conversation, or one takes the whole task (Focus); see `browserSide`.
 */
export default function DeskTaskBody({ project, task, visible, projectDir }: {
  project: Project
  task: Task
  visible: boolean
  projectDir: string
}): React.ReactElement {
  const { addTab, setActiveTab } = useApp()
  const bench = useBench(task.id)
  const focusedPane = useFocusedPane(task.id)
  const chatTabId = conversationTabId(task)
  const panes = benchPanes(task, chatTabId)
  const local = hasLocalFileTabs(project)
  const view: BenchView = (!local && (bench.view === 'files' || bench.view === 'changes')) || (bench.view === 'run' && !bench.run)
    ? 'panes'
    : bench.view
  const open = !chatTabId || bench.open
  const sideState = useBrowserSide(task.id)
  const sideShare = useSideShare()
  const side = browserSideLayout(task, chatTabId, sideState)

  // A file, diff or note opened from a Bench panel shows in its pane right away.
  // A browser tab that opens shows in the Side; an artifact takes the whole task (Focus).
  const tabIdsKey = taskTabIds(task).join('|')
  const knownTabs = useRef<string>(tabIdsKey)
  const taskRef = useRef(task)
  taskRef.current = task
  useEffect(() => {
    const before = new Set(knownTabs.current.split('|'))
    knownTabs.current = tabIdsKey
    const added = tabIdsKey.split('|').filter(id => id && !before.has(id))
    if (added.length === 0) return
    const current = taskRef.current
    const tabs = current.panes.flatMap(pane => pane.tabs).filter(tab => added.includes(tab.id))
    const browser = conversationTabId(current) ? tabs.filter(tab => tab.type === 'browser').pop() : undefined
    if (browser) {
      if (browser.artifact) focusBrowser(task.id, browser.id)
      else showInSide(task.id, browser.id)
    }
    if (tabs.some(tab => tab !== browser)) {
      const state = getBench(task.id)
      if (state.open && state.view !== 'panes') setBench(task.id, { view: 'panes' })
    }
  }, [tabIdsKey, task.id])

  // Esc leaves Focus, unless you're typing (the prompt keeps its own Esc).
  const focused = !!side.focusTabId
  useEffect(() => {
    if (!visible || !focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      exitBrowserFocus(task.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, focused, task.id])

  const pick = (item: BenchItem): void => {
    const current = open ? benchCurrentItem(panes, view, focusedPane) : null
    // The lit item again closes the drawer.
    if (chatTabId && current === item) {
      setBench(task.id, { open: false })
      return
    }
    // With a conversation the browser is the Side: the item shows or hides it.
    if (item === 'browser' && chatTabId) {
      if (side.open && !side.focusTabId) setBrowserSide(task.id, { open: false })
      else if (side.tabId) {
        setActiveTab(project.id, task.id, side.tabId)
        showInSide(task.id, side.tabId)
      } else addTab(project.id, task.id, { withTab: chatTabId }, 'browser')
      return
    }
    if (item === 'terminal' || item === 'browser') {
      const existing = benchTabOfType(panes, item)
      if (existing) {
        setActiveTab(project.id, task.id, existing)
        const at = findTabLocation(task, existing)
        if (at) setFocusedPane(task.id, at.pane)
      } else {
        addTab(project.id, task.id, benchNewTabPane(panes, focusedPane), item)
      }
      openBench(task.id, 'panes')
      return
    }
    openBench(task.id, item)
  }

  const items: BenchItem[] = local ? ['terminal', 'browser', 'files', 'changes', 'notes'] : ['terminal', 'browser', 'notes']
  const current = open ? benchCurrentItem(panes, view, focusedPane) : null

  return (
    <TaskPanes
      project={project}
      task={task}
      visible={visible}
      projectDir={projectDir}
      desk={{
        chatTabId,
        open: bench.open,
        height: bench.height,
        view,
        side,
        sideShare,
        strip: (trailing) => (
          <BenchStrip
            trailing={trailing}
            taskId={task.id}
            collapsible={!!chatTabId}
            open={open}
            items={items}
            current={current}
            panes={panes}
            browserCount={chatTabId ? side.tabs.length : null}
            sideOpen={side.open && !side.focusTabId}
            onPick={pick}
            run={bench.run}
            runShown={open && view === 'run'}
            onRun={() => {
              // The lit run again closes the drawer, like the other items.
              if (chatTabId && open && view === 'run') setBench(task.id, { open: false })
              else setBench(task.id, { open: true, view: 'run' })
            }}
            onCloseRun={() => closeBenchRun(task.id)}
          />
        ),
        panel: visible && open && view === 'run' && bench.run ? (
          <div className="flex-1 flex flex-col min-h-0">
            <StreamRunLogs
              key={`${bench.run.projectId}:${bench.run.streamId}:${bench.run.commandId}`}
              {...bench.run}
              embedded={{
                onClose: () => closeBenchRun(task.id),
                onPick: (commandId) => bench.run && openBenchRun(task.id, { ...bench.run, commandId })
              }}
            />
          </div>
        ) : visible && open && view !== 'panes' ? (
          <div className="flex-1 overflow-auto flex flex-col min-h-0">
            <FileBrowserBody
              tab={view === 'changes' ? 'git' : view === 'files' ? 'files' : 'notes'}
              active={visible}
              pane={benchNewTabPane(panes, focusedPane)}
              onOpened={(taskId) => openBench(taskId, 'panes')}
            />
          </div>
        ) : null
      }}
    />
  )
}

/** The Bench's strip: chevron, the items, the shortcut. Its top edge resizes the open drawer. */
function BenchStrip({ taskId, collapsible, open, items, current, panes, browserCount, sideOpen, onPick, run, runShown, onRun, onCloseRun, trailing }: {
  taskId: string
  collapsible: boolean
  open: boolean
  items: BenchItem[]
  current: BenchItem | null
  panes: BenchPane[]
  /** Browser tabs in the Side, when the task has one (it has a conversation); else they're on the Bench. */
  browserCount: number | null
  sideOpen: boolean
  onPick: (item: BenchItem) => void
  /** The run log the Bench holds, an entry of its own after the items. */
  run: StreamRunLogsTarget | null
  runShown: boolean
  onRun: () => void
  onCloseRun: () => void
  /** At the right end: the lone Bench tab's "+" and ×, when its bar is folded in here. */
  trailing?: React.ReactNode
}): React.ReactElement {
  const shortcut = formatShortcutForApp('Ctrl+`')
  const counts = { terminal: 0, browser: 0 }
  for (const pane of panes) {
    for (const tab of pane.tabs) if (tab.type === 'terminal' || tab.type === 'browser') counts[tab.type]++
  }
  if (browserCount !== null) counts.browser = browserCount

  const startResize = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const strip = e.currentTarget.parentElement
    const grid = strip?.closest<HTMLElement>('[data-task-id]')
    if (!strip || !grid) return
    const gridRect = grid.getBoundingClientRect()
    const startY = e.clientY
    const startHeight = gridRect.bottom - strip.getBoundingClientRect().bottom
    const max = gridRect.height * 0.75
    // Webviews and xterm swallow mouse moves: a shield keeps the drag's coming.
    const shield = document.createElement('div')
    shield.style.cssText = 'position:fixed;inset:0;z-index:2000;cursor:row-resize'
    document.body.appendChild(shield)
    const onMove = (ev: MouseEvent): void => {
      setBench(taskId, { height: Math.min(max, startHeight + startY - ev.clientY) })
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      shield.remove()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`relative flex items-center gap-0.5 h-[34px] px-2 bg-surface border-b-[0.5px] border-border text-sm select-none ${collapsible ? 'border-t-[0.5px]' : ''}`}
      data-testid="desk-bench-strip"
    >
      {collapsible && open && (
        <div className="absolute left-0 right-0 -top-[3px] h-[6px] cursor-row-resize z-(--z-sticky)" onMouseDown={startResize} />
      )}
      {collapsible && (
        <button
          type="button"
          className="size-6 inline-flex items-center justify-center rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-sel"
          aria-expanded={open}
          title={`${open ? 'Close' : 'Open'} the Bench (${shortcut})`}
          onClick={() => setBench(taskId, { open: !open })}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      )}
      {items.map(item => {
        const count = item === 'terminal' || item === 'browser' ? counts[item] : 0
        const lit = browserCount !== null && item === 'browser' ? sideOpen : item === current
        const title = item === 'browser' && browserCount !== null
          ? sideOpen ? 'Hide the browser' : count > 0 ? 'Show the browser beside the conversation' : 'Open a browser beside the conversation'
          : item === 'terminal' || item === 'browser'
            ? count > 0 ? `Show the ${ITEM_LABEL[item].toLowerCase()}` : `Open a ${ITEM_LABEL[item].toLowerCase()} in the Bench`
            : `${ITEM_LABEL[item]} in the Bench`
        return (
          <button
            key={item}
            type="button"
            className={`h-6 px-2 inline-flex items-center gap-1.5 rounded-md border-0 cursor-pointer text-sm font-medium transition-colors duration-(--motion-fast) ${lit ? 'bg-field text-text shadow-(--shadow-raise)' : 'bg-transparent text-text-muted hover:text-text hover:bg-sel'}`}
            aria-pressed={lit}
            title={title}
            onClick={() => onPick(item)}
          >
            {React.createElement(ITEM_ICON[item], { size: 13, 'aria-hidden': true, className: 'opacity-80' })}
            {ITEM_LABEL[item]}
            {count > 1 && <span className="ml-1 font-mono text-xs text-text-subtle">{count}</span>}
          </button>
        )
      })}
      {run && <BenchRunItem run={run} shown={runShown} onShow={onRun} onClose={onCloseRun} />}
      <span className="flex-1" />
      {collapsible && <span className="font-mono text-xs text-text-subtle px-1">{shortcut}</span>}
      {trailing}
    </div>
  )
}

/** The strip's entry for the run log the Bench holds: its state dot, the command's name, ×. */
function BenchRunItem({ run: target, shown, onShow, onClose }: {
  run: StreamRunLogsTarget
  shown: boolean
  onShow: () => void
  onClose: () => void
}): React.ReactElement {
  const { projects } = useApp()
  const run = useStreamRun(target.projectId, target.streamId, target.commandId)
  const stream = projects.find(p => p.id === target.projectId)?.streams.find(s => s.id === target.streamId)
  const name = run?.name ?? 'Log'
  const dot = run?.status === 'running' ? 'bg-running' : run && streamRunCrashed(run) ? 'bg-crashed' : 'bg-text-subtle'
  return (
    <span
      className={`group/run inline-flex items-center h-6 pl-2 pr-0.5 rounded-md text-sm transition-colors duration-(--motion-fast) ${shown ? 'bg-sel text-text' : 'text-text-muted hover:text-text'}`}
      data-testid="desk-bench-run"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer text-inherit text-sm"
        aria-pressed={shown}
        title={`${name} log${stream && !stream.isMain ? ` · ${stream.name}` : ''}`}
        onClick={onShow}
      >
        <span className={`size-1.5 rounded-full ${dot}`} />
        {name}
      </button>
      <button
        type="button"
        className="size-5 inline-flex items-center justify-center bg-transparent border-0 rounded-sm cursor-pointer text-text-subtle hover:text-text"
        title="Close the log (the app keeps running)"
        onClick={onClose}
      >
        <X size={11} />
      </button>
    </span>
  )
}
