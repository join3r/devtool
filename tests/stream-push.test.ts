import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pushStream, streamPushStatus } from '../src/main/stream-push'
import { LocalGitRunner } from '../src/main/git-runner'
import { canonicalFilePath } from '../src/main/workspace-manager'
import type { ProjectsData, Stream } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function commit(dir: string, file: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), `${message}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

function identity(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

describe('stream push', () => {
  let root: string
  let repo: string
  let remote: string
  let streamPath: string
  let data: ProjectsData

  beforeEach(() => {
    root = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-push-')))
    remote = path.join(root, 'remote.git')
    repo = path.join(root, 'repo')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote])
    execFileSync('git', ['init', '-q', '-b', 'master', repo])
    identity(repo)
    fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n')
    commit(repo, 'a.txt', 'init')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'master')
    streamPath = path.join(repo, '.worktrees', 'release')
    git(repo, 'worktree', 'add', '-q', streamPath, '-b', 'release', 'master')
    const main: Stream = { id: 's-main', name: 'main', isMain: true, tasks: [] }
    const release: Stream = {
      id: 's-release',
      name: 'Release',
      workspace: { worktreePath: streamPath, branchName: 'release', baseBranch: 'master', relativeProjectPath: '' },
      tasks: []
    }
    data = { projects: [fixtureProject({ id: 'p1', directory: repo, streams: [main, release] })] } as ProjectsData
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const deps = () => ({ projects: { peek: () => data }, runner: new LocalGitRunner(), env: {} })

  it('counts unpushed commits on main and pushes them to the upstream', async () => {
    commit(repo, 'b.txt', 'two')
    commit(repo, 'c.txt', 'three')
    expect(await streamPushStatus(deps(), 'p1', 's-main')).toEqual({ branch: 'master', remote: 'origin', upstream: 'origin/master', ahead: 2, behind: 0 })
    expect(await pushStream(deps(), 'p1', 's-main')).toEqual({ status: 'pushed', branch: 'master', remote: 'origin', upstream: 'origin/master', commits: 2 })
    expect(git(remote, 'rev-parse', 'master')).toBe(git(repo, 'rev-parse', 'master'))
    expect((await streamPushStatus(deps(), 'p1', 's-main'))?.ahead).toBe(0)
    expect(await pushStream(deps(), 'p1', 's-main')).toEqual({ status: 'nothing', branch: 'master', upstream: 'origin/master' })
  })

  it('pushes a stream branch that was never pushed and sets its upstream', async () => {
    commit(streamPath, 'r.txt', 'release work')
    expect(await streamPushStatus(deps(), 'p1', 's-release')).toEqual({ branch: 'release', remote: 'origin', upstream: null, ahead: 1, behind: 0 })
    expect(await pushStream(deps(), 'p1', 's-release')).toMatchObject({ status: 'pushed', upstream: 'origin/release', commits: 1 })
    expect(git(repo, 'config', '--get', 'branch.release.merge').trim()).toBe('refs/heads/release')
    expect(git(remote, 'rev-parse', 'release')).toBe(git(repo, 'rev-parse', 'release'))
  })

  it('refuses to overwrite commits the remote has and the branch lacks', async () => {
    const other = path.join(root, 'other')
    execFileSync('git', ['clone', '-q', remote, other])
    identity(other)
    commit(other, 'x.txt', 'from elsewhere')
    git(other, 'push', '-q', 'origin', 'master')
    commit(repo, 'y.txt', 'local')
    const result = await pushStream(deps(), 'p1', 's-main')
    expect(result.status).toBe('rejected')
    expect(git(remote, 'rev-parse', 'master')).toBe(git(other, 'rev-parse', 'master'))
  })

  it('answers no-remote for a repo without one', async () => {
    git(repo, 'remote', 'remove', 'origin')
    expect(await pushStream(deps(), 'p1', 's-main')).toEqual({ status: 'no-remote' })
    expect(await streamPushStatus(deps(), 'p1', 's-main')).toEqual({ branch: 'master', remote: null, upstream: null, ahead: 0, behind: 0 })
  })

  it('fails without prompting when the remote is unreachable', async () => {
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'))
    commit(repo, 'b.txt', 'two')
    const result = await pushStream(deps(), 'p1', 's-main')
    expect(result.status).toBe('failed')
  })

  it('reports a detached project folder', async () => {
    git(repo, 'checkout', '-q', '--detach')
    expect(await pushStream(deps(), 'p1', 's-main')).toEqual({ status: 'failed', error: 'The project folder is not on a branch (detached HEAD)' })
    expect(await streamPushStatus(deps(), 'p1', 's-main')).toBeNull()
  })
})
