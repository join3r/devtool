import React, { useEffect, useState } from 'react'
import type { Task } from '../../../shared/types'
import { cpuTone, formatCpu, formatMem, LOCAL_USAGE_HOST, memTone, type HostUsage, type ProcessUsage, type UsageTone } from '../../../shared/task-usage'
import { HISTORY_STEP_MS, taskUsage, taskUsageSeries, useTaskUsageSnapshot } from '../../taskUsage'
import { menuCls } from '../ui'

export const USAGE_TONE_CLS: Record<UsageTone, string> = {
  quiet: 'text-text-muted bg-border',
  warm: 'text-warn bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)]',
  hot: 'text-danger bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)]'
}

const TONE_TEXT: Record<UsageTone, string> = { quiet: 'text-text-muted', warm: 'text-warn', hot: 'text-danger' }

const PILL = 'font-mono text-[10.5px] leading-[15px] px-1 rounded tabular-nums whitespace-nowrap'

/**
 * A desk row's CPU and memory, each shown only once it is worth noticing (half a
 * core, 1 GB), amber then red as it climbs. Nothing on a quiet task. Hovering
 * shows the last two minutes of both.
 */
export default function TaskUsagePills({ task }: { task: Task }): React.ReactElement | null {
  const snapshot = useTaskUsageSnapshot()
  const [hover, setHover] = useState<DOMRect | null>(null)
  const found = taskUsage(snapshot, task)
  if (!found) return null
  const { usage, host } = found
  const cpu = cpuTone(usage.cpu)
  const mem = memTone(usage.rss)
  if (!cpu && !mem) return null
  const show = (e: React.SyntheticEvent<HTMLElement>): void => setHover(e.currentTarget.getBoundingClientRect())
  return (
    <>
      <span
        className="flex items-center gap-1"
        // An empty title keeps the row's own tooltip from covering the chart.
        title=""
        tabIndex={0}
        aria-label={usageSummary(usage, host)}
        onMouseEnter={show}
        onFocus={show}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        data-testid="desk-row-usage"
      >
        {cpu && <span className={`${PILL} ${USAGE_TONE_CLS[cpu]}`}>{formatCpu(usage.cpu)}</span>}
        {mem && <span className={`${PILL} ${USAGE_TONE_CLS[mem]}`}>{formatMem(usage.rss)}</span>}
      </span>
      {hover && <UsageChart task={task} usage={usage} host={host} rect={hover} />}
    </>
  )
}

function usageSummary(usage: ProcessUsage, host: HostUsage): string {
  const where = host.id === LOCAL_USAGE_HOST ? '' : ` on ${host.label}`
  return `${formatCpu(usage.cpu)} CPU, ${formatMem(usage.rss)} memory, ${usage.procs === 1 ? '1 process' : `${usage.procs} processes`}${where}`
}

/** The clock, stepping with the samples while the chart is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), HISTORY_STEP_MS)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** The popover under the pills: fixed, so the row's clip doesn't cut it; right-aligned to them. */
function UsageChart({ task, usage, host, rect }: { task: Task; usage: ProcessUsage; host: HostUsage; rect: DOMRect }): React.ReactElement {
  const now = useNow()
  const series = taskUsageSeries(task, now)
  const peakCpu = Math.max(...series.cpu)
  const peakRss = Math.max(...series.rss)
  const below = rect.bottom + 230 < window.innerHeight
  return (
    <div
      role="tooltip"
      className={`fixed z-(--z-menu) pointer-events-none w-72 flex flex-col gap-3 px-3 py-2.5 text-xs tabular-nums ${menuCls}`}
      style={{
        right: Math.max(8, window.innerWidth - rect.right),
        ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 })
      }}
      data-testid="desk-row-usage-chart"
    >
      <div className="flex items-baseline justify-between gap-3 text-text-muted">
        <span>Last 2 minutes{host.id === LOCAL_USAGE_HOST ? '' : ` · ${host.label}`}</span>
        <span>{usage.procs === 1 ? '1 process' : `${usage.procs} processes`}</span>
      </div>
      <Metric
        label="CPU"
        value={formatCpu(usage.cpu)}
        detail={`${(usage.cpu / 100).toFixed(1)} of ${host.cores} cores · peak ${formatCpu(peakCpu)}`}
        values={series.cpu}
        // One core is the least the scale shows, so a calm task looks calm.
        max={Math.max(100, peakCpu)}
        maxLabel={formatCpu(Math.max(100, peakCpu))}
        tone={cpuTone(usage.cpu) ?? 'quiet'}
      />
      <Metric
        label="Memory"
        value={formatMem(usage.rss)}
        detail={`${host.totalMem > 0 ? `of ${formatMem(host.totalMem)} · ` : ''}peak ${formatMem(peakRss)}`}
        values={series.rss}
        max={Math.max(1024 ** 3, peakRss)}
        maxLabel={formatMem(Math.max(1024 ** 3, peakRss))}
        tone={memTone(usage.rss) ?? 'quiet'}
      />
    </div>
  )
}

const W = 264
const H = 40

function Metric({ label, value, detail, values, max, maxLabel, tone }: {
  label: string
  value: string
  detail: string
  values: number[]
  max: number
  maxLabel: string
  tone: UsageTone
}): React.ReactElement {
  const step = values.length > 1 ? W / (values.length - 1) : W
  const y = (v: number): number => H - 1 - (Math.min(v, max) / max) * (H - 4)
  // A step line: each sample holds until the next, as the samples do.
  let line = `M0 ${y(values[0] ?? 0).toFixed(1)}`
  values.forEach((v, i) => {
    if (i === 0) return
    line += ` H${(i * step).toFixed(1)} V${y(v).toFixed(1)}`
  })
  const lastY = y(values[values.length - 1] ?? 0)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-text">{label} <span className={`font-mono ${TONE_TEXT[tone]}`}>{value}</span></span>
        <span className="text-text-subtle truncate">{detail}</span>
      </div>
      <div className={`relative ${TONE_TEXT[tone]}`}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true" className="block overflow-visible">
          <line x1="0" y1="3" x2={W} y2="3" stroke="var(--color-hair)" strokeDasharray="2 3" />
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--color-hair)" />
          <path d={`${line} V${H} H0 Z`} fill="currentColor" opacity="0.16" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          <circle cx={W} cy={lastY} r="2.5" fill="currentColor" />
        </svg>
        <span className="absolute left-0 -top-0.5 text-[10px] leading-none text-text-subtle bg-surface pr-1">{maxLabel}</span>
      </div>
    </div>
  )
}
