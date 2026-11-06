import type { AgentActivity } from '../shared/agent-activity'
import { autopilotActive, autopilotTab } from '../shared/autopilot'
import {
  betterBest,
  decide,
  JUDGE_LABEL,
  judgePrompt,
  judgeReminder,
  parseScoreLine,
  validScore,
  withScore,
  workerFeedbackPrompt,
  workerFirstPrompt
} from '../shared/loop'
import { findTaskInProject, taskDirectory } from '../shared/streams'
import type { LoopJudge, LoopJudging, LoopScore, Project, ProjectsData, Stream, Tab, TabStatusValue, Task, TaskAutopilot, TaskLoop } from '../shared/types'
import { gitOutput, type GitRunner } from './git-runner'
import { commitWorktreeChanges, worktreeChanges } from './task-landing'

/**
 * Moves an Autopilot loop on (`shared/loop.ts` holds its rules and words):
 * round 0 starts the first judge on the original state, and the worker gets
 * its first prompt (the user's brief plus the rubric) once that judge scored.
 * Every turn the worker ends (`AutopilotRunner` hands it over) becomes a
 * checkpoint commit and a judge task in the worker's folder; every judge that
 * scored is checked for files it changed (put back), closed, and its score
 * decides the next step: the next judge, the worker again (after a reset to
 * the best round when this one was worse), landing, or handing back.
 *
 * Judges score through MCP `submit_score` (`devtool-mcp.ts`), which only
 * records it on the loop; the step is taken once the judge's turn is over.
 * A judge whose turn ends without one is read for a `SCORE: n/10` line, then
 * reminded once, then the loop stops.
 */

const SETTLE_MS = 1500
const FINDINGS_MAX = 6000

/** What `AutopilotRunner` lends the loop: its view of runs and its ways of ending them. */
export interface LoopHost {
  find(taskId: string): LoopFound | null
  update(taskId: string, fn: (autopilot: TaskAutopilot) => TaskAutopilot): boolean
  stop(taskId: string, reason: string): void
  land(taskId: string, projectId: string, summary: string | undefined): Promise<void>
}

export interface LoopFound {
  project: Project
  stream: Stream
  task: Task
  autopilot: TaskAutopilot
  tab: Tab
}

export interface StartJudgeInput {
  project: Project
  worker: Task
  agent: LoopJudge
  round: number
  prompt: string
}

export interface LoopDeps {
  peek(): ProjectsData
  statusOf(tabId: string): TabStatusValue
  activityOf(tabId: string): AgentActivity | null
  subscribe(listener: (tabId: string) => void): () => void
  subscribeProjects(listener: () => void): () => void
  runner: GitRunner
  ensureWorktree(projectId: string, taskId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** A judge task (`Task.judgeOf`) in the worker's folder, its first prompt sent. */
  startJudge(input: StartJudgeInput): Promise<{ ok: true; taskId: string } | { ok: false; error: string }>
  /** Ends the judge's tabs (and what they started) and archives it. */
  closeJudge(project: Project, judge: Task): Promise<void>
  /** The worker's first prompt, into a chat that has none yet. */
  sendFirstPrompt(projectId: string, taskId: string, tabId: string, prompt: string, mode: string | undefined): Promise<void>
  sendToAgent(project: Project, task: Task, tab: Tab, text: string): Promise<void>
  /** The judge's last reply (its transcript, else its activity). */
  lastReply(project: Project, task: Task, tab: Tab): Promise<string | null>
  log(message: string): void
  now?(): number
  settleMs?: number
}

function clip(text: string, max = FINDINGS_MAX): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class LoopDriver {
  /** Workers the driver is acting on (a git step, a judge starting): one step at a time each. */
  private readonly acting = new Set<string>()
  /** Judges being closed. */
  private readonly closing = new Set<string>()
  private readonly lastStatus = new Map<string, TabStatusValue>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubscribe: (() => void)[] = []
  private scheduled = false

  constructor(private readonly deps: LoopDeps, private readonly host: LoopHost) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [
      this.deps.subscribe(tabId => this.tabChanged(tabId)),
      this.deps.subscribeProjects(() => this.schedule())
    ]
    this.schedule()
  }

