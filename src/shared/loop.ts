import type { LoopJudge, LoopRound, LoopScore, TaskAutopilot, TaskLoop } from './types'

/**
 * Autopilot loop: a scored improvement loop, the rules both processes read.
 *
 * Round 0 the first judge writes a rubric and scores the original state.
 * Every round after it the worker improves the task, DevTool commits a
 * checkpoint, and the judges score it in order: a judge is asked only once the
 * one before it gave the target. Every judge at the target lands the task. A
 * round whose first score falls below the best round's (and under the target)
 * is reset to the best round's checkpoint. When the rounds run out, the folder
 * goes back to the best round and the task is handed back.
 *
 * Judges are tasks of their own (`Task.judgeOf`) working in the worker's
 * folder while the worker waits, so they build and run what the worker built
 * and look for themselves. Main's `LoopDriver` (main/autopilot-loop.ts) moves
 * a loop on; this file holds what it decides and says.
 */

export const LOOP_JUDGES: readonly LoopJudge[] = ['codex', 'claude']
export const LOOP_DEFAULT_ROUNDS = 5
export const LOOP_MAX_ROUNDS = 20
export const LOOP_DEFAULT_TARGET = 8

export const JUDGE_LABEL: Record<LoopJudge, string> = { codex: 'Codex', claude: 'Claude' }

/** What the compose box asks for: the loop's settings. */
export interface LoopSettings {
  target: number
  rounds: number
  judges: LoopJudge[]
}

/** The settings made safe: a score 1-10, 1..LOOP_MAX_ROUNDS rounds, known judges once each in their order. */
export function normalizeLoopSettings(settings: Partial<LoopSettings>): LoopSettings | null {
  const target = Math.round(Number(settings.target))
  const rounds = Math.round(Number(settings.rounds ?? LOOP_DEFAULT_ROUNDS))
  const judges = LOOP_JUDGES.filter(judge => (settings.judges ?? LOOP_JUDGES).includes(judge))
  if (!Number.isFinite(target) || target < 1 || target > 10) return null
  if (!Number.isFinite(rounds) || rounds < 1 || rounds > LOOP_MAX_ROUNDS) return null
  if (judges.length === 0) return null
  return { target, rounds, judges }
}

export function newLoop(settings: LoopSettings, brief: string, mode?: string): TaskLoop {
  return { ...settings, brief, ...(mode ? { mode } : {}), round: 0, history: [] }
}

/** A score a judge may give. */
export function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10
}

/** The judge after `judge` in the loop's order, or null when it is the last. */
export function judgeAfter(loop: TaskLoop, judge: LoopJudge): LoopJudge | null {
  const index = loop.judges.indexOf(judge)
  return index >= 0 && index + 1 < loop.judges.length ? loop.judges[index + 1] : null
}

/** A round's first judge's score: what rounds are ranked by. */
export function roundScore(round: LoopRound | undefined): number | null {
  return round?.scores[0]?.score ?? null
}

/**
 * `SCORE: 7/10` as the last non-empty line of a judge's reply: the fallback for
 * a judge that couldn't call `submit_score`. Only that line counts, so a score
 * quoted from what the judge read (the worker's summary, a file) doesn't.
 */
export function parseScoreLine(text: string): number | null {
  const last = text.trim().split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? ''
  const match = /^[`*_]*SCORE\s*[:=]\s*(\d+(?:[.,]\d+)?)(?:\s*\/\s*10)?[`*_.]*$/i.exec(last)
  if (!match) return null
  const score = Number(match[1].replace(',', '.'))
  return validScore(score) ? score : null
}

/** What happens after a judge scored round `round` (> 0). */
export type LoopDecision =
  /** The judge after it scores the same round. */
  | { kind: 'next-judge'; judge: LoopJudge }
  /** Every judge gave the target: land. */
  | { kind: 'success' }
  /** Back to the worker with the findings (after a reset to the best round when `revert`). */
  | { kind: 'feedback'; revert: boolean }
  /** The last round fell short: back to the best round, handed to the user. */
  | { kind: 'out-of-rounds'; revert: boolean }

/**
 * The step after `judge` gave `score` for the loop's current round, with the
 * round's earlier scores already in `loop.history`. `revert` asks for the
 * folder to go back to the best round: only a first score below the best
 * round's and under the target does (a round that clears the target goes on to
 * the next judge whatever it ranks).
 */
export function decide(loop: TaskLoop, judge: LoopJudge, score: number): LoopDecision {
  if (score >= loop.target) {
    const next = judgeAfter(loop, judge)
    if (next) return { kind: 'next-judge', judge: next }
    return { kind: 'success' }
  }
  const first = judge === loop.judges[0]
  const revert = first && !!loop.best && score < loop.best.score
  return loop.round >= loop.rounds ? { kind: 'out-of-rounds', revert } : { kind: 'feedback', revert }
}

