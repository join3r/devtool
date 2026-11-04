import { describe, expect, it } from 'vitest'
import { scheduleForRun, updateScheduleInData } from '../src/main/mobile/schedules'
import { mainStreamId, type Project, type ProjectsData, type Schedule, type Stream } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const BUGS: Stream = { id: 's-bugs', name: 'bugfixes', tasks: [] }
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime()
const SC1: Schedule = { id: 'sc1', name: 'Check', prompt: 'Go', every: 1, unit: 'week', startAt: NOW + 1000, nextRunAt: NOW + 1000, createdAt: NOW - 1 }

function data(extra: Partial<Project> = {}): ProjectsData {
  const projects = [
    fixtureProject({ id: 'p1', name: 'api', directory: '/src/api', streams: [BUGS], schedules: [SC1], ...extra }),
    fixtureProject({ id: 'hidden', hideFromMobile: true, schedules: [SC1] })
  ]
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] }
}

function p1(result: ReturnType<typeof updateScheduleInData>): Project {
  if (!result.ok) throw new Error(result.message)
  return result.data.projects[0]
}

describe('updateScheduleInData (SPEC.md §8.25)', () => {
  it('adds a schedule, keeping streamId only off main', () => {
    const toMain = updateScheduleInData(data(), { projectId: 'p1', action: 'add', name: 'Audit', prompt: 'npm audit', every: 2, unit: 'day', streamId: mainStreamId('p1') }, () => 'sc2', NOW)
    expect(toMain).toMatchObject({ ok: true, scheduleId: 'sc2' })
    const added = p1(toMain).schedules!.at(-1)!
    expect(added).toMatchObject({ id: 'sc2', name: 'Audit', every: 2, unit: 'day' })
    expect(added.streamId).toBeUndefined()
    const toBugs = updateScheduleInData(data(), { projectId: 'p1', action: 'add', name: 'A', prompt: 'B', every: 1, unit: 'hour', streamId: 's-bugs', startAt: NOW + 60_000 }, () => 'sc3', NOW)
    expect(p1(toBugs).schedules!.at(-1)).toMatchObject({ streamId: 's-bugs', nextRunAt: NOW + 60_000 })
  })

  it('edits, pauses and removes', () => {
    expect(p1(updateScheduleInData(data(), { projectId: 'p1', action: 'edit', scheduleId: 'sc1', name: 'Renamed', streamId: 's-bugs' }, undefined, NOW)).schedules![0]).toMatchObject({ name: 'Renamed', streamId: 's-bugs' })
    expect(p1(updateScheduleInData(data(), { projectId: 'p1', action: 'pause', scheduleId: 'sc1', paused: true }, undefined, NOW)).schedules![0].paused).toBe(true)
    expect(p1(updateScheduleInData(data(), { projectId: 'p1', action: 'remove', scheduleId: 'sc1' }, undefined, NOW)).schedules).toBeUndefined()
  })

  it('answers not-found for what the phone cannot see, and unsupported where schedules cannot run', () => {
    expect(updateScheduleInData(data(), { projectId: 'nope', action: 'remove', scheduleId: 'sc1' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateScheduleInData(data(), { projectId: 'hidden', action: 'remove', scheduleId: 'sc1' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateScheduleInData(data(), { projectId: 'p1', action: 'remove', scheduleId: 'gone' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateScheduleInData(data(), { projectId: 'p1', action: 'add', name: 'x', prompt: 'y', every: 1, unit: 'day', streamId: 'gone' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateScheduleInData(data(), { projectId: 'p1', action: 'add', name: 'x', prompt: 'y', every: 999, unit: 'week' })).toMatchObject({ ok: false, code: 'bad-request' })
    const shell = data({ shellCommand: { command: 'make' } as Project['shellCommand'] })
    expect(updateScheduleInData(shell, { projectId: 'p1', action: 'add', name: 'x', prompt: 'y', every: 1, unit: 'day' })).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('scheduleForRun (SPEC.md §8.25)', () => {
  it('needs a visible project and a schedule it has', () => {
    expect(scheduleForRun(data(), { projectId: 'p1', scheduleId: 'sc1' })).toEqual({ ok: true })
    expect(scheduleForRun(data(), { projectId: 'p1', scheduleId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(scheduleForRun(data(), { projectId: 'hidden', scheduleId: 'sc1' })).toMatchObject({ ok: false, code: 'not-found' })
  })
})
