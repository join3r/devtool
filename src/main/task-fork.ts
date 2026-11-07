/**
 * Fork a task's Claude chat at one of its agent's messages: a sibling task in
 * the same stream whose conversation is the original's up to that message and
 * whose worktree starts from the original's files as they are now (commit and
 * uncommitted changes, `TaskWorktreeManager.forkFrom`). `HostServices.forkTask`
 * puts it together; this file holds the parts that need no app state.
 */
import fs from 'fs'
import path from 'path'
import type { Project } from '../shared/types'
import { copyLocalSession, localSessionRoots } from './agent-session-move'
import { claudeProjectSlug, isClaudeSessionId } from './ipc/agents'
import { loadClaudeSdk } from './claude-chat/sdk'

/** Where Claude keeps sessions here: the SDK's fork writes under `CLAUDE_CONFIG_DIR` when it is set. */
function claudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  return configDir ? path.join(configDir, 'projects') : localSessionRoots().claudeProjects
}

const FORK_SUFFIX = /\s+\(fork(?:\s+\d+)?\)$/

/** "Fix PIN" → "Fix PIN (fork)", then "(fork 2)", …; forking a fork numbers on rather than nesting. */
export function forkTaskName(name: string, project: Pick<Project, 'streams'>): string {
  const base = name.replace(FORK_SUFFIX, '').trim() || name.trim() || 'Task'
  const taken = new Set(project.streams.flatMap(stream => stream.tasks.map(task => task.name)))
  if (!taken.has(`${base} (fork)`)) return `${base} (fork)`
  for (let n = 2; ; n++) {
    const candidate = `${base} (fork ${n})`
    if (!taken.has(candidate)) return candidate
  }
}

const EXCERPT_CHARS = 80

/** The first line of a message with its Markdown marks stripped, shortened: what "Forked from … at" quotes. */
export function forkExcerpt(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l && !/^(```|---|\*\*\*)/.test(l)) ?? ''
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+\.)\s+/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
  return plain.length > EXCERPT_CHARS ? `${plain.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : plain
}

/**
 * A new Claude session holding `sessionId`'s conversation up to `upToMessageId`
 * (that message included), the SDK's own fork: fresh ids, the chain kept. It is
 * written next to the source, in `sourceCwd`'s session folder.
 */
export async function forkClaudeSession(sessionId: string, sourceCwd: string, upToMessageId: string, title: string): Promise<string> {
  if (!isClaudeSessionId(sessionId)) throw new Error('This chat has no saved conversation yet')
  const sdk = await loadClaudeSdk()
  try {
    return (await sdk.forkSession(sessionId, { dir: sourceCwd, upToMessageId, title })).sessionId
  } catch {
    // The folder Claude filed it under can differ (symlinks, a moved worktree): search everywhere.
    return (await sdk.forkSession(sessionId, { upToMessageId, title })).sessionId
  }
}

/**
 * The forked session into `targetCwd`'s session folder, where `--resume` in the
 * fork's worktree finds it, and gone from wherever the fork wrote it.
 */
export function moveForkedSession(sessionId: string, sourceCwd: string, targetCwd: string, root: string = claudeProjectsRoot()): void {
  if (claudeProjectSlug(sourceCwd) === claudeProjectSlug(targetCwd)) return
  const outcome = copyLocalSession({ kind: 'claude', sessionId }, sourceCwd, targetCwd, { claudeProjects: root, piSessions: '' })
  if (outcome === 'missing') throw new Error('The forked conversation was not saved')
  const keep = claudeProjectSlug(targetCwd)
  for (const folder of safeList(root)) {
    if (folder === keep) continue
    const file = path.join(root, folder, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }
}

/** Removes a forked session that never became a task. */
export function deleteForkedSession(sessionId: string, root: string = claudeProjectsRoot()): void {
  if (!isClaudeSessionId(sessionId)) return
  for (const folder of safeList(root)) fs.rmSync(path.join(root, folder, `${sessionId}.jsonl`), { force: true })
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
