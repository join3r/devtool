import { createContext, useContext } from 'react'

/**
 * The id of the visible label a SetBlock draws, so the Field, Select or SegCtl
 * inside it is named by that label (not by its placeholder).
 */
export const BlockLabelContext = createContext<string | undefined>(undefined)

/** `aria-labelledby` for a control: the block's label, unless the control is named some other way. */
export function useBlockLabel(named: boolean): string | undefined {
  const id = useContext(BlockLabelContext)
  return named ? undefined : id
}
