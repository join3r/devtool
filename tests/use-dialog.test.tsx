// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Modal from '../src/renderer/components/ui/Modal'

void React

afterEach(cleanup)

async function flush(): Promise<void> {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

function Harness({ onClose, nested = false, autoFocusField = false, menu = false }: { onClose: () => void; nested?: boolean; autoFocusField?: boolean; menu?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [inner, setInner] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button>Background</button>
      {open && (
        <Modal title="Outer" onClose={() => { onClose(); setOpen(false) }}>
          <input aria-label="Name" autoFocus={autoFocusField} />
          {menu && <div role="menu">menu</div>}
          <button onClick={() => setInner(true)}>Inner</button>
        </Modal>
      )}
      {open && nested && inner && (
        <Modal title="Inner dialog" onClose={() => setInner(false)}>
          <button>Ok</button>
        </Modal>
      )}
    </>
  )
}

describe('Modal keyboard behaviour (useDialog)', () => {
  it('is a labelled modal dialog that focuses its first field', async () => {
    render(<Harness onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Open'))
    await flush()
    const dialog = screen.getByRole('dialog', { name: 'Outer' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('closes on Escape and gives focus back to the opener', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByText('Open')
    opener.focus()
    fireEvent.click(opener)
    await flush()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps Tab inside the dialog', async () => {
    render(<Harness onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Open'))
    await flush()
    const close = screen.getByRole('button', { name: 'Close' })
    const inner = screen.getByText('Inner')
    inner.focus()
    fireEvent.keyDown(inner, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(inner)
  })

  it('Escape peels off only the topmost of nested dialogs', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} nested />)
    fireEvent.click(screen.getByText('Open'))
    await flush()
    fireEvent.click(screen.getByText('Inner'))
    await flush()
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('gives focus back to the opener when a field inside took it with autoFocus', async () => {
    render(<Harness onClose={vi.fn()} autoFocusField />)
    const opener = screen.getByText('Open')
    opener.focus()
    fireEvent.click(opener)
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('makes the background inert while open, and lifts it on close', async () => {
    render(<Harness onClose={vi.fn()} />)
    const background = screen.getByText('Background')
    fireEvent.click(screen.getByText('Open'))
    await flush()
    expect(background.closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(document.querySelector('[inert]')).toBeNull()
  })

  it('leaves Escape to an open menu inside the dialog', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} menu />)
    fireEvent.click(screen.getByText('Open'))
    await flush()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
