// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanAccount } from '../src/shared/plan-limits'

void React

const account: PlanAccount = {
  email: 'me@example.com', plan: 'max', readAt: 0, hosts: ['This Mac'],
  fiveHour: { utilization: 44 }, sevenDay: { utilization: 43 },
  models: [{ name: 'Fable', utilization: 22, resetsAt: '2999-01-01T00:00:00Z' }]
}

vi.mock('../src/renderer/planLimits', () => ({ usePlanLimits: () => [account] }))

afterEach(cleanup)

describe('PlanLimitChips', () => {
  it("shows each per-model weekly window (Fable) beside the 5-hour and weekly ones", async () => {
    const { default: PlanLimitChips } = await import('../src/renderer/components/desk/PlanLimitChips')
    render(<PlanLimitChips />)
    const chip = screen.getByTestId('desk-status-plan')
    expect(chip.getAttribute('aria-label')).toContain('Fable weekly limit 22% used')
    fireEvent.mouseEnter(chip)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('5-hour limit')
    expect(tip.textContent).toContain('Weekly limit')
    expect(tip.textContent).toContain('Weekly · Fable22% used')
  })
})
