import React from 'react'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Accessible name, when no visible label is tied to it (GroupRow ties its own). */
  label?: string
  labelledBy?: string
}

/**
 * Pill toggle — replaces raw checkboxes everywhere.
 * On: accent track with an accent-ink knob. Off: dim track with a muted knob.
 * The knob changes colour as well as position, so the state stays readable in
 * the monochrome theme, where the accent is near-white.
 */
export default function Switch({ checked, onChange, disabled, label, labelledBy }: Props): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative w-[34px] h-5 rounded-full border-0 shrink-0 transition-colors duration-(--motion-med)',
        checked ? 'bg-accent' : 'bg-[color-mix(in_srgb,var(--color-text)_10%,var(--color-field))] shadow-[inset_0_0_0_1px_var(--color-control)]',
        disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 size-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-all duration-(--motion-med)',
          checked ? 'left-[16px] bg-accent-ink' : 'left-0.5 bg-text-subtle'
        ].join(' ')}
      />
    </button>
  )
}
