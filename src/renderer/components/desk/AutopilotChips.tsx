import React from 'react'
import { readLoopSettings, writeLoopSettings, type DeskAutopilot } from './deskStart'
import { JUDGE_LABEL, LOOP_JUDGES, LOOP_MAX_ROUNDS } from '../../../shared/loop'
import type { LoopJudge } from '../../../shared/types'

const baseCls = 'flex items-center gap-1.5 border rounded-full px-2.5 py-[3px] text-sm cursor-pointer whitespace-nowrap'
const offCls = `${baseCls} bg-surface-3 border-border text-text-muted hover:border-border-strong hover:text-body`
const onCls = `${baseCls} bg-surface-3 border-text-muted text-text`
const numCls = 'w-[3.2em] bg-transparent border-0 border-b border-border text-text text-sm text-center outline-none focus:border-text-muted [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'

/**
 * The Autopilot chip of the compose box and the ⌘K bar (decision 7 of the
 * redesign), and beside it once it is on "+ Codex review" or "Loop" (a scored
 * improvement loop, `shared/loop.ts`) with the loop's target, rounds and
 * judges. Off by default every time: the caller resets it after each fire.
 * `loop`: whether the target can run a loop (it needs a worktree of its own);
 * `codex`: whether Codex is turned on, to judge and to review.
 */
export default function AutopilotChips({ value, onChange, loop: loopOk = false, codex = true }: {
  value: DeskAutopilot
  onChange: (next: DeskAutopilot) => void
  loop?: boolean
  codex?: boolean
}): React.ReactElement {
  const loop = loopOk && value.loop ? value.loop : null
  const judges: readonly LoopJudge[] = codex ? LOOP_JUDGES : ['claude']
  const setLoop = (next: NonNullable<DeskAutopilot['loop']>): void => {
    writeLoopSettings(next)
    onChange({ ...value, review: false, loop: next })
  }
  const keep = (e: React.MouseEvent): void => e.preventDefault()
  return (
    <>
      <button
        type="button"
        className={value.on ? onCls : offCls}
        aria-pressed={value.on}
        title="Autopilot: Claude works in auto mode, then the task lands and goes to Done by itself. Anything that needs you stops it into Needs you."
        onMouseDown={keep}
        onClick={() => onChange(value.on ? { on: false, review: false } : { on: true, review: value.review, loop: value.loop ?? null })}
        data-testid="desk-autopilot-chip"
      >
        {value.on && <span className="w-[6px] h-[6px] rounded-full bg-text" aria-hidden />}
        Autopilot
      </button>
      {value.on && !loop && codex && (
        <button
          type="button"
          className={value.review ? onCls : offCls}
          aria-pressed={value.review}
          title="Codex reviews the task's changes before it lands; its findings go back to Claude once"
          onMouseDown={keep}
          onClick={() => onChange({ ...value, review: !value.review })}
          data-testid="desk-autopilot-review"
        >
          + Codex review
        </button>
      )}
      {value.on && loopOk && (
        <button
          type="button"
          className={loop ? onCls : offCls}
          aria-pressed={!!loop}
          title="Loop: a judge writes a rubric and scores the original state; then the agent improves the task round after round while independent judges (Codex, then Claude) run and score each round, until every judge gives the target or the rounds run out"
          onMouseDown={keep}
          onClick={() => onChange(loop ? { ...value, loop: null } : { ...value, review: false, loop: { ...readLoopSettings(), judges: readLoopSettings().judges.filter(j => judges.includes(j)) } })}
          data-testid="desk-autopilot-loop"
        >
          Loop
        </button>
      )}
      {loop && (
        <span className="flex items-center gap-1.5 text-sm text-text-muted whitespace-nowrap" data-testid="desk-autopilot-loop-settings">
          <label className="flex items-center gap-0.5" title="The score every judge must give (1-10)">
            to
            <input
              type="number"
              min={1}
              max={10}
              className={numCls}
              value={loop.target}
              onChange={(e) => setLoop({ ...loop, target: Math.max(1, Math.min(10, Math.round(Number(e.target.value)) || 1)) })}
              aria-label="Target score"
              data-testid="desk-autopilot-loop-target"
            />/10
          </label>
          <label className="flex items-center gap-0.5" title="The most rounds the agent gets">
            ·
            <input
              type="number"
              min={1}
              max={LOOP_MAX_ROUNDS}
              className={numCls}
              value={loop.rounds}
              onChange={(e) => setLoop({ ...loop, rounds: Math.max(1, Math.min(LOOP_MAX_ROUNDS, Math.round(Number(e.target.value)) || 1)) })}
              aria-label="Rounds"
              data-testid="desk-autopilot-loop-rounds"
            />
            rounds ·
          </label>
          {judges.map(judge => {
            const on = loop.judges.includes(judge)
            return (
              <button
                key={judge}
                type="button"
                className={on ? onCls : offCls}
                aria-pressed={on}
                title={judge === loop.judges[0] || !on ? `${JUDGE_LABEL[judge]} writes the rubric and judges every round` : `${JUDGE_LABEL[judge]} judges a round once the judge before it gives the target`}
                onMouseDown={keep}
                onClick={() => {
                  const next = on ? loop.judges.filter(j => j !== judge) : LOOP_JUDGES.filter(j => j === judge || loop.judges.includes(j))
                  if (next.length > 0) setLoop({ ...loop, judges: next })
                }}
                data-testid={`desk-autopilot-loop-judge-${judge}`}
              >
                {JUDGE_LABEL[judge]}
              </button>
            )
          })}
        </span>
      )}
    </>
  )
}
