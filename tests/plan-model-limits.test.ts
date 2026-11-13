import { describe, expect, it } from 'vitest'
import { modelLimitWindows } from '../src/main/claude-chat/chat-session'
import { modelLimitWindows as wireModelLimitWindows, viewUsage } from '../src/main/mobile/chat-view'
import { PlanLimits } from '../src/main/plan-limits'
import { buildInbox } from '../src/main/mobile/inbox'
import { emptyChatState, reduceChat, type ChatEvent } from '../src/shared/claude-chat'

const RESET = '2026-11-14T16:00:00.455259+00:00'

describe('per-model plan windows (Fable…)', () => {
  it("reads the server's scoped rows from /usage, skipping the session and all-models ones", () => {
    expect(modelLimitWindows({
      limits: [
        { kind: 'session', group: 'session', percent: 44, resets_at: RESET, scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: RESET, scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 22, resets_at: RESET, scope: { model: { display_name: 'Fable' } } }
      ],
      model_scoped: [{ display_name: 'Ignored', utilization: 1, resets_at: null }]
    })).toEqual([{ name: 'Fable', utilization: 22, resetsAt: RESET }])
  })

  it('falls back to model_scoped, then the Opus/Sonnet fields, and is undefined with nothing', () => {
    expect(modelLimitWindows({ model_scoped: [{ display_name: 'Fable', utilization: 22, resets_at: null }] }))
      .toEqual([{ name: 'Fable', utilization: 22 }])
    expect(modelLimitWindows({ seven_day_opus: { utilization: 5, resets_at: null }, seven_day_sonnet: null }))
      .toEqual([{ name: 'Opus', utilization: 5 }])
    expect(modelLimitWindows({ limits: [], seven_day_opus: null })).toBeUndefined()
    expect(modelLimitWindows(null)).toBeUndefined()
  })

  it('carries them through the plan tracker to the phone, in whole percents and Unix ms', () => {
    const limits = new PlanLimits({ selfLabel: 'This Mac', hostOfTab: () => null, now: () => 1000 })
    const event: ChatEvent = {
      t: 'meta',
      info: { account: { email: 'me@example.com', plan: 'max' } },
      usage: { fiveHour: { utilization: 44 }, models: [{ name: 'Fable', utilization: 21.6, resetsAt: RESET }] }
    }
    const state = reduceChat(emptyChatState(), event)
    limits.observe('a', event, state)
    // A later read without models keeps the last known ones.
    const later: ChatEvent = { t: 'meta', usage: { fiveHour: { utilization: 45 } } }
    limits.observe('a', later, reduceChat(state, later))
    const [account] = limits.accounts()
    expect(account.models).toEqual([{ name: 'Fable', utilization: 21.6, resetsAt: RESET }])

    const wire = [{ name: 'Fable', used: 22, resetsAt: Date.parse(RESET) }]
    expect(viewUsage(state.usage)?.models).toEqual(wire)
    const inbox = buildInbox({ projects: [], settings: {} } as never, (() => undefined) as never, { id: 'd', name: 'Mac' }, 0, new Set(), () => [], () => undefined, [account])
    expect(inbox.limits?.[0].models).toEqual(wire)
    expect(wireModelLimitWindows([{ name: '', utilization: 3 }])).toBeUndefined()
  })
})
