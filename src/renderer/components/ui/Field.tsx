import React from 'react'
import { useBlockLabel } from './labelContext'

const fieldCls =
  'h-(--ctl-h) px-2.5 rounded-md bg-field border border-control text-base text-text ' +
  'focus:border-border-focus focus:shadow-focus outline-none disabled:opacity-50 ' +
  'placeholder:text-text-subtle'

type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/** Standard text/number input — compact control height on the field surface. */
export const Field = React.forwardRef<HTMLInputElement, InputProps>(function Field(
  { className, ...rest },
  ref
) {
  const labelledBy = useBlockLabel(!!(rest['aria-label'] || rest['aria-labelledby'] || rest.id))
  return <input ref={ref} aria-labelledby={labelledBy} className={`${fieldCls} ${className ?? ''}`} {...rest} />
})

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

/** Standard dropdown, same geometry as Field. Native option lists on Windows ignore CSS — conda pickers use ThemedSelect. */
export function Select({ className, children, ...rest }: SelectProps): React.ReactElement {
  const labelledBy = useBlockLabel(!!(rest['aria-label'] || rest['aria-labelledby'] || rest.id))
  return (
    <select aria-labelledby={labelledBy} className={`${fieldCls} cursor-pointer ${className ?? ''}`} {...rest}>
      {children}
    </select>
  )
}
