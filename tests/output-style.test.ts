import { describe, expect, it } from 'vitest'
import { isOutputStyle, outputStyleNote } from '../src/shared/output-style'

describe('outputStyleNote', () => {
  it('tells the agent the STE rules for ste100 and nothing for standard', () => {
    expect(outputStyleNote('standard')).toBeNull()
    expect(outputStyleNote(undefined)).toBeNull()
    const note = outputStyleNote('ste100')!
    expect(note).toContain('ASD-STE100')
    expect(note).toContain('max 20 words')
  })

  it('knows only the two styles', () => {
    expect(isOutputStyle('ste100')).toBe(true)
    expect(isOutputStyle('standard')).toBe(true)
    expect(isOutputStyle('pirate')).toBe(false)
    expect(isOutputStyle(undefined)).toBe(false)
  })
})
