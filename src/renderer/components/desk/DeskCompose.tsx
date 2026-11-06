import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { isChatTabType, type AppConfig, type DeskScope, type Project } from '../../../shared/types'
import ProjectTileBadge from '../ProjectTileBadge'
import { PROMPT_BOX_AGENT_LABEL } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { composeTarget } from './deskInbox'
import { deskEvents } from './deskEvents'
import { autopilotAvailable, busyChoices, busyInSameFolder, canQueueStart, effectiveBusyChoice, type BusyChoice, deskAgents, deskSubmission, mentionAt, readLastWhere, whereOptions, writeLastWhere, type WhereOption } from './deskStart'
import { paletteEvents } from '../../palette/paletteEvents'
import { useAllTabStatuses } from '../../context/TabStatusContext'
import SameFolderWarning from './SameFolderWarning'
import { AttachmentStrip, toChatImages, useImageAttachments } from '../claude-chat/imageAttachments'

const chipCls = 'flex items-center gap-1.5 h-6 bg-sel border-0 rounded-md px-2 text-sm text-body cursor-pointer hover:bg-row-sel hover:text-text transition-colors duration-(--motion-fast) min-w-0'

/**
 * The desk's compose box: "Ask or give a task…" and a where chip (project ›
 * stream). Typing `@` opens a search over projects and streams, most recently
 * worked in first; ↵ or Tab picks one and drops the `@word` from the text. ↵
 * fires the task into the chosen stream and leaves you here; ⇧↵ is a new line;
 * ⌘↵ fires it on Autopilot (Settings says whether Codex reviews it). It aims at
 * the column's scope unless a pick says otherwise. The agent is Settings'
 * quick-task one, named on a chip only when a project can't run it. Agent tasks
 * start in auto mode (decision 2 of the redesign). A Claude chat takes pasted
 * or dropped images; they go with the prompt, and Options… carries them over.
 */
