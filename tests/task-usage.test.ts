import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { attributeUsage, parseProcStat, parsePsRows, TaskUsage, usageChanged } from '../src/main/task-usage'
import { tagsByPid } from '../src/main/tab-processes'
import { cpuTone, formatMem, memTone, parseMachineUsage, type MachineUsage, type TaskUsageSnapshot } from '../src/shared/task-usage'
import { machineTone } from '../src/renderer/components/desk/TaskUsageStatus'
import { HISTORY_MS, recordUsage, taskUsage, taskUsageSeries } from '../src/renderer/taskUsage'
import { DesktopRouting, type RoutingHub } from '../src/main/servers/desktop-routing'
import type { ServerEvent } from '../src/main/servers/server-hub'
import type { ServersState } from '../src/shared/servers'
import type { Task } from '../src/shared/types'

const MB = 1024 ** 2
const GB = 1024 ** 3

describe('parsePsRows', () => {
  it('reads pid, ppid, cpu and rss in KiB', () => {
    expect(parsePsRows('  10     1  12.5  2048\n  11 10 0.0 4\n\ngarbage\n')).toEqual([
      { pid: 10, ppid: 1, cpu: 12.5, rss: 2048 * 1024 },
      { pid: 11, ppid: 10, cpu: 0, rss: 4096 }
    ])
  })
})

describe('tagsByPid', () => {
  it('maps each tagged pid to its tab', () => {
    const ps = [
      '  101 node server.js PATH=/bin DEVTOOL_TAB_OWNER=tab-1 HOME=/u',
      '  102 electron . DEVTOOL_TAB_OWNER=tab-2',
      '  104 zsh HOME=/u'
    ].join('\n')
    expect([...tagsByPid(ps)]).toEqual([[101, 'tab-1'], [102, 'tab-2']])
  })
})

describe('attributeUsage', () => {
  const row = (pid: number, ppid: number, cpu: number, rssMb: number) => ({ pid, ppid, cpu, rss: rssMb * MB })
  const rows = [
    row(1, 0, 1, 10), // launchd
    row(50, 1, 5, 300), // DevTool
    row(100, 50, 0, 5), // zsh of a terminal tab
    row(101, 100, 300, 900), // npm test
    row(102, 101, 200, 600), // its worker
    row(200, 50, 20, 290), // claude of a chat tab (tagged)
    row(201, 200, 10, 100), // a tool it runs (tagged, inherited)
    row(300, 1, 30, 400), // vite the agent detached (tagged)
    row(400, 1, 90, 900) // someone else's
  ]

  it('sums each tab by its PTY tree and its tag, counting a pid once', () => {
    const usage = attributeUsage(rows, new Map([['term', 100]]), new Map([[200, 'chat'], [201, 'chat'], [300, 'chat']]), [50])
    expect(usage.term).toEqual({ cpu: 500, rss: 1505 * MB, procs: 3 })
    expect(usage.chat).toEqual({ cpu: 60, rss: 790 * MB, procs: 3 })
    expect(Object.keys(usage).sort()).toEqual(['chat', 'term'])
  })

  it('never counts the excluded pids', () => {
    const usage = attributeUsage(rows, new Map([['term', 100]]), new Map([[50, 'outer']]), [50])
    expect(usage.outer).toBeUndefined()
  })

  it('skips a root that is gone', () => {
    expect(attributeUsage(rows, new Map([['gone', 999]]), new Map(), [])).toEqual({})
  })
})

describe('usageChanged', () => {
  const a = { t: { cpu: 100, rss: GB, procs: 2 } }
  it('ignores jitter and notices real changes', () => {
    expect(usageChanged(a, { t: { cpu: 105, rss: GB + 10 * MB, procs: 2 } })).toBe(false)
    expect(usageChanged(a, { t: { cpu: 120, rss: GB, procs: 2 } })).toBe(true)
    expect(usageChanged(a, { t: { cpu: 100, rss: GB, procs: 3 } })).toBe(true)
    expect(usageChanged(a, {})).toBe(true)
  })
})

