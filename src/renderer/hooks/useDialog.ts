import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]'
].join(',')

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    // checkVisibility skips display:none/hidden subtrees; where it's missing (jsdom) everything counts.
    .filter(el => el === document.activeElement || (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true))
}

/** The dialog on top: the last open one in the document. A nested dialog takes the keys first. */
function isTopmost(el: HTMLElement): boolean {
  const open = document.querySelectorAll('[aria-modal="true"]')
  return open[open.length - 1] === el
}

/**
 * Everything outside the dialog becomes inert while it is open: no clicks,
 * focus or screen-reader reach into the background. Walks from the dialog up
 * to <body>, marking each ancestor's other children. The undo only clears
 * what it set, so an outer dialog's marks stay.
 */
function inertOutside(root: HTMLElement): () => void {
  const marked: Element[] = []
  let node: Element = root
  while (node.parentElement && node !== document.body) {
    const parent: HTMLElement = node.parentElement
    for (const sibling of Array.from(parent.children)) {
      // data-dialog-keep: requests that need an answer wherever you are (pairing), and toasts.
      if (sibling === node || sibling.hasAttribute('inert') || sibling.hasAttribute('data-dialog-keep')) continue
      if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE' || sibling.tagName === 'LINK') continue
      sibling.setAttribute('inert', '')
      marked.push(sibling)
    }
    node = parent
  }
  return () => { for (const el of marked) el.removeAttribute('inert') }
}

export interface DialogOptions {
  /** Called on Escape. Leave it out when the dialog handles Escape itself. */
  onEscape?: () => void
  /** For a component that stays mounted and shows its dialog now and then. Default true. */
  open?: boolean
  /** Give focus back to where it was before the dialog opened. Default true. */
  restoreFocus?: boolean
}

/**
 * Modal keyboard behaviour for a dialog card (`aria-modal="true"`): focus moves
 * in on open (unless something inside already took it, e.g. an autoFocus
 * field), Tab and Shift+Tab stay inside, the background is inert, Escape calls
 * `onEscape`, and focus goes back to the opener on close. Only the topmost
 * dialog reacts, so dialogs can nest. Pass the Escape handler alone as a
 * shorthand for `{ onEscape }`.
 */
export function useDialog<T extends HTMLElement>(options: DialogOptions | (() => void) = {}): React.RefObject<T | null> {
  const { onEscape, open = true, restoreFocus = true } = typeof options === 'function' ? { onEscape: options } : options
  const ref = useRef<T | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  const restoreRef = useRef(restoreFocus)
  restoreRef.current = restoreFocus

  // The opener, read while rendering the dialog's first open frame: before an
  // autoFocus inside it moves focus (React does that in the commit, before effects).
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
  }
  wasOpen.current = open

  useEffect(() => {
    const root = ref.current
    if (!open || !root) return
    const previous = opener.current
    const undoInert = inertOutside(root.closest<HTMLElement>('[data-modal]') ?? root)

    // After children's own effects (autoFocus, focus calls) have run.
    const focusTimer = window.setTimeout(() => {
      if (!root.isConnected || root.contains(document.activeElement)) return
      // A field first, then any control but the close button, which only gets focus when it's all there is.
      const items = focusables(root)
      const first = items.find(el => el.matches('input, textarea, select')) ??
        items.find(el => !el.hasAttribute('data-dialog-close')) ?? items[0]
      if (first) first.focus()
      else { root.tabIndex = -1; root.focus() }
    }, 0)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isTopmost(root)) return
      if (e.key === 'Escape') {
        if (e.defaultPrevented || !escapeRef.current) return
        // An open menu or dropdown closes first (its own Escape listener runs after this one).
        if (document.querySelector('[role="menu"], [role="listbox"]')) return
        e.preventDefault()
        e.stopPropagation()
        escapeRef.current()
        return
      }
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const items = focusables(root)
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      undoInert()
      if (!restoreRef.current) return
      // Give focus back only when it was inside (or nowhere): don't steal it from where the close sent it.
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active) || !active.isConnected
      if (lost && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  return ref
}
