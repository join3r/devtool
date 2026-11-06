import { useSyncExternalStore } from 'react'

/** A short note at the bottom of the window that goes away by itself ("<server> is offline"). */
export interface Toast {
  id: number
  message: string
  /** One follow-up, e.g. "Show logs"; it dismisses the toast. */
  action?: { label: string; run: () => void }
}

const TOAST_MS = 4000
let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function showToast(message: string, options: { action?: Toast['action'] } = {}): void {
  // The same note twice in a row reads as one.
  if (toasts.some(toast => toast.message === message)) return
  const toast: Toast = { id: nextId++, message, action: options.action }
  toasts = [...toasts, toast]
  emit()
  // One with an action stays a little longer: there is something to do with it.
  setTimeout(() => dismissToast(toast.id), options.action ? TOAST_MS * 1.5 : TOAST_MS)
}

export function dismissToast(id: number): void {
  const next = toasts.filter(toast => toast.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => toasts
  )
}
