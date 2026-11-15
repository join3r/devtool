import { describe, expect, it } from 'vitest'
import {
  barSections,
  completeToken,
  parseBar,
  prefersJump,
  resolveBar,
  targetLabel,
  tokenKey,
  type BarHere,
  type BarSources
} from '../src/renderer/components/desk/commandBar'
import { createMainStream } from '../src/shared/types'
import type { Project, Stream, Task } from '../src/shared/types'
import { singlePane } from '../src/shared/streams'
import { AUTOPILOT_OFF, autopilotAvailable, deskSubmission, mentionAt, whereOptions, whereScope, whereStream } from '../src/renderer/components/desk/deskStart'

const NOW = new Date('2026-10-30T12:00:00').getTime()

function task(id: string, name = id): Task {
  return { id, name, panes: singlePane([{ id: `${id}-tab`, type: 'claude-chat' as const, title: 'Claude' }]) }
}

function stream(id: string, name: string, tasks: Task[] = []): Stream {
  return { id, name, tasks }
}

function project(id: string, name: string, tasks: Task[], streams: Stream[] = []): Project {
  return { id, name, directory: `/tmp/${id}`, streams: [createMainStream(id, tasks), ...streams] }
}

const beta = stream('beta', '0.7.0', [task('t-beta', 'Run logs in the Bench')])
const devtool = project('dt', 'devtool', [task('t-main', 'Fix the login bug')], [beta])
const stem = project('st', 'Stem App', [task('t-stem', 'Ship the relay')], [stream('st-next', 'next')])
const projects = [devtool, stem]

const nowhere: BarHere = { projectId: null, taskId: null, scope: null, last: null }

function sources(extra: Partial<BarSources> = {}): BarSources {
  return { projects, composeProjects: projects, apps: [], commands: [], notes: {}, files: null, ...extra }
}

describe('parseBar', () => {
  it('reads the mode sigil and the all-projects star', () => {
    expect(parseBar('> theme').mode).toBe('command')
    expect(parseBar('/readme').mode).toBe('files')
    expect(parseBar('fix it').mode).toBe('plain')
    expect(parseBar('* login').allProjects).toBe(true)
    expect(parseBar('>*theme')).toMatchObject({ mode: 'command', allProjects: true })
    expect(parseBar('>*theme').pieces.map(p => p.text)).toEqual(['theme'])
  })

  it('marks an @/# token being typed at the end', () => {
    expect(parseBar('fix @dev').completing?.text).toBe('@dev')
    expect(parseBar('fix @dev ').completing).toBeNull()
    expect(parseBar('fix #').completing?.text).toBe('#')
  })
})