describe('tones and formatting', () => {
  it('shows CPU from half a core, amber from two, red from four', () => {
    expect(cpuTone(40)).toBeNull()
    expect(cpuTone(60)).toBe('quiet')
    expect(cpuTone(250)).toBe('warm')
    expect(cpuTone(640)).toBe('hot')
  })

  it('shows memory from 1 GB, amber from 4, red from 8', () => {
    expect(memTone(900 * MB)).toBeNull()
    expect(memTone(1.2 * GB)).toBe('quiet')
    expect(memTone(4.5 * GB)).toBe('warm')
    expect(memTone(9 * GB)).toBe('hot')
  })

  it('formats memory', () => {
    expect(formatMem(910 * MB)).toBe('910 MB')
    expect(formatMem(3.8 * GB)).toBe('3.8 GB')
    expect(formatMem(12 * GB)).toBe('12 GB')
  })

  it('tones the machine total by the larger share', () => {
    expect(machineTone({ cpu: 300, rss: GB, procs: 1 }, 12, 36 * GB)).toBe('quiet')
    expect(machineTone({ cpu: 900, rss: GB, procs: 1 }, 12, 36 * GB)).toBe('warm')
    expect(machineTone({ cpu: 100, rss: 33 * GB, procs: 1 }, 12, 36 * GB)).toBe('hot')
  })
})

describe('parseProcStat', () => {
  it('reads ppid, CPU ticks and resident pages past a name with spaces and parens', () => {
    const stat = '4242 (node (worker) x) S 4100 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 12345 999999 2560 18446744073709551615'
    expect(parseProcStat(stat)).toEqual({ ppid: 4100, ticks: 300, rssPages: 2560 })
  })

  it('refuses a line without a name', () => {
    expect(parseProcStat('garbage')).toBeNull()
  })
})

describe('parseMachineUsage', () => {
  it('keeps well-formed tabs and drops the rest', () => {
    expect(parseMachineUsage({ cores: 8, totalMem: 16, tabs: { a: { cpu: 1, rss: 2, procs: 1 }, b: { cpu: 'x' } } }))
      .toEqual({ cores: 8, totalMem: 16, tabs: { a: { cpu: 1, rss: 2, procs: 1 } } })
    expect(parseMachineUsage(null)).toBeNull()
    expect(parseMachineUsage({ tabs: {} })).toBeNull()
  })
})

describe('TaskUsage', () => {
  it('lists this machine first, then each server, and drops a server that goes away', () => {
    let changes = 0
    const usage = new TaskUsage({ ptyRoots: () => new Map(), localLabel: 'This Mac', onChange: () => { changes++ } })
    const box: MachineUsage = { cores: 4, totalMem: 8 * GB, tabs: { t1: { cpu: 300, rss: GB, procs: 2 } } }
    usage.setForeign('srvA', 'box', box)
    const hosts = usage.snapshot().hosts
    expect(hosts.map(h => [h.id, h.label])).toEqual([['local', 'This Mac'], ['srvA', 'box']])
    expect(hosts[1].tabs).toEqual(box.tabs)
    usage.setForeign('srvA', '', null)
    usage.setForeign('srvA', '', null)
    expect(usage.snapshot().hosts.map(h => h.id)).toEqual(['local'])
    expect(changes).toBe(2)
  })
})

