/**
 * Asking before something that can't be undone, in DevTool's own dialog
 * (`ConfirmHost`, mounted once in App) instead of the OS's OK/Cancel box: the
 * button says what happens ("Discard", "Delete"), destructive ones are red,
 * and Escape or Cancel back out. Without a host (tests, a window still
 * mounting) it falls back to `window.confirm`.
 */
export interface ConfirmRequest {
  /** Bold first line, a question: "Discard “Fix login”?" */
  title: string
  /** What happens, in a sentence or two. */
  message?: string
  /** The confirming button. Default "OK". */
  confirmLabel?: string
  /** Red confirming button: the action deletes or throws away work. */
  danger?: boolean
}

type Host = (request: ConfirmRequest, settle: (ok: boolean) => void) => void
let host: Host | null = null

/** ConfirmHost registers itself; returns the unregister. */
export function registerConfirmHost(next: Host): () => void {
  host = next
  return () => { if (host === next) host = null }
}

/** A question written as one text: its first paragraph is the title, the rest the message. */
export function splitQuestion(text: string): { title: string; message?: string } {
  const at = text.indexOf('\n\n')
  return at < 0 ? { title: text } : { title: text.slice(0, at), message: text.slice(at + 2) }
}

export function confirmAction(request: ConfirmRequest | string, options: Omit<ConfirmRequest, 'title' | 'message'> = {}): Promise<boolean> {
  const req = typeof request === 'string' ? { ...splitQuestion(request), ...options } : { ...request, ...options }
  if (!host) return Promise.resolve(window.confirm([req.title, req.message].filter(Boolean).join('\n\n')))
  const current = host
  return new Promise(resolve => current(req, resolve))
}
