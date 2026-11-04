import React, { useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { SecretRequest } from '../../shared/secrets'
import { LinkBtn } from './ui'

/**
 * The masked field for an agent's `request_secret`. The value goes straight to
 * main (`secret-answer`) and is dropped from this component once sent; the
 * agent learns only the file it was written to.
 *
 * `compact`: the Inbox row's version. Clicks and keys stay inside it, so the
 * row doesn't open and the Inbox's shortcuts don't fire while typing.
 */
export default function SecretPrompt({ request, compact = false }: { request: SecretRequest; compact?: boolean }): React.ReactElement {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (answer: Parameters<typeof window.api.secretAnswer>[1]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.secretAnswer(request.id, answer)
      if (!result.ok) setError(result.error)
      else setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (): void => {
    if (!value || busy) return
    void send({ kind: 'value', value, remember })
  }

  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

  return (
    <div
      className={compact
        ? 'mt-1.5 flex flex-col gap-1.5 cursor-default'
        : 'shrink-0 flex flex-col gap-1.5 px-3 py-2 text-sm bg-surface-2 border-b-[0.5px] border-border'}
      role="group"
      aria-label={`Secret ${request.name}`}
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onContextMenu={stop}
      data-testid="secret-prompt"
      data-request-id={request.id}
    >
      {!compact && (
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound size={14} className="shrink-0 text-status-attention" aria-hidden="true" />
          <span className="text-text">The agent needs <span className="font-mono font-medium">{request.name}</span></span>
          {request.reason && <span className="text-text-muted truncate" title={request.reason}>· {request.reason}</span>}
        </div>
      )}
      <form
        className="flex items-center gap-2 min-w-0"
        onSubmit={(e) => { e.preventDefault(); submit() }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={!compact}
          aria-label={`Value for ${request.name}`}
          placeholder="Paste the value"
          className="flex-1 min-w-0 h-(--ctl-h) px-2.5 rounded-md bg-field border border-border text-base text-text font-mono focus:border-border-focus focus:shadow-focus outline-none placeholder:text-text-subtle placeholder:font-sans"
          value={value}
          disabled={busy}
          onChange={e => setValue(e.target.value)}
          data-testid="secret-prompt-input"
        />
        <button
          type="submit"
          disabled={!value || busy}
          className="shrink-0 inline-flex items-center h-(--ctl-h) px-3 rounded-md border-0 cursor-pointer text-sm font-medium text-accent-ink bg-accent hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="secret-prompt-save"
        >Save</button>
      </form>
      <div className="flex items-center gap-4 text-xs text-text-muted flex-wrap">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            className="accent-(--color-accent)"
            checked={remember}
            disabled={busy}
            onChange={e => setRemember(e.target.checked)}
            data-testid="secret-prompt-remember"
          />
          Remember for this project
        </label>
        {request.saved && <LinkBtn disabled={busy} onClick={() => void send({ kind: 'saved' })}>Use saved</LinkBtn>}
        <LinkBtn danger disabled={busy} onClick={() => void send({ kind: 'decline' })}>Decline</LinkBtn>
        <span className="text-text-subtle">Goes to <span className="font-mono">{request.file}</span>, kept out of git and the chat.</span>
      </div>
      {error && <div className="text-xs text-danger" role="alert">{error}</div>}
    </div>
  )
}
