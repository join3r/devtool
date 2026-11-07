import { describe, expect, it } from 'vitest'
import { aheadBehindLine, FOCUS_CONTEXT, FOCUS_MIN, FOLD_MIN, projectGraph, projectHostLabel, quietFor, recentWeeks, streamAheadBehind, type GraphRow } from '../src/renderer/components/desk/projectMap'
import { emptyArchive, pruneArchive, withoutArchived, type ArchivedTask, type ProjectArchive } from '../src/shared/archive'
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task, WorkspaceConfig } from '../src/shared/types'

function commit(hash: string, parents: string[], day = 1): GitGraphCommit {
  return { hash, parents, subject: `commit ${hash}`, author: 'me', isoDate: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z` }
}

function ws(branchName: string, baseBranch: string): WorkspaceConfig {
  return { worktreePath: `/wt/${branchName}`, branchName, baseBranch, relativeProjectPath: '' }
}

function task(id: string, workspace?: WorkspaceConfig, extra: Partial<Task> = {}): Task {
  return { id, name: id, panes: [], ...(workspace ? { workspace } : {}), ...extra } as unknown as Task
}

function stream(id: string, extra: Partial<Stream> = {}): Stream {
  return { id, name: id, tasks: [], ...extra } as Stream
}

/** Newest first, like `git log --topo-order`. */
function graph(commits: GitGraphCommit[], tips: Record<string, string>, head = 'master'): GitBranchGraph {
  return { commits, tips, head, more: false }
}

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`).getTime()
const done = (t: Task, day: number, streamId = 'main'): ArchivedTask => ({ task: t, streamId, streamName: streamId, dir: '', archivedAt: at(day) })
const keys = (rows: GraphRow[]) => rows.map(r => r.item.kind === 'fold' ? `fold:${r.item.commits.length}` : r.item.key)
const opts = { showDone: false, expanded: new Set<string>(), rowLimit: 100 }

describe('project graph', () => {
  // master: a ← b ← c ← d; stream rel cut from b: b ← r1 ← r2; task t1's branch t1x off c.
  const g = graph([
    commit('r2', ['r1'], 9), commit('d', ['c'], 8), commit('t1x', ['c'], 7), commit('r1', ['b'], 6),
    commit('c', ['b'], 5), commit('b', ['a'], 4), commit('a', [], 2)
  ], { master: 'd', rel: 'r2', 'task/t1': 't1x' })
  const main = stream('main', { isMain: true, tasks: [task('t1', ws('task/t1', 'master')), task('plain')] })
  const rel = stream('rel', { workspace: ws('rel', 'master'), tasks: [task('rx')] })
  const project = { id: 'p', name: 'p', streams: [main, rel] } as unknown as Project

  it('puts open tasks on top, each joined to its own branch or else its stream\'s head', () => {
    const { rows } = projectGraph(project, g, null, opts)
    expect(keys(rows).slice(0, 3)).toEqual(['task:t1', 'task:plain', 'task:rx'])
    const parentOf = (key: string) => rows.find(r => r.item.key === key)!.segments.find(s => s.part === 'bottom')?.parent
    expect(parentOf('task:t1')).toBe('t1x')
    expect(parentOf('task:plain')).toBe('d')
    expect(parentOf('task:rx')).toBe('r2')
  })

  it('names the streams whose branch ends at a commit, and colours commits by the stream they belong to', () => {
    const model = projectGraph(project, g, null, opts)
    const row = (key: string) => model.rows.find(r => r.item.key === key)!
    expect(row('d').item).toMatchObject({ kind: 'commit', heads: ['main'] })
    expect(row('r2').item).toMatchObject({ kind: 'commit', heads: ['rel'] })
    expect(['a', 'b', 'c', 'd', 't1x'].map(h => model.owner.get(h))).toEqual(['main', 'main', 'main', 'main', 'main'])
    expect(['r1', 'r2', 'task:rx'].map(h => model.owner.get(h))).toEqual(['rel', 'rel', 'rel'])
    // rel's line curving into b where it was cut is rel's.
    const fork = row('b').segments.find(s => s.part === 'top' && s.child === 'r1')!
    expect(model.edgeOwner(fork)).toBe('rel')
  })

  it('shows branches git has that no stream or task claims', () => {
    const extra = { ...g, tips: { ...g.tips, develop: 'b' } }
    const row = projectGraph(project, extra, null, opts).rows.find(r => r.item.key === 'b')!
    expect(row.item).toMatchObject({ branches: ['develop'] })
  })

  it('folds runs of plain commits, and opens one asked for', () => {
    const chain = Array.from({ length: 10 }, (_, i) => commit(`c${9 - i}`, i === 9 ? [] : [`c${8 - i}`], 20 - i))
    const linear = graph(chain, { master: 'c9' })
    const solo = { id: 'p', streams: [stream('main', { isMain: true })] } as unknown as Project
    // The head, eight plain commits, then the root (where the line ends).
    expect(keys(projectGraph(solo, linear, null, opts).rows)).toEqual(['c9', 'fold:8', 'c0'])
    expect(keys(projectGraph(solo, linear, null, { ...opts, expanded: new Set(['c8']) }).rows)).toHaveLength(10)
    // Fewer than FOLD_MIN stay as they are.
    const short = graph(chain.slice(7), { master: 'c2' })
    expect(FOLD_MIN).toBe(3)
    expect(keys(projectGraph(solo, short, null, opts).rows)).toEqual(['c2', 'c1', 'c0'])
  })

  it('keeps a fold\'s lines and marks its commits\' column dotted', () => {
    const chain = Array.from({ length: 6 }, (_, i) => commit(`c${5 - i}`, i === 5 ? [] : [`c${4 - i}`], 20 - i))
    const solo = { id: 'p', streams: [stream('main', { isMain: true })] } as unknown as Project
    const fold = projectGraph(solo, graph(chain, { master: 'c5' }), null, opts).rows[1]
    expect(fold.item.kind).toBe('fold')
    expect(fold.column).toBeNull()
    expect(fold.dotted).toEqual([0])
    expect(fold.segments.map(s => [s.lane, s.part])).toEqual([[0, 'full']])
  })

  it('leaves done tasks out until asked for', () => {
    const archive: ProjectArchive = { ...emptyArchive(), tasks: [done({ ...task('x'), name: 'commit c' } as Task, 6)] }
    const hidden = projectGraph(project, g, archive, opts)
    expect(hidden.rows.every(r => r.item.kind !== 'commit' || r.item.done.length === 0)).toBe(true)
    const shown = projectGraph(project, g, archive, { ...opts, showDone: true })
    expect(shown.rows.find(r => r.item.key === 'c')!.item).toMatchObject({ done: [{ task: { id: 'x' } }] })
  })

  it('puts a done task on the commit it landed, by its recorded commit or else by its name on its stream\'s branch', () => {
    const archive: ProjectArchive = {
      ...emptyArchive(),
      tasks: [
        done({ ...task('recorded'), name: 'Something else', landedCommits: ['r1'] } as Task, 7, 'rel'),
        done({ ...task('named'), name: 'commit b' } as Task, 5),
        // Named like a commit on rel, but closed from main: not that one.
        done({ ...task('wrong'), name: 'commit r2' } as Task, 9)
      ]
    }
    const { rows } = projectGraph(project, g, archive, { ...opts, showDone: true })
    const doneOn = (key: string) => (rows.find(r => r.item.key === key)!.item as { done: ArchivedTask[] }).done.map(e => e.task.id)
    expect(doneOn('r1')).toEqual(['recorded'])
    expect(doneOn('b')).toEqual(['named'])
    expect(doneOn('r2')).toEqual([])
    expect(keys(rows)).toContain('done:wrong')
  })

  it('places done tasks without a commit, and closed and deleted streams, by time', () => {
    const archive: ProjectArchive = {
      ...emptyArchive(),
      tasks: [done({ ...task('lost'), name: 'Never landed' } as Task, 6)],
      streams: [{ stream: stream('old', { workspace: ws('old', 'master') }), doneTasks: [], dir: '', archivedAt: at(4) }],
      deletedStreams: [{ streamId: 'gone', streamName: 'gone', closedAt: at(1), deletedAt: at(8) }]
    }
    const { rows } = projectGraph(project, g, archive, { ...opts, showDone: true })
    const commitsAndEvents = keys(rows).filter(k => !k.startsWith('task:'))
    // Commit days: r2 9, d 8, t1x 7, r1 6, c 5, b 4, a 2; events at noon of days 8, 6 and 4.
    expect(commitsAndEvents).toEqual(['r2', 'deleted:gone', 'd', 't1x', 'done:lost', 'r1', 'c', 'closed:old', 'b', 'a'])
    // An event row passes the lines around it through.
    const event = rows.find(r => r.item.key === 'done:lost')!
    expect(event.column).toBeNull()
    expect(event.segments.length).toBeGreaterThan(0)
    expect(event.segments.every(s => s.part === 'full')).toBe(true)
  })

  it('stops at the row limit and says so', () => {
    const model = projectGraph(project, g, null, { ...opts, rowLimit: 4 })
    expect(model.rows).toHaveLength(4)
    expect(model.cut).toBe(true)
    expect(projectGraph(project, g, null, opts).cut).toBe(false)
  })

  it('by default stops a little past where the last stream or task branches off', () => {
    // main c0 … c19; feature cut from c15; old branches nobody claims at c1 … c12 keep those rows from folding.
    const chain = Array.from({ length: 20 }, (_, i) => commit(`c${19 - i}`, i === 19 ? [] : [`c${18 - i}`], 25 - i))
    const tips: Record<string, string> = { master: 'c19', feature: 'f1' }
    for (let i = 1; i <= 12; i++) tips[`old${i}`] = `c${i}`
    const g2 = graph([commit('f1', ['c15'], 26), ...chain], tips)
    const p = { id: 'p', streams: [stream('main', { isMain: true }), stream('feature', { workspace: ws('feature', 'master') })] } as unknown as Project
    const focused = projectGraph(p, g2, null, { showDone: false, expanded: new Set() })
    // f1, c19, ⋯ 3, c15 (the fork), then FOCUS_CONTEXT rows, at least FOCUS_MIN in all.
    expect(keys(focused.rows).slice(0, 4)).toEqual(['f1', 'c19', 'fold:3', 'c15'])
    expect(focused.rows).toHaveLength(Math.max(4 + FOCUS_CONTEXT, FOCUS_MIN))
    expect(focused.cut).toBe(true)
  })

  it('without a graph lists the open tasks alone', () => {
    const { rows, width } = projectGraph(project, null, null, opts)
    expect(keys(rows)).toEqual(['task:t1', 'task:plain', 'task:rx'])
    expect(rows.every(r => r.column === 0 && r.segments.length === 0)).toBe(true)
    expect(width).toBe(1)
  })

  it('nests a task under the task in its stream that started it', () => {
    const parent = task('parent')
    const child = task('child', undefined, { delegatedFrom: { taskId: 'parent', name: 'parent' } })
    const p = { id: 'p', streams: [stream('main', { isMain: true, tasks: [child, task('other'), parent] })] } as unknown as Project
    const rows = projectGraph(p, null, null, opts).rows
    expect(rows.map(r => r.item.kind === 'task' ? `${r.item.task.id}${r.item.nested ? '*' : ''}` : '')).toEqual(['other', 'parent', 'child*'])
  })

  it('counts a worktree stream ahead of and behind its base', () => {
    expect(streamAheadBehind(g, rel)).toEqual({ ahead: 2, behind: 2, partial: false })
    expect(aheadBehindLine(streamAheadBehind(g, rel), 'master')).toBe('2 ahead of master · 2 behind')
    expect(streamAheadBehind(g, main)).toBeNull()
    const cut = graph([commit('r2', ['r1']), commit('d', ['c'])], { master: 'd', rel: 'r2' })
    expect(aheadBehindLine(streamAheadBehind(cut, rel), 'master')).toBe('1+ ahead of master · 1+ behind')
    expect(aheadBehindLine({ ahead: 0, behind: 0, partial: false }, 'master')).toBe('up to date with master')
    expect(aheadBehindLine({ ahead: 0, behind: 3, partial: false }, 'master')).toBe('3 behind master')
    expect(aheadBehindLine(null, 'master')).toBeNull()
  })
})

describe('project map lines', () => {
  it('says how long a quiet lane has been quiet', () => {
    const now = new Date('2026-10-30T12:00:00Z').getTime()
    expect(quietFor('2026-10-30T08:00:00Z', now)).toBeNull()
    expect(quietFor('2026-10-29T08:00:00Z', now)).toBe('Quiet since yesterday')
    expect(quietFor('2026-10-24T08:00:00Z', now)).toBe('Quiet for 6 days')
    expect(quietFor('2026-06-01T08:00:00Z', now)).toBe('Quiet for 5 months')
    expect(quietFor(undefined, now)).toBeNull()
  })

  it('names the host', () => {
    expect(projectHostLabel({ id: 'p' } as Project)).toBe('This Mac')
    expect(projectHostLabel({ id: 'p', host: 's1' } as Project, 'hetzner-1')).toBe('hetzner-1')
    expect(projectHostLabel({ id: 'p', ssh: { host: 'box', port: 22, username: 'me', remoteDir: '' } } as Project)).toBe('me@box')
    expect(projectHostLabel({ id: 'p', shellCommand: { command: 'orb shell' } } as Project)).toBe('Custom shell')
    expect(projectHostLabel({ id: 'p', shellCommand: { command: 'orb shell' } } as Project, undefined, 'Orb')).toBe('Orb')
  })

  it('lays out recent weeks Monday first, ending today', () => {
    const counts = new Map([['2026-10-30', 3], ['2026-10-26', 1]])
    const weeks = recentWeeks(counts, new Date(2026, 9, 30, 15), 2)
    expect(weeks).toHaveLength(2)
    expect(weeks[0][0].iso).toBe('2026-10-19')
    expect(weeks[0]).toHaveLength(7)
    // Friday the 30th is the last day drawn.
    expect(weeks[1].map(d => d.iso)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'])
    expect(weeks[1].map(d => d.count)).toEqual([1, 0, 0, 0, 3])
  })
})

describe('project archive', () => {
  it('remembers streams deleted for good, not reopened ones, until they are older than the retention', () => {
    const archive: ProjectArchive = { ...emptyArchive(), streams: [{ stream: stream('s', { workspace: ws('s', 'master') }), doneTasks: [], dir: '', archivedAt: 5 }] }
    expect(withoutArchived(archive, { streams: ['s'] }).deletedStreams).toBeUndefined()
    const deleted = withoutArchived(archive, { streams: ['s'] }, 100)
    expect(deleted.deletedStreams).toEqual([{ streamId: 's', streamName: 's', branchName: 's', baseBranch: 'master', closedAt: 5, deletedAt: 100 }])
    expect(pruneArchive(deleted, 50)).toBe(deleted)
    expect(pruneArchive(deleted, 200).deletedStreams).toBeUndefined()
  })
})
