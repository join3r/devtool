/**
 * Settings → AI → Response style: how every agent DevTool starts writes its
 * answers. It is one app setting, not a project one. A desktop sends it to each
 * of its DevTool servers ({@link OUTPUT_STYLE_SET_CHANNEL}), so an agent on a
 * server writes the same way. It reaches the agent in the note DevTool already
 * gives it (`agent-context.ts`): Claude's SessionStart hook or a chat's appended
 * system prompt, Codex's developer instructions, Pi before every turn.
 */

export type OutputStyle = 'standard' | 'ste100'

export const OUTPUT_STYLES: readonly OutputStyle[] = ['standard', 'ste100']

export const OUTPUT_STYLE_LABEL: Record<OutputStyle, string> = {
  standard: 'Standard',
  ste100: 'ASD-STE100 (Simplified Technical English)'
}

/** A desktop → server call: the server keeps the desktop's style in its own config. */
export const OUTPUT_STYLE_SET_CHANNEL = 'output-style-set'

export function isOutputStyle(value: unknown): value is OutputStyle {
  return typeof value === 'string' && (OUTPUT_STYLES as readonly string[]).includes(value)
}

const STE100 = [
  'Response style: write all prose in ASD-STE100 Simplified Technical English. The user chose this in DevTool\'s settings; it holds for the whole session.',
  '- Use approved STE words, each with its one approved meaning, and use one word for one concept. Technical names (code identifiers, commands, file paths, product names) are allowed.',
  '- Procedural sentences: max 20 words. Descriptive sentences: max 25 words.',
  '- One instruction per sentence. Write instructions in the imperative.',
  '- Use the active voice. Do not use the passive voice in procedures.',
  '- Use only simple tenses: present, past, future. Do not use -ing verb forms, except in technical names.',
  '- Do not omit articles ("the", "a") or other short words to make sentences shorter.',
  '- Max 6 sentences per paragraph, one topic per paragraph. Use vertical lists for sequences and for complex text.',
  '- Put a condition first, then the instruction ("If X, do Y").',
  '- Start a warning or a caution with a short command that tells what to do.',
  'Code blocks, commands, file paths, quoted text and tool input are exempt. Write commit messages and code comments in STE too.'
].join('\n')

/** The note for `style`, or null when the agent keeps its own way of writing. */
export function outputStyleNote(style: OutputStyle | undefined): string | null {
  return style === 'ste100' ? STE100 : null
}