describe('resolveBar', () => {
  it('aims at the named project and stream and keeps the rest as the prompt', () => {
    const bar = resolveBar('Make logs a Bench tab @devtool #0.7.0', projects, nowhere)
    expect(bar.query).toBe('Make logs a Bench tab')
    expect(bar.target?.project.id).toBe('dt')
    expect(bar.target?.stream?.id).toBe('beta')
    expect(bar.tokens.map(t => t.kind)).toEqual(['project', 'stream'])
  })

  it('matches tokens by dashed name and by prefix', () => {
    expect(tokenKey('Stem App')).toBe('stem-app')
    expect(resolveBar('x @stem-app', projects, nowhere).project?.id).toBe('st')
    expect(resolveBar('x @ste', projects, nowhere).project?.id).toBe('st')
  })

  it('leaves a token that names nothing in the prompt', () => {
    const bar = resolveBar('fix #123 crash', projects, nowhere)
    expect(bar.stream).toBeNull()
    expect(bar.query).toBe('fix #123 crash')
  })

  it('finds a #stream in another project when there is no @', () => {
    const bar = resolveBar('do it #next', projects, { ...nowhere, last: { projectId: 'dt' } })
    expect(bar.target?.project.id).toBe('st')
    expect(bar.target?.stream?.id).toBe('st-next')
  })

  it('defaults to the open task, then the scope, then the last project', () => {
    expect(resolveBar('x', projects, { ...nowhere, projectId: 'dt', taskId: 't-beta' }).target)
      .toMatchObject({ project: { id: 'dt' }, stream: { id: 'beta' } })
    expect(resolveBar('x', projects, { ...nowhere, scope: { projectId: 'st', streamId: 'st-next' } }).target)
      .toMatchObject({ project: { id: 'st' }, stream: { id: 'st-next' } })
    expect(resolveBar('x', projects, { ...nowhere, last: { projectId: 'st' } }).target?.project.id).toBe('st')
    expect(resolveBar('x', projects, { ...nowhere, last: { projectId: 'st', streamId: 'st-next' } }).target)
      .toMatchObject({ project: { id: 'st' }, stream: { id: 'st-next' } })
    expect(resolveBar('x', projects, nowhere).target?.project.id).toBe('dt')
    // @ to another project drops the open task's stream: its main.
    expect(resolveBar('x @stem', projects, { ...nowhere, projectId: 'dt', taskId: 't-beta' }).target?.stream).toBeUndefined()
  })

  it('aims an @project at the stream it was last left in', () => {
    const left = [devtool, { ...stem, lastStreamId: 'st-next' }]
    expect(resolveBar('x @stem', left, nowhere).target).toMatchObject({ project: { id: 'st' }, stream: { id: 'st-next' } })
    // Fired into its main last: that wins.
    expect(resolveBar('x @stem', left, { ...nowhere, last: { projectId: 'st' } }).target?.stream).toBeUndefined()
  })

  it('drops a bare sigil from the prompt', () => {
    expect(resolveBar('fix it @', projects, nowhere).query).toBe('fix it')
  })
})

describe('barSections', () => {
  const sections = (input: string, here = nowhere, extra: Partial<BarSources> = {}) =>
    barSections(resolveBar(input, projects, here), sources(extra), here, {}, NOW)

  it('offers Start task first for a prompt, and the busy folder\'s choices (default first) only when it is busy', () => {
    const result = sections('refactor the whole settings page please')
    expect(result[0].key).toBe('start')
    expect(result[0].items.map(i => i.kind)).toEqual(['start'])
    const busy = sections('refactor the whole settings page please', nowhere, { busyChoices: ['queue', 'worktree', 'here'] })
    expect(busy[0].items.map(i => i.kind)).toEqual(['queue', 'worktree', 'start'])
  })

  it('puts a match first when the words name it', () => {
    const result = sections('login bug')
    expect(result[0].key).toBe('matches')
    expect(result[0].items[0]).toMatchObject({ kind: 'task', id: 'task:dt:t-main' })
    expect(result[1].key).toBe('start')
  })

  it('narrows matches to the #stream', () => {
    const result = sections('#0.7.0 run')
    const matches = result.find(s => s.key === 'matches')
    expect(matches?.items.map(i => i.id)).toEqual(['task:dt:t-beta'])
  })

  it('completes @ with projects and # with streams of the target first', () => {
    const at = sections('fix @')
    expect(at[0].key).toBe('complete')
    expect(at[0].items.map(i => (i.kind === 'complete' ? i.value : ''))).toEqual(['devtool', 'stem-app'])
    const hash = sections('fix #', { ...nowhere, last: { projectId: 'st' } })
    expect(hash[0].items.map(i => (i.kind === 'complete' ? i.value : ''))).toEqual(['main', 'next', '0.7.0'])
  })

  it('lists commands only after >', () => {
    const commands = [{ id: 'command:cmd.theme', title: 'Switch Theme', searchable: 'Switch Theme theme' }]
    const result = sections('>theme', nowhere, { commands })
    expect(result).toHaveLength(1)
    expect(result[0].items.map(i => i.id)).toEqual(['command:cmd.theme'])
  })

  it('lists the target project notes and files after /', () => {
    const notes = { dt: [{ id: 'n1', name: 'Release notes', content: 'x' }], st: [{ id: 'n2', name: 'Relay notes', content: '' }] }
    const result = sections('/notes', nowhere, { notes, files: ['docs/notes.md', 'src/app.ts'] })
    expect(result.map(s => s.key)).toEqual(['notes', 'files'])
    expect(result[0].items.map(i => i.id)).toEqual(['note:dt:n1'])
    expect(result[1].items.map(i => i.id)).toEqual(['file:dt:docs/notes.md'])
  })

  it('shows recent places when empty, and nothing when nothing was used', () => {
    expect(sections('')).toEqual([])
    const frecent = barSections(resolveBar('', projects, nowhere), sources(), nowhere, { 'task:st:t-stem': { lastUsedAt: NOW - 1000, useCount: 3 } }, NOW)
    expect(frecent[0]).toMatchObject({ key: 'recent' })
    expect(frecent[0].items.map(i => i.id)).toEqual(['task:st:t-stem'])
  })

  it('lists what is in a project named alone', () => {
    const result = sections('@stem ')
    expect(result[0].key).toBe('recent')
    expect(result[0].items.map(i => i.id)).toEqual(['task:st:t-stem', 'stream:st:st-next'])
  })
})

