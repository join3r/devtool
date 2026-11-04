import { describe, it, expect } from 'vitest'
import { defaultFirstRun, formatRunTime, fromLocalInput, scheduleLastRunLine, scheduleWhenLine, toLocalInput } from '../src/renderer/components/desk/schedules'
import type { Schedule } from '../src/shared/types'

const NOW = new Date(2026, 10, 4, 15, 0).getTime() // Wed Nov 4, 15:00 local

function schedule(over: Partial<Schedule> = {}): Schedule {
  return { id: 's', name: 'SDK check', prompt: 'p', every: 1, unit: 'week', startAt: NOW, nextRunAt: NOW + 86_400_000, createdAt: NOW, ...over }
}

describe('schedule lines', () => {
  it('says the cadence and when it runs next', () => {
    expect(scheduleWhenLine(schedule(), NOW)).toMatch(/^every week · next tomorrow /)
    expect(scheduleWhenLine(schedule({ every: 2, unit: 'day', paused: true }), NOW)).toBe('every 2 days · paused')
    expect(formatRunTime(NOW + 3_600_000, NOW)).toMatch(/^today /)
  })

  it('says what the last run came to', () => {
    expect(scheduleLastRunLine(schedule(), NOW)).toBeNull()
    expect(scheduleLastRunLine(schedule({ lastRun: { at: NOW - 2 * 86_400_000, outcome: 'quiet', note: 'Still open' } }), NOW)).toBe('Last run 2d ago: nothing new. Still open')
    expect(scheduleLastRunLine(schedule({ lastRun: { at: NOW, outcome: 'failed', note: 'Claude is turned off in Settings.' } }), NOW)).toContain('failed: Claude is turned off')
  })

  it('round-trips datetime-local values and picks tomorrow 9:00 by default', () => {
    expect(fromLocalInput(toLocalInput(NOW))).toBe(NOW)
    expect(fromLocalInput('')).toBeNull()
    const first = new Date(defaultFirstRun('week', NOW))
    expect([first.getDate(), first.getHours()]).toEqual([5, 9])
  })
})