describe('DesktopRouting with server usage', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

  it('asks a server that comes online, folds its pushes in, and drops it when it goes offline', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-usage-'))
    dirs.push(configDir)
    let state: ServersState = {
      relay: { kind: 'online' },
      servers: [{ id: 'srvA', name: 'box', state: 'online', pairedAt: 1, lastSeen: 2, build: null, host: null }],
      invite: null
    }
    const events = new Set<(event: ServerEvent) => void>()
    const stateListeners = new Set<(state: ServersState) => void>()
    const first: MachineUsage = { cores: 4, totalMem: 8 * GB, tabs: { t1: { cpu: 100, rss: GB, procs: 1 } } }
    const hub: RoutingHub = {
      getState: () => state,
      onStateChange: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener) },
      onEvent: (listener) => { events.add(listener); return () => events.delete(listener) },
      call: async (_serverId, _clientId, ch) => {
        if (ch === 'load-projects') return { local: { revision: 1, data: { projects: [], tags: [], projectOrder: [], pinnedItems: [] } } }
        if (ch === 'task-usage-get') return first
        return {}
      }
    }
    const seen: Array<[string, string, MachineUsage | null]> = []
    const routing = new DesktopRouting({ configDir, windows: { send: () => {}, broadcast: () => {} }, log: () => {} })
    routing.attachHost({
      getProjectsData: () => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }),
      onProjectsChanged: () => () => {},
      taskUsage: { setForeign: (serverId, label, usage) => { seen.push([serverId, label, usage]) } }
    })
    routing.attachHub(hub)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen).toEqual([['srvA', 'box', first]])

    const pushed: MachineUsage = { cores: 4, totalMem: 8 * GB, tabs: { t1: { cpu: 380, rss: 2 * GB, procs: 3 } } }
    for (const listener of events) listener({ serverId: 'srvA', ch: 'server-task-usage-changed', args: [pushed] } as ServerEvent)
    expect(seen[1]).toEqual(['srvA', 'box', pushed])

    state = { ...state, servers: [{ ...state.servers[0], state: 'offline' }] }
    for (const listener of stateListeners) listener(state)
    expect(seen[2]).toEqual(['srvA', '', null])
    // A late push from a server already offline is ignored.
    for (const listener of events) listener({ serverId: 'srvA', ch: 'server-task-usage-changed', args: [pushed] } as ServerEvent)
    expect(seen).toHaveLength(3)
  })
})

describe('the hover chart history', () => {
  const task = { id: 'task', name: 'T', panes: [{ tabs: [{ id: 'h-a', type: 'terminal', title: '' }, { id: 'h-b', type: 'terminal', title: '' }] }] } as unknown as Task
  const snap = (tabs: MachineUsage['tabs'], id = 'local'): TaskUsageSnapshot => ({ hosts: [{ id, label: id, cores: 8, totalMem: 16 * GB, tabs }] })

  it('sums a task over its tabs and names the machine they run on', () => {
    recordUsage(snap({ 'h-a': { cpu: 10, rss: 1, procs: 1 }, 'h-b': { cpu: 5, rss: 2, procs: 2 } }, 'srvA'), 1_000_000)
    const found = taskUsage(snap({}), task)
    expect(found?.usage).toEqual({ cpu: 15, rss: 3, procs: 3 })
    expect(found?.host.id).toBe('srvA')
  })

  it('holds each value until the next push, and drops to zero when the tab stops', () => {
    const t0 = 5_000_000
    recordUsage(snap({ 'h-a': { cpu: 100, rss: GB, procs: 1 } }), t0)
    recordUsage(snap({ 'h-a': { cpu: 400, rss: 2 * GB, procs: 2 } }), t0 + 60_000)
    recordUsage(snap({}), t0 + 90_000)
    const series = taskUsageSeries(task, t0 + HISTORY_MS)
    expect(series.cpu).toHaveLength(41)
    // 0–60 s: 100%; 60–90 s: 400%; then nothing.
    expect(series.cpu[0]).toBe(100)
    expect(series.cpu[20]).toBe(400)
    expect(series.cpu[29]).toBe(400)
    expect(series.cpu[30]).toBe(0)
    expect(series.rss[25]).toBe(2 * GB)
    expect(series.cpu[40]).toBe(0)
  })
})