/**
 * The loop's best round after the first judge gave `score` for round `round`
 * at `commit`: a tie goes to the newer round (it has the later fixes).
 */
export function betterBest(loop: TaskLoop, round: number, score: number, commit: string): TaskLoop['best'] {
  if (loop.best && score < loop.best.score) return loop.best
  return { round, score, commit }
}

/** The loop with `score` added to round `round`'s scores (the round made when missing). */
export function withScore(loop: TaskLoop, round: number, entry: LoopScore, commit?: string): TaskLoop {
  const existing = loop.history.find(r => r.round === round)
  const updated: LoopRound = existing
    ? { ...existing, scores: [...existing.scores.filter(s => s.judge !== entry.judge), entry] }
    : { round, ...(commit ? { commit } : {}), scores: [entry] }
  const history = existing
    ? loop.history.map(r => (r.round === round ? updated : r))
    : [...loop.history, updated].sort((a, b) => a.round - b.round)
  return { ...loop, history }
}

// ---- what people read ---------------------------------------------------------------

/** "Loop · round 2/5 · best 7 · Codex judging": an Inbox row's line, or null when there's nothing to add. */
export function loopLine(autopilot: TaskAutopilot | undefined): string | null {
  const loop = autopilot?.loop
  if (!loop || !autopilot) return null
  const parts = ['Loop']
  parts.push(loop.round === 0 ? 'rubric' : `round ${loop.round}/${loop.rounds}`)
  if (loop.best) parts.push(`best ${formatScore(loop.best.score)}`)
  parts.push(`target ${loop.target}`)
  if (autopilot.phase === 'judging' && loop.judging) parts.push(`${JUDGE_LABEL[loop.judging.agent]} ${loop.round === 0 ? 'writing the rubric' : 'judging'}`)
  else if (autopilot.phase === 'landing') parts.push('landing')
  else if (autopilot.phase === 'working' || autopilot.phase === 'fixing') parts.push('working')
  return parts.join(' · ')
}

export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

/** The scores so far as a Markdown table, one row per round. */
export function historyTable(loop: TaskLoop): string {
  if (loop.history.length === 0) return '(no rounds scored yet)'
  const head = `| Round | ${loop.judges.map(j => JUDGE_LABEL[j]).join(' | ')} | |`
  const rule = `|---|${loop.judges.map(() => '---').join('|')}|---|`
  const rows = loop.history.map(round => {
    const cells = loop.judges.map(judge => {
      const score = round.scores.find(s => s.judge === judge)
      return score ? `${formatScore(score.score)}${score.tampered ? ' (changed files)' : ''}` : '–'
    })
    const note = round.round === 0 ? 'original state' : round.reverted ? 'reverted' : loop.best?.round === round.round ? 'best' : ''
    return `| ${round.round} | ${cells.join(' | ')} | ${note} |`
  })
  return [head, rule, ...rows].join('\n')
}

// ---- prompts ------------------------------------------------------------------------

const quote = (text: string): string => text.split('\n').map(line => `> ${line}`).join('\n')

function judgesInWords(loop: TaskLoop): string {
  const names = loop.judges.map(j => JUDGE_LABEL[j])
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')}, then ${names.at(-1)}`
}

/** The worker's first prompt: the user's brief, then how the loop runs and the rubric. */
export function workerFirstPrompt(loop: TaskLoop): string {
  const baseline = roundScore(loop.history.find(r => r.round === 0))
  return [
    loop.brief,
    '',
    '---',
    `DevTool runs this task as an Autopilot loop. Each time your turn ends, DevTool commits your changes as a checkpoint and independent judges (${judgesInWords(loop)}) score the result from 1 to 10 against the rubric below.`,
    'The judges gather their own evidence: they build and run the app, test and measure it themselves, and look beyond what you point them at. Your summary is only a hint to them.',
    `The loop ends when every judge gives at least ${loop.target}/10, or after ${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}. A round that scores worse than the best one so far is reset to that round's checkpoint.`,
    '',
    `Rubric (written by ${JUDGE_LABEL[loop.judges[0]]} from the original state${baseline !== null ? `, which it scored ${formatScore(baseline)}/10` : ''}):`,
    '',
    loop.rubric ?? '(none)',
    '',
    ...roundRules(1, loop)
  ].join('\n')
}

function roundRules(round: number, loop: TaskLoop): string[] {
  return [
    `Now do round ${round} of ${loop.rounds}. Work through the whole round in this one turn without asking questions, and check that your changes work.`,
    'End with a short summary: what you changed and how you checked it. Don\'t commit, reset or land: DevTool does that.'
  ]
}

