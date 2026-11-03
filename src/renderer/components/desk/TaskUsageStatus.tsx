import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../context/AppContext'
import { menuCls } from '../ui'
import { cpuTone, formatCpu, formatMem, LOCAL_USAGE_HOST, memTone, type HostUsage, type ProcessUsage, type UsageTone } from '../../../shared/task-usage'
import type { Project, Task } from '../../../shared/types'
import { taskUsage, useTaskUsageSnapshot } from '../../taskUsage'
import { USAGE_TONE_CLS } from './TaskUsagePills'

const BUTTON = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0 bg-transparent border-y-0 border-l-0 cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast) tabular-nums'

const TONE_TEXT: Record<UsageTone, string> = { quiet: '', warm: 'text-warn', hot: 'text-danger' }
const TONE_DOT: Record<UsageTone, string> = { quiet: 'bg-text-subtle opacity-60', warm: 'bg-warn', hot: 'bg-danger' }

interface Row {
  project: Project
  task: Task
  usage: ProcessUsage
}

/** Of the machine's capacity, the larger share the tasks take: amber past 70%, red past 90%. */
export function machineTone(total: ProcessUsage, cores: number, totalMem: number): UsageTone {
  const cpuShare = total.cpu / (Math.max(1, cores) * 100)
  const memShare = totalMem > 0 ? total.rss / totalMem : 0
  const share = Math.max(cpuShare, memShare)
  return share >= 0.9 ? 'hot' : share >= 0.7 ? 'warm' : 'quiet'
}

/**
 * The status bar's usage items: one per machine whose tasks run something (this
 * one first, then each server), with CPU and memory of every task's processes
 * there together. A click lists that machine's tasks heaviest first; a task opens it.
 */
export default function TaskUsageStatus(): React.ReactElement {
  const snapshot = useTaskUsageSnapshot()
  return <>{snapshot.hosts.map(host => <HostItem key={host.id} host={host} />)}</>
}

function HostItem({ host }: { host: HostUsage }): React.ReactElement | null {
  const { projects, switchToTask } = useApp()
  const snapshot = useTaskUsageSnapshot()
  const [open, setOpen] = useState<DOMRect | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const list: Row[] = []
    for (const project of projects) {
      for (const stream of project.streams ?? []) {
        for (const task of stream.tasks) {
          const found = taskUsage(snapshot, task)
          if (found && found.host.id === host.id) list.push({ project, task, usage: found.usage })
        }
      }
    }
    // CPU leads; memory breaks near-ties, so idle dev servers sort by their size.
    return list.sort((a, b) => (Math.round(b.usage.cpu / 10) - Math.round(a.usage.cpu / 10)) || (b.usage.rss - a.usage.rss))
  }, [projects, snapshot, host.id])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (rows.length === 0) return null
  const total = rows.reduce((sum, row) => ({ cpu: sum.cpu + row.usage.cpu, rss: sum.rss + row.usage.rss, procs: sum.procs + row.usage.procs }), { cpu: 0, rss: 0, procs: 0 })
  const tone = machineTone(total, host.cores, host.totalMem)
  const ofMem = host.totalMem > 0 ? ` of ${formatMem(host.totalMem)}` : ''
  const local = host.id === LOCAL_USAGE_HOST
  const name = local ? 'Tasks' : host.label

  return (
    <>
      <button
        type="button"
        className={BUTTON}
        title={`CPU and memory of your tasks' processes on ${local ? 'this machine' : host.label} (${host.cores} cores${ofMem}) · click for each task`}
        onMouseDown={(e) => { if (open) e.stopPropagation() }}
        onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}
        aria-expanded={open !== null}
        data-testid="desk-status-usage"
        data-host={host.id}
      >
        <span className={`size-[7px] shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <span className={`truncate ${TONE_TEXT[tone]}`}>{name} {formatCpu(total.cpu)} · {formatMem(total.rss)}{ofMem}</span>
      </button>
      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={`Tasks by CPU and memory${local ? '' : ` on ${host.label}`}`}
          className={`fixed z-(--z-menu) w-80 max-h-[60vh] overflow-y-auto flex flex-col text-xs tabular-nums ${menuCls}`}
          style={{ left: Math.max(8, Math.min(open.left, window.innerWidth - 328)), bottom: window.innerHeight - open.top + 8 }}
          data-testid="desk-status-usage-list"
        >
          <div className="flex justify-between gap-3 px-2.5 pt-1.5 pb-1 text-text-subtle">
            <span>{local ? 'Task' : `Task on ${host.label}`}</span>
            <span>CPU · Memory</span>
          </div>
          {rows.map(({ project, task, usage }) => {
            const cpu = cpuTone(usage.cpu) ?? 'quiet'
            const mem = memTone(usage.rss) ?? 'quiet'
            return (
              <button
                key={task.id}
                type="button"
                className="flex items-center justify-between gap-3 w-full rounded-md px-2.5 py-1.5 bg-transparent border-0 text-left cursor-pointer hover:bg-sel"
                title={`${usage.procs === 1 ? '1 process' : `${usage.procs} processes`} · open the task`}
                onClick={() => { setOpen(null); switchToTask(project.id, task.id) }}
              >
                <span className="min-w-0 truncate">
                  <span className="text-text-muted">{project.name} · </span>
                  <span className="text-text">{task.name}</span>
                </span>
                <span className="shrink-0 flex gap-1 font-mono text-[10.5px] leading-[15px]">
                  <span className={`px-1 rounded ${USAGE_TONE_CLS[cpu]}`}>{formatCpu(usage.cpu)}</span>
                  <span className={`px-1 rounded ${USAGE_TONE_CLS[mem]}`}>{formatMem(usage.rss)}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
