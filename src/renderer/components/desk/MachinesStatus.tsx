import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../context/AppContext'
import { menuCls } from '../ui'
import { cpuTone, formatCpu, formatMem, LOCAL_USAGE_HOST, memTone, type HostUsage, type ProcessUsage, type UsageTone } from '../../../shared/task-usage'
import type { Project, Task } from '../../../shared/types'
import { paletteEvents } from '../../palette/paletteEvents'
import { taskUsage, useTaskUsageSnapshot } from '../../taskUsage'
import { USAGE_TONE_CLS } from './TaskUsagePills'
import { hostAlert, machinesLabel, type StatusHost, type StatusTone } from './statusBar'

const BUTTON = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0 bg-transparent border-y-0 border-l-0 cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast) tabular-nums'

const TONE_TEXT: Record<UsageTone, string> = { quiet: '', warm: 'text-warn', hot: 'text-danger' }
const TONE_DOT: Record<UsageTone, string> = { quiet: 'bg-text-subtle opacity-60', warm: 'bg-warn', hot: 'bg-danger' }
const HOST_DOT: Record<StatusTone, string> = {
  ok: 'bg-running',
  idle: 'bg-text-subtle opacity-60',
  bad: 'bg-crashed',
  needs: 'bg-needs'
}

interface Row {
  project: Project
  task: Task
  usage: ProcessUsage
  host: HostUsage
}

/** One machine's tasks: their load together, and how much of the machine it is. */
interface Load {
  host: HostUsage
  rows: Row[]
  total: ProcessUsage
  tone: UsageTone
}

/** Of the machine's capacity, the larger share the tasks take: amber past 70%, red past 90%. */
export function machineTone(total: ProcessUsage, cores: number, totalMem: number): UsageTone {
  const cpuShare = total.cpu / (Math.max(1, cores) * 100)
  const memShare = totalMem > 0 ? total.rss / totalMem : 0
  const share = Math.max(cpuShare, memShare)
  return share >= 0.9 ? 'hot' : share >= 0.7 ? 'warm' : 'quiet'
}

/** CPU leads; memory breaks near-ties, so idle dev servers sort by their size. */
function heaviestFirst(a: Row, b: Row): number {
  return (Math.round(b.usage.cpu / 10) - Math.round(a.usage.cpu / 10)) || (b.usage.rss - a.usage.rss)
}

function sum(rows: readonly Row[]): ProcessUsage {
  return rows.reduce((acc, row) => ({ cpu: acc.cpu + row.usage.cpu, rss: acc.rss + row.usage.rss, procs: acc.procs + row.usage.procs }), { cpu: 0, rss: 0, procs: 0 })
}

/** The usage host a status host stands for: this Mac is `local`, a server its id. */
function usageHostId(host: StatusHost): string | null {
  if (host.kind === 'mac') return LOCAL_USAGE_HOST
  if (host.kind === 'server') return host.key.slice('server:'.length)
  return null
}

function loadText(load: Load, withCapacity: boolean): string {
  const of = withCapacity && load.host.totalMem > 0 ? ` of ${formatMem(load.host.totalMem)}` : ''
  return `${formatCpu(load.total.cpu)} · ${formatMem(load.total.rss)}${of}`
}

/** Settings › Hosts; a server opens the servers, with their pairing, builds and updates. */
function openHostSettings(host: StatusHost): void {
  paletteEvents.emit('open-settings-tab', host.kind === 'server' ? 'servers' : 'hosts')
}

/**
 * The status bar's machines (option B: quiet unless something needs you). One
 * chip stands for every machine while all is well: a dot per machine and the
 * load of all your tasks; a click lists each machine and the heaviest tasks.
 * A machine in trouble (`hostAlert`) and one whose tasks take most of it
 * (`machineTone` warm or hot) get a chip of their own beside it.
 */
