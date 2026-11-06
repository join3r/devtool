import fs from 'fs'
import path from 'path'
import type { Project, Stream, Task } from '../shared/types'
import { taskDirectory, taskTabs } from '../shared/streams'
import { autopilotActive, autopilotSupported, autopilotTab } from '../shared/autopilot'
import { HOOK_PORT_ENV, HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER, TASK_TOKEN_ENV } from '../shared/hook-protocol'
import { readWorktreeConfig } from './worktree-setup'

/**
 * What an agent DevTool starts is told about where it runs: its task, stream and
 * branch, that DevTool (not the agent) lands the task and merges the stream, and
 * what it shares with the tasks running beside it. Without it agents merged and
 * cherry-picked task branches by hand, pulled `main` into streams, ran `npm
 * install` into another worktree's linked `node_modules` and killed each other's
 * dev servers.
 *
 * Claude gets it from its SessionStart hook (also after a resume or compaction),
 * a chat tab as an appended system prompt, Pi before every turn, Codex as
 * `developer_instructions`.
 */

/**
 * How the agent reaches DevTool's hook server to land or update its task. Port
 * and token come from the agent's env ({@link agentHookEnv}), not the note: the
 * note outlives a DevTool restart (a resumed Claude keeps its first system
 * prompt), the port and token don't.
 */
export interface AgentContextHook {
  tabId: string
}

/** The env an agent's land/update command reads: the hook server's port and the tab's own token. */
export function agentHookEnv(port: number, tabToken: string): Record<string, string> {
  return { [HOOK_PORT_ENV]: String(port), [TASK_TOKEN_ENV]: tabToken }
}

/** A `.devtool/worktree.json` symlink in the task's worktree and where it points. */
export interface SharedLink {
  entry: string
  target: string
}

export interface AgentContextInput {
  project: Pick<Project, 'name' | 'directory'>
  stream: Pick<Stream, 'name' | 'isMain' | 'workspace'>
  task: Pick<Task, 'name' | 'workspace' | 'scheduledFrom' | 'judgeOf'>
  /** The folder the agent runs in. */
  dir: string
  hook?: AgentContextHook
  links?: SharedLink[]
  /** The task runs on Autopilot and this is the chat it follows: what Autopilot does when the turn ends. */
  autopilot?: { review: boolean; loop?: boolean }
  /** The agent has DevTool's MCP tools (`devtool-mcp.ts`). */
  mcp?: boolean
}

function code(text: string): string {
  return `\`${text}\``
}

/** How the user may ask to merge into the stream's base branch. */
function mergeAsk(base: string): string {
  return base === 'main' || base === 'master' ? `"Merge to ${base}"` : `"Merge to ${base}" (or to main/master)`
}

function hookCommand(hook: AgentContextHook, endpoint: string, body: string): string {
  return `curl -s -X POST "http://127.0.0.1:$${HOOK_PORT_ENV}/hook/${endpoint}" -H '${HOOK_TAB_ID_HEADER}: ${hook.tabId}' -H "${HOOK_TOKEN_HEADER}: $${TASK_TOKEN_ENV}" -d '${body}'`
}

function sharedLines(links: SharedLink[]): string[] {
  const lines: string[] = []
  for (const link of links) {
    lines.push(
      `- ${code(link.entry)} here is a symlink to ${code(link.target)}, shared with other tasks. Never install, update or delete into it (no npm/pnpm/yarn install or ci through the link). ` +
      `To change dependencies, first replace the link with this worktree's own copy (${code(`rm ${link.entry}`)}, then install).`
    )
  }
  lines.push(
    '- Other tasks may be running their own dev servers, apps and builds at the same time. Use free ports rather than fixed ones, and stop only processes you started (by PID). ' +
    'Never use broad `pkill -f` / `killall` patterns that match other tasks\' processes.'
  )
  return lines
}

