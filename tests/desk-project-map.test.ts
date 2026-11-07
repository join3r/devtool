import { describe, expect, it } from 'vitest'
import { aheadBehindLine, commitNotes, LANE_GEOMETRY as G, labelWidth, laneGeometry, laneTrack, mergedBranch, placeMarks, projectLanes, type RailMark, projectHostLabel, quietFor, recentWeeks } from '../src/renderer/components/desk/projectMap'
import { emptyArchive, pruneArchive, withoutArchived, type ProjectArchive } from '../src/shared/archive'
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task, WorkspaceConfig } from '../src/shared/types'

function commit(hash: string, parents: string[], day = 1): GitGraphCommit {
  return { hash, parents, subject: `commit ${hash}`, author: 'me', isoDate: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z` }
}

function ws(branchName: string, baseBranch: string): WorkspaceConfig {
  return { worktreePath: `/wt/${branchName}`, branchName, baseBranch, relativeProjectPath: '' }
}

function task(id: string, workspace?: WorkspaceConfig): Task {
  return { id, name: id, panes: [], ...(workspace ? { workspace } : {}) } as unknown as Task
}

function stream(id: string, extra: Partial<Stream> = {}): Stream {
  return { id, name: id, tasks: [], ...extra } as Stream
}

/** Newest first, like `git log --topo-order`. */
function graph(commits: GitGraphCommit[], tips: Record<string, string>, head = 'master'): GitBranchGraph {
  return { commits, tips, head, more: false }
}

const ids = (items: ReturnType<typeof laneTrack>['items']) => items.map(i => i.kind === 'commit' ? i.commit.hash : i.kind === 'task' ? `task:${i.task.id}` : `mark:${i.mark.key}`)

describe('project map lanes', () => {
  // master: a ← b ← c ← d; stream rel cut from b: b ← r1 ← r2; task t1 off c, task t2 off a.
  const g = graph([
    commit('r2', ['r1'], 9), commit('d', ['c'], 8), commit('t1x', ['c'], 7), commit('r1', ['b'], 6),
    commit('c', ['b'], 5), commit('b', ['a'], 4), commit('t2x', ['a'], 3), commit('a', [], 2)
  ], { master: 'd', rel: 'r2', 'task/t1': 't1x', 'task/t2': 't2x' })

  it('draws the main stream\'s first-parent history older → newer with tasks after the commit they forked from', () => {
    const main = stream('main', { isMain: true, tasks: [task('t1', ws('task/t1', 'master')), task('plain'), task('t2', ws('task/t2', 'master'))] })
    const track = laneTrack(g, main)
    expect(track.branch).toBe('master')
    expect(track.projectFolder).toBe(true)
    expect(ids(track.items)).toEqual(['a', 'task:t2', 'b', 'c', 'task:t1', 'd', 'task:plain'])
    expect(track.newest?.hash).toBe('d')
    expect(track.ahead).toBeNull()
  })

  it('keeps only the newest commits, and puts tasks forked from older ones first', () => {
    const main = stream('main', { isMain: true, tasks: [task('t2', ws('task/t2', 'master'))] })
    expect(ids(laneTrack(g, main, 2).items)).toEqual(['task:t2', 'c', 'd'])
  })

  it('counts a worktree stream ahead of and behind its base, drawing only its own commits', () => {
    const rel = stream('rel', { workspace: ws('rel', 'master') })
    const track = laneTrack(g, rel)
    expect(ids(track.items)).toEqual(['r1', 'r2'])
    expect([track.ahead, track.behind, track.partial]).toEqual([2, 2, false])
    expect(aheadBehindLine(track, 'master')).toBe('2 ahead of master · 2 behind')
  })

  it('draws no commits for another project-folder stream, which shares main\'s checkout', () => {
    const side = stream('side', { tasks: [task('x')] })
    const track = laneTrack(g, side)
    expect(track.branch).toBe('master')
    expect(ids(track.items)).toEqual(['task:x'])
    expect(track.newest).toBeNull()
  })

  it('without a graph lists the tasks alone', () => {
    const track = laneTrack(null, stream('main', { isMain: true, tasks: [task('a'), task('b')] }))
    expect(track.branch).toBeNull()
    expect(ids(track.items)).toEqual(['task:a', 'task:b'])
  })

  it('marks counts that ran past the loaded graph', () => {
    const cut = graph([commit('r2', ['r1']), commit('d', ['c'])], { master: 'd', rel: 'r2' })
    const track = laneTrack(cut, stream('rel', { workspace: ws('rel', 'master') }))
    expect(track.partial).toBe(true)
    expect(aheadBehindLine(track, 'master')).toBe('1+ ahead of master · 1+ behind')
  })
})

describe('project map lines', () => {
  it('says how a stream stands against its base', () => {
    const base = { branch: 'x', projectFolder: false, items: [], partial: false, newest: null, history: [], baseMerges: new Set<string>() }
    expect(aheadBehindLine({ ...base, ahead: 0, behind: 0 }, 'master')).toBe('up to date with master')
    expect(aheadBehindLine({ ...base, ahead: 0, behind: 3 }, 'master')).toBe('3 behind master')
    expect(aheadBehindLine({ ...base, ahead: null, behind: null }, 'master')).toBeNull()
  })

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

describe('project map lane geometry', () => {
  const c = (hash: string) => ({ kind: 'commit' as const, commit: commit(hash, []) })
  const t = (id: string) => ({ kind: 'task' as const, task: task(id) })

  it('spaces commits on the rail and hangs each task under the commit it forked from', () => {
    const geo = laneGeometry([c('a'), t('early'), c('b'), c('c'), t('late')])
    expect(geo.commits.map(x => x.x)).toEqual([G.padLeft, G.padLeft + G.step, G.padLeft + 2 * G.step])
    expect(geo.tasks.map(x => x.forkX)).toEqual([G.padLeft, G.padLeft + 2 * G.step])
    expect(geo.tasks[0].x).toBe(G.padLeft - G.stemInset)
    // The second card can't sit under its fork: it starts after the first.
    expect(geo.tasks[1].x).toBe(geo.tasks[0].x + G.cardWidth + G.cardGap)
    expect(geo.railEnd).toBe(G.padLeft + 2 * G.step)
    expect(geo.addX).toBe(geo.railEnd + G.addGap)
    expect(geo.width).toBe(geo.tasks[1].x + G.cardWidth + G.padRight)
  })

  it('forks tasks older than every drawn commit from the rail\'s start', () => {
    const geo = laneGeometry([t('old'), c('a')])
    expect(geo.tasks[0].forkX).toBe(geo.railStart)
    expect(geo.tasks[0].x).toBeGreaterThanOrEqual(0)
  })

  it('without commits keeps the rail short and the tasks at its start', () => {
    const geo = laneGeometry([t('x')])
    expect(geo.commits).toEqual([])
    expect(geo.railEnd).toBe(geo.railStart)
    expect(geo.tasks[0].forkX).toBe(geo.railStart)
  })
})

describe('project map history', () => {
  const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T10:00:00Z`).getTime()
  const done = (t: Task, day: number, streamId = 'main') => ({ task: t, streamId, streamName: streamId, dir: '', archivedAt: at(day) })

  // master: a ← b ← "Fix login" ← m (merges rel's r1); rel cut from a: a ← r1 ← mb (merges b back in) ← r2
  const g = graph([
    commit('r2', ['mb'], 9), commit('m', ['fix', 'r1'], 8), commit('mb', ['r1', 'b'], 7), commit('r1', ['a'], 5),
    commit('fix', ['b'], 4), commit('b', ['a'], 3), commit('a', [], 2)
  ], { master: 'm', rel: 'r2' })
  g.commits.find(c => c.hash === 'fix')!.subject = 'Fix login'
  g.commits.find(c => c.hash === 'm')!.subject = 'Merge stream "rel" (rel) into master'
  const main = stream('main', { isMain: true })
  const rel = stream('rel', { workspace: ws('rel', 'master') })

  it('reads the branch a merge commit names', () => {
    expect(mergedBranch('Merge stream "0.8.0" (0.8.0) into main')).toEqual({ stream: '0.8.0', branch: '0.8.0' })
    expect(mergedBranch("Merge branch 'feature/x' into main")).toEqual({ branch: 'feature/x' })
    expect(mergedBranch('Merge pull request #12 from me/fix-it')).toEqual({ branch: 'fix-it' })
    expect(mergedBranch('Fix merge of things')).toBeNull()
  })

  it('checks the commit a done task landed, by its recorded commit or else by its name', () => {
    const track = laneTrack(g, main)
    const recorded = { ...task('t1'), name: 'Something else', landedCommits: ['b'] } as Task
    const named = { ...task('t2'), name: 'Fix login' } as Task
    const lost = { ...task('t3'), name: 'Never landed' } as Task
    const { notes, unclaimed } = commitNotes(track, [done(recorded, 3), done(named, 4), done(lost, 6)], undefined, new Map())
    expect(notes.get('b')).toEqual({ kind: 'task', name: 'Something else' })
    expect(notes.get('fix')).toEqual({ kind: 'task', name: 'Fix login' })
    expect(notes.get('m')).toEqual({ kind: 'merged', name: 'rel' })
    expect(unclaimed.map(t => t.id)).toEqual(['t3'])
  })

  it('tells a merge of the base into a stream apart', () => {
    const track = laneTrack(g, rel)
    expect([...track.baseMerges]).toEqual(['mb'])
    expect(commitNotes(track, [], 'master', new Map()).notes.get('mb')).toEqual({ kind: 'base', name: 'master' })
  })

  it('puts marks on the rail by time, leaving out ones older than what is drawn', () => {
    const mark = (key: string, day: number): RailMark => ({ key, kind: 'closed', at: at(day) + 1, label: key, title: key })
    const whole = laneTrack(g, main)
    expect(ids(placeMarks(whole, [mark('x', 3), mark('y', 20), mark('z', 1)]).items)).toEqual(['mark:z', 'a', 'b', 'mark:x', 'fix', 'm', 'mark:y'])
    const cut = laneTrack(g, main, 2)
    expect(ids(placeMarks(cut, [mark('old', 2), mark('new', 8)]).items)).toEqual(['fix', 'm', 'mark:new'])
  })

  it('puts closed and deleted streams on the lane they came from, folding a close into its merge', () => {
    const project = { id: 'p', name: 'p', streams: [main, rel] } as unknown as Project
    const archive: ProjectArchive = {
      ...emptyArchive(),
      tasks: [done({ ...task('t3'), name: 'Never landed' } as Task, 6)],
      streams: [
        { stream: stream('rel-old', { name: 'rel' } as Partial<Stream>), doneTasks: [], dir: '', archivedAt: at(8) },
        { stream: stream('spike'), doneTasks: [], dir: '', archivedAt: at(4) }
      ],
      deletedStreams: [{ streamId: 'gone', streamName: 'gone', branchName: 'gone', baseBranch: 'rel', closedAt: at(5), deletedAt: at(9) }]
    }
    const lanes = projectLanes(project, g, archive)
    const mainLane = lanes.get('main')!
    expect(mainLane.notes.get('m')).toEqual({ kind: 'merged', name: 'rel', closed: true })
    expect(ids(mainLane.track.items)).toEqual(['a', 'b', 'fix', 'mark:closed-spike', 'mark:done-t3', 'm'])
    // r1 reached master with the merge, so only mb and r2 are rel's own.
    expect(ids(lanes.get('rel')!.track.items)).toEqual(['mb', 'r2', 'mark:deleted-gone'])
  })

  it('remembers streams deleted for good, not reopened ones, until they are older than the retention', () => {
    const archive: ProjectArchive = { ...emptyArchive(), streams: [{ stream: stream('s', { workspace: ws('s', 'master') }), doneTasks: [], dir: '', archivedAt: 5 }] }
    expect(withoutArchived(archive, { streams: ['s'] }).deletedStreams).toBeUndefined()
    const deleted = withoutArchived(archive, { streams: ['s'] }, 100)
    expect(deleted.deletedStreams).toEqual([{ streamId: 's', streamName: 's', branchName: 's', baseBranch: 'master', closedAt: 5, deletedAt: 100 }])
    expect(pruneArchive(deleted, 50)).toBe(deleted)
    expect(pruneArchive(deleted, 200).deletedStreams).toBeUndefined()
  })

  it('spreads labelled rail items so their labels don\'t touch', () => {
    const c = (hash: string) => ({ kind: 'commit' as const, commit: commit(hash, []) })
    const geo = laneGeometry([c('a'), c('b'), c('c')], item => item.kind === 'commit' && item.commit.hash !== 'b' ? 'a long label here' : null)
    const [a, , cc] = geo.commits.map(x => x.x)
    expect(cc - a).toBeGreaterThanOrEqual(labelWidth('a long label here') + 8)
    expect(geo.labels.map(l => l.key)).toEqual(['a', 'c'])
  })
})
