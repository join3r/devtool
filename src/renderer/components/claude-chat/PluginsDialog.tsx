import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  isPluginScope,
  searchCatalog,
  type AvailablePlugin,
  type InstalledPlugin,
  type PluginAction,
  type PluginCatalog,
  type PluginScope
} from '../../../shared/claude-plugins'
import { Field, HelperText, LinkBtn, Modal, PrimaryButton, SegCtl, Select, Switch } from '../ui'

interface Props {
  tabId: string
  /** The project directory; null for a remote project, whose plugins live on the host. */
  cwd: string | null
  /** Its project, so a DevTool server's project runs `claude plugin` on that server. */
  projectId?: string
  onClose: () => void
  onOpenInTerminal: () => void
}

type View = 'installed' | 'marketplace'

const SCOPE_OPTIONS: { value: PluginScope; label: string; hint: string }[] = [
  { value: 'user', label: 'User', hint: 'All your projects' },
  { value: 'project', label: 'Project', hint: 'This project, shared in git' },
  { value: 'local', label: 'Local', hint: 'This project, only for you' }
]

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

function formatCount(count: number): string {
  const short = (value: number, unit: string): string => `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/u, '')}${unit}`
  if (count >= 1_000_000) return short(count / 1_000_000, 'M')
  if (count >= 1000) return short(count / 1000, 'k')
  return String(count)
}

const ACTION_DONE: Record<PluginAction, string> = {
  install: 'Installed',
  uninstall: 'Removed',
  enable: 'Enabled',
  disable: 'Disabled'
}

/**
 * `/plugins` for a chat tab: the CLI's `/plugin` menu is terminal UI, so DevTool
 * runs `claude plugin …` itself and then reloads the plugins into the running
 * session, so new commands and skills work at once.
 */
