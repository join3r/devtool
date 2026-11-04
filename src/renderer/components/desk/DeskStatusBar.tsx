import React, { useMemo } from 'react'
import { Smartphone } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useServersState } from '../../serversState'
import { useSshStatuses } from '../../sshStatuses'
import { useMobileState } from '../../hooks/useMobileState'
import { paletteEvents } from '../../palette/paletteEvents'
import PlanLimitChips from './PlanLimitChips'
import MachinesStatus from './MachinesStatus'
import { statusHosts, statusPhone, type StatusTone } from './statusBar'

const DOT: Record<StatusTone, string> = {
  ok: 'bg-running',
  idle: 'bg-text-subtle opacity-60',
  bad: 'bg-crashed',
  needs: 'bg-needs'
}

const BUTTON = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0 bg-transparent border-y-0 border-l-0 cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)'

/**
 * The desk's status bar, along the bottom of the window (change 7 of the
 * redesign), quiet unless something needs you: the machines as one chip, with
 * a chip of their own for one in trouble or running hot, on the left; one
 * Claude limits chip and the phone's icon on the right. The stream commands
 * live in the run dock over the Inbox (`DeskRunDock`).
 */
export default function DeskStatusBar(): React.ReactElement {
  const { projects } = useApp()
  const sshProjectIds = useMemo(() => projects.filter(project => project.ssh).map(project => project.id), [projects])
  const servers = useServersState()
  const ssh = useSshStatuses(sshProjectIds)
  const [mobile] = useMobileState()

  const hosts = useMemo(() => statusHosts(projects, servers.servers, ssh), [projects, servers, ssh])
  const phone = statusPhone(mobile)
  // The phone says something only when it wants you: a pairing to accept, an update.
  const phoneSpeaks = phone && (phone.tone === 'needs' || phone.tone === 'bad')

  return (
    <footer
      className="shrink-0 flex items-stretch h-[26px] border-t-[0.5px] border-hair bg-surface overflow-hidden select-none"
      data-testid="desk-status-bar"
    >
      <MachinesStatus hosts={hosts} />
      <span className="flex-1" />
      <span className="border-l-[0.5px] border-hair" />
      <PlanLimitChips />
      {phone && (
        <button
          type="button"
          className={BUTTON}
          title={`${phone.label}${phone.detail ? ` · ${phone.detail}` : ''}\n${phone.title}`}
          aria-label={`${phone.label}${phone.detail ? `, ${phone.detail}` : ''}`}
          onClick={() => paletteEvents.emit('open-settings-tab', 'mobile')}
          data-testid="desk-status-phone"
        >
          <Smartphone size={12} className="shrink-0" />
          <span className={`size-[7px] shrink-0 rounded-full ${DOT[phone.tone]}`} />
          {phoneSpeaks && <span className="truncate">{phone.label}{phone.detail && <span className="text-text-subtle"> · {phone.detail}</span>}</span>}
        </button>
      )}
    </footer>
  )
}