/** The note for one agent. Pure; {@link agentContextForTab} gathers its input. */
export function buildAgentContext(input: AgentContextInput): string {
  const { project, stream, task, dir, hook } = input
  const own = task.workspace
  const lines: string[] = [
    'DevTool context. DevTool is the app that started you; this describes where you run and holds for the whole session.',
    `- Project "${project.name}", stream "${stream.name}", task "${task.name}". Your folder: ${code(dir)}.`
  ]

  if (task.judgeOf) {
    lines.push(...judgeLines(!!input.mcp))
    lines.push(...sharedLines(input.links ?? []))
    return lines.join('\n')
  }

  if (own) {
    const target = own.baseBranch
    const where = stream.isMain ? `the project folder ${code(project.directory)}` : stream.workspace ? `the stream's worktree ${code(stream.workspace.worktreePath)}` : code(project.directory)
    lines.push(
      `- This is the task's own git worktree, on branch ${code(own.branchName)}, cut from ${code(target)} (checked out in ${where}). Other tasks work in parallel in worktrees of their own.`,
      `- DevTool does the merging. When the user closes this task, or picks "Land and keep working", DevTool commits anything uncommitted, squashes this branch into one commit (the task's name, with your commit subjects listed in it), rebases it onto ${code(target)} and fast-forwards ${code(target)}.` +
        (stream.isMain || !stream.workspace ? '' : ` Closing the stream "${stream.name}" in DevTool merges ${code(target)} into ${code(stream.workspace.baseBranch)}.`),
      `- So commit on ${code(own.branchName)} as you go, and leave moving work between branches to DevTool. Do not merge, rebase onto, cherry-pick, pull or switch branches yourself; do not commit in the main checkout, the stream's worktree or another task's worktree; do not make worktrees of your own to combine branches.`,
      '- Finished work on this branch is not "unmerged" or at risk: closing the task lands it. Do not ask whether to merge, and do not record it as unmerged in memory.'
    )
    if (hook) {
      lines.push(
        `- If the user asks you to merge or land this task into ${code(target)}, land it through DevTool (it keeps this task and worktree open, on the new tip):`,
        `  ${hookCommand(hook, 'land', '{"summary":"<what this task changed, one short paragraph, no single quotes>"}')}`,
        `  To take in what landed on ${code(target)} since this task started (instead of git pull or merge), the same call to ${code('/hook/update')} with ${code('-d \'{}\'')}.`,
        '  If either one reports a conflict, resolve it in this worktree (edit, `git add`, `GIT_EDITOR=true git rebase --continue`) and run it again. Never abort it.'
      )
    }
    if (!stream.isMain && stream.workspace) {
      lines.push(`- ${mergeAsk(stream.workspace.baseBranch)} means closing the stream "${stream.name}" in DevTool, which the user does. Tell them so rather than merging by hand.`)
    }
    lines.push(`- Pushing, deploying, releasing or uploading a build from this branch ships work that has not landed in ${code(target)} yet. Land first, or say so and ask.`)
  } else if (stream.workspace) {
    lines.push(
      `- This is the stream's git worktree, on branch ${code(stream.workspace.branchName)}, shared with the stream's other tasks: your commits go straight onto ${code(stream.workspace.branchName)}. Stay on it; do not switch branches or commit in other worktrees.`,
      `- Closing the stream "${stream.name}" in DevTool merges ${code(stream.workspace.branchName)} into ${code(stream.workspace.baseBranch)}. ${mergeAsk(stream.workspace.baseBranch)} means that, which the user does; do not merge by hand.`
    )
  } else {
    lines.push('- This is the project folder itself, on whatever branch it has checked out. Other tasks may be working in the same folder at the same time: do not switch branches, reset, stash or discard changes you did not make.')
  }

  lines.push(...sharedLines(input.links ?? []))
  if (input.mcp) lines.push(...mcpLines(!!own))
  if (input.autopilot) lines.push(...autopilotLines(input.autopilot.review, !!input.autopilot.loop))
  if (task.scheduledFrom) lines.push(...scheduledRunLines(task.scheduledFrom.name, !!input.mcp))
  return lines.join('\n')
}

/** What DevTool's MCP tools are for, and what a task they start does with its work. */
function mcpLines(ownWorktree: boolean): string[] {
  return [
    '- DevTool\'s MCP tools (server `devtool`: start_task, list_tasks, get_task, send_to_task, wait_for_tasks) start and follow other DevTool tasks in this project, each one its own agent that the user also sees in DevTool. ' +
      'Use them when the user asks you to hand work off or to work on several things in parallel; a new agent knows nothing of this conversation, so give it a complete brief.',
    '- schedule_task, list_schedules and cancel_schedule (same server) manage the project\'s schedules: a prompt DevTool runs again every hour/day/week as a new task. ' +
      'Use them when the user asks for something to be done or checked regularly ("check weekly whether X is fixed"); write the prompt as a complete brief that says what is worth reporting.',
    '- A task you start runs in your permission mode or a stricter one. In auto mode it works unattended (unless you pass `autopilot: false`): when it finishes DevTool lands its work into its stream as one commit and closes it. ' +
      (ownWorktree
        ? 'Its commits are not in your worktree until you update this task from its stream (the `/hook/update` call above).'
        : 'Its work lands on the stream\'s branch, not in this folder\'s uncommitted state.')
  ]
}

/**
 * Autopilot (src/main/autopilot.ts) hands the task back on anything that ends
 * the turn waiting on the user, a closing question included. The note is fixed
 * for the session, so it has to stay true after the user takes over.
 */
