import React from 'react'
import { useBlockLabel } from './labelContext'

interface Props<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  compact?: boolean
  /** Accessible name of the group. */
  label?: string
}

/** Segmented control for mutually-exclusive presets; the active segment is raised on the field surface. */
export default function SegCtl<T extends string>({ options, value, onChange, disabled, compact, label }: Props<T>): React.ReactElement {
  const labelledBy = useBlockLabel(!!label)
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={[
        'inline-flex self-start rounded-md p-0.5 gap-0.5',
        'bg-[color-mix(in_srgb,var(--color-text)_7%,var(--color-field))]',
        disabled ? 'opacity-50 pointer-events-none' : ''
      ].join(' ')}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={[
            'border-0 rounded cursor-pointer transition-colors duration-(--motion-med)',
            compact ? 'px-2 h-5 text-xs' : 'px-2.5 h-6 text-sm',
            opt.value === value
              ? 'bg-field text-text font-medium shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_var(--color-border-strong)]'
              : 'bg-transparent text-text-muted hover:text-text'
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
