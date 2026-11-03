/**
 * CPU and memory of the processes each tab started, as main samples them on this
 * machine: the tab's own process tree plus what its agent detached (found by the
 * tab's environment tag). The desk sums a task's tabs.
 */

export interface ProcessUsage {
  /** Percent of one core, as Activity Monitor and `top` show it (400 = four cores busy). */
  cpu: number
  /** Resident memory, bytes. */
  rss: number
  /** Processes counted. */
  procs: number
}

/** One machine's tabs: this desktop's, or a DevTool server's. */
export interface MachineUsage {
  /** By tab id; tabs with no live process are absent. */
  tabs: Record<string, ProcessUsage>
  /** Logical cores of the machine. */
  cores: number
  /** Physical memory of the machine, bytes. */
  totalMem: number
}

export interface HostUsage extends MachineUsage {
  /** `local`, or the server's id. */
  id: string
  /** "This Mac", or the server's name. */
  label: string
}

export const LOCAL_USAGE_HOST = 'local'

/** What a desktop's windows get: its own machine first, then each online server that reports. */
export interface TaskUsageSnapshot {
  hosts: HostUsage[]
}

export const EMPTY_TASK_USAGE: TaskUsageSnapshot = { hosts: [] }

/** A server's push or answer, checked: null when it isn't one. */
export function parseMachineUsage(value: unknown): MachineUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const { tabs, cores, totalMem } = value as Partial<MachineUsage>
  if (typeof tabs !== 'object' || tabs === null || typeof cores !== 'number' || typeof totalMem !== 'number') return null
  const clean: Record<string, ProcessUsage> = {}
  for (const [id, usage] of Object.entries(tabs)) {
    if (usage && typeof usage.cpu === 'number' && typeof usage.rss === 'number' && typeof usage.procs === 'number') {
      clean[id] = { cpu: usage.cpu, rss: usage.rss, procs: usage.procs }
    }
  }
  return { tabs: clean, cores, totalMem }
}

export type UsageTone = 'quiet' | 'warm' | 'hot'

const GB = 1024 ** 3

/** The row pill shows CPU from half a core; amber from two cores, red from four. */
export const CPU_SHOW = 50
const CPU_WARM = 200
const CPU_HOT = 400
/** And memory from 1 GB; amber from 4 GB, red from 8 GB. */
export const MEM_SHOW = GB
const MEM_WARM = 4 * GB
const MEM_HOT = 8 * GB

export function cpuTone(cpu: number): UsageTone | null {
  if (cpu < CPU_SHOW) return null
  return cpu >= CPU_HOT ? 'hot' : cpu >= CPU_WARM ? 'warm' : 'quiet'
}

export function memTone(rss: number): UsageTone | null {
  if (rss < MEM_SHOW) return null
  return rss >= MEM_HOT ? 'hot' : rss >= MEM_WARM ? 'warm' : 'quiet'
}

/** "640%". */
export function formatCpu(cpu: number): string {
  return `${Math.round(cpu)}%`
}

/** "910 MB", "3.8 GB". */
export function formatMem(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}
