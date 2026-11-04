import type { Schedule } from '../../../shared/types'
import { cadenceLabel } from '../../../shared/schedules'
import { formatRelativeTime } from '../projectStats'

/** "Mon 9:00", "today 14:30", "tomorrow 9:00", "Nov 30 9:00". */
export function formatRunTime(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startOf = (t: number): number => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime() }
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000)
  if (days === 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/** "every week · next Mon 9:00", or "every week · paused". */
export function scheduleWhenLine(schedule: Schedule, now: number): string {
  return `${cadenceLabel(schedule)} · ${schedule.paused ? 'paused' : `next ${formatRunTime(schedule.nextRunAt, now)}`}`
}

/** What the latest run came to, in a line; null before the first run. */
export function scheduleLastRunLine(schedule: Schedule, now: number): string | null {
  const last = schedule.lastRun
  if (!last) return null
  const when = formatRelativeTime(last.at, now)
  switch (last.outcome) {
    case 'running': return `Running now (started ${when})`
    case 'reported': return `Last run ${when}: reported, see its task`
    case 'quiet': return `Last run ${when}: nothing new${last.note ? `. ${last.note}` : ''}`
    case 'failed': return `Last run ${when} failed${last.note ? `: ${last.note}` : ''}`
    case 'skipped': return `Last run ${when} skipped`
  }
}

/** A time as `<input type="datetime-local">` wants it, in local time. */
export function toLocalInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `<input type="datetime-local">`'s value as a time; null when blank or unreadable. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const at = new Date(value).getTime()
  return Number.isNaN(at) ? null : at
}

/** A new schedule's first run: the next full hour for hourly ones, else tomorrow at 9:00. */
export function defaultFirstRun(unit: Schedule['unit'], now: number): number {
  const d = new Date(now)
  if (unit === 'hour') {
    d.setHours(d.getHours() + 1, 0, 0, 0)
    return d.getTime()
  }
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}