describe('helpers', () => {
  it('labels targets project-first, main omitted', () => {
    expect(targetLabel({ project: devtool, stream: beta })).toBe('devtool › 0.7.0')
    expect(targetLabel({ project: devtool, stream: devtool.streams[0] })).toBe('devtool')
  })

  it('jumps only for a few words a title contains', () => {
    const item = { kind: 'project' as const, id: 'project:dt', title: 'devtool', project: devtool }
    expect(prefersJump('devt', item)).toBe(true)
    expect(prefersJump('make devtool faster', item)).toBe(false)
    expect(prefersJump('x', undefined)).toBe(false)
  })

  it('completes the token being typed', () => {
    const piece = parseBar('fix @de').completing!
    expect(completeToken('fix @de', piece, '@', 'devtool')).toBe('fix @devtool ')
  })
})

describe('Images on a start', () => {
  it('go with a Claude chat prompt only', () => {
    const images = [{ mediaType: 'image/png', data: 'aGk=' }]
    expect(deskSubmission(devtool, beta, 'claude-chat', 'look', null, images).start?.prompt?.images).toEqual(images)
    expect(deskSubmission(devtool, beta, 'claude-chat', 'look', null, []).start?.prompt?.images).toBeUndefined()
    expect(deskSubmission(devtool, beta, 'codex', 'look', null, images).start?.prompt?.images).toBeUndefined()
  })
})

describe('Autopilot on a start', () => {
  it('goes with a chat (Claude, Codex or Pi) in a project on this Mac only', () => {
    const on = { on: true, review: true }
    expect(deskSubmission(devtool, beta, 'claude-chat', 'fix it', on).autopilot).toEqual({ review: true })
    expect(deskSubmission(devtool, beta, 'claude-chat', 'fix it', AUTOPILOT_OFF).autopilot).toBeUndefined()
    expect(deskSubmission(devtool, beta, 'codex', 'fix it', on).autopilot).toBeUndefined()
    const server = { ...devtool, host: 'server-1' }
    expect(deskSubmission(server, beta, 'claude-chat', 'fix it', on).autopilot).toBeUndefined()
    expect(autopilotAvailable(devtool, 'claude-chat')).toBe(true)
    expect(autopilotAvailable(server, 'claude-chat')).toBe(false)
    expect(deskSubmission(devtool, beta, 'codex-chat', 'fix it', on)).toMatchObject({ autopilot: { review: true }, start: { prompt: { mode: 'auto' } } })
    expect(deskSubmission(devtool, beta, 'codex-chat', 'fix it', AUTOPILOT_OFF).start?.prompt.mode).toBeUndefined()
    expect(autopilotAvailable(devtool, 'codex-chat')).toBe(true)
    expect(autopilotAvailable(devtool, 'pi-chat')).toBe(true)
    expect(autopilotAvailable(devtool, 'pi')).toBe(false)
  })
})

