import React from 'react'
import { X } from 'lucide-react'
import { dismissToast, useToasts } from '../toasts'

/** The window's toasts, bottom centre, above everything but modals. */
export default function Toasts(): React.ReactElement | null {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none" role="status" aria-live="polite" data-dialog-keep>
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="ui-rise-in pointer-events-auto flex items-center gap-1 max-w-[min(560px,90vw)] pl-3.5 pr-1 py-1 rounded-lg border border-border-strong bg-surface-3 text-sm text-text shadow-pop"
          data-testid="toast"
        >
          <span className="py-1 min-w-0">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="ml-2 shrink-0 h-6 px-2 rounded-md border-0 bg-sel text-sm font-medium text-text cursor-pointer hover:bg-border-strong"
              onClick={() => { dismissToast(toast.id); toast.action?.run() }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 size-6 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-text-muted cursor-pointer hover:text-text hover:bg-sel"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
