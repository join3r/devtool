import { useCallback, useEffect, useRef, useState } from 'react'
import { findMainStream } from '../../shared/streams'
import type { GitBranchGraph, Project } from '../../shared/types'

const POLL_MS = 15_000

/** What DevTool knows a branch as: a stream's, a task's, or the base a stream was cut from. */
export interface BranchLabel {
  branch: string
  kind: 'stream' | 'task' | 'base'
  /** The stream's or task's name; the branch itself for a base. */
  name: string
  /** Checked out in a worktree of its own (not the project folder). */
  worktree: boolean
  taskId?: string
}

/**
 * The project's branches, labelled. A branch that is more than one thing keeps
 * the first: a stream's own branch, then a task's, then the project folder's
 * (the default stream), then the bases streams were cut from.
 */
export function projectBranchLabels(project: Project, head: string | null): Map<string, BranchLabel> {
  const labels = new Map<string, BranchLabel>()
  const add = (label: BranchLabel) => { if (!labels.has(label.branch)) labels.set(label.branch, label) }
  for (const stream of project.streams) {
    if (stream.workspace) add({ branch: stream.workspace.branchName, kind: 'stream', name: stream.name, worktree: true })
  }
  for (const stream of project.streams) {
    for (const task of stream.tasks) {
      if (task.workspace) add({ branch: task.workspace.branchName, kind: 'task', name: task.name, worktree: true, taskId: task.id })
    }
  }
  const main = findMainStream(project)
  if (head) add({ branch: head, kind: 'stream', name: main?.name ?? head, worktree: false })
  for (const stream of project.streams) {
    if (stream.workspace) add({ branch: stream.workspace.baseBranch, kind: 'base', name: stream.workspace.baseBranch, worktree: false })
  }
  return labels
}

/** `projectId` routes the call to a DevTool server's project. */
export function useBranchGraph(projectDir: string, branches: string[], limit: number, enabled: boolean, projectId?: string): GitBranchGraph | null {
  const [graph, setGraph] = useState<GitBranchGraph | null>(null)
  const requestIdRef = useRef(0)
  const branchKey = branches.join('\n')

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current
    if (!enabled || !projectDir) {
      setGraph(null)
      return
    }
    window.api.gitBranchGraph(projectDir, branchKey ? branchKey.split('\n') : [], limit, projectId)
      .then(result => { if (requestId === requestIdRef.current) setGraph(result) })
      .catch(() => { /* keep what's shown */ })
  }, [enabled, projectDir, branchKey, limit, projectId])

  useEffect(() => {
    fetch()
    const id = window.setInterval(fetch, POLL_MS)
    window.addEventListener('focus', fetch)
    return () => {
      requestIdRef.current += 1
      window.clearInterval(id)
      window.removeEventListener('focus', fetch)
    }
  }, [fetch])

  return graph
}
