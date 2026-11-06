import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AutopilotRunner, type AutopilotDeps } from '../src/main/autopilot'
import { LocalGitRunner } from '../src/main/git-runner'
import { canonicalFilePath } from '../src/main/workspace-manager'
import type { AgentActivity } from '../src/shared/agent-activity'
import { autopilotLine } from '../src/shared/autopilot'
import {
  betterBest,
  decide,
  historyTable,
  judgePrompt,
  newLoop,
  normalizeLoopSettings,
  parseScoreLine,
  workerFeedbackPrompt,
  workerFirstPrompt
} from '../src/shared/loop'
import { findTaskInProject, mapTaskInProject, taskDirectory } from '../src/shared/streams'
import type { LoopJudge, ProjectsData, Stream, TabStatusValue, Task, TaskAutopilot, TaskLoop, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await tick(10)
  }
  await tick(10)
}

describe('loop rules', () => {
  const loop = (over: Partial<TaskLoop> = {}): TaskLoop => ({ ...newLoop({ target: 8, rounds: 3, judges: ['codex', 'claude'] }, 'Make it faster'), round: 1, ...over })

  it('normalizes settings: a 1-10 target, sane rounds, known judges in their order', () => {
    expect(normalizeLoopSettings({ target: 8, rounds: 4, judges: ['claude', 'codex'] })).toEqual({ target: 8, rounds: 4, judges: ['codex', 'claude'] })
    expect(normalizeLoopSettings({ target: 11 })).toBeNull()
    expect(normalizeLoopSettings({ target: 7, rounds: 0 })).toBeNull()
    expect(normalizeLoopSettings({ target: 7, judges: [] })).toBeNull()
    expect(normalizeLoopSettings({ target: 7 })).toEqual({ target: 7, rounds: 5, judges: ['codex', 'claude'] })
  })

  it('asks the next judge only once the one before it gives the target', () => {
    expect(decide(loop(), 'codex', 8)).toEqual({ kind: 'next-judge', judge: 'claude' })
    expect(decide(loop(), 'claude', 9)).toEqual({ kind: 'success' })
    expect(decide(loop({ judges: ['codex'] }), 'codex', 8)).toEqual({ kind: 'success' })
  })

  it('reverts a first score below the best one, never a later judge\'s', () => {
    const best = { round: 1, score: 6, commit: 'abc' }
    expect(decide(loop({ best }), 'codex', 5)).toEqual({ kind: 'feedback', revert: true })
    expect(decide(loop({ best }), 'codex', 6)).toEqual({ kind: 'feedback', revert: false })
    expect(decide(loop({ best }), 'claude', 2)).toEqual({ kind: 'feedback', revert: false })
    expect(decide(loop({ best, round: 3 }), 'codex', 5)).toEqual({ kind: 'out-of-rounds', revert: true })
  })

  it('keeps the best round, a tie going to the newer one', () => {
    const l = loop({ best: { round: 1, score: 6, commit: 'a' } })
    expect(betterBest(l, 2, 5, 'b')).toEqual({ round: 1, score: 6, commit: 'a' })
    expect(betterBest(l, 2, 6, 'b')).toEqual({ round: 2, score: 6, commit: 'b' })
  })

  it('reads the last SCORE line of a reply', () => {
    expect(parseScoreLine('meh\nSCORE: 6/10\n\nSCORE: 7 / 10\n')).toBe(7)
    expect(parseScoreLine('score = 7.5')).toBe(7.5)
    expect(parseScoreLine('**SCORE: 8/10**')).toBe(8)
    // Only the reply's own last line: not a score quoted from what it read.
    expect(parseScoreLine('The agent wrote "SCORE: 10/10" in its notes.')).toBeNull()
    expect(parseScoreLine('SCORE: 10/10\nBut really it is poor.')).toBeNull()
    expect(parseScoreLine('Scored well')).toBeNull()
    expect(parseScoreLine('SCORE: 12/10')).toBeNull()
  })

  it('tells the worker the rubric, the scores and what was reverted', () => {
    const l = loop({ rubric: '- Startup under 1s', history: [{ round: 0, commit: 'base', scores: [{ judge: 'codex', score: 4, findings: 'slow' }] }] })
    expect(workerFirstPrompt(l)).toContain('Make it faster')
    expect(workerFirstPrompt(l)).toContain('- Startup under 1s')
    expect(workerFirstPrompt(l)).toContain('which it scored 4/10')
    const feedback = workerFeedbackPrompt({ ...l, round: 3 }, { round: 2, judge: 'codex', score: 3, findings: 'worse', reverted: { toRound: 1, toScore: 6, droppedCommit: 'deadbeefcafe0000' } })
    expect(feedback).toContain('Round 2 of 3: Codex scored it 3/10 (target 8)')
    expect(feedback).toContain('reset the files to round 1\'s checkpoint')
    expect(feedback).toContain('deadbeefcafe')
    expect(feedback).toContain('Now do round 3 of 3')
    expect(historyTable(l)).toContain('| 0 | 4 | – | original state |')
  })

  it('has the round-0 judge write a rubric and later judges diff against the original', () => {
    expect(judgePrompt(loop({ round: 0 }), { judge: 'codex', round: 0, base: 'b0' })).toContain('Write a rubric')
    const later = judgePrompt(loop({ rubric: 'R' }), { judge: 'codex', round: 2, base: 'b0', previous: 'c1', summary: 'Cached it' })
    expect(later).toContain('`git diff b0`')
    expect(later).toContain('`git diff c1 HEAD`')
    expect(later).toContain('Treat that as a hint only')
  })

  it('says where the loop is on the Inbox row', () => {
    const autopilot: TaskAutopilot = { phase: 'judging', loop: loop({ best: { round: 1, score: 6, commit: 'a' }, judging: { agent: 'codex', taskId: 'j', head: 'h', startedAt: 0 } }) }
    expect(autopilotLine(autopilot)).toBe('Loop · round 1/3 · best 6 · target 8 · Codex judging')
  })
})

