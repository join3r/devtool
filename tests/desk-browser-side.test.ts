import { beforeEach, describe, expect, it } from 'vitest'
import { benchPanes, benchTabClosable, withSideColumn } from '../src/renderer/components/desk/benchLayout'
import {
  browserSideLayout,
  clampShare,
  exitBrowserFocus,
  focusBrowser,
  getBrowserSide,
  MAX_SIDE_SHARE,
  MIN_SIDE_SHARE,
  setBrowserSide,
  showInSide,
  sideTabs
} from '../src/renderer/components/desk/browserSide'
import type { Tab, TabType, Task, TaskPane } from '../src/shared/types'

function tab(id: string, type: TabType): Tab {
  return { id, type, title: id }
}

function pane(tabs: Tab[], activeTabId = tabs[0]?.id ?? '', width = 1): TaskPane {
  return { tabs, activeTabId, width }
}

function task(panes: TaskPane[]): Task {
  return { id: 't', name: 't', panes }
}

const closed = { open: false, tabId: null, focusTabId: null }

describe('the browser Side', () => {
  const t = task([pane([tab('chat', 'claude-chat'), tab('w1', 'browser'), tab('term', 'terminal')], 'chat'), pane([tab('w2', 'browser')])])

  it('holds every browser tab of a task with a conversation, in pane order', () => {
    expect(sideTabs(t, 'chat').map(x => x.id)).toEqual(['w1', 'w2'])
    expect(sideTabs(t, null)).toEqual([])
  })

  it('shows its tab, or the first when that one is gone', () => {
    expect(browserSideLayout(t, 'chat', { open: true, tabId: 'w2', focusTabId: null })).toMatchObject({ open: true, tabId: 'w2', focusTabId: null })
    expect(browserSideLayout(t, 'chat', { open: true, tabId: 'gone', focusTabId: null }).tabId).toBe('w1')
    expect(browserSideLayout(t, 'chat', closed)).toMatchObject({ open: false, tabId: 'w1' })
  })

  it('is not there without a browser tab', () => {
    const plain = task([pane([tab('chat', 'claude-chat')])])
    expect(browserSideLayout(plain, 'chat', { open: true, tabId: null, focusTabId: null })).toMatchObject({ open: false, tabId: null })
  })

  it('gives Focus only to a tab that is still there', () => {
    expect(browserSideLayout(t, 'chat', { open: false, tabId: 'w1', focusTabId: 'w2' })).toMatchObject({ open: true, tabId: 'w2', focusTabId: 'w2' })
    expect(browserSideLayout(t, 'chat', { open: false, tabId: 'w1', focusTabId: 'gone' })).toMatchObject({ open: false, focusTabId: null })
  })

  it('puts the Side right of the Bench at its share of the width', () => {
    const bench = benchPanes(t, 'chat')
    // The second pane holds only a browser tab, so the Bench hides it: the Side gets 1fr × 0.5 / 0.5.
    expect(withSideColumn([1, 1], bench, 0.5)).toBe('minmax(0, 1fr) 0px 0px 3px minmax(0, 1fr)')
    // Only the conversation: its own width counts.
    const onlyChat = benchPanes(task([pane([tab('chat', 'claude-chat'), tab('w', 'browser')])]), 'chat')
    expect(withSideColumn([1], onlyChat, 0.75)).toBe('minmax(0, 1fr) 3px minmax(0, 3fr)')
  })

  it('keeps its share within bounds', () => {
    expect(clampShare(0.05)).toBe(MIN_SIDE_SHARE)
    expect(clampShare(0.99)).toBe(MAX_SIDE_SHARE)
  })

  it('lets ⌘W close a browser tab only while the Side shows it', () => {
    const bench = { open: false, view: 'panes' as const, run: null }
    expect(benchTabClosable(t, bench, 'w1', true)).toBe(true)
    expect(benchTabClosable(t, bench, 'w1', false)).toBe(false)
  })
})

describe('Side state', () => {
  let n = 0
  let id = ''
  beforeEach(() => { id = `side-${n++}` })

  it('starts closed', () => {
    expect(getBrowserSide(id)).toEqual(closed)
  })

  it('leaves Focus for the Side on the same tab', () => {
    focusBrowser(id, 'art')
    expect(getBrowserSide(id)).toEqual({ open: true, tabId: 'art', focusTabId: 'art' })
    exitBrowserFocus(id)
    expect(getBrowserSide(id)).toEqual({ open: true, tabId: 'art', focusTabId: null })
  })

  it('leaves Focus when a tab is shown in the Side', () => {
    focusBrowser(id, 'art')
    showInSide(id, 'dev')
    expect(getBrowserSide(id)).toEqual({ open: true, tabId: 'dev', focusTabId: null })
  })

  it('hides and keeps its tab', () => {
    showInSide(id, 'dev')
    setBrowserSide(id, { open: false })
    expect(getBrowserSide(id)).toEqual({ open: false, tabId: 'dev', focusTabId: null })
  })
})
