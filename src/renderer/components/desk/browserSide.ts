import { useSyncExternalStore } from 'react'
import type { Tab, Task } from '../../../shared/types'

/**
 * The browser's place in the desk's task view. With a conversation, browser
 * tabs leave the Bench: they show in the Side, a column right of the
 * conversation, and one of them can take the whole task (Focus), with the
 * conversation folded to its prompt. An artifact opens in Focus. Renderer
 * state only, like the Bench: a fresh window starts with every Side closed.
 * The data model is unchanged: browser tabs stay in `task.panes`.
 */
export interface BrowserSideState {
  open: boolean
  /** The browser tab the Side shows; a missing one falls back to the first. */
  tabId: string | null
  /** The browser tab that has the whole task, if any. */
  focusTabId: string | null
}

const DEFAULT_STATE: BrowserSideState = { open: false, tabId: null, focusTabId: null }

/** The Side's share of the task's width, for every task in this window. */
export const DEFAULT_SIDE_SHARE = 0.55
export const MIN_SIDE_SHARE = 0.25
export const MAX_SIDE_SHARE = 0.8
const SHARE_KEY = 'devtool.browserSideShare'

const states = new Map<string, BrowserSideState>()
const listeners = new Set<() => void>()
let share = readShare()

function readShare(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(SHARE_KEY))
    return raw ? clampShare(raw) : DEFAULT_SIDE_SHARE
  } catch {
    return DEFAULT_SIDE_SHARE
  }
}

export function clampShare(value: number): number {
  return Math.min(MAX_SIDE_SHARE, Math.max(MIN_SIDE_SHARE, value))
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function getBrowserSide(taskId: string): BrowserSideState {
  return states.get(taskId) ?? DEFAULT_STATE
}

export function setBrowserSide(taskId: string, patch: Partial<BrowserSideState>): void {
  const current = getBrowserSide(taskId)
  const next = { ...current, ...patch }
  if (next.open === current.open && next.tabId === current.tabId && next.focusTabId === current.focusTabId) return
  states.set(taskId, next)
  emit()
}

/** Show `tabId` in the Side, leaving Focus: a page you asked for beside the conversation. */
export function showInSide(taskId: string, tabId: string): void {
  setBrowserSide(taskId, { open: true, tabId, focusTabId: null })
}

/** Give `tabId` the whole task. Leaving Focus shows it in the Side. */
export function focusBrowser(taskId: string, tabId: string): void {
  setBrowserSide(taskId, { open: true, tabId, focusTabId: tabId })
}

/** Out of Focus, back to the Side on the same tab. */
export function exitBrowserFocus(taskId: string): void {
  const current = getBrowserSide(taskId)
  if (!current.focusTabId) return
  setBrowserSide(taskId, { open: true, tabId: current.focusTabId, focusTabId: null })
}

export function getSideShare(): number {
  return share
}

export function setSideShare(value: number): void {
  const next = clampShare(value)
  if (next === share) return
  share = next
  try { globalThis.localStorage?.setItem(SHARE_KEY, String(next)) } catch { /* a per-window convenience */ }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useBrowserSide(taskId: string): BrowserSideState {
  return useSyncExternalStore(subscribe, () => getBrowserSide(taskId))
}

export function useSideShare(): number {
  return useSyncExternalStore(subscribe, getSideShare)
}

/** The tabs the Side holds: every browser tab of a task with a conversation, in pane order. */
export function sideTabs(task: Task, chatTabId: string | null): Tab[] {
  if (!chatTabId) return []
  return task.panes.flatMap(pane => pane.tabs.filter(tab => tab.type === 'browser'))
}

export interface BrowserSideLayout {
  tabs: Tab[]
  /** The Side is on screen (open, with a tab to show). */
  open: boolean
  /** The tab it shows. */
  tabId: string | null
  /** The tab in Focus, when one is: it covers the task. */
  focusTabId: string | null
}

/** What the task view shows of the browser, its state checked against the tabs there are. */
export function browserSideLayout(task: Task, chatTabId: string | null, state: BrowserSideState): BrowserSideLayout {
  const tabs = sideTabs(task, chatTabId)
  const has = (id: string | null): id is string => !!id && tabs.some(tab => tab.id === id)
  const focusTabId = has(state.focusTabId) ? state.focusTabId : null
  const tabId = focusTabId ?? (has(state.tabId) ? state.tabId : tabs[0]?.id ?? null)
  return { tabs, open: !!tabId && (state.open || !!focusTabId), tabId, focusTabId }
}