describe('whereOptions (the compose box where picker)', () => {
  it('lists each project followed by its non-main streams', () => {
    expect(whereOptions(projects, '').map(option => option.key)).toEqual(['dt', 'dt:beta', 'st', 'st:st-next'])
  })

  it('narrows on project names, and on "project stream" for streams', () => {
    expect(whereOptions(projects, 'stem').map(option => option.key)).toContain('st')
    expect(whereOptions(projects, 'stem').map(option => option.key)).not.toContain('dt')
    expect(whereOptions(projects, 'dev 0.7').map(option => option.key)).toEqual(['dt:beta'])
  })
})

describe('whereScope (what a picked where row aims at)', () => {
  const recent = project('st', 'Stem App', [task('t-stem', 'Ship the relay')], [
    stream('st-new', '0.8.0', [{ ...task('t-new', 'New'), lastInteractedAt: 20 }])
  ])
  const main = recent.streams.find(s => s.isMain)!

  it('aims a project row at the stream the project was last left in', () => {
    const left = { ...recent, lastStreamId: 'st-new' }
    const [row] = whereOptions([left], 'stem')
    expect(row.stream).toBeUndefined()
    expect(whereStream(row, null)?.id).toBe('st-new')
    expect(whereScope(row, null)).toEqual({ projectId: 'st', streamId: 'st-new' })
  })

  it('aims a project row at the stream last fired into there', () => {
    const [row] = whereOptions([recent], 'stem')
    expect(whereScope(row, { projectId: 'st', streamId: 'st-new' })).toEqual({ projectId: 'st', streamId: 'st-new' })
    // Last fired into its main: main, even when the project was left elsewhere.
    const [leftRow] = whereOptions([{ ...recent, lastStreamId: 'st-new' }], 'stem')
    expect(whereScope(leftRow, { projectId: 'st' })).toEqual({ projectId: 'st', streamId: main.id })
  })

  it('aims a project row with no last stream at its main stream', () => {
    const [row] = whereOptions([recent], 'stem')
    expect(whereScope(row, { projectId: 'dt', streamId: 'beta' })).toEqual({ projectId: 'st', streamId: main.id })
  })

  it('aims a stream row at that stream', () => {
    const option = whereOptions(projects, 'dev 0.7')[0]
    expect(whereScope(option, { projectId: 'dt' })).toEqual({ projectId: 'dt', streamId: 'beta' })
  })
})

describe('whereOptions recency', () => {
  it('puts the project (and stream) worked in last first', () => {
    const recent = project('st', 'Stem App', [task('t-stem', 'Ship the relay')], [
      stream('st-old', 'old', [{ ...task('t-old', 'Old'), lastInteractedAt: 10 }]),
      stream('st-new', 'new', [{ ...task('t-new', 'New'), lastInteractedAt: 20 }])
    ])
    expect(whereOptions([devtool, recent], '').map(option => option.key)).toEqual(['st', 'st:st-new', 'st:st-old', 'dt', 'dt:beta'])
  })
})

describe('mentionAt', () => {
  it('finds the @word at the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('fix it @dev', 11)).toEqual({ start: 7, query: 'dev' })
    expect(mentionAt('fix @dev it', 8)).toEqual({ start: 4, query: 'dev' })
  })

  it('ignores an @ inside a word or one already finished', () => {
    expect(mentionAt('mail me@x.com', 13)).toBeNull()
    expect(mentionAt('@dev fix', 8)).toBeNull()
    expect(mentionAt('no at here', 10)).toBeNull()
  })
})
