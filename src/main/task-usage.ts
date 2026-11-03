import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import { listAllTagged } from './tab-processes'
import { LOCAL_USAGE_HOST, type HostUsage, type MachineUsage, type ProcessUsage, type TaskUsageSnapshot } from '../shared/task-usage'

/**
 * Samples CPU and memory per tab for the desk: one `ps` of the whole machine
 * every few seconds, attributed to tabs by their PTY's process tree and by the
 * `DEVTOOL_TAB_OWNER` tag agents carry (which also finds what an agent detached,
 * reparented to launchd). The tag scan reads every process's environment, so it
 * runs less often; an agent started in between is counted from the next one.
 */

const SAMPLE_MS = 3000
const TAG_SCAN_MS = 15_000

export interface ProcessRow {
  pid: number
  ppid: number
  /** Percent of one core. */
  cpu: number
  /** Bytes. */
  rss: number
}

/** `ps -axo pid=,ppid=,pcpu=,rss=` (rss in KiB). */
export function parsePsRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const [pid, ppid, cpu, rss] = parts.map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    rows.push({ pid, ppid, cpu: Number.isFinite(cpu) ? cpu : 0, rss: Number.isFinite(rss) ? rss * 1024 : 0 })
  }
  return rows
}

/**
 * Each tab's processes summed: everything under its PTY's root pid first, then
 * everything under a process tagged with it that no tab has claimed yet. A pid
 * counts once. `exclude` (this process and its parent) and their trees never
 * count: a dev DevTool started from an agent tab carries that tab's tag.
 */
export function attributeUsage(
  rows: readonly ProcessRow[],
  ptyRoots: ReadonlyMap<string, number>,
  tagged: ReadonlyMap<number, string>,
  exclude: readonly number[]
): Record<string, ProcessUsage> {
  const byPid = new Map<number, ProcessRow>()
  const children = new Map<number, number[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const owner = new Map<number, string>()
  const blocked = new Set(exclude)
  const claim = (root: number, tabId: string): void => {
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      if (owner.has(pid) || blocked.has(pid) || !byPid.has(pid)) continue
      owner.set(pid, tabId)
      for (const child of children.get(pid) ?? []) stack.push(child)
    }
  }
  for (const [tabId, pid] of ptyRoots) claim(pid, tabId)
  // Ancestors first, so a tagged parent claims its tagged children under its own tab.
  for (const pid of [...tagged.keys()].sort((a, b) => a - b)) claim(pid, tagged.get(pid) as string)

  const usage: Record<string, ProcessUsage> = {}
  for (const [pid, tabId] of owner) {
    const row = byPid.get(pid) as ProcessRow
    const total = usage[tabId] ?? (usage[tabId] = { cpu: 0, rss: 0, procs: 0 })
    total.cpu += row.cpu
    total.rss += row.rss
    total.procs += 1
  }
  return usage
}

/** Whether two samples differ enough to repaint the desk: 10% CPU, 50 MB, or a process. */
export function usageChanged(a: Record<string, ProcessUsage>, b: Record<string, ProcessUsage>): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    const x = a[id]
    const y = b[id]
    if (!x || !y) return true
    if (Math.abs(x.cpu - y.cpu) >= 10 || Math.abs(x.rss - y.rss) >= 50 * 1024 ** 2 || x.procs !== y.procs) return true
  }
  return false
}

/** Clock ticks per second of `/proc/<pid>/stat` times; 100 on every Linux DevTool runs on. */
const CLK_TCK = 100
const PAGE_SIZE = 4096

/** Of a `/proc/<pid>/stat` line: its parent, CPU time in ticks and resident pages. The name may hold spaces and parens. */
export function parseProcStat(stat: string): { ppid: number; ticks: number; rssPages: number } | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  // After the name: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime … rss is the 22nd.
  const fields = stat.slice(close + 2).split(' ')
  const ppid = Number(fields[1])
  const ticks = Number(fields[11]) + Number(fields[12])
  const rssPages = Number(fields[21])
  if (!Number.isFinite(ppid) || !Number.isFinite(ticks) || !Number.isFinite(rssPages)) return null
  return { ppid, ticks, rssPages }
}

