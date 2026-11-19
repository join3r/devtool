import type { Project, ProjectsData, Stream, StreamPushResult, StreamPushStatus } from '../shared/types'
import { gitErrorText, type GitRunner } from './git-runner'

/**
 * Pushing a stream's branch to its remote. A stream is a branch (`main` is
 * whatever the project folder has checked out), and tasks land into it, so the
 * stream is what gets pushed; a task's own branch never is.
 *
 * The push goes to the branch's upstream when it has one, else to the remote
 * (`remote.pushDefault`, `origin`, or the only one there is) under the
 * branch's own name, setting it as the upstream. It is never forced: a remote
 * that moved on answers `rejected`. git never prompts: with no stored
 * credentials, no key in the agent or an unknown host it fails at once
 * (`auth`) instead of waiting on a terminal nobody sees.
 *
 * The status counts compare with the remote-tracking refs as last fetched, so
 * they cost no network; only the push itself talks to the remote. One push per
 * stream at a time.
 */

export interface StreamPushDeps {
  projects: { peek(): ProjectsData }
  runner: GitRunner
  /** The environment git inherits, to tell whether the user picked their own SSH command. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
  log?(message: string): void
}

/** A push over a slow link, or one that runs a pre-push hook. */
const PUSH_TIMEOUT_MS = 120_000

const pushing = new Set<string>()

interface Located {
  project: Project
  stream: Stream
  cwd: string
  branch: string
}

interface Target {
  remote: string | null
  /** The branch name on the remote. */
  remoteBranch: string
  /** `branch.<b>.remote` names this remote and `branch.<b>.merge` is set. */
  tracked: boolean
}

async function config(runner: GitRunner, cwd: string, key: string): Promise<string | null> {
  const result = await runner.run(['config', '--get', key], { cwd })
  const value = result.stdout.trim()
  return result.code === 0 && value ? value : null
}

async function locate(deps: StreamPushDeps, projectId: string, streamId: string): Promise<Located | string> {
  const project = deps.projects.peek().projects.find(p => p.id === projectId)
  const stream = project?.streams.find(candidate => candidate.id === streamId)
  if (!project || !stream) return 'No such stream'
  if (project.ssh) return 'Pushing is not supported for SSH projects yet'
  const cwd = stream.workspace?.worktreePath ?? (stream.isMain ? project.directory : '')
  if (!cwd) return 'This stream has no folder'
  if (stream.workspace) return { project, stream, cwd, branch: stream.workspace.branchName }
  const head = await deps.runner.run(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd })
  if (head.failure) return gitErrorText(['symbolic-ref'], head)
  const branch = head.stdout.trim()
  if (head.code !== 0 || !branch) {
    const inRepo = await deps.runner.run(['rev-parse', '--git-dir'], { cwd })
    return inRepo.code === 0 ? 'The project folder is not on a branch (detached HEAD)' : 'The project folder is not a git repository'
  }
  return { project, stream, cwd, branch }
}

async function target(runner: GitRunner, cwd: string, branch: string): Promise<Target> {
  const branchRemote = await config(runner, cwd, `branch.${branch}.remote`)
  const merge = await config(runner, cwd, `branch.${branch}.merge`)
  if (branchRemote && branchRemote !== '.' && merge?.startsWith('refs/heads/')) {
    return { remote: branchRemote, remoteBranch: merge.slice('refs/heads/'.length), tracked: true }
  }
  const remotes = (await runner.run(['remote'], { cwd })).stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const pushDefault = await config(runner, cwd, 'remote.pushDefault')
  const remote = pushDefault && remotes.includes(pushDefault) ? pushDefault
    : remotes.includes('origin') ? 'origin'
      : remotes.length === 1 ? remotes[0]
        : null
  return { remote, remoteBranch: branch, tracked: false }
}

async function refExists(runner: GitRunner, cwd: string, ref: string): Promise<boolean> {
  return (await runner.run(['rev-parse', '--verify', '-q', ref], { cwd })).code === 0
}

async function counts(runner: GitRunner, cwd: string, branch: string, remote: string, remoteBranch: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const local = `refs/heads/${branch}`
  const tracking = `refs/remotes/${remote}/${remoteBranch}`
  if (await refExists(runner, cwd, tracking)) {
    const result = await runner.run(['rev-list', '--left-right', '--count', `${local}...${tracking}`], { cwd })
    const [ahead, behind] = result.stdout.trim().split(/\s+/).map(n => Number.parseInt(n, 10))
    return { upstream: `${remote}/${remoteBranch}`, ahead: ahead || 0, behind: behind || 0 }
  }
  // Never pushed: what no branch of that remote has yet.
  const result = await runner.run(['rev-list', '--count', local, '--not', `--remotes=${remote}`], { cwd })
  return { upstream: null, ahead: Number.parseInt(result.stdout.trim(), 10) || 0, behind: 0 }
}

