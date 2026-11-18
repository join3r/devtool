import { randomUUID } from 'crypto'
import { redactionList, SECRET_VALUE_MAX, type RedactionList, type SecretAnswer, type SecretRequest } from '../../shared/secrets'
import type { SecretStore } from './secret-store'

/**
 * Open `request_secret` calls, each waiting on the user's answer in a window.
 * Main keeps them (not the windows), so every window and the Inbox show the
 * same list, and the value only ever travels window → main → the named file.
 */

export interface SecretRequestInput {
  projectId: string
  taskId: string
  tabId: string
  name: string
  reason: string
  /** Relative to `dir`, already checked (`safeSecretFile`, `checkSecretFile`). */
  file: string
  /** The task's folder on this machine. */
  dir: string
}

export type SecretOutcome =
  | { status: 'provided'; file: string; excluded: boolean; remembered: boolean; rememberFailed: boolean; fromSaved: boolean }
  | { status: 'declined' }
  | { status: 'timeout' }
  | { status: 'cancelled' }

export interface SecretRequestsDeps {
  store: SecretStore
  /** Puts the value into the file (`secret-file.ts`). */
  write(dir: string, file: string, name: string, value: string): Promise<{ excluded: boolean }>
  /** The list changed: windows redraw it. */
  onChange(list: SecretRequest[]): void
  /** A request opened or closed for a tab: its status shows (or stops showing) that it waits on you. */
  onOpen?(request: SecretRequest): void
  onClose?(request: SecretRequest): void
  log?(message: string): void
  now?(): number
}

interface Pending {
  request: SecretRequest
  dir: string
  settle(outcome: SecretOutcome): void
  /** Callers waiting on it: the same name asked twice by one tab shares one prompt. */
  waiters: number
  listeners: ((outcome: SecretOutcome) => void)[]
}

/** How long a call waits for the user before it answers `timeout`. */
export const SECRET_WAIT_MS = 30 * 60_000

export class SecretRequests {
  private readonly pending = new Map<string, Pending>()
  /** Values given this run, for redaction. Never written anywhere. */
  private readonly known = new Map<string, { name: string; value: string }>()
  private redactions: RedactionList = []

  constructor(private readonly deps: SecretRequestsDeps) {}

  list(): SecretRequest[] {
    return [...this.pending.values()].map(p => p.request).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** What chat views and replies must not show: every value given this run, longest first. */
  redactionList(): RedactionList {
    return this.redactions
  }

  /**
   * Opens a prompt and waits for the answer. `signal` aborting (the agent's call
   * went away) closes it; so does the timeout.
   */
  request(input: SecretRequestInput, signal?: AbortSignal, timeoutMs = SECRET_WAIT_MS): Promise<SecretOutcome> {
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' })
    const same = [...this.pending.values()].find(p => p.request.tabId === input.tabId && p.request.name === input.name && p.request.file === input.file)
    return new Promise<SecretOutcome>(resolve => {
      let pending = same
      if (!pending) {
        const request: SecretRequest = {
          id: randomUUID(),
          projectId: input.projectId,
          taskId: input.taskId,
          tabId: input.tabId,
          name: input.name,
          reason: input.reason,
          file: input.file,
          saved: this.deps.store.has(input.projectId, input.name),
          canRemember: this.deps.store.canSave(),
          createdAt: this.deps.now?.() ?? Date.now()
        }
        const created: Pending = {
          request,
          dir: input.dir,
          waiters: 0,
          listeners: [],
          settle: (outcome) => {
            if (this.pending.get(request.id) !== created) return
            this.pending.delete(request.id)
            this.deps.log?.(`secretRequest closed id=${request.id} tab=${request.tabId} name=${request.name} status=${outcome.status}`)
            this.deps.onClose?.(request)
            this.changed()
            for (const listener of created.listeners) listener(outcome)
          }
        }
        this.pending.set(request.id, created)
        pending = created
        this.deps.log?.(`secretRequest open id=${request.id} tab=${request.tabId} name=${request.name} file=${request.file}`)
        this.deps.onOpen?.(request)
        this.changed()
      }
      const target = pending
      target.waiters += 1
      let done = false
      const finish = (outcome: SecretOutcome): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      target.listeners.push(finish)
      const leave = (outcome: SecretOutcome): void => {
        if (done) return
        target.waiters -= 1
        // The last caller gone: nobody would get the answer, so the prompt goes too.
        if (target.waiters <= 0) target.settle(outcome)
        finish(outcome)
      }
      const onAbort = (): void => leave({ status: 'cancelled' })
      const timer = setTimeout(() => leave({ status: 'timeout' }), timeoutMs)
      signal?.addEventListener('abort', onAbort)
    })
  }

  /**
   * The user's answer from a window. An error keeps the prompt open (the
   * window shows it); a decline or a delivered value closes it.
   */
  async answer(id: string, answer: SecretAnswer): Promise<{ ok: true; rememberFailed?: boolean } | { ok: false; error: string }> {
    const pending = this.pending.get(id)
    if (!pending) return { ok: false, error: 'That request is gone.' }
    const { request } = pending
    if (answer.kind === 'decline') {
      pending.settle({ status: 'declined' })
      return { ok: true }
    }
    let value: string
    let fromSaved = false
    if (answer.kind === 'saved') {
      const saved = this.deps.store.get(request.projectId, request.name)
      if (saved === null) return { ok: false, error: 'The saved value could not be read. Enter it again.' }
      value = saved
      fromSaved = true
    } else {
      value = answer.value
      if (value.length === 0) return { ok: false, error: 'Enter a value.' }
      if (value.length > SECRET_VALUE_MAX) return { ok: false, error: 'That value is too long.' }
    }
    let excluded: boolean
    try {
      excluded = (await this.deps.write(pending.dir, request.file, request.name, value)).excluded
    } catch (err) {
      return { ok: false, error: `Couldn't write ${request.file}: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.remember(request.name, value)
    let remembered = false
    let rememberFailed = false
    if (answer.kind === 'value' && answer.remember) {
      try {
        remembered = this.deps.store.set(request.projectId, request.name, value)
      } catch {
        remembered = false
      }
      rememberFailed = !remembered
    }
    pending.settle({ status: 'provided', file: request.file, excluded, remembered, rememberFailed, fromSaved })
    return rememberFailed ? { ok: true, rememberFailed } : { ok: true }
  }

  /** A tab is gone (closed, its task removed): its prompts go with it. */
  cancelTab(tabId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.tabId === tabId) pending.settle({ status: 'cancelled' })
    }
  }

  /**
   * Learns every remembered value, so a chat's history replayed after a
   * restart is redacted too. Values given without Remember were never stored,
   * so they can't be known again.
   */
  learnSaved(): void {
    for (const { name, value } of this.deps.store.all()) this.remember(name, value)
  }

  /** Adds a value to the redaction list (also used for saved values once read). */
  remember(name: string, value: string): void {
    if (this.known.get(value)?.name === name) return
    this.known.set(value, { name, value })
    this.redactions = redactionList(this.known.values())
  }

  private changed(): void {
    this.deps.onChange(this.list())
  }
}