/** What the worker is told after a round fell short. */
export function workerFeedbackPrompt(loop: TaskLoop, args: {
  round: number
  judge: LoopJudge
  score: number
  findings: string
  /** Reset to the best round: its number, score and the dropped round's commit. */
  reverted?: { toRound: number; toScore: number; droppedCommit?: string }
  tampered?: boolean
}): string {
  const { round, judge, score, findings, reverted } = args
  const lines = [
    `Round ${round} of ${loop.rounds}: ${JUDGE_LABEL[judge]} scored it ${formatScore(score)}/10 (target ${loop.target}).`,
    '',
    findings.trim() || '(no findings given)',
    ''
  ]
  if (reverted) {
    lines.push(
      `That is below the best round so far (round ${reverted.toRound}, ${formatScore(reverted.toScore)}/10), so DevTool reset the files to ${reverted.toRound === 0 ? 'the original state' : `round ${reverted.toRound}'s checkpoint`}.` +
        ` Your round ${round} changes are gone from the folder${reverted.droppedCommit ? ` (commit ${reverted.droppedCommit.slice(0, 12)} still has them)` : ''}. That direction didn't work: try a different approach.`,
      ''
    )
  }
  if (args.tampered) lines.push(`(${JUDGE_LABEL[judge]} changed files while judging; DevTool put them back. Nothing of yours was lost.)`, '')
  lines.push(
    'Scores so far:',
    '',
    historyTable(loop),
    '',
    'Rubric:',
    '',
    loop.rubric ?? '(none)',
    '',
    ...roundRules(round + 1, loop)
  )
  return lines.join('\n')
}

/** Everything a judge is told. `base`: the original state's commit; `previous`: the last round's checkpoint. */
export function judgePrompt(loop: TaskLoop, args: {
  judge: LoopJudge
  round: number
  base: string
  previous?: string
  summary?: string
}): string {
  const { round, base, previous, summary } = args
  const lines = [
    `You are a judge in a DevTool Autopilot loop. Another agent works on this task in this folder:`,
    '',
    quote(loop.brief),
    ''
  ]
  if (round === 0) {
    lines.push(
      'Nothing has been changed yet: you see the original state.',
      '1. Write a rubric for this task: 3 to 5 criteria that together make a 10/10 result, and for each one what you will check and how (which screens and flows, which benchmark or measurement, which commands).',
      '   Cover everything the task touches, not only the main screen or the obvious path. The rubric is fixed for the whole loop and every judge uses it.',
      '2. Check the current state yourself against it and score it from 1 to 10. That is the baseline later rounds are compared with; note the measurements you took.'
    )
  } else {
    lines.push(
      `This is round ${round} of ${loop.rounds}. The agent's changes since the original state: \`git diff ${base}\`` +
        (previous && previous !== base ? `; this round alone: \`git diff ${previous} HEAD\`.` : '.'),
      ...(summary ? ['', 'The agent says:', '', quote(summary.trim()), '', 'Treat that as a hint only. Check for yourself, and look beyond what it points at.'] : []),
      '',
      'Rubric:',
      '',
      loop.rubric ?? '(none)',
      '',
      'Scores so far:',
      '',
      historyTable(loop),
      '',
      `Score the current state from 1 to 10 against the rubric. ${loop.target}/10 is the bar the user set for good enough: give it only when it is met.`
    )
  }
  lines.push(
    '',
    'How to judge:',
    '- Gather your own evidence: build and run the app, open every screen and flow the rubric names (and others the changes touch), take screenshots, run the benchmarks or tests. Read the code too.',
    '- Don\'t change, add, commit or delete any file in this folder: DevTool checks, puts back anything you change and tells the agent. Build output and caches are fine. Keep screenshots and notes in a scratch folder outside it (for example under $TMPDIR).',
    '- Use free ports and a scratch config dir rather than the defaults, and stop every process you started before you finish.',
    '',
    `When you are done, call the \`devtool\` MCP tool \`submit_score\` with \`score\` (1-10) and \`findings\`: what keeps it from 10, most important first, each one concrete (where, what is wrong, what to do)` +
      (round === 0 ? ', and `rubric`: the rubric as Markdown.' : '.'),
    'If you can\'t call it, end your reply with the findings' + (round === 0 ? ' and the rubric' : '') + ' and a last line `SCORE: n/10`. Then end your turn; DevTool closes this task.'
  )
  return lines.join('\n')
}

/** What a judge is told when its turn ended without a score. */
export function judgeReminder(round: number): string {
  return `You ended your turn without a score. Call the \`devtool\` MCP tool \`submit_score\` now (\`score\`, \`findings\`${round === 0 ? ', `rubric`' : ''}), or end your reply with a line \`SCORE: n/10\`.`
}