/** Where the stream's branch stands against its remote; null when it can't tell (no such stream, not a repo, SSH). */
export async function streamPushStatus(deps: StreamPushDeps, projectId: string, streamId: string): Promise<StreamPushStatus | null> {
  const at = await locate(deps, projectId, streamId)
  if (typeof at === 'string') return null
  try {
    const to = await target(deps.runner, at.cwd, at.branch)
    if (!to.remote) return { branch: at.branch, remote: null, upstream: null, ahead: 0, behind: 0 }
    return { branch: at.branch, remote: to.remote, ...await counts(deps.runner, at.cwd, at.branch, to.remote, to.remoteBranch) }
  } catch {
    return null
  }
}

/**
 * git without prompts: no username/password question, no Git Credential
 * Manager window, and ssh in batch mode unless the user set their own SSH
 * command (theirs wins; a bad one fails the same way).
 */
async function quietEnv(deps: StreamPushDeps, cwd: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  const inherited = deps.env ?? process.env
  if (!inherited.GIT_SSH_COMMAND && !inherited.GIT_SSH && !await config(deps.runner, cwd, 'core.sshCommand')) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return env
}

const AUTH_FAILURE = /permission denied|authentication failed|could not read (username|password)|terminal prompts disabled|host key verification failed|invalid username or password|requested url returned error: 40[13]/i
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i

/** Pushes the stream's branch (see the file comment). */
export async function pushStream(deps: StreamPushDeps, projectId: string, streamId: string): Promise<StreamPushResult> {
  if (pushing.has(streamId)) return { status: 'failed', error: 'This stream is already being pushed' }
  pushing.add(streamId)
  try {
    const at = await locate(deps, projectId, streamId)
    if (typeof at === 'string') return { status: 'failed', error: at }
    const to = await target(deps.runner, at.cwd, at.branch)
    if (!to.remote) return { status: 'no-remote' }
    const before = await counts(deps.runner, at.cwd, at.branch, to.remote, to.remoteBranch)
    const args = [
      'push', '--porcelain',
      ...(to.tracked ? [] : ['--set-upstream']),
      to.remote,
      `refs/heads/${at.branch}:refs/heads/${to.remoteBranch}`
    ]
    const result = await deps.runner.run(args, { cwd: at.cwd, env: await quietEnv(deps, at.cwd), timeoutMs: PUSH_TIMEOUT_MS })
    const said = `${result.stdout}\n${result.stderr}`
    const upstream = `${to.remote}/${to.remoteBranch}`
    if (result.code === 0) {
      // --porcelain marks the ref `=` when the remote had it already.
      const upToDate = result.stdout.split('\n').some(line => line.startsWith('=\t'))
      deps.log?.(`stream push stream=${at.stream.id} ${at.branch} -> ${upstream} ${upToDate ? 'up to date' : `${before.ahead} commit(s)`}`)
      return upToDate
        ? { status: 'nothing', branch: at.branch, upstream }
        : { status: 'pushed', branch: at.branch, remote: to.remote, upstream, commits: before.ahead }
    }
    deps.log?.(`stream push stream=${at.stream.id} failed code=${result.code} ${result.stderr.trim().split('\n').pop() ?? ''}`)
    if (result.failure === 'timeout') return { status: 'failed', error: `The push to ${to.remote} timed out` }
    if (REJECTED.test(said) || result.stdout.split('\n').some(line => line.startsWith('!\t') && /fetch first|non-fast-forward/.test(line))) {
      return { status: 'rejected', message: `${upstream} has commits ${at.branch} doesn't. Take them in first (git pull), then push again.` }
    }
    if (AUTH_FAILURE.test(said)) {
      return { status: 'auth', message: `git couldn't log in to ${to.remote}: ${lastLine(result.stderr) || 'no credentials'}` }
    }
    return { status: 'failed', error: gitErrorText(['push'], { ...result, stdout: '' }) }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    pushing.delete(streamId)
  }
}

/** git's last meaningful line ("fatal: …"), without the generic "Could not read from remote repository" trailer. */
function lastLine(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean)
    .filter(line => !/^fatal: could not read from remote repository|^please make sure you have the correct access/i.test(line))
  return lines.length ? lines[lines.length - 1].replace(/^(fatal|error): /, '') : ''
}
