import React, { useEffect, useState } from 'react'
import { registerConfirmHost, type ConfirmRequest } from '../confirmAction'
import Modal from './ui/Modal'

interface Pending { request: ConfirmRequest; settle: (ok: boolean) => void }

/** Renders `confirmAction` questions one at a time; a second waits for the first. */
export default function ConfirmHost(): React.ReactElement | null {
  const [queue, setQueue] = useState<Pending[]>([])
  useEffect(() => registerConfirmHost((request, settle) => setQueue(q => [...q, { request, settle }])), [])
  const current = queue[0]
  if (!current) return null
  const answer = (ok: boolean): void => {
    current.settle(ok)
    setQueue(q => q.slice(1))
  }
  const { request } = current
  return (
    <Modal
      key={queue.length}
      title={request.title}
      onClose={() => answer(false)}
      width="w-[460px]"
      footer={
        <>
          <button
            type="button"
            className="h-(--ctl-h) px-3 rounded-md border border-border bg-transparent text-base text-text cursor-pointer hover:bg-sel"
            onClick={() => answer(false)}
            data-testid="confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus={!request.danger}
            className={[
              'h-(--ctl-h) px-4 rounded-md border-0 text-base font-medium cursor-pointer shadow-(--shadow-raise) hover:brightness-110',
              request.danger ? 'bg-danger text-danger-ink' : 'bg-accent text-accent-ink'
            ].join(' ')}
            onClick={() => answer(true)}
            data-testid="confirm-ok"
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {request.message
        ? <p className="m-0 text-base text-text-muted whitespace-pre-line leading-relaxed [overflow-wrap:anywhere]" data-testid="confirm-message">{request.message}</p>
        : <span className="sr-only">Confirm</span>}
    </Modal>
  )
}