export default function DeskCompose({ projects, scope, config, theme, onCompose }: {
  projects: readonly Project[]
  scope: DeskScope | null
  config: AppConfig
  theme: 'dark' | 'light'
  onCompose: (submission: NewTaskSubmission) => void
}): React.ReactElement {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  // A picked where overrides the scope until the next fire or scope change.
  const [override, setOverride] = useState<DeskScope | null>(null)
  // Escape closes the search for the `@` at this offset until another one is typed.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setOverride(null) }, [scope?.projectId, scope?.streamId])

  useEffect(() => deskEvents.onFocusCompose((where) => {
    if (where) setOverride(where)
    inputRef.current?.focus()
  }), [])

  const target = useMemo(
    () => composeTarget(projects, override ?? scope, readLastWhere()),
    [projects, override, scope]
  )
  const { agent, isDefault } = deskAgents(config, target?.project, null)
  const canAutopilot = autopilotAvailable(target?.project, agent)
  // Only the chat view takes images; aiming elsewhere hides them rather than dropping them.
  const takesImages = !!agent && isChatTabType(agent)
  const attachments = useImageAttachments(takesImages)
  const images = takesImages ? attachments.images : []

  // Options… keeps the text and images until the form files it: closing the form must not lose them.
  const clearImages = attachments.clear
  useEffect(() => deskEvents.onClearCompose(() => { setText(''); setOverride(null); clearImages() }), [clearImages])

  const statuses = useAllTabStatuses()
  const busy = useMemo(
    () => (target && agent ? busyInSameFolder(target.project, target.stream, (tabId) => statuses[tabId]) : []),
    [target, agent, statuses]
  )
  const [pickedChoice, setPickedChoice] = useState<BusyChoice | null>(null)
  const choices = target ? busyChoices(target.project, target.stream, canQueueStart(agent, images.length)) : []
  const choice = effectiveBusyChoice(busy, choices, pickedChoice)

  const found = mentionAt(text, caret)
  const mention = found && found.start !== dismissedAt ? found : null
  const query = mention ? mention.query : null
  const options = useMemo(() => (query === null ? [] : whereOptions(projects, query)), [projects, query])
  useEffect(() => { setCursor(0) }, [query, mention?.start])
  // Under the box, placed once when the search opens.
  const searching = mention !== null
  const anchor = useMemo<MenuAnchor | null>(() => {
    if (!searching) return null
    const r = boxRef.current?.getBoundingClientRect()
    return r ? { x: r.left, y: r.bottom + 4 } : null
  }, [searching])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    // A scrollbar only once it stops growing: a rounding pixel would otherwise show a thumb on one line.
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [text])

  const edit = (next: string, nextCaret: number): void => {
    setText(next)
    setCaret(nextCaret)
    if (dismissedAt !== null && mentionAt(next, nextCaret)?.start !== dismissedAt) setDismissedAt(null)
  }

  /** Aim at the option and take its `@word` out of the text. */
  const pick = (option: WhereOption | undefined): void => {
    if (!option || !mention) return
    setOverride(option.stream ? { projectId: option.project.id, streamId: option.stream.id } : { projectId: option.project.id })
    const rest = text.slice(caret).replace(/^ /, '')
    const head = text.slice(0, mention.start)
    edit(head + rest, head.length)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(head.length, head.length)
    })
  }

  /** Sends as the same-folder warning says (`choice`); ⌘↵'s Autopilot doesn't wait in the queue, so it starts here instead. */
  const fire = (onAutopilot: boolean): void => {
    const prompt = text.trim()
    if (!prompt || !target) return
    writeLastWhere(target.project, target.stream)
    const autopilot = onAutopilot && canAutopilot
    if (choice === 'queue' && !autopilot) {
      onCompose({ ...deskSubmission(target.project, target.stream, agent, prompt), queue: true })
    } else {
      const submission = deskSubmission(target.project, target.stream, agent, prompt, autopilot ? { on: true, review: config.autopilotReview } : null, toChatImages(images))
      onCompose(choice === 'worktree' ? { ...submission, ownWorktree: true } : submission)
    }
    edit('', 0)
    attachments.clear()
    setOverride(null)
    setPickedChoice(null)
  }

  const whereLabel = target
    ? (target.stream && !target.stream.isMain ? `${target.project.name} › ${target.stream.name}` : target.project.name)
    : 'No project yet'
  const autopilotHint = canAutopilot ? ` · ⌘↵ on Autopilot${config.autopilotReview ? ' with a Codex review' : ''}` : ''

  return (
    <div ref={boxRef} className="@container border border-border bg-field rounded-xl px-3 pt-2.5 pb-2 flex flex-col gap-2 shadow-(--shadow-raise) transition-[border-color,box-shadow] duration-(--motion-fast) hover:border-border-strong focus-within:border-border-focus/60 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-border-focus)_16%,transparent)]" data-testid="desk-compose" {...attachments.dropProps}>
      {images.length > 0 && (
        <div className="-mx-2.5 -mt-2.5">
          <AttachmentStrip images={images} onRemove={attachments.remove} />
        </div>
      )}
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="New task"
        placeholder="Ask or give a task… @ picks the project"
        title={`↵ starts the task${autopilotHint} · @ picks the project${takesImages ? ' · paste or drop images to send them' : ''} · ${formatShortcutForApp('CmdOrCtrl+N')} comes back here`}
        className="bg-transparent border-0 outline-none text-text text-md resize-none leading-snug placeholder:text-text-subtle"
        value={text}
        onChange={(e) => edit(e.target.value, e.target.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={attachments.onPaste}
        onBlur={() => setDismissedAt(found?.start ?? null)}
        onFocus={(e) => { setCaret(e.currentTarget.selectionStart); setDismissedAt(null) }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (mention) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(i => Math.min(i + 1, Math.max(0, options.length - 1))); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(i => Math.max(0, i - 1)); return }
            if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || (e.key === 'Tab' && !e.shiftKey)) {
              if (options.length > 0) { e.preventDefault(); pick(options[cursor]); return }
            }
            if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(mention.start); return }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fire(true) }
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(false) }
          else if (e.key === 'Escape') { e.currentTarget.blur() }
        }}
        data-testid="desk-compose-input"
      />
      <div className="flex gap-1.5 items-center min-w-0">
        <button
          type="button"
          className={`${chipCls} shrink`}
          onClick={() => {
            const el = inputRef.current
            const at = el?.selectionStart ?? text.length
            const pad = at > 0 && !/\s/.test(text[at - 1]) ? ' ' : ''
            edit(text.slice(0, at) + pad + '@' + text.slice(at), at + pad.length + 1)
            setDismissedAt(null)
            requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + pad.length + 1, at + pad.length + 1) })
          }}
          title={`Where the task goes: ${whereLabel}. Type @ to pick another.`}
          data-testid="desk-compose-where"
        >
          {target && <ProjectTileBadge project={target.project} theme={theme} size={14} />}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{whereLabel}</span>
        </button>
        {/* Settings' agent goes unsaid; one a project falls back to is named. */}
        {!isDefault && (
          <span className={`${chipCls} shrink-0 whitespace-nowrap cursor-default`} title="This project can't run the agent picked in Settings">
            {agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'Terminal'}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="shrink-0 px-1.5 py-px rounded-md border-0 bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-surface-3 whitespace-nowrap"
          title="The full form: agent, model, permission mode, effort, Autopilot, pictures, a terminal task, any folder"
          onClick={() => {
            paletteEvents.emit('open-new-task-form', {
              ...(target ? { projectId: target.project.id, ...(target.stream ? { streamId: target.stream.id } : {}) } : {}),
              prompt: text,
              ...(images.length > 0 ? { images } : {})
            })
          }}
          data-testid="desk-compose-options"
        >Options…</button>
        {/* A narrow sidebar keeps the chip and drops the key hint (it is the textarea's tooltip too). */}
        <span className="hidden @[440px]:inline font-mono text-xs text-text-subtle whitespace-nowrap">
          ↵ fire{canAutopilot && ' · ⌘↵ autopilot'}
        </span>
        <button
          type="button"
          className="shrink-0 size-6 inline-flex items-center justify-center rounded-md border-0 bg-accent text-accent-ink cursor-pointer transition-[opacity,transform] duration-(--motion-fast) hover:brightness-110 active:scale-95 disabled:opacity-25 disabled:cursor-default disabled:active:scale-100"
          disabled={!text.trim() || !target}
          title={target ? `Start the task (↵)${canAutopilot ? ' · ⌘↵ on Autopilot' : ''}` : 'Pick a project first: type @'}
          aria-label="Start the task"
          onClick={() => fire(false)}
          data-testid="desk-compose-send"
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>
      </div>
      {target && text.trim() !== '' && (
        <SameFolderWarning
          project={target.project}
          stream={target.stream}
          busy={busy}
          choices={choices}
          choice={choice}
          onChoose={setPickedChoice}
        />
      )}
      <WhereMenu
        anchor={anchor}
        options={options}
        cursor={cursor}
        filtered={!!mention?.query}
        theme={theme}
        onHover={setCursor}
        onPick={pick}
        onDismiss={() => { if (mention) setDismissedAt(mention.start) }}
      />
    </div>
  )
}