/**
 * Linux, from `/proc` (a server's container may have no `ps`): CPU over the time
 * since the previous read, from each process's CPU ticks, so a long-lived
 * process shows what it does now rather than its lifetime average.
 */
export class ProcReader {
  private last = new Map<number, number>()
  private lastAt = 0

  read(now = Date.now()): ProcessRow[] {
    const rows: ProcessRow[] = []
    const ticks = new Map<number, number>()
    const elapsed = this.lastAt > 0 ? (now - this.lastAt) / 1000 : 0
    for (const entry of fs.readdirSync('/proc')) {
      const pid = Number(entry)
      if (!Number.isInteger(pid)) continue
      let stat: ReturnType<typeof parseProcStat>
      try {
        stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      } catch {
        continue
      }
      if (!stat) continue
      ticks.set(pid, stat.ticks)
      const before = this.last.get(pid)
      const cpu = elapsed > 0 && before !== undefined ? Math.max(0, ((stat.ticks - before) / CLK_TCK / elapsed) * 100) : 0
      rows.push({ pid, ppid: stat.ppid, cpu, rss: stat.rssPages * PAGE_SIZE })
    }
    this.last = ticks
    this.lastAt = now
    return rows
  }
}

/** macOS's %cpu is a short decaying average, like Activity Monitor's. */
function readPsRows(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,pcpu=,rss='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : parsePsRows(stdout)))
  })
}

export interface TaskUsageSamplerDeps {
  ptyRoots: () => Map<string, number>
  /** This machine's tabs changed. */
  onChange: () => void
}

export class TaskUsageSampler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private tagged = new Map<number, string>()
  private taggedAt = 0
  private tabs: Record<string, ProcessUsage> = {}
  private stopped = false
  private readonly proc = process.platform === 'linux' ? new ProcReader() : null

  constructor(private readonly deps: TaskUsageSamplerDeps) {}

  /** Windows has neither `ps` nor the tag scan: nothing is sampled there. */
  start(): void {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** This machine's tabs, as a server sends them to its desktops. */
  own(): MachineUsage {
    return { tabs: this.tabs, cores: os.cpus().length || 1, totalMem: os.totalmem() }
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.tick() }, delay)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    try {
      if (Date.now() - this.taggedAt >= TAG_SCAN_MS) {
        this.tagged = await listAllTagged()
        this.taggedAt = Date.now()
      }
      const rows = this.proc ? this.proc.read() : await readPsRows()
      if (this.stopped) return
      const next = rows.length > 0 ? attributeUsage(rows, this.deps.ptyRoots(), this.tagged, [process.pid, process.ppid]) : {}
      if (usageChanged(this.tabs, next)) {
        this.tabs = next
        this.deps.onChange()
      }
    } finally {
      this.schedule(SAMPLE_MS)
    }
  }
}

/**
 * A desktop's view: its own machine (the sampler) and what each online server
 * reports of its own (`setForeign`). A server sends only its own.
 */
export class TaskUsage {
  private readonly foreign = new Map<string, HostUsage>()
  private readonly sampler: TaskUsageSampler

  constructor(private readonly deps: {
    ptyRoots: () => Map<string, number>
    localLabel: string
    /** What a window or a desktop should hear of: called with nothing, read `snapshot()` or `own()`. */
    onChange: () => void
  }) {
    this.sampler = new TaskUsageSampler({ ptyRoots: deps.ptyRoots, onChange: deps.onChange })
  }

  start(): void { this.sampler.start() }
  stop(): void { this.sampler.stop() }

  own(): MachineUsage {
    return this.sampler.own()
  }

  /** A server's report, or null when it went offline or away: its numbers would be stale. */
  setForeign(serverId: string, label: string, usage: MachineUsage | null): void {
    if (usage) this.foreign.set(serverId, { ...usage, id: serverId, label })
    else if (!this.foreign.delete(serverId)) return
    this.deps.onChange()
  }

  snapshot(): TaskUsageSnapshot {
    return { hosts: [{ ...this.own(), id: LOCAL_USAGE_HOST, label: this.deps.localLabel }, ...this.foreign.values()] }
  }
}
