import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * WCAG contrast of the desk theme's colour tokens, read from styles.css. This is
 * a source-token check (it does not render anything): it keeps a token edit
 * from quietly dropping text below AA on any surface it is drawn on.
 */
const css = readFileSync(join(__dirname, '../src/renderer/styles.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(start, css.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2]
  return out
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3', 'field', 'row-hover', 'row-sel']
const TEXT = ['text', 'text-muted', 'text-subtle', 'body', 'danger', 'warn', 'info', 'success', 'needs', 'answered', 'running', 'crashed', 'status-attention']

describe.each([
  ['dark', '.layout-desk:not(.theme-light)'],
  ['light', '.layout-desk.theme-light']
])('%s theme tokens', (_name, selector) => {
  const t = block(selector)

  it.each(TEXT)('--color-%s reads at 4.5:1 or more on every surface', (fg) => {
    for (const bg of SURFACES) {
      expect(t[fg], `missing --color-${fg}`).toBeDefined()
      expect(ratio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('draws focus rings and field/switch outlines at 3:1 or more', () => {
    for (const bg of ['bg', 'surface', 'surface-2', 'field']) {
      expect(ratio(t['border-focus'], t[bg]), `focus on ${bg}`).toBeGreaterThanOrEqual(3)
      expect(ratio(t.control, t[bg]), `control outline on ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps button labels readable on filled buttons', () => {
    expect(ratio(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(t['danger-ink'], t.danger)).toBeGreaterThanOrEqual(4.5)
  })
})
