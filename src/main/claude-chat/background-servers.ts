import { execFile } from 'child_process'
import fs from 'fs'

/**
 * Which of a chat's background shells are servers: a shell is one when anything
 * under it listens on a TCP port. A dev server the agent started with
 * `run_in_background` never ends, so counting it as work would hold the task
 * "working" forever; a build or a test run listens on nothing and still counts.
 *
 * The shells are found under the chat's own `claude` process (a child of this
 * one, named by its session id). Claude Code points a background shell's stdout
 * at `…/tasks/<task id>.output`, which says which task each shell is.
 */

export interface ProcEntry {
  pid: number
  ppid: number
  command: string
}

/** A background shell's stdout: `…/tasks/<task id>.output`. */
const TASK_OUTPUT = /\/tasks\/([^/]+)\.output$/

/** The task id a background shell's stdout path names, or null. */
export function taskIdOfOutput(path: string): string | null {
  const match = TASK_OUTPUT.exec(path)
  return match ? match[1] : null
}

/** `ps -axo pid=,ppid=,command=` lines. */
export function parsePsCommands(output: string): ProcEntry[] {
  const out: ProcEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return out
}

/** The chat's `claude`: a child of `parentPid` whose command names the session. */
export function findChatRoot(procs: readonly ProcEntry[], parentPid: number, sessionId: string): number | null {
  const found = procs.find(p => p.ppid === parentPid && p.command.includes(sessionId))
  return found ? found.pid : null
}

/** The processes directly under `root`. */
export function childrenOf(procs: readonly ProcEntry[], root: number): number[] {
  return procs.filter(p => p.ppid === root).map(p => p.pid)
}

/** `pid` and everything under it. */
export function subtree(procs: readonly ProcEntry[], pid: number): number[] {
  const children = new Map<number, number[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const seen = new Set<number>()
  const stack = [pid]
  while (stack.length > 0) {
    const next = stack.pop() as number
    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
    for (const child of children.get(next) ?? []) stack.push(child)
  }
  return out
}

/** Of `lsof -Fp` output, the pids. */
export function parseLsofPids(output: string): Set<number> {
  const pids = new Set<number>()
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      if (Number.isInteger(pid)) pids.add(pid)
    }
  }
  return pids
}

/** Of `lsof -Fpn` output, each pid's (first) file name. */
export function parseLsofNames(output: string): Map<number, string> {
  const names = new Map<number, string>()
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null && Number.isInteger(pid) && !names.has(pid)) names.set(pid, line.slice(1))
  }
  return names
}

/** Of `/proc/net/tcp` or `tcp6` contents, the socket inodes in LISTEN state. */
export function listeningInodes(table: string): Set<string> {
  const inodes = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    // sl local rem st tx:rx tr:tm retrnsmt uid timeout inode
    if (fields.length > 9 && fields[3] === '0A' && fields[9] !== '0') inodes.add(fields[9])
  }
  return inodes
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when nothing matched: its (empty) output is still the answer.
      if (err && !stdout && (err as { code?: unknown }).code !== 1) resolve(null)
      else resolve(stdout ?? '')
    })
  })
}

function readProcTable(): ProcEntry[] {
  const out: ProcEntry[] = []
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid)) continue
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
      if (Number.isInteger(ppid)) out.push({ pid, ppid, command })
    } catch {
      // Gone, or someone else's.
    }
  }
  return out
}

async function processTable(): Promise<ProcEntry[] | null> {
  if (process.platform === 'linux') return readProcTable()
  const out = await run('ps', ['-axo', 'pid=,ppid=,command='])
  return out === null ? null : parsePsCommands(out)
}

/** Which of `pids` listen on a TCP port; null when that can't be told. */
async function listeningAmong(pids: readonly number[]): Promise<Set<number> | null> {
  if (pids.length === 0) return new Set()
  if (process.platform === 'linux') {
    const inodes = new Set<string>()
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        for (const inode of listeningInodes(fs.readFileSync(table, 'utf8'))) inodes.add(inode)
      } catch {
        // No IPv6, say.
      }
    }
    const found = new Set<number>()
    if (inodes.size === 0) return found
    for (const pid of pids) {
      let fds: string[]
      try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
      for (const fd of fds) {
        let target: string
        try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { continue }
        const match = /^socket:\[(\d+)\]$/.exec(target)
        if (match && inodes.has(match[1])) { found.add(pid); break }
      }
    }
    return found
  }
  const out = await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fp', '-p', pids.join(',')])
  return out === null ? null : parseLsofPids(out)
}

/** Each pid's stdout path, of those that have one. */
async function stdoutPaths(pids: readonly number[]): Promise<Map<number, string> | null> {
  if (pids.length === 0) return new Map()
  if (process.platform === 'linux') {
    const paths = new Map<number, string>()
    for (const pid of pids) {
      try { paths.set(pid, fs.readlinkSync(`/proc/${pid}/fd/1`)) } catch { /* gone */ }
    }
    return paths
  }
  const out = await run('lsof', ['-nP', '-a', '-d', '1', '-Fpn', '-p', pids.join(',')])
  return out === null ? null : parseLsofNames(out)
}

/**
 * The chat's background shell tasks that are servers, by task id. Null when it
 * can't be told (no `claude` found, a platform without the tools): then every
 * shell keeps counting as work.
 */
export async function detectServerTasks(sessionId: string, parentPid = process.pid): Promise<Set<string> | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  try {
    const procs = await processTable()
    if (!procs) return null
    const root = findChatRoot(procs, parentPid, sessionId)
    if (root === null) return null
    const paths = await stdoutPaths(childrenOf(procs, root))
    if (!paths) return null
    const shells = new Map<string, number[]>()
    for (const [pid, path] of paths) {
      const id = taskIdOfOutput(path)
      if (id) shells.set(id, subtree(procs, pid))
    }
    const listening = await listeningAmong([...shells.values()].flat())
    if (!listening) return null
    const servers = new Set<string>()
    for (const [id, tree] of shells) if (tree.some(pid => listening.has(pid))) servers.add(id)
    return servers
  } catch {
    return null
  }
}
