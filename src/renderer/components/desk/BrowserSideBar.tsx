import React from 'react'
import { ChevronsRight, Globe, Maximize2, Minimize2, Plus, Sparkles, X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Tab } from '../../../shared/types'
import { exitBrowserFocus, focusBrowser, setBrowserSide, showInSide } from './browserSide'

/** The Side's bar height, and the top margin of the page under it. */
export const SIDE_BAR_HEIGHT = 'var(--ctl-h-lg)'

const iconBtn = 'size-6 shrink-0 inline-flex items-center justify-center rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)'

/**
 * Above the browser in the Side, or across the task in Focus: the browser
 * tabs, "+" for another, then Focus (or Exit focus) and hide the Side.
 */
export default function BrowserSideBar({ projectId, taskId, chatTabId, tabs, activeTabId, focused, style }: {
  projectId: string
  taskId: string
  chatTabId: string
  tabs: Tab[]
  activeTabId: string
  focused: boolean
  style?: React.CSSProperties
}): React.ReactElement {
  const { addTab, removeTab, setActiveTab } = useApp()
  const pick = (tabId: string): void => {
    setActiveTab(projectId, taskId, tabId)
    if (focused) focusBrowser(taskId, tabId)
    else showInSide(taskId, tabId)
  }
  return (
    <div
      className="min-w-0 flex items-center gap-0.5 px-1.5 bg-surface border-b-[0.5px] border-border text-sm select-none"
      style={{ height: SIDE_BAR_HEIGHT, alignSelf: 'start', ...style }}
      data-testid={focused ? 'browser-focus-bar' : 'browser-side-bar'}
    >
      <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map(tab => {
          const active = tab.id === activeTabId
          return (
            <span
              key={tab.id}
              className={`group/side h-6 min-w-0 max-w-56 shrink-0 inline-flex items-center rounded-md transition-colors duration-(--motion-fast) ${active ? 'bg-field text-text shadow-(--shadow-raise)' : 'text-text-muted hover:text-text hover:bg-sel'}`}
            >
              <button
                type="button"
                className="min-w-0 h-full pl-2 pr-1 inline-flex items-center gap-1.5 bg-transparent border-0 cursor-pointer text-inherit text-sm"
                aria-pressed={active}
                title={tab.artifact ? `${tab.title} (artifact)` : tab.title}
                onClick={() => pick(tab.id)}
              >
                {tab.artifact ? <Sparkles size={12} className="shrink-0 opacity-80" aria-hidden="true" /> : <Globe size={12} className="shrink-0 opacity-80" aria-hidden="true" />}
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                className={`size-5 mr-0.5 shrink-0 inline-flex items-center justify-center rounded-sm bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text ${active ? '' : 'opacity-0 group-hover/side:opacity-100 focus-visible:opacity-100'}`}
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
                onClick={() => { void removeTab(projectId, taskId, tab.id) }}
              >
                <X size={11} />
              </button>
            </span>
          )
        })}
        <button
          type="button"
          className={iconBtn}
          title="New browser tab"
          aria-label="New browser tab"
          onClick={() => addTab(projectId, taskId, { withTab: chatTabId }, 'browser')}
        >
          <Plus size={14} />
        </button>
      </div>
      {focused ? (
        <button
          type="button"
          className="h-6 px-2 shrink-0 inline-flex items-center gap-1.5 rounded-md border-0 bg-sel text-text text-sm cursor-pointer hover:bg-field transition-colors duration-(--motion-fast)"
          title="Back to the conversation, the page beside it (Esc)"
          onClick={() => exitBrowserFocus(taskId)}
        >
          <Minimize2 size={13} aria-hidden="true" />
          Exit focus
          <span className="font-mono text-xs text-text-subtle">Esc</span>
        </button>
      ) : (
        <>
          <button
            type="button"
            className={iconBtn}
            title="Focus: the page takes the whole task, the conversation folds to its prompt"
            aria-label="Focus"
            onClick={() => focusBrowser(taskId, activeTabId)}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className={iconBtn}
            title="Hide the browser (its tabs stay open)"
            aria-label="Hide the browser"
            onClick={() => setBrowserSide(taskId, { open: false })}
          >
            <ChevronsRight size={14} />
          </button>
        </>
      )}
    </div>
  )
}
