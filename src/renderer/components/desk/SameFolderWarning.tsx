import React from 'react'
import type { Project, Stream, Task } from '../../../shared/types'
import { streamWorktreeSupported } from '../../../shared/streams'
import { paletteEvents } from '../../palette/paletteEvents'
import { sameFolderWarning } from './deskStart'

/**
 * Under a new task's prompt, once something is typed, when another agent is
 * already working in the folder it would start in (see `busyInSameFolder`). In the compose box,
 * New stream… makes a worktree, then aims the box at it; the full form has
 * its own stream picker instead. Queue (a chat start) files the task snoozed:
 * it starts by itself once the other agents there finish.
 */
export default function SameFolderWarning({ project, stream, busy, offerStream = true, onQueue }: {
  project: Project
  stream: Stream | undefined
  busy: readonly Task[]
  offerStream?: boolean
  /** Queue the task instead of starting it; absent when it can't wait (not a chat). */
  onQueue?: () => void
}): React.ReactElement | null {
  if (busy.length === 0) return null
  const canBranch = offerStream && streamWorktreeSupported(project)
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-sm text-text"
      title={busy.map(task => task.name).join(', ')}
      data-testid="same-folder-warning"
    >
      <span className="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 bg-warn" />
      <span className="flex-1 min-w-0">{sameFolderWarning(project, stream, busy)}</span>
      {onQueue && (
        <button
          type="button"
          className="shrink-0 bg-transparent border-0 p-0 text-sm text-accent cursor-pointer hover:underline"
          title={`Start it once ${busy.length === 1 ? `"${busy[0].name}" finishes` : 'they finish'}; it waits in Snoozed`}
          onClick={onQueue}
          data-testid="same-folder-queue"
        >Queue</button>
      )}
      {canBranch && (
        <button
          type="button"
          className="shrink-0 bg-transparent border-0 p-0 text-sm text-accent cursor-pointer hover:underline"
          onClick={() => paletteEvents.emit('open-new-stream-for-task', project.id)}
          data-testid="same-folder-new-stream"
        >New stream…</button>
      )}
    </div>
  )
}