function autopilotLines(review: boolean, loop = false): string[] {
  const after = loop
    ? 'commits your changes as a checkpoint and has independent judges score the round; below the target their findings come back to you as the next round, and once every judge is satisfied DevTool lands the task'
    : review
    ? 'checks that files changed, has Codex review the diff (any findings come back to you once to fix), then lands the task'
    : 'checks that files changed, then lands the task'
  return [
    '- This task was started on Autopilot: until the user writes to you, nobody is watching. ' +
      `When your turn ends DevTool ${after}. Don't land it yourself.`,
    '- Anything that ends your turn waiting on the user stops Autopilot and hands the task back: a question, an offer such as "Want me to also…?", a permission request. ' +
      'So make reasonable calls yourself, finish the whole task in this turn, check it works, and end with a short summary of what you did and anything left open, not a question. ' +
      'If you really cannot go on without the user, say what you need and stop.',
    '- Once the user writes to you, they are back: the usual rules apply from then on.'
  ]
}

/** A judge of an Autopilot loop (`main/autopilot-loop.ts`): it works in another task's folder and only looks. */
function judgeLines(mcp: boolean): string[] {
  return [
    '- You are a judge in an Autopilot loop: this folder belongs to another task, whose agent waits while you judge its work. Nobody is watching; don\'t ask questions.',
    '- Build, run, test and measure as much as you need, but change, add, commit or delete no file here and touch no branch: DevTool checks afterwards and puts back anything you changed.',
    mcp
      ? '- When you are done, report your score with the `devtool` MCP tool `submit_score`, then end your turn. DevTool closes this task. Don\'t use the other DevTool tools.'
      : '- When you are done, end your reply with a line `SCORE: n/10`. DevTool closes this task.'
  ]
}

/**
 * A schedule's run (`main/schedule-runner.ts`): unattended, and most runs find
 * nothing new. The note is fixed for the session; once the user writes, they're back.
 */
function scheduledRunLines(name: string, mcp: boolean): string[] {
  return [
    `- This task is a scheduled run of "${name}": DevTool started it by itself and nobody is watching. Do the job in the prompt in this one turn, without asking questions.`,
    mcp
      ? '- If you find nothing new that the user needs to see, call the `devtool` MCP tool `nothing_new` with a one-line note of what you checked, then end your turn with that line: DevTool closes this task quietly. ' +
        'Otherwise end with a short report of what is new; the task stays in the user\'s Inbox.'
      : '- End with a short report; if nothing changed, say so in one line.',
    '- Once the user writes to you, they are back: the usual rules apply from then on.'
  ]
}

/** The `.devtool/worktree.json` symlinks that are links in `root`, and where they point. */
export function sharedLinksIn(root: string): SharedLink[] {
  const loaded = readWorktreeConfig(root)
  if (!loaded.ok) return []
  const links: SharedLink[] = []
  for (const entry of loaded.config.symlink) {
    const at = path.join(root, entry)
    try {
      if (!fs.lstatSync(at).isSymbolicLink()) continue
      links.push({ entry, target: fs.realpathSync(at) })
    } catch {
      // Missing or dangling: nothing shared to warn about.
    }
  }
  return links
}

/**
 * The note for the agent in `tabId`, or null when no project task owns the tab.
 * `hook` is false where the agent can't reach DevTool's hook server.
 */
export function agentContextForTab(
  projects: readonly Project[],
  tabId: string,
  hook = false
): string | null {
  for (const project of projects) {
    for (const stream of project.streams ?? []) {
      const task = stream.tasks.find(candidate => taskTabs(candidate).some(tab => tab.id === tabId))
      if (!task) continue
      // SSH projects: the agent runs on another machine, which these paths aren't on.
      if (project.ssh) return null
      const root = task.workspace?.worktreePath ?? stream.workspace?.worktreePath
      return buildAgentContext({
        project,
        stream,
        task,
        dir: taskDirectory(project, task),
        hook: task.workspace && hook ? { tabId } : undefined,
        links: root ? sharedLinksIn(root) : [],
        mcp: hasMcpTools(taskTabs(task).find(tab => tab.id === tabId)?.type),
        // Only the chat Autopilot follows (`autopilotTab`).
        ...(task.autopilot && autopilotActive(task) && autopilotSupported(project) && autopilotTab(task)?.id === tabId
          ? { autopilot: { review: !!task.autopilot.review, ...(task.autopilot.loop ? { loop: true } : {}) } }
          : {})
      })
    }
  }
  return null
}

/** Tab kinds DevTool hands its MCP server to (`claude` and `codex` terminals, Claude and Codex chats). */
export function hasMcpTools(type: string | undefined): boolean {
  if (type === 'claude' || type === 'claude-chat' || type === 'codex-chat') return true
  return type === 'codex' && process.platform !== 'win32'
}