export default function MachinesStatus({ hosts }: { hosts: readonly StatusHost[] }): React.ReactElement {
  const { projects, switchToTask } = useApp()
  const snapshot = useTaskUsageSnapshot()
  const [open, setOpen] = useState<{ rect: DOMRect; hostId: string | null } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const loads = useMemo(() => {
    const byHost = new Map<string, Row[]>()
    for (const project of projects) {
      for (const stream of project.streams ?? []) {
        for (const task of stream.tasks) {
          const found = taskUsage(snapshot, task)
          if (!found) continue
          const list = byHost.get(found.host.id) ?? []
          list.push({ project, task, usage: found.usage, host: found.host })
          byHost.set(found.host.id, list)
        }
      }
    }
    const out = new Map<string, Load>()
    for (const host of snapshot.hosts) {
      const rows = (byHost.get(host.id) ?? []).sort(heaviestFirst)
      if (rows.length === 0) continue
      const total = sum(rows)
      out.set(host.id, { host, rows, total, tone: machineTone(total, host.cores, host.totalMem) })
    }
    return out
  }, [projects, snapshot])

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

  const allRows = [...loads.values()].flatMap(load => load.rows)
  const total = sum(allRows)
  const hot = [...loads.values()].filter(load => load.tone !== 'quiet')
  const alerts = hosts.filter(hostAlert)
  const worst: UsageTone = hot.some(load => load.tone === 'hot') ? 'hot' : hot.length > 0 ? 'warm' : 'quiet'

  const toggle = (e: React.MouseEvent<HTMLButtonElement>, hostId: string | null): void => {
    const same = open && open.hostId === hostId
    setOpen(same ? null : { rect: e.currentTarget.getBoundingClientRect(), hostId })
  }
  // A click on the chip whose list is open closes it, rather than the outside click closing and the click reopening.
  const keepOpen = (e: React.MouseEvent): void => { if (open) e.stopPropagation() }

  const label = machinesLabel(hosts)
  const shownLoad = open?.hostId ? loads.get(open.hostId) : undefined
  const popRows = (open?.hostId ? shownLoad?.rows ?? [] : [...allRows].sort(heaviestFirst)).slice(0, open?.hostId ? undefined : 8)

  return (
    <>
      <button
        type="button"
        className={BUTTON}
        title={`${hosts.map(host => `${host.label}${host.detail ? ` (${host.detail})` : ''}`).join(', ')}${allRows.length > 0 ? `\nYour tasks' processes: ${formatCpu(total.cpu)} CPU · ${formatMem(total.rss)}` : ''}\nClick for each machine and task`}
        onMouseDown={keepOpen}
        onClick={(e) => toggle(e, null)}
        aria-expanded={open?.hostId === null}
        data-testid="desk-status-machines"
      >
        <span className="flex items-center gap-[3px]">
          {hosts.map(host => <span key={host.key} className={`size-[7px] shrink-0 rounded-full ${HOST_DOT[host.tone]}`} data-testid="desk-status-host" />)}
        </span>
        <span className="truncate">{label}</span>
        {allRows.length > 0 && <span className={worst === 'quiet' ? 'text-text-subtle' : TONE_TEXT[worst]}>{formatCpu(total.cpu)} · {formatMem(total.rss)}</span>}
      </button>

      {alerts.map(host => (
        <button
          key={host.key}
          type="button"
          className={BUTTON}
          title={`${host.title} · open Settings › Hosts`}
          onClick={() => openHostSettings(host)}
          data-testid="desk-status-alert"
        >
          <span className={`size-[7px] shrink-0 rounded-full ${HOST_DOT[host.tone]}`} />
          <span className="truncate">{host.label}</span>
          {host.detail && <span className="text-text-subtle">· {host.detail}</span>}
        </button>
      ))}

      {hot.map(load => {
        const local = load.host.id === LOCAL_USAGE_HOST
        return (
          <button
            key={load.host.id}
            type="button"
            className={BUTTON}
            title={`Your tasks take most of ${local ? 'this machine' : load.host.label} (${load.host.cores} cores) · click for each task`}
            onMouseDown={keepOpen}
            onClick={(e) => toggle(e, load.host.id)}
            aria-expanded={open?.hostId === load.host.id}
            data-testid="desk-status-usage"
            data-host={load.host.id}
          >
            <span className={`size-[7px] shrink-0 rounded-full ${TONE_DOT[load.tone]}`} />
            <span className={`truncate ${TONE_TEXT[load.tone]}`}>{load.host.label} {loadText(load, true)}</span>
          </button>
        )
      })}

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={shownLoad ? `Tasks on ${shownLoad.host.label}` : 'Machines and tasks'}
          className={`fixed z-(--z-menu) w-80 max-h-[60vh] overflow-y-auto flex flex-col text-xs tabular-nums ${menuCls}`}
          style={{ left: Math.max(8, Math.min(open.rect.left, window.innerWidth - 328)), bottom: window.innerHeight - open.rect.top + 8 }}
          data-testid="desk-status-usage-list"
        >
          {!open.hostId && (
            <>
              <Head left="Machine" right="Your tasks" />
              {hosts.map(host => {
                const id = usageHostId(host)
                const load = id ? loads.get(id) : undefined
                return (
                  <button
                    key={host.key}
                    type="button"
                    className="flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 bg-transparent border-0 text-left cursor-pointer hover:bg-sel"
                    title={`${host.title} · open Settings › Hosts`}
                    onClick={() => { setOpen(null); openHostSettings(host) }}
                  >
                    <span className={`size-[7px] shrink-0 rounded-full ${HOST_DOT[host.tone]}`} />
                    <span className="min-w-0 truncate text-text">{host.label}</span>
                    {host.detail && <span className="shrink-0 text-text-subtle">· {host.detail}</span>}
                    <span className={`ml-auto shrink-0 ${load ? TONE_TEXT[load.tone] || 'text-text-muted' : 'text-text-subtle'}`}>
                      {load ? loadText(load, true) : '—'}
                    </span>
                  </button>
                )
              })}
            </>
          )}
          {popRows.length > 0 && (
            <>
              <Head left={open.hostId ? `Task on ${shownLoad?.host.label ?? ''}` : 'Heaviest tasks'} right="CPU · Memory" divided={!open.hostId} />
              {popRows.map(({ project, task, usage, host }) => {
                const cpu = cpuTone(usage.cpu) ?? 'quiet'
                const mem = memTone(usage.rss) ?? 'quiet'
                return (
                  <button
                    key={task.id}
                    type="button"
                    className="flex items-center justify-between gap-3 w-full rounded-md px-2.5 py-1.5 bg-transparent border-0 text-left cursor-pointer hover:bg-sel"
                    title={`${usage.procs === 1 ? '1 process' : `${usage.procs} processes`}${host.id === LOCAL_USAGE_HOST ? '' : ` on ${host.label}`} · open the task`}
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
            </>
          )}
        </div>
      )}
    </>
  )
}

function Head({ left, right, divided }: { left: string; right: string; divided?: boolean }): React.ReactElement {
  return (
    <div className={`flex justify-between gap-3 px-2.5 pt-1.5 pb-1 text-text-subtle ${divided ? 'mt-1 border-t-[0.5px] border-hair pt-2' : ''}`}>
      <span>{left}</span>
      <span>{right}</span>
    </div>
  )
}
