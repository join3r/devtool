/**
 * What a shell command is for, in words: "Running tests", "Building". The
 * sidebar's Working row shows this instead of the raw command line, so you can
 * tell at a glance that an agent is testing rather than reading `cd … && npx
 * vitest run 2>&1 | tail -40`.
 *
 * Only the common toolchains are known. Anything else falls back to the
 * command itself (see agent-activity's `activityToolLabel`).
 */
export type CommandKind = 'test' | 'typecheck' | 'lint' | 'build' | 'install' | 'commit' | 'push'

export const COMMAND_KIND_LABELS: Record<CommandKind, string> = {
  test: 'Running tests',
  typecheck: 'Type-checking',
  lint: 'Linting',
  build: 'Building',
  install: 'Installing dependencies',
  commit: 'Committing',
  push: 'Pushing'
}

/** A package-manager script: `npm test`, `npm run test:unit`, `pnpm build`, `yarn lint`, `bun run typecheck`. */
const RUNNER = String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+|run-script\s+)?`

// Checked in order; the first kind that matches a segment wins.
const PATTERNS: Array<[CommandKind, RegExp]> = [
  ['test', new RegExp([
    `${RUNNER}t(?:est(?:[:\\w-]*))?(?=[\\s'"]|$)`,
    String.raw`\b(?:vitest|jest|mocha|ava|pytest|rspec|phpunit|ctest|tox|nox)\b`,
    String.raw`\bplaywright\s+test\b`,
    String.raw`\bnode\s+(?:[^|;&]*\s)?--test\b`,
    String.raw`\b(?:go|cargo|swift|dotnet|mix|deno|bun)\s+test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
    String.raw`\b(?:make|just|gradlew?|\.\/gradlew|mvnw?)\s+(?:[\w:-]+\s+)*(?:test|check|connectedCheck)\b`,
    String.raw`\bxcodebuild\b[^|;&]*\btest(?:-without-building)?\b`
  ].join('|')) ],
  ['typecheck', new RegExp([
    `${RUNNER}(?:typecheck|type-check|types|check-types|tsc)\\b`,
    String.raw`\btsc\b`,
    String.raw`\b(?:mypy|pyright|vue-tsc)\b`,
    String.raw`\bcargo\s+check\b`
  ].join('|')) ],
  ['lint', new RegExp([
    `${RUNNER}lint(?:[:\\w-]*)?\\b`,
    String.raw`\b(?:eslint|ruff|flake8|pylint|rubocop|golangci-lint|swiftlint|stylelint|biome)\b`,
    String.raw`\bcargo\s+clippy\b`
  ].join('|')) ],
  ['build', new RegExp([
    `${RUNNER}build(?:[:\\w-]*)?\\b`,
    String.raw`\b(?:cargo|go|swift|dotnet|docker|electron-vite|vite|next|gradlew?|\.\/gradlew)\s+build\b`,
    String.raw`\bxcodebuild\b`,
    String.raw`\bmvnw?\s+(?:[\w:-]+\s+)*(?:package|install|compile)\b`,
    String.raw`(?:^|\s)make(?:\s|$)`
  ].join('|')) ],
  ['install', new RegExp([
    String.raw`\b(?:npm|pnpm|bun)\s+(?:install|i|ci|add)\b`,
    String.raw`\byarn(?:\s+(?:install|add)\b|\s*$)`,
    String.raw`\b(?:pip3?|uv\s+pip|brew|gem|bundle|pod)\s+install\b`,
    String.raw`\b(?:uv|poetry)\s+(?:sync|install|add)\b`,
    String.raw`\b(?:cargo|go)\s+(?:add|get)\b`
  ].join('|')) ],
  ['commit', /\bgit\s+(?:-C\s+\S+\s+)?commit\b/],
  ['push', /\bgit\s+(?:-C\s+\S+\s+)?push\b/]
]

/** The command's pieces: split on `&&`, `||`, `;`, `|` and newlines, trimmed. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean)
}

/** Drop a leading `cd x &&`-style prefix and env assignments; what is left is the interesting part. */
function isNoise(segment: string): boolean {
  return /^(?:cd|pushd|export|source|\.|set|echo)\b/.test(segment)
}

export interface CommandClass {
  kind: CommandKind
  label: string
  /** The piece of the command that matched: `npm test` out of `cd app && npm test 2>&1 | tail`. */
  detail: string
}

/** What the command is for, or null when it is nothing this module knows. */
export function classifyCommand(command: string | undefined): CommandClass | null {
  if (!command) return null
  // Codex runs commands through a login shell: `/bin/zsh -lc 'npm test'`.
  const unwrapped = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(command)?.[2] ?? command
  const parts = segments(unwrapped).filter((s) => !isNoise(s))
  for (const [kind, pattern] of PATTERNS) {
    const hit = parts.find((part) => pattern.test(part))
    if (hit) return { kind, label: COMMAND_KIND_LABELS[kind], detail: hit.replace(/\s+\d*>{1,2}&?\S*/g, '').replace(/\s+/g, ' ') }
  }
  return null
}