export default function PluginsDialog({ tabId, cwd, projectId, onClose, onOpenInTerminal }: Props): React.ReactElement {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [view, setView] = useState<View>('installed')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PluginScope>('user')
  /** The plugin id a change runs for. One change at a time: they write the same settings files. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!cwd) return
    try {
      setCatalog(await window.api.chatPluginsList(cwd, projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [cwd, projectId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const change = async (action: PluginAction, plugin: { id: string; name: string }, pluginScope?: string): Promise<void> => {
    if (!cwd || busy) return
    setBusy(plugin.id)
    setError(null)
    setStatus(null)
    try {
      await window.api.chatPluginsChange(cwd, action, plugin.id, pluginScope, projectId)
      await load()
      const reload = await window.api.chatPluginsReload(tabId).catch(() => null)
      const where = reload?.reloaded
        ? reload.errorCount > 0 ? ` Reloaded with ${reload.errorCount} plugin error${reload.errorCount === 1 ? '' : 's'}.` : ' Applied to this chat now.'
        : ' Applies from the next message.'
      setStatus(`${ACTION_DONE[action]} ${plugin.name}.${where}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const matches = useMemo(() => (catalog ? searchCatalog(catalog, query) : []), [catalog, query])

  if (!cwd) {
    return (
      <Modal
        title="Plugins"
        onClose={onClose}
        footer={
          <>
            <LinkBtn onClick={onClose}>Close</LinkBtn>
            <PrimaryButton onClick={() => { onClose(); onOpenInTerminal() }}>Switch to terminal</PrimaryButton>
          </>
        }
      >
        <HelperText>
          This project's Claude plugins live on the remote host. Continue this task in a terminal and run /plugin there.
        </HelperText>
      </Modal>
    )
  }

  const viewOptions = [
    { value: 'installed' as const, label: catalog ? `Installed (${catalog.installed.length})` : 'Installed' },
    { value: 'marketplace' as const, label: 'Marketplace' }
  ]

  return (
    <Modal title="Plugins" width="w-[600px]" onClose={onClose} footer={<LinkBtn onClick={onClose}>Done</LinkBtn>}>
      <div className="flex items-center justify-between gap-3">
        <SegCtl options={viewOptions} value={view} onChange={setView} label="Plugin list" />
        {busy && <span className="text-xs text-text-subtle">Working…</span>}
      </div>
      {error && (
        <HelperText>
          <span className="text-danger whitespace-pre-wrap">{error}</span>{' '}
          <LinkBtn onClick={() => { onClose(); onOpenInTerminal() }}>Use a terminal</LinkBtn>
        </HelperText>
      )}
      {status && !error && <HelperText>{status}</HelperText>}
      {!catalog ? (
        !error && <HelperText>Loading plugins…</HelperText>
      ) : view === 'installed' ? (
        <InstalledList plugins={catalog.installed} busy={busy} onChange={(action, plugin) => { void change(action, plugin, plugin.scope) }} onBrowse={() => setView('marketplace')} />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            <Field
              autoFocus
              className="flex-1 min-w-0 text-sm"
              placeholder={`Search ${catalog.available.length} plugins`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select value={scope} onChange={(e) => { if (isPluginScope(e.target.value)) setScope(e.target.value) }} title="Where the plugin is installed">
              {SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>
              ))}
            </Select>
          </div>
          {matches.length === 0 ? (
            <HelperText>{catalog.available.length === 0 ? 'No marketplace is set up. Add one in a terminal with claude plugin marketplace add.' : 'No plugin matches.'}</HelperText>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col rounded-md border-[0.5px] border-border bg-surface-2 max-h-[50vh] overflow-y-auto">
              {matches.map((plugin) => (
                <MarketplaceRow
                  key={plugin.id}
                  plugin={plugin}
                  installed={plugin.installed}
                  busy={busy}
                  onInstall={() => { void change('install', plugin, scope) }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

function InstalledList({ plugins, busy, onChange, onBrowse }: {
  plugins: InstalledPlugin[]
  busy: string | null
  onChange: (action: PluginAction, plugin: InstalledPlugin) => void
  onBrowse: () => void
}): React.ReactElement {
  if (plugins.length === 0) {
    return <HelperText>No plugins installed. <LinkBtn onClick={onBrowse}>Browse the marketplace</LinkBtn></HelperText>
  }
  return (
    <ul className="m-0 p-0 list-none flex flex-col rounded-md border-[0.5px] border-border bg-surface-2 max-h-[55vh] overflow-y-auto">
      {plugins.map((plugin) => {
        // `managed` and `synced` plugins come from an admin or claude.ai: the CLI cannot change them here.
        const editable = isPluginScope(plugin.scope)
        const meta = [plugin.marketplace !== plugin.scope ? plugin.marketplace : '', plugin.scope, plugin.version ? `v${plugin.version}` : ''].filter(Boolean).join(' · ')
        return (
          <li key={`${plugin.id}:${plugin.scope}`} className="group flex items-center gap-2 px-2.5 py-1.5 border-b border-hair last:border-b-0">
            <div className="flex-1 min-w-0 flex flex-col">
              <span className={`text-sm truncate ${plugin.enabled ? 'text-text' : 'text-text-subtle'}`} title={plugin.id}>{plugin.name}</span>
              <span className="text-xs text-text-subtle truncate">{meta}</span>
              {plugin.notes?.map((note) => <span key={note} className="text-xs text-warn">{note}</span>)}
            </div>
            {editable && (
              <button
                type="button"
                title="Uninstall this plugin"
                aria-label={`Uninstall ${plugin.name}`}
                disabled={busy !== null}
                onClick={() => onChange('uninstall', plugin)}
                className="w-6 h-6 inline-flex items-center justify-center rounded-sm border-0 bg-transparent text-text-subtle cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-surface-3 disabled:cursor-default"
              >
                <X size={13} />
              </button>
            )}
            <Switch
              checked={plugin.enabled}
              disabled={!editable || busy !== null}
              label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
              onChange={(on) => onChange(on ? 'enable' : 'disable', plugin)}
            />
          </li>
        )
      })}
    </ul>
  )
}

function MarketplaceRow({ plugin, installed, busy, onInstall }: {
  plugin: AvailablePlugin
  installed: boolean
  busy: string | null
  onInstall: () => void
}): React.ReactElement {
  return (
    <li className="flex items-start gap-3 px-2.5 py-2 border-b border-hair last:border-b-0">
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm text-text truncate" title={plugin.id}>{plugin.name}</span>
          <span className="text-xs text-text-subtle truncate">
            {plugin.marketplace}{plugin.installCount ? ` · ${formatCount(plugin.installCount)} installs` : ''}
          </span>
        </div>
        {plugin.description && <span className="text-xs text-text-muted line-clamp-2">{plugin.description}</span>}
      </div>
      <div className="shrink-0 pt-0.5">
        {installed ? (
          <span className="text-xs text-text-subtle">Installed</span>
        ) : busy === plugin.id ? (
          <span className="text-xs text-text-subtle">Installing…</span>
        ) : (
          <LinkBtn disabled={busy !== null} onClick={onInstall}>Install</LinkBtn>
        )}
      </div>
    </li>
  )
}
