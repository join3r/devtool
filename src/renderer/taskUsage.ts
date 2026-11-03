import { useSyncExternalStore } from 'react'
import { EMPTY_TASK_USAGE, type HostUsage, type ProcessUsage, type TaskUsageSnapshot } from '../shared/task-usage'
import type { Task } from '../shared/types'

/**
 * CPU and memory per tab, as main samples them on this machine and its servers
 * report theirs (`task-usage-get` and the `task-usage-changed` push). Shared by
 * every component of a window, which also keeps the last two minutes of it for
 * the row's hover chart: main pushes only changes, so a value holds until the
 * next push says otherwise.
 */

/** How far back the hover chart looks, and the step between its points. */
export const HISTORY_MS = 120_000
export const HISTORY_STEP_MS = 3000

interface Point {
  at: number
  cpu: number
  rss: number
}

let snapshot: TaskUsageSnapshot = EMPTY_TASK_USAGE
let hostOfTab = new Map<string, HostUsage>()
const history = new Map<string, Point[]>()
let started = false
const listeners = new Set<() => void>()

/** Records a snapshot into the tabs' histories at `now`. Exported for tests. */
export function recordUsage(next: TaskUsageSnapshot, now: number): void {
  snapshot = next
  hostOfTab = new Map()
  for (const host of next.hosts) {
    for (const id of Object.keys(host.tabs)) if (!hostOfTab.has(id)) hostOfTab.set(id, host)
  }
  for (const [id, host] of hostOfTab) {
    const usage = host.tabs[id]
    push(id, { at: now, cpu: usage.cpu, rss: usage.rss })
  }
  for (const [id, points] of history) {
    if (hostOfTab.has(id)) continue
    const last = points[points.length - 1]
    if (last && (last.cpu > 0 || last.rss > 0)) push(id, { at: now, cpu: 0, rss: 0 })
    // A tab quiet for the whole window has nothing left to draw.
    else if (!last || now - last.at > HISTORY_MS) history.delete(id)
  }
}

function push(id: string, point: Point): void {
  const points = history.get(id) ?? []
  points.push(point)
  // Keep one point from before the window: it is the value at its left edge.
  const cutoff = point.at - HISTORY_MS
  let drop = 0
  while (drop + 1 < points.length && points[drop + 1].at <= cutoff) drop++
  if (drop > 0) points.splice(0, drop)
  history.set(id, points)
}

function set(next: TaskUsageSnapshot | undefined): void {
  // A stubbed api (tests) may answer nothing; an older main sends no hosts.
  if (!next || typeof next !== 'object' || !Array.isArray(next.hosts)) return
  recordUsage(next, Date.now())
  for (const listener of [...listeners]) listener()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const api = window.api as Partial<typeof window.api> | undefined
  api?.onTaskUsageChanged?.(set)
  void api?.taskUsageGet?.().then(set).catch(() => {})
}

function getSnapshot(): TaskUsageSnapshot {
  ensureStarted()
  return snapshot
}

function subscribe(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTaskUsageSnapshot(): TaskUsageSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function taskTabIds(task: Task): string[] {
  return task.panes.flatMap(pane => pane.tabs.map(tab => tab.id))
}

/**
 * A task's processes summed over its tabs, and the machine they run on; null
 * when none runs anything. Read with the snapshot `useTaskUsageSnapshot` gave,
 * so a component repaints when it changes.
 */
export function taskUsage(_snapshot: TaskUsageSnapshot, task: Task): { usage: ProcessUsage; host: HostUsage } | null {
  let usage: ProcessUsage | null = null
  let host: HostUsage | null = null
  for (const id of taskTabIds(task)) {
    const owner = hostOfTab.get(id)
    const tab = owner?.tabs[id]
    if (!owner || !tab) continue
    host ??= owner
    usage = usage
      ? { cpu: usage.cpu + tab.cpu, rss: usage.rss + tab.rss, procs: usage.procs + tab.procs }
      : { ...tab }
  }
  return usage && host ? { usage, host } : null
}

/** The value a tab's history holds at `at`: its last point at or before it, else nothing yet. */
function valueAt(points: readonly Point[], at: number): Point | null {
  let found: Point | null = null
  for (const point of points) {
    if (point.at > at) break
    found = point
  }
  return found
}

/** The task's CPU and memory over the last two minutes, oldest first, one point per step. */
export function taskUsageSeries(task: Task, now: number): { cpu: number[]; rss: number[] } {
  const ids = taskTabIds(task)
  const cpu: number[] = []
  const rss: number[] = []
  for (let at = now - HISTORY_MS; at <= now; at += HISTORY_STEP_MS) {
    let c = 0
    let r = 0
    for (const id of ids) {
      const point = valueAt(history.get(id) ?? [], at)
      if (point) {
        c += point.cpu
        r += point.rss
      }
    }
    cpu.push(c)
    rss.push(r)
  }
  return { cpu, rss }
}
