import React, { useId } from 'react'
import { X } from 'lucide-react'
import { useDialog } from '../../hooks/useDialog'

interface Props {
  title: React.ReactNode
  onClose: () => void
  /** Tailwind width class for the card, default w-[440px] */
  width?: string
  /** Right-aligned footer content (LinkBtns + one PrimaryButton) */
  footer?: React.ReactNode
  children: React.ReactNode
}

/** Standard modal shell: dim backdrop on the modal z-rung, rounded card with pop shadow. */
export default function Modal({ title, onClose, width = 'w-[440px]', footer, children }: Props): React.ReactElement {
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const titleId = useId()
  return (
    <div className="ui-fade-in fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/45 backdrop-blur-[2px]" onClick={onClose} data-modal>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${width} max-w-[90vw] max-h-[85vh] ui-rise-in rounded-2xl border border-border bg-surface shadow-pop flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 pl-5 pr-3 pt-4 pb-1 shrink-0">
          {/* Wraps, never truncates: a confirm question names the exact task, file or project it acts on.
              A very long one scrolls on its own, so the body and footer keep their room. */}
          <h2 id={titleId} className="text-md font-semibold text-text m-0 min-w-0 pt-0.5 leading-snug [overflow-wrap:anywhere] max-h-[30vh] overflow-y-auto">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="size-7 shrink-0 inline-flex items-center justify-center bg-transparent border-0 text-text-muted cursor-pointer rounded-md hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)"
            title="Close (Esc)"
            aria-label="Close"
            data-dialog-close
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 flex flex-col gap-3">
          {children}
        </div>

        {footer && (
          <footer className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-hair bg-surface-2/60 shrink-0">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
