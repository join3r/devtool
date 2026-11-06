import React, { useEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/types'
import { formatScore, historyTable, JUDGE_LABEL } from '../../../shared/loop'
import MarkdownPreview from '../MarkdownPreview'
import { useApp } from '../../context/AppContext'

/** The loop as one Markdown page: settings, scores, rubric, and each round's findings, newest first. */
export function loopReport(task: Task): string {
  const loop = task.autopilot?.loop
  if (!loop) return ''
  const parts = [
    `**Target ${loop.target}/10** from ${loop.judges.map(j => JUDGE_LABEL[j]).join(', then ')} · ${loop.rounds} rounds` +
      (loop.best ? ` · best so far: ${loop.best.round === 0 ? 'the original state' : `round ${loop.best.round}`} (${formatScore(loop.best.score)})` : ''),
    '',
    historyTable(loop)
  ]
  if (task.autopilot?.phase === 'stopped' && task.autopilot.reason) parts.push('', `_Stopped: ${task.autopilot.reason}_`)
  parts.push('', '### Rubric', '', loop.rubric ?? '_Not written yet._')
  for (const round of [...loop.history].reverse()) {
    for (const score of [...round.scores].reverse()) {
      if (!score.findings) continue
      parts.push('', `### Round ${round.round} · ${JUDGE_LABEL[score.judge]} ${formatScore(score.score)}/10${round.reverted ? ' (reverted)' : ''}`, '', score.findings)
    }
  }
  return parts.join('\n')
}

/** The task header's Loop pill: opens the loop's scores, rubric and findings. Shown for a running or stopped loop. */
export default function DeskLoopPanel({ task }: { task: Task }): React.ReactElement | null {
  const { effectiveTheme } = useApp()
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const loop = task.autopilot?.loop
  if (!loop) return null
  const best = loop.best ? ` · best ${formatScore(loop.best.score)}` : ''
  return (
    <>
      <button
        type="button"
        className="shrink-0 mr-1.5 flex items-center h-[22px] px-2 rounded-full border border-border bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-sel [-webkit-app-region:no-drag]"
        title="The loop's scores, rubric and findings"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (open) { setOpen(null); return }
          const rect = e.currentTarget.getBoundingClientRect()
          setOpen({ x: Math.max(8, Math.min(rect.left, window.innerWidth - 568)), y: rect.bottom + 6 })
        }}
        data-testid="desk-task-loop"
      >Loop {loop.round === 0 ? 'rubric' : `${loop.round}/${loop.rounds}`}{best}</button>
      {open && (
        <div
          ref={panelRef}
          className="fixed z-50 w-[560px] max-h-[70vh] overflow-y-auto rounded-[10px] border border-border-strong bg-surface-2 shadow-lg px-4 py-3 [-webkit-app-region:no-drag]"
          style={{ left: open.x, top: open.y }}
          data-testid="desk-task-loop-panel"
        >
          <MarkdownPreview content={loopReport(task)} effectiveTheme={effectiveTheme} variant="flow" fontSize={13} />
        </div>
      )}
    </>
  )
}
