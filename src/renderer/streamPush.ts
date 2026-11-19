import { useEffect, useState } from 'react'
import type { StreamPushStatus } from '../shared/types'
import { streamPushMessage } from '../shared/stream-push'
import { dismissToast, showToast } from './toasts'

/**
 * A stream's push (`src/main/stream-push.ts`) on the desktop: the stream
 * menu's Push and its unpushed count, and Done's Land and push. The count is
 * read when a menu opens and again after a push or a landing; nothing polls.
 */

const pushing = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Pushes the stream and says how it went in a toast. True when the remote has the branch now. */
export async function pushStreamWithToast(projectId: string, streamId: string): Promise<boolean> {
  if (pushing.has(streamId)) return false
  pushing.add(streamId)
  emit()
  const note = showToast('Pushing…')
  try {
    const result = await window.api.streamPush(projectId, streamId)
    showToast(streamPushMessage(result))
    return result.status === 'pushed' || result.status === 'nothing'
  } catch (err) {
    showToast(`Push failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    if (note !== null) dismissToast(note)
    pushing.delete(streamId)
    emit()
  }
}

/** The stream's unpushed commits; null while unknown or when git can't tell. `bump` re-reads it (after a landing). */
export function useStreamPushStatus(projectId: string, streamId: string, enabled = true, bump = 0): { status: StreamPushStatus | null; pushing: boolean } {
  const [status, setStatus] = useState<StreamPushStatus | null>(null)
  const [busy, setBusy] = useState(pushing.has(streamId))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const onChange = (): void => setBusy(pushing.has(streamId))
    listeners.add(onChange)
    const off = window.api.onStreamPushed((pid, sid) => {
      if (pid === projectId && sid === streamId) setTick(t => t + 1)
    })
    return () => {
      listeners.delete(onChange)
      off()
    }
  }, [projectId, streamId])

  useEffect(() => {
    if (!enabled) return
    let live = true
    window.api.streamPushStatus(projectId, streamId)
      .then(next => { if (live) setStatus(next) })
      .catch(() => { if (live) setStatus(null) })
    return () => { live = false }
  }, [projectId, streamId, enabled, bump, tick])

  return { status, pushing: busy }
}

/** "↑3", or "up to date". */
export function unpushedHint(status: StreamPushStatus): string {
  return status.ahead > 0 ? `↑${status.ahead}` : 'up to date'
}

/** The stream menu header's line: "3 commits not pushed to origin/master". */
export function unpushedLine(status: StreamPushStatus): string | null {
  if (!status.remote) return null
  const commits = status.ahead === 1 ? '1 commit' : `${status.ahead} commits`
  if (!status.upstream) return status.ahead > 0 ? `${commits} never pushed to ${status.remote}` : null
  if (status.ahead > 0) return `${commits} not pushed to ${status.upstream}`
  return null
}
