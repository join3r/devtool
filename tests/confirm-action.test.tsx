// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmHost from '../src/renderer/components/ConfirmHost'
import { confirmAction, splitQuestion } from '../src/renderer/confirmAction'

void React

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const flush = async (): Promise<void> => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

describe('confirmAction', () => {
  it('splits a written question into title and message', () => {
    expect(splitQuestion('Remove "x"?\n\nNothing is landed.')).toEqual({ title: 'Remove "x"?', message: 'Nothing is landed.' })
    expect(splitQuestion('Sure?')).toEqual({ title: 'Sure?' })
  })

  it('falls back to window.confirm with the whole text when no host is mounted', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await expect(confirmAction('Delete it?\n\nGone for good.')).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Delete it?\n\nGone for good.')
  })

  it('asks in DevTool\'s own dialog: a named red button, Cancel focused first, Escape backs out', async () => {
    render(<ConfirmHost />)
    let answer: boolean | undefined
    act(() => { void confirmAction('Discard "Fix login"?\n\nIts worktree goes.', { confirmLabel: 'Discard', danger: true }).then(ok => { answer = ok }) })
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'Discard "Fix login"?' })
    expect(dialog.textContent).toContain('Its worktree goes.')
    expect(screen.getByRole('button', { name: 'Discard' }).className).toContain('bg-danger')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(answer).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves true on the confirming button', async () => {
    render(<ConfirmHost />)
    let answer: boolean | undefined
    act(() => { void confirmAction({ title: 'Move "x" to release?', confirmLabel: 'Move' }).then(ok => { answer = ok }) })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await flush()
    expect(answer).toBe(true)
  })

  it('shows a long target in full: the title wraps instead of truncating', async () => {
    render(<ConfirmHost />)
    const name = 'Investigate flaky e2e test on CI that times out after the third retry when the database is slow / src/really/long/path/without-any-spaces-in-it-at-all.ts'
    act(() => { void confirmAction(`Delete "${name}"?\n\nThis can't be undone.`, { confirmLabel: 'Delete', danger: true }) })
    await flush()
    const title = screen.getByRole('heading', { level: 2 })
    expect(title.textContent).toBe(`Delete "${name}"?`)
    expect(title.className).not.toContain('truncate')
    expect(title.className).toContain('[overflow-wrap:anywhere]')
  })
})
