import React, { useState } from 'react'
import { Clock } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Project, Schedule, ScheduleUnit } from '../../../shared/types'
import { findTaskInProject } from '../../../shared/streams'
import { SCHEDULE_EVERY_MAX, type ScheduleUpdateRequest } from '../../../shared/schedules'
import { showToast } from '../../toasts'
import { Field, InlineConfirm, LinkBtn, Modal, PrimaryButton, Select } from '../ui'
import { defaultFirstRun, fromLocalInput, scheduleLastRunLine, scheduleWhenLine, toLocalInput } from './schedules'

const headCls = 'text-2xs font-semibold uppercase tracking-[0.07em] text-text-muted'
const linkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-muted hover:text-text hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default'
const labelCls = 'flex flex-col gap-1 text-xs text-text-muted'

/** Can a project show schedules here? A server project's run on its server. */
export function schedulesShown(project: Project): boolean {
  return !project.ssh && !project.shellCommand && !project.ephemeral
}

async function update(projectId: string, req: ScheduleUpdateRequest): Promise<boolean> {
  const result = await window.api.scheduleUpdate(projectId, req)
  if (!result.ok) showToast(`Schedule: ${result.error}`)
  return result.ok
}

function ScheduleRow({ project, schedule, now, onEdit }: { project: Project; schedule: Schedule; now: number; onEdit: () => void }): React.ReactElement {
  const { switchToTask } = useApp()
  const [starting, setStarting] = useState(false)
  const last = scheduleLastRunLine(schedule, now)
  const runTask = findTaskInProject(project, schedule.lastRun?.taskId)
  const runNow = async (): Promise<void> => {
    setStarting(true)
    try {
      const result = await window.api.scheduleRun(project.id, schedule.id)
      if (!result.ok) showToast(`Run now: ${result.error}`)
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="flex flex-col gap-1 py-2 border-t border-hair first:border-t-0" data-testid={`schedule-${schedule.id}`}>
      <div className="flex items-center gap-2 min-w-0">
        <Clock size={13} className={`shrink-0 ${schedule.paused ? 'text-text-subtle' : 'text-text-muted'}`} />
        <span className={`flex-1 min-w-0 text-sm truncate ${schedule.paused ? 'text-text-muted' : 'text-text'}`} title={schedule.prompt}>{schedule.name}</span>
        <button type="button" className={linkCls} disabled={starting} onClick={() => void runNow()}>{starting ? 'Starting…' : 'Run now'}</button>
        <button type="button" className={linkCls} onClick={() => void update(project.id, { action: 'pause', scheduleId: schedule.id, paused: !schedule.paused })}>
          {schedule.paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className={linkCls} onClick={onEdit}>Edit</button>
      </div>
      <span className="pl-[21px] text-xs text-text-muted">{scheduleWhenLine(schedule, now)}</span>
      {last && (
        <span className="pl-[21px] text-xs text-text-subtle truncate" title={last}>
          {runTask
            ? <button type="button" className={`${linkCls} text-text-subtle`} onClick={() => switchToTask(project.id, runTask.id)}>{last}</button>
            : last}
        </span>
      )}
      {schedule.createdBy && <span className="pl-[21px] text-2xs text-text-subtle truncate">Made by task “{schedule.createdBy.name}”</span>}
    </div>
  )
}

/** The project page's Schedules card: each schedule, its next and last run, and New. */
export function SchedulesCard({ project, now }: { project: Project; now: number }): React.ReactElement {
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const schedules = project.schedules ?? []
  return (
    <div className="flex-[1_1_320px] min-w-0 self-start mt-2 border border-border rounded-[10px] bg-field px-4 py-3.5 flex flex-col gap-1.5" data-testid="map-schedules">
      <div className="flex items-center gap-2">
        <span className={headCls}>Schedules</span>
        <span className="flex-1" />
        <button type="button" className={linkCls} onClick={() => setEditing('new')} data-testid="schedule-new">New schedule</button>
      </div>
      {schedules.length === 0 && (
        <span className="text-xs text-text-muted">
          Run a prompt every hour, day or week as a new task. Runs that find nothing new close by themselves; the rest wait in the Inbox.
        </span>
      )}
      {schedules.map(schedule => (
        <ScheduleRow key={schedule.id} project={project} schedule={schedule} now={now} onEdit={() => setEditing(schedule)} />
      ))}
      {editing && <ScheduleModal project={project} schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

const UNITS: { value: ScheduleUnit; label: string }[] = [
  { value: 'hour', label: 'hours' },
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' }
]

/** New schedule / Edit schedule. */
export function ScheduleModal({ project, schedule, onClose }: { project: Project; schedule: Schedule | null; onClose: () => void }): React.ReactElement {
  const [name, setName] = useState(schedule?.name ?? '')
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [every, setEvery] = useState(String(schedule?.every ?? 1))
  const [unit, setUnit] = useState<ScheduleUnit>(schedule?.unit ?? 'week')
  const [first, setFirst] = useState(() => toLocalInput(schedule?.startAt ?? defaultFirstRun('week', Date.now())))
  const mainId = project.streams.find(s => s.isMain)?.id ?? ''
  const [streamId, setStreamId] = useState(schedule?.streamId ?? mainId)
  const [saving, setSaving] = useState(false)

  const n = Number(every)
  const startAt = fromLocalInput(first)
  const valid = name.trim() !== '' && prompt.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= SCHEDULE_EVERY_MAX[unit] && startAt !== null

  const save = async (): Promise<void> => {
    if (!valid || startAt === null) return
    setSaving(true)
    const base = { name, prompt, every: n, unit, streamId: streamId || null }
    const ok = schedule
      ? await update(project.id, { action: 'edit', scheduleId: schedule.id, ...base, ...(startAt !== schedule.startAt ? { startAt } : {}) })
      : await update(project.id, { action: 'add', ...base, streamId: streamId && streamId !== mainId ? streamId : undefined, startAt })
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Modal
      title={schedule ? 'Edit schedule' : 'New schedule'}
      onClose={onClose}
      width="w-[520px]"
      footer={
        <>
          {schedule && (
            <span className="mr-auto flex items-center gap-3">
              <LinkBtn onClick={() => { void update(project.id, { action: 'pause', scheduleId: schedule.id, paused: !schedule.paused }).then(ok => { if (ok) onClose() }) }}>
                {schedule.paused ? 'Resume' : 'Pause'}
              </LinkBtn>
              <InlineConfirm
                trigger="Delete schedule"
                prompt="Delete it?"
                confirmLabel="Delete"
                onConfirm={() => { void update(project.id, { action: 'remove', scheduleId: schedule.id }).then(ok => { if (ok) onClose() }) }}
              />
            </span>
          )}
          <LinkBtn onClick={onClose}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => void save()} disabled={!valid || saving}>{schedule ? 'Save' : 'Create'}</PrimaryButton>
        </>
      }
    >
      <label className={labelCls}>
        Name
        <Field value={name} onChange={e => setName(e.target.value)} placeholder="Agent SDK usage bug" autoFocus maxLength={120} />
      </label>
      <label className={labelCls}>
        Prompt for each run
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={6}
          placeholder="Check whether anthropics/claude-code#97074 is fixed. Report only if its status changed."
          className="px-2.5 py-2 rounded-md bg-field border border-border text-base text-text leading-[1.5] resize-y min-h-[110px] outline-none focus:border-border-focus focus:shadow-focus placeholder:text-text-subtle"
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelCls}>
          Every
          <span className="flex items-center gap-1.5">
            <Field type="number" min={1} max={SCHEDULE_EVERY_MAX[unit]} value={every} onChange={e => setEvery(e.target.value)} className="w-16" />
            <Select value={unit} onChange={e => setUnit(e.target.value as ScheduleUnit)}>
              {UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
            </Select>
          </span>
        </label>
        <label className={labelCls}>
          {schedule ? 'Runs at (first run)' : 'First run'}
          <Field type="datetime-local" value={first} onChange={e => setFirst(e.target.value)} />
        </label>
        {project.streams.length > 1 && (
          <label className={labelCls}>
            Stream
            <Select value={streamId} onChange={e => setStreamId(e.target.value)}>
              {project.streams.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
        )}
      </div>
      <span className="text-xs text-text-subtle">
        Each run is a new Claude task. A run that finds nothing new closes itself; one with news stays in the Inbox. Runs need DevTool open; missed ones run once at the next launch.
      </span>
    </Modal>
  )
}
