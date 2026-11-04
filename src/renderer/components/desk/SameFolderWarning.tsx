import React from 'react'
import type { Project, Stream, Task } from '../../../shared/types'
import { streamWorktreeSupported } from '../../../shared/streams'
import { paletteEvents } from '../../palette/paletteEvents'
import { sameFolderWarning, type BusyChoice } from './deskStart'

const CHOICE_LABEL: Record<BusyChoice, string> = {
  queue: 'Queue',
  worktree: 'Own worktree',
  here: 'Start here'
}

function choiceTitle(choice: BusyChoice, busy: readonly Task[]): string {
  const them = busy.length === 1 ? `"${busy[0].name}" finishes` : 'they finish'
  switch (choice) {
    case 'queue': return `Start it once ${them}; it waits in Snoozed`
    case 'worktree': return 'Start now in a worktree of its own, off the project folder\'s last commit; Done lands it back into the folder'
    case 'here': return 'Start now in the same folder, alongside them'
  }
}

/**
 * Under a new task's prompt, once something is typed, when another agent is
 * already working in the folder it would start in (see `busyInSameFolder`). It
 * asks what the start does (`BusyChoice`): Queue (a chat start) files the task
 * snoozed until the other agents there finish, Own worktree (`main` with its
 * task worktrees off) gives this one task a worktree that lands back into the
 * project folder, Start here starts alongside them. Send follows the choice,
 * the first one by default. In the compose box, New stream… makes a worktree
 * stream, then aims the box at it; the full form has its own stream picker.
 */
export default function SameFolderWarning({ project, stream, busy, offerStream = true, choices, choice, onChoose }: {
  project: Project
  stream: Stream | undefined
  busy: readonly Task[]
  offerStream?: boolean
  /** What a start can do here (`busyChoices`). */
  choices: readonly BusyChoice[]
  /** The one a send follows (`effectiveBusyChoice`). */
  choice: BusyChoice | null
  onChoose: (choice: BusyChoice) => void
}): React.ReactElement | null {
  if (busy.length === 0) return null
  const canBranch = offerStream && streamWorktreeSupported(project)
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-sm text-text"
      title={busy.map(task => task.name).join(', ')}
      data-testid="same-folder-warning"
    >
      <div className="flex items-start gap-2">
        <span className="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 bg-warn" />
        <span className="flex-1 min-w-0">{sameFolderWarning(project, stream, busy)}</span>
        {canBranch && (
          <button
            type="button"
            className="shrink-0 bg-transparent border-0 p-0 text-sm text-accent cursor-pointer hover:underline"
            onClick={() => paletteEvents.emit('open-new-stream-for-task', project.id)}
            data-testid="same-folder-new-stream"
          >New stream…</button>
        )}
      </div>
      {choices.length > 1 && (
        <div role="radiogroup" aria-label="Start it" className="flex flex-wrap items-center gap-1 pl-3.5">
          {choices.map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === choice}
              title={choiceTitle(option, busy)}
              onClick={() => onChoose(option)}
              className={`rounded-full border px-2 py-[1px] text-xs cursor-pointer ${option === choice
                ? 'border-accent bg-accent/15 text-text'
                : 'border-line bg-transparent text-text-muted hover:text-text'}`}
              data-testid={`same-folder-${option}`}
            >{CHOICE_LABEL[option]}</button>
          ))}
        </div>
      )}
    </div>
  )
}