  dispose(): void {
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.scan()
    })
  }

  // ---- watching -----------------------------------------------------------------------

  /** Loops to begin, judges whose score is in, judges gone, judges nobody waits for. */
  private scan(): void {
    for (const project of this.deps.peek().projects) {
      for (const stream of project.streams ?? []) {
        for (const task of stream.tasks) {
          if (task.judgeOf) {
            this.checkJudge(project, task)
            continue
          }
          const loop = task.autopilot?.loop
          if (!loop || !autopilotActive(task) || task.autopilot?.phase !== 'judging' || this.acting.has(task.id)) continue
          if (!loop.judging) {
            if (loop.round === 0) void this.act(task.id, found => this.beginRubric(found))
            continue
          }
          const judge = findTaskInProject(project, loop.judging.taskId)
          if (!judge) {
            this.host.stop(task.id, `The ${JUDGE_LABEL[loop.judging.agent]} judge was closed before it scored`)
            continue
          }
          const tab = autopilotTab(judge)
          if (loop.judging.score !== undefined && (!tab || this.deps.statusOf(tab.id) !== 'working')) {
            void this.act(task.id, found => this.judged(found))
          }
        }
      }
    }
  }

  /** A judge nobody waits for any more (its loop stopped, moved on or went): closed. */
  private checkJudge(project: Project, judge: Task): void {
    if (this.closing.has(judge.id)) return
    // Mid-step (a judge just started, its id not on the loop yet): look again after.
    if (this.acting.has(judge.judgeOf!.taskId)) return
    const worker = findTaskInProject(project, judge.judgeOf!.taskId)
    const waited = !!worker && autopilotActive(worker) && worker.autopilot?.loop?.judging?.taskId === judge.id
    if (waited) return
    this.closeJudge(project, judge)
  }

  private closeJudge(project: Project, judge: Task): void {
    if (this.closing.has(judge.id)) return
    this.closing.add(judge.id)
    this.deps.log(`loop judge=${judge.id} closing`)
    void this.deps.closeJudge(project, judge)
      .catch(err => this.deps.log(`loop judge=${judge.id} close error=${errorText(err)}`))
      .finally(() => this.closing.delete(judge.id))
  }

  private tabChanged(tabId: string): void {
    const previous = this.lastStatus.get(tabId) ?? null
    const status = this.deps.statusOf(tabId)
    this.lastStatus.set(tabId, status)
    if (previous === status) return
    const found = this.judgeByTab(tabId)
    if (!found) return
    const { worker, judge } = found
    if (status === 'exited') {
      this.host.stop(worker.id, `The ${JUDGE_LABEL[judge.judgeOf!.agent]} judge exited before it scored`)
      return
    }
    if (status === 'working') {
      this.clearTimer(judge.id)
      return
    }
    if (previous === 'working' && status === null) {
      this.clearTimer(judge.id)
      this.timers.set(judge.id, setTimeout(() => {
        this.timers.delete(judge.id)
        void this.act(worker.id, f => this.judgeTurnEnded(f, judge.id, tabId))
      }, this.deps.settleMs ?? SETTLE_MS))
    }
    // 'attention': the judge asks something; it waits in the Inbox under its loop, and the loop waits for it.
  }

  private judgeByTab(tabId: string): { worker: Task; judge: Task } | null {
    for (const project of this.deps.peek().projects) {
      for (const stream of project.streams ?? []) {
        for (const task of stream.tasks) {
          if (!task.judgeOf || autopilotTab(task)?.id !== tabId) continue
          const worker = findTaskInProject(project, task.judgeOf.taskId)
          if (worker?.autopilot?.loop?.judging?.taskId === task.id && autopilotActive(worker)) return { worker, judge: task }
          return null
        }
      }
    }
    return null
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  /** `fn` on the worker's run, one at a time per worker; a throw stops the run. */
  private async act(taskId: string, fn: (found: LoopFound & { loop: TaskLoop }) => Promise<void>): Promise<void> {
    if (this.acting.has(taskId)) return
    const found = this.host.find(taskId)
    const loop = found?.autopilot.loop
    if (!found || !loop) return
    this.acting.add(taskId)
    try {
      await fn({ ...found, loop })
    } catch (err) {
      this.host.stop(taskId, `The loop failed: ${errorText(err)}`)
    } finally {
      this.acting.delete(taskId)
      this.schedule()
    }
  }

  private setLoop(taskId: string, fn: (loop: TaskLoop, autopilot: TaskAutopilot) => Partial<TaskAutopilot> & { loop: TaskLoop }): void {
    this.host.update(taskId, autopilot => (autopilot.loop ? { ...autopilot, ...fn(autopilot.loop, autopilot) } : autopilot))
  }

  // ---- git ----------------------------------------------------------------------------

  private git(cwd: string, args: string[]): Promise<string> {
    return gitOutput(this.deps.runner, args, { cwd, timeoutMs: 60_000 })
  }

  private async rootOf(found: LoopFound): Promise<string> {
    return (await this.git(taskDirectory(found.project, found.task), ['rev-parse', '--show-toplevel'])).trim()
  }

  private async headOf(root: string): Promise<string> {
    return (await this.git(root, ['rev-parse', 'HEAD'])).trim()
  }

  /** The folder back at `commit`: tracked files reset, files that weren't there removed (DevTool's own left alone). */
  private async resetTo(root: string, commit: string): Promise<void> {
    await this.git(root, ['reset', '-q', '--hard', commit])
    const left = await worktreeChanges(this.deps.runner, root)
    if (left.length > 0) await this.git(root, ['clean', '-fdq', '--', ...left.map(file => `:(literal)${file}`)])
  }

  // ---- steps --------------------------------------------------------------------------

  /** Round 0: the worker's worktree made, the first judge started on the original state. */
  private async beginRubric(found: LoopFound & { loop: TaskLoop }): Promise<void> {
    const { project, task, loop } = found
    const worktree = await this.deps.ensureWorktree(project.id, task.id)
    if (!worktree.ok) {
      this.host.stop(task.id, `Couldn't create the task's worktree: ${worktree.error}`)
      return
    }
    const current = this.host.find(task.id)
    if (!current) return
    const root = await this.rootOf(current)
    const base = await this.headOf(root)
    this.setLoop(task.id, l => ({ loop: { ...l, base, head: base } }))
    await this.startJudging({ ...current, loop: { ...loop, base, head: base } }, loop.judges[0], 0, base)
  }

  /** The worker's turn ended (`AutopilotRunner`): its round becomes a checkpoint, and the first judge scores it. */
  async roundEnded(found: LoopFound, summary: string | undefined): Promise<void> {
    await this.act(found.task.id, async ({ project, task, loop, ...rest }) => {
      const root = await this.rootOf({ project, task, ...rest })
      const committed = await commitWorktreeChanges(this.deps.runner, root, `loop: round ${loop.round}`)
      const head = await this.headOf(root)
      if (!committed && head === loop.head) {
        this.host.stop(task.id, `Round ${loop.round} changed no files`)
        return
      }
      this.deps.log(`loop task=${task.id} round=${loop.round} checkpoint=${head}`)
      const next = { ...loop, head }
      this.setLoop(task.id, () => ({ phase: 'judging', loop: next }))
      await this.startJudging({ project, task, ...rest, loop: next }, loop.judges[0], loop.round, head, summary)
    })
  }

  private async startJudging(found: LoopFound & { loop: TaskLoop }, agent: LoopJudge, round: number, head: string, summary?: string): Promise<void> {
    const { project, task, loop } = found
    const root = await this.rootOf(found)
    const previous = round > 0
      ? (await this.deps.runner.run(['rev-parse', '--verify', '-q', `${head}~1`], { cwd: root })).stdout.trim() || undefined
      : undefined
    const prompt = judgePrompt(loop, { judge: agent, round, base: loop.base ?? head, previous, summary })
    this.deps.log(`loop task=${task.id} round=${round} judge=${agent} starting`)
    const started = await this.deps.startJudge({ project, worker: task, agent, round, prompt })
    if (!started.ok) {
      this.host.stop(task.id, `Couldn't start the ${JUDGE_LABEL[agent]} judge: ${started.error}`)
      return
    }
    const judging: LoopJudging = { agent, taskId: started.taskId, head, startedAt: this.now() }
    this.setLoop(task.id, l => ({ phase: 'judging', loop: { ...l, judging } }))
  }

  /** A judge's turn ended: its score is in, or is read from its reply, or it is asked once more. */
  private async judgeTurnEnded(found: LoopFound & { loop: TaskLoop }, judgeId: string, tabId: string): Promise<void> {
    const { project, task, loop } = found
    const judging = loop.judging
    if (!judging || judging.taskId !== judgeId) return
    if (this.deps.statusOf(tabId) !== null) return
    if (judging.score !== undefined) {
      await this.judged(found)
      return
    }
    const judge = findTaskInProject(project, judgeId)
    const tab = judge ? autopilotTab(judge) : undefined
    if (!judge || !tab) return
    const reply = await this.deps.lastReply(project, judge, tab).catch(() => null)
    const score = reply ? parseScoreLine(reply) : null
    if (score !== null && reply) {
      const recorded: LoopJudging = { ...judging, score, findings: clip(reply), ...(loop.round === 0 ? { rubric: clip(reply) } : {}) }
      this.setLoop(task.id, l => ({ loop: { ...l, judging: recorded } }))
      await this.judged({ ...found, loop: { ...loop, judging: recorded } })
      return
    }
    if (!judging.reminded) {
      this.setLoop(task.id, l => ({ loop: { ...l, judging: l.judging ? { ...l.judging, reminded: true } : l.judging } }))
      await this.deps.sendToAgent(project, judge, tab, judgeReminder(loop.round))
      return
    }
    this.host.stop(task.id, `${JUDGE_LABEL[judging.agent]} ended its turn without a score`)
  }

  /** The judge scored: check what it touched, close it, take the step its score decides. */
  private async judged(found: LoopFound & { loop: TaskLoop }): Promise<void> {
    const { project, task, tab, loop } = found
    const judging = loop.judging
    if (!judging || !validScore(judging.score)) return
    const score = judging.score
    const root = await this.rootOf(found)

    // The judge may build and run, but not change the work it judges.
    const changed = await worktreeChanges(this.deps.runner, root)
    const head = await this.headOf(root)
    const tampered = changed.length > 0 || head !== judging.head
    if (tampered) {
      this.deps.log(`loop task=${task.id} judge=${judging.agent} changed files (${changed.length}, head moved=${head !== judging.head}); putting them back`)
      await this.resetTo(root, judging.head)
    }
    const judgeTask = findTaskInProject(project, judging.taskId)
    if (judgeTask) this.closeJudge(project, judgeTask)

    const entry: LoopScore = { judge: judging.agent, score, findings: clip(judging.findings ?? ''), ...(tampered ? { tampered: true as const } : {}) }
    this.deps.log(`loop task=${task.id} round=${loop.round} judge=${judging.agent} score=${score}`)

    if (loop.round === 0) {
      const next: TaskLoop = {
        ...withScore({ ...loop, judging: undefined }, 0, entry, judging.head),
        rubric: clip(judging.rubric ?? judging.findings ?? '', 12_000),
        best: { round: 0, score, commit: judging.head },
        round: 1
      }
      this.setLoop(task.id, () => ({ phase: 'working', loop: next }))
      await this.deps.sendFirstPrompt(project.id, task.id, tab.id, workerFirstPrompt(next), loop.mode)
      return
    }

    const round = loop.round
    const decision = decide(loop, judging.agent, score)
    const first = judging.agent === loop.judges[0]
    let next: TaskLoop = withScore({ ...loop, judging: undefined }, round, entry, judging.head)
    if (first) next = { ...next, best: betterBest(loop, round, score, judging.head) }

    switch (decision.kind) {
      case 'next-judge':
        this.setLoop(task.id, () => ({ loop: next }))
        await this.startJudging({ ...found, loop: next }, decision.judge, round, judging.head)
        return
      case 'success':
        this.setLoop(task.id, () => ({ loop: next }))
        this.deps.log(`loop task=${task.id} reached ${loop.target} in round ${round}`)
        await this.host.land(task.id, project.id, this.deps.activityOf(tab.id)?.lastAnswer)
        return
      case 'feedback':
      case 'out-of-rounds': {
        const best = loop.best
        const revert = decision.revert && !!best
        if (revert) {
          await this.resetTo(root, best!.commit)
          next = {
            ...next,
            head: best!.commit,
            history: next.history.map(r => (r.round === round ? { ...r, reverted: true as const } : r))
          }
        }
        if (decision.kind === 'out-of-rounds') {
          const keep = next.best
          if (keep && !revert && keep.commit !== judging.head) await this.resetTo(root, keep.commit)
          if (keep) next = { ...next, head: keep.commit }
          this.setLoop(task.id, () => ({ loop: next }))
          const where = !keep || keep.round === 0
            ? 'No round beat the original state; the folder is back at it.'
            : `The folder is at the best round, ${keep.round} (${keep.score}/10).`
          this.host.stop(task.id, `${loop.rounds} rounds without ${loop.target}/10 from every judge. ${where}`)
          return
        }
        next = { ...next, round: round + 1 }
        this.setLoop(task.id, () => ({ phase: 'working', loop: next }))
        const prompt = workerFeedbackPrompt(next, {
          round,
          judge: judging.agent,
          score,
          findings: entry.findings,
          ...(revert ? { reverted: { toRound: best!.round, toScore: best!.score, droppedCommit: judging.head } } : {}),
          tampered
        })
        const latest = this.host.find(task.id)
        if (!latest) return
        await this.deps.sendToAgent(latest.project, latest.task, latest.tab, prompt)
      }
    }
  }
}
