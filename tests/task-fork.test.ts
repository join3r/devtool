import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { forkExcerpt, forkTaskName, moveForkedSession } from '../src/main/task-fork'
import { buildAgentContext } from '../src/main/agent-context'
import { WorkspaceManager, canonicalFilePath } from '../src/main/workspace-manager'
import { claudeProjectSlug } from '../src/main/ipc/agents'
import { emptyChatState, reduceChat, type ChatEvent } from '../src/shared/claude-chat'
import type { Project, Task, WorkspaceConfig } from '../src/shared/types'

function projectWith(...names: string[]): Pick<Project, 'streams'> {
  const tasks = names.map((name, i) => ({ id: `t${i}`, name, panes: [] }) as unknown as Task)
  return { streams: [{ id: 's', name: 'main', isMain: true, tasks }] } as unknown as Pick<Project, 'streams'>
}

describe('forkTaskName', () => {
  it('adds (fork), then numbers further forks', () => {
    expect(forkTaskName('Fix PIN', projectWith('Fix PIN'))).toBe('Fix PIN (fork)')
    expect(forkTaskName('Fix PIN', projectWith('Fix PIN', 'Fix PIN (fork)'))).toBe('Fix PIN (fork 2)')
    expect(forkTaskName('Fix PIN', projectWith('Fix PIN', 'Fix PIN (fork)', 'Fix PIN (fork 2)'))).toBe('Fix PIN (fork 3)')
  })

  it('forks a fork without nesting the suffix', () => {
    expect(forkTaskName('Fix PIN (fork)', projectWith('Fix PIN', 'Fix PIN (fork)'))).toBe('Fix PIN (fork 2)')
    expect(forkTaskName('Fix PIN (fork 2)', projectWith('Fix PIN (fork 2)'))).toBe('Fix PIN (fork)')
  })
})

describe('forkExcerpt', () => {
  it('takes the first line without Markdown marks', () => {
    expect(forkExcerpt('## **Plan**\n\nmore')).toBe('Plan')
    expect(forkExcerpt('- Use `sqlite` via [better-sqlite3](https://x)')).toBe('Use sqlite via better-sqlite3')
    expect(forkExcerpt('```ts\ncode\n```')).toBe('code')
  })

  it('shortens long lines', () => {
    const excerpt = forkExcerpt('word '.repeat(40))
    expect(excerpt.length).toBeLessThanOrEqual(80)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

describe('agent text uuids', () => {
  const sdk = (m: unknown): ChatEvent => ({ t: 'sdk', m, at: 1 })

  it('keeps the transcript uuid on a streamed reply once its message arrives', () => {
    const events: ChatEvent[] = [
      sdk({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null }),
      sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null }),
      sdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, parent_tool_use_id: null })
    ]
    const streaming = events.reduce(reduceChat, emptyChatState())
    expect(streaming.items[0]).toMatchObject({ kind: 'text', streaming: true })
    expect(streaming.items[0]).not.toHaveProperty('uuid')
    const done = reduceChat(streaming, sdk({ type: 'assistant', uuid: 'a-1', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] }, parent_tool_use_id: null }))
    expect(done.items[0]).toMatchObject({ kind: 'text', text: 'Hi', uuid: 'a-1', streaming: false })
  })

  it('keeps it on history read back from the transcript', () => {
    const state = reduceChat(emptyChatState(), {
      t: 'history',
      messages: [{ type: 'assistant', uuid: 'a-2', message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] }, parent_tool_use_id: null }]
    })
    expect(state.items[0]).toMatchObject({ kind: 'text', uuid: 'a-2' })
  })
})

describe('the fork note', () => {
  const ws: WorkspaceConfig = { worktreePath: '/repo/.worktrees/master--fix-fork', branchName: 'master--fix-fork', baseBranch: 'master', relativeProjectPath: '' }

  it('tells a fork its files may be ahead of the conversation', () => {
    const note = buildAgentContext({
      project: { name: 'App', directory: '/repo' },
      stream: { name: 'main', isMain: true },
      task: { name: 'Fix (fork)', workspace: ws, forkedFrom: { taskId: 't', name: 'Fix', excerpt: 'Plan' } },
      dir: ws.worktreePath
    })
    expect(note).toContain('fork of the task "Fix"')
    expect(note).toContain('uncommitted changes included')
  })

  it('warns a fork sharing the folder that the original may still edit it', () => {
    const note = buildAgentContext({
      project: { name: 'App', directory: '/repo' },
      stream: { name: 'main', isMain: true },
      task: { name: 'Fix (fork)', forkedFrom: { taskId: 't', name: 'Fix', excerpt: '' } },
      dir: '/repo'
    })
    expect(note).toContain('share the original task\'s folder')
  })
})

describe('moveForkedSession', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sessions-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('moves the fork into the new folder and leaves none behind', () => {
    const id = '0123abcd-0000-0000-0000-000000000001'
    const from = path.join(root, claudeProjectSlug('/repo'))
    fs.mkdirSync(from, { recursive: true })
    fs.writeFileSync(path.join(from, `${id}.jsonl`), '{}\n')
    moveForkedSession(id, '/repo', '/repo/.worktrees/x', root)
    expect(fs.existsSync(path.join(root, claudeProjectSlug('/repo/.worktrees/x'), `${id}.jsonl`))).toBe(true)
    expect(fs.existsSync(path.join(from, `${id}.jsonl`))).toBe(false)
  })
})

describe('WorkspaceManager fork helpers', () => {
  let repo: string
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args]).toString()

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-git-')))
    execFileSync('git', ['init', '-b', 'master', repo])
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
    git('add', '.')
    git('commit', '-m', 'init')
  })
  afterEach(() => {
    try { git('worktree', 'prune') } catch { /* gone */ }
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('starts a worktree on the source commit with its uncommitted changes', async () => {
    const manager = new WorkspaceManager()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    fs.mkdirSync(path.join(repo, 'new'))
    fs.writeFileSync(path.join(repo, 'new', 'b.txt'), 'untracked\n')
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret\n')
    const head = await manager.headCommit(repo)
    expect(head).toBe(git('rev-parse', 'HEAD').trim())
    const created = await manager.create(repo, 'master--fork', head)
    const missed = await manager.copyUncommitted(repo, created.worktreePath)
    expect(missed).toEqual([])
    expect(fs.readFileSync(path.join(created.worktreePath, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(fs.readFileSync(path.join(created.worktreePath, 'new', 'b.txt'), 'utf8')).toBe('untracked\n')
    expect(fs.existsSync(path.join(created.worktreePath, 'ignored.txt'))).toBe(false)
    // The source is left as it was.
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
  })
})