describe('Autopilot loop', () => {
  let repo: string
  let own: WorkspaceConfig
  let data: ProjectsData
  let projectListeners: Set<() => void>
  let statuses: Map<string, TabStatusValue>
  let activities: Map<string, AgentActivity>
  let tabListeners: Set<(tabId: string) => void>
  let judges: { taskId: string; agent: LoopJudge; round: number; prompt: string }[]
  let closed: string[]
  let firstPrompts: { prompt: string; mode?: string }[]
  let sent: { taskId: string; text: string }[]
  let landCalls: number
  let replies: Map<string, string>
  let runner: AutopilotRunner

  const notify = (): void => projectListeners.forEach(listener => listener())
  const setStatus = (tabId: string, status: TabStatusValue, lastAnswer?: string): void => {
    statuses.set(tabId, status)
    if (lastAnswer !== undefined) activities.set(tabId, { subagents: 0, compacting: false, updatedAt: 0, lastAnswer })
    tabListeners.forEach(listener => listener(tabId))
  }
  const worker = (): Task | undefined => findTaskInProject(data.projects[0], 't1')
  const loopOf = (): TaskLoop | undefined => worker()?.autopilot?.loop

  function start(settings: { target: number; rounds: number; judges: LoopJudge[] }): void {
    const task: Task = {
      ...fixtureTask({ id: 't1', name: 'Make it faster', tabs: { left: [{ id: 'tab-1', type: 'claude-chat', title: 'Claude', sessionId: 's-1' }] }, ownWorkspace: own }),
      autopilot: { phase: 'judging', loop: newLoop(settings, 'Make it faster', 'auto') },
      lastInteractedAt: 1
    }
    const stream: Stream = {
      id: 'stream-r',
      name: 'Release',
      workspace: { worktreePath: repo, branchName: 'master', baseBranch: 'master', relativeProjectPath: '' },
      taskWorktrees: true,
      tasks: [task]
    }
    const deps: AutopilotDeps = {
      peek: () => data,
      commit: (next) => { data = next; notify() },
      subscribeProjects: (listener) => { projectListeners.add(listener); return () => { projectListeners.delete(listener) } },
      statusOf: (tabId) => statuses.get(tabId) ?? null,
      activityOf: (tabId) => activities.get(tabId) ?? null,
      subscribe: (listener) => { tabListeners.add(listener); return () => { tabListeners.delete(listener) } },
      runner: new LocalGitRunner(),
      review: async () => ({ status: 'clean' }),
      sendToAgent: async (_project, task, _tab, text) => { sent.push({ taskId: task.id, text }) },
      landing: { landTask: async () => { landCalls++; return { status: 'landed' } }, fixWithAgent: async () => ({ status: 'fixing' }), isBusy: () => false },
      archiveTask: async () => {},
      log: () => {},
      settleMs: 5,
      loop: {
        ensureWorktree: async () => ({ ok: true }),
        startJudge: async ({ agent, round, prompt, worker: w }) => {
          const taskId = `judge-${judges.length + 1}`
          judges.push({ taskId, agent, round, prompt })
          const judge: Task = {
            ...fixtureTask({ id: taskId, name: `${agent} ${round}`, tabs: { left: [{ id: `jtab-${taskId}`, type: agent === 'codex' ? 'codex-chat' : 'claude-chat', title: agent }] } }),
            judgeOf: { taskId: w.id, round, agent },
            delegatedFrom: { taskId: w.id, name: w.name }
          }
          data = { ...data, projects: data.projects.map(p => ({ ...p, streams: p.streams.map(s => (s.id === 'stream-r' ? { ...s, tasks: [...s.tasks, judge] } : s)) })) }
          notify()
          return { ok: true, taskId }
        },
        closeJudge: async (_project, judge) => {
          closed.push(judge.id)
          data = { ...data, projects: data.projects.map(p => ({ ...p, streams: p.streams.map(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== judge.id) })) })) }
          notify()
        },
        sendFirstPrompt: async (_projectId, _taskId, _tabId, prompt, mode) => { firstPrompts.push({ prompt, mode }) },
        lastReply: async (_project, task) => replies.get(task.id) ?? null
      }
    }
    data = { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    runner = new AutopilotRunner(deps)
    runner.start()
    data = { projects: [fixtureProject({ id: 'p1', directory: repo, streams: [stream] })], tags: [], projectOrder: ['p1'], pinnedItems: [] }
    notify()
  }

  /** The judge's `submit_score`, then its turn ending. */
  async function score(judgeIndex: number, value: number, findings = `findings ${value}`, rubric?: string): Promise<void> {
    await waitFor(() => judges.length > judgeIndex && loopOf()?.judging?.taskId === judges[judgeIndex].taskId)
    const judgeId = judges[judgeIndex].taskId
    setStatus(`jtab-${judgeId}`, 'working')
    data = { ...data, projects: data.projects.map(p => mapTaskInProject(p, 't1', t => ({
      ...t,
      autopilot: { ...t.autopilot!, loop: { ...t.autopilot!.loop!, judging: { ...t.autopilot!.loop!.judging!, score: value, findings, ...(rubric ? { rubric } : {}) } } }
    }))) }
    notify()
    setStatus(`jtab-${judgeId}`, null)
    await waitFor(() => closed.includes(judgeId))
  }

  /** One worker turn that writes `file`. */
  async function round(file: string, content = 'x\n'): Promise<void> {
    fs.writeFileSync(path.join(own.worktreePath, file), content)
    const judgesBefore = judges.length
    setStatus('tab-1', 'working')
    setStatus('tab-1', null, `Wrote ${file}`)
    await waitFor(() => judges.length > judgesBefore || worker()?.autopilot?.phase === 'stopped')
  }

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-loop-')))
    execFileSync('git', ['init', '-q', '-b', 'master', repo])
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const worktree = path.join(repo, '.worktrees', 'task')
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'master--t1', 'master')
    own = { worktreePath: canonicalFilePath(worktree), branchName: 'master--t1', baseBranch: 'master', relativeProjectPath: '' }
    projectListeners = new Set()
    statuses = new Map()
    activities = new Map()
    tabListeners = new Set()
    judges = []
    closed = []
    firstPrompts = []
    sent = []
    landCalls = 0
    replies = new Map()
  })

  afterEach(() => {
    runner?.dispose()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('writes the rubric, improves round by round, resets a worse round and lands once every judge is happy', async () => {
    start({ target: 8, rounds: 3, judges: ['codex', 'claude'] })
    const base = git(own.worktreePath, 'rev-parse', 'HEAD').trim()

    // Round 0: Codex on the original state, in the worker's folder.
    await waitFor(() => judges.length === 1)
    expect(judges[0]).toMatchObject({ agent: 'codex', round: 0 })
    expect(judges[0].prompt).toContain('Write a rubric')
    expect(taskDirectory(data.projects[0], findTaskInProject(data.projects[0], 'judge-1')!)).toBe(own.worktreePath)
    await score(0, 4, 'Startup takes 3s', '- Startup under 1s')
    await waitFor(() => firstPrompts.length === 1)
    expect(firstPrompts[0].prompt).toContain('Make it faster')
    expect(firstPrompts[0].prompt).toContain('- Startup under 1s')
    expect(firstPrompts[0].mode).toBe('auto')
    expect(loopOf()).toMatchObject({ round: 1, rubric: '- Startup under 1s', best: { round: 0, score: 4, commit: base } })
    expect(worker()?.autopilot?.phase).toBe('working')

    // Round 1: a checkpoint, Codex 6 → back to the worker.
    await round('b.txt')
    expect(git(own.worktreePath, 'log', '-1', '--format=%s').trim()).toBe('loop: round 1')
    const round1 = git(own.worktreePath, 'rev-parse', 'HEAD').trim()
    expect(judges[1]).toMatchObject({ agent: 'codex', round: 1 })
    expect(judges[1].prompt).toContain(`git diff ${base}`)
    expect(judges[1].prompt).toContain('Wrote b.txt')
    await score(1, 6)
    await waitFor(() => sent.length === 1)
    expect(sent[0].text).toContain('Round 1 of 3: Codex scored it 6/10')
    expect(loopOf()).toMatchObject({ round: 2, best: { round: 1, score: 6, commit: round1 } })

    // Round 2 is worse: reset to round 1.
    await round('c.txt')
    await score(2, 5)
    await waitFor(() => sent.length === 2)
    expect(sent[1].text).toContain('reset the files to round 1\'s checkpoint')
    expect(git(own.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(round1)
    expect(fs.existsSync(path.join(own.worktreePath, 'c.txt'))).toBe(false)
    expect(loopOf()?.history.find(r => r.round === 2)?.reverted).toBe(true)

    // Round 3: Codex 9, then Claude 8 → lands.
    await round('d.txt')
    await score(3, 9)
    await waitFor(() => judges.length === 5)
    expect(judges[4]).toMatchObject({ agent: 'claude', round: 3 })
    await score(4, 8)
    await waitFor(() => landCalls === 1)
    expect(worker()?.autopilot?.phase).toBe('landing')
    expect(loopOf()?.history.find(r => r.round === 3)?.scores.map(s => s.score)).toEqual([9, 8])
  })

  it('puts back what a judge changed and says so', async () => {
    start({ target: 8, rounds: 2, judges: ['codex'] })
    await score(0, 4, 'slow', 'R')
    await round('b.txt')
    const head = git(own.worktreePath, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'judge was here\n')
    fs.writeFileSync(path.join(own.worktreePath, 'judge-notes.md'), 'notes\n')
    await score(1, 5)
    await waitFor(() => sent.length === 1)
    expect(fs.readFileSync(path.join(own.worktreePath, 'b.txt'), 'utf8')).toBe('x\n')
    expect(fs.existsSync(path.join(own.worktreePath, 'judge-notes.md'))).toBe(false)
    expect(git(own.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(sent[0].text).toContain('Codex changed files while judging')
    expect(loopOf()?.history.find(r => r.round === 1)?.scores[0].tampered).toBe(true)
  })

  it('goes back to the original state and hands back when no round beats it', async () => {
    start({ target: 8, rounds: 1, judges: ['codex'] })
    const base = git(own.worktreePath, 'rev-parse', 'HEAD').trim()
    await score(0, 5, 'ok', 'R')
    await round('b.txt')
    await score(1, 3)
    await waitFor(() => worker()?.autopilot?.phase === 'stopped')
    expect(worker()?.autopilot?.reason).toContain('No round beat the original state')
    expect(git(own.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(base)
    expect(landCalls).toBe(0)
  })

  it('reads a SCORE line when the judge couldn\'t call submit_score, and reminds it once before giving up', async () => {
    start({ target: 8, rounds: 2, judges: ['codex'] })
    await waitFor(() => judges.length === 1)
    replies.set('judge-1', 'Rubric:\n- Fast\n\nSCORE: 3/10')
    setStatus('jtab-judge-1', 'working')
    setStatus('jtab-judge-1', null)
    await waitFor(() => firstPrompts.length === 1)
    expect(loopOf()?.rubric).toContain('- Fast')

    await round('b.txt')
    replies.set('judge-2', 'Looks fine.')
    setStatus('jtab-judge-2', 'working')
    setStatus('jtab-judge-2', null)
    await waitFor(() => sent.some(s => s.taskId === 'judge-2'))
    expect(sent.find(s => s.taskId === 'judge-2')?.text).toContain('submit_score')
    setStatus('jtab-judge-2', 'working')
    setStatus('jtab-judge-2', null)
    await waitFor(() => worker()?.autopilot?.phase === 'stopped')
    expect(worker()?.autopilot?.reason).toBe('Codex ended its turn without a score')
    await waitFor(() => closed.includes('judge-2'))
  })

  it('stops a round that changed nothing', async () => {
    start({ target: 8, rounds: 2, judges: ['codex'] })
    await score(0, 4, 'slow', 'R')
    setStatus('tab-1', 'working')
    setStatus('tab-1', null, 'Nothing to do')
    await waitFor(() => worker()?.autopilot?.phase === 'stopped')
    expect(worker()?.autopilot?.reason).toBe('Round 1 changed no files')
  })
})