/** The `@` search's rows: projects, each with its non-main streams under it (flat, "project › stream", once filtered). */
function WhereMenu({ anchor, options, cursor, filtered, theme, onHover, onPick, onDismiss }: {
  anchor: MenuAnchor | null
  options: readonly WhereOption[]
  cursor: number
  filtered: boolean
  theme: 'dark' | 'light'
  onHover: (index: number) => void
  onPick: (option: WhereOption) => void
  /** A click elsewhere. */
  onDismiss: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector(`[data-where-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, options])
  useEffect(() => {
    if (!anchor) return
    window.addEventListener('mousedown', onDismiss)
    return () => window.removeEventListener('mousedown', onDismiss)
  }, [anchor, onDismiss])
  if (!anchor) return null

  return (
    <div
      ref={pos.ref}
      className="fixed z-(--z-menu) w-[260px] bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-pop ui-pop-in overflow-y-auto"
      style={pos.style}
      // Keep focus (and the caret) in the textarea.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      data-testid="desk-compose-where-menu"
    >
      <div ref={listRef}>
      {options.length === 0 && <div className="px-2.5 py-1.5 text-sm text-text-muted">No project or stream matches</div>}
      {options.map((option, index) => {
        const selected = index === cursor
        return option.stream ? (
          <button key={option.key} type="button" data-where-index={index} className={`flex w-full items-center gap-2 ${filtered ? 'pl-2.5' : 'pl-[34px]'} pr-2.5 py-1 rounded-md border-0 text-sm cursor-pointer text-left font-mono ${selected ? 'bg-sel text-text' : 'bg-transparent text-text-muted'}`} onMouseMove={() => onHover(index)} onClick={() => onPick(option)}>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{filtered ? `${option.project.name} › ${option.stream.name}` : `› ${option.stream.name}`}</span>
          </button>
        ) : (
          <button key={option.key} type="button" data-where-index={index} className={`flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md border-0 text-base text-text cursor-pointer text-left ${selected ? 'bg-sel' : 'bg-transparent'}`} onMouseMove={() => onHover(index)} onClick={() => onPick(option)}>
            <ProjectTileBadge project={option.project} theme={theme} size={16} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{option.project.name}</span>
          </button>
        )
      })}
      </div>
    </div>
  )
}
