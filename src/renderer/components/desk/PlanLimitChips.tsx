import React, { useEffect, useState } from 'react'
import { menuCls } from '../ui'
import { usePlanLimits } from '../../planLimits'
import { busiestAccount, currentWindow, leadWindow, type PlanAccount } from '../../../shared/plan-limits'
import type { ChatLimitWindow } from '../../../shared/claude-chat'
import { formatResetAt, formatResetIn, limitTone } from '../claude-chat/UsageMeter'

/**
 * The status bar's plan limits: one Claude chip for every claude.ai login the
 * Claude tabs run on (this Mac, its SSH boxes and its servers). It shows the
 * login nearest its limit: the 5-hour bar over the weekly one and the 5-hour
 * share used, plus the countdown once it runs hot. Hovering shows each login's
 * windows, their resets and the hosts on it.
 */

const TONE_TEXT = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' } as const
const TONE_BG = { success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' } as const

/** The clock, ticking every 30s so countdowns and passed resets stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** One bar of a window, filled by the share used; an empty track when unknown. */
function Bar({ window, thick }: { window?: ChatLimitWindow; thick?: boolean }): React.ReactElement {
  const used = window ? Math.min(100, Math.max(0, window.utilization)) : 0
  const height = thick ? 'h-1' : 'h-[3px]'
  return (
    <span className={`block ${height} rounded-full bg-[color-mix(in_srgb,currentColor_18%,transparent)] overflow-hidden`}>
      {window && <span className={`block h-full rounded-full ${TONE_BG[limitTone(used)]}`} style={{ width: `${used}%` }} />}
    </span>
  )
}

/** "Resets 14:30 · in 4h 16m"; empty when the window has no reset time. */
function resetLine(window: ChatLimitWindow, now: number): string {
  if (!window.resetsAt) return ''
  const reset = formatResetIn(window.resetsAt, now)
  if (!reset) return ''
  return reset === 'now' ? 'Resetting now' : `Resets ${formatResetAt(window.resetsAt, now)} · in ${reset}`
}

function WindowRow({ label, window, now }: { label: string; window: ChatLimitWindow; now: number }): React.ReactElement {
  const tone = limitTone(window.utilization)
  const reset = resetLine(window, now)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-text">{label}</span>
        <span className={TONE_TEXT[tone]}>{Math.round(window.utilization)}% used</span>
      </div>
      <Bar window={window} thick />
      {reset && <span className="text-text-muted">{reset}</span>}
    </div>
  )
}

const CHIP = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0 bg-transparent border-y-0 border-l-0 cursor-default hover:text-text hover:bg-sel transition-colors duration-(--motion-fast) tabular-nums'

export default function PlanLimitChips(): React.ReactElement | null {
  const accounts = usePlanLimits()
  const now = useNow()
  const [hover, setHover] = useState<DOMRect | null>(null)
  const lead = busiestAccount(accounts, now)
  if (!lead) return null
  return (
    <>
      <Chip
        account={lead}
        accounts={accounts}
        now={now}
        onShow={setHover}
        onHide={() => setHover(null)}
      />
      {hover && <Details accounts={accounts} rect={hover} now={now} />}
    </>
  )
}

/** The window's share in words, for a screen reader. */
function spoken(account: PlanAccount, now: number): string {
  const fiveHour = currentWindow(account.fiveHour, now)
  const sevenDay = currentWindow(account.sevenDay, now)
  const parts = [
    fiveHour && `5-hour limit ${Math.round(fiveHour.utilization)}% used`,
    sevenDay && `weekly limit ${Math.round(sevenDay.utilization)}% used`
  ].filter(Boolean)
  return `${account.email}: ${parts.join(', ')}`
}

/** One chip for every login: the bars and share of the one nearest its limit; hovering shows each. */
function Chip({ account, accounts, now, onShow, onHide }: {
  account: PlanAccount
  accounts: readonly PlanAccount[]
  now: number
  onShow: (rect: DOMRect) => void
  onHide: () => void
}): React.ReactElement {
  const fiveHour = currentWindow(account.fiveHour, now)
  const sevenDay = currentWindow(account.sevenDay, now)
  const lead = leadWindow(account, now)
  const tone = lead ? limitTone(lead.utilization) : 'success'
  const reset = tone !== 'success' && lead?.resetsAt ? formatResetIn(lead.resetsAt, now) : ''
  const show = (e: React.SyntheticEvent<HTMLButtonElement>): void => onShow(e.currentTarget.getBoundingClientRect())
  return (
    <button
      type="button"
      className={CHIP}
      aria-label={`Claude plan limits. ${accounts.map(each => spoken(each, now)).join('. ')}`}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={onHide}
      onBlur={onHide}
      data-testid="desk-status-plan"
    >
      <span className="inline-flex flex-col justify-center gap-0.5 w-7 shrink-0">
        <Bar window={fiveHour} />
        <Bar window={sevenDay} />
      </span>
      <span>Claude</span>
      {lead && (
        <span className={tone === 'success' ? '' : TONE_TEXT[tone]}>
          {Math.round(lead.utilization)}%{reset && reset !== 'now' ? ` · ↺ ${reset}` : ''}
        </span>
      )}
    </button>
  )
}

/** The popover above the chip: fixed, so the bar's overflow clip doesn't cut it; right-aligned to the chip. One block per login. */
function Details({ accounts, rect, now }: { accounts: readonly PlanAccount[]; rect: DOMRect; now: number }): React.ReactElement {
  return (
    <div
      role="tooltip"
      className={`fixed z-(--z-menu) pointer-events-none w-72 flex flex-col gap-3 px-3 py-2.5 text-xs tabular-nums ${menuCls}`}
      style={{ right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 }}
    >
      {accounts.map((account, index) => {
        const fiveHour = currentWindow(account.fiveHour, now)
        const sevenDay = currentWindow(account.sevenDay, now)
        return (
          <div key={account.email} className={`flex flex-col gap-2.5 ${index > 0 ? 'border-t-[0.5px] border-hair pt-3' : ''}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-text truncate">{account.email}</span>
              {account.plan && <span className="text-text-muted capitalize shrink-0">{account.plan}</span>}
            </div>
            {fiveHour && <WindowRow label="5-hour limit" window={fiveHour} now={now} />}
            {sevenDay && <WindowRow label="Weekly limit" window={sevenDay} now={now} />}
            {account.hosts.length > 0 && <div className="text-text-muted">Used by {account.hosts.join(', ')}</div>}
          </div>
        )
      })}
    </div>
  )
}
