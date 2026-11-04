import { describe, it, expect } from 'vitest'
import { classifyCommand } from '../src/shared/command-kind'
import { activityToolLabel, reduceAgentActivity, describeActivity } from '../src/shared/agent-activity'

const kind = (command: string): string | undefined => classifyCommand(command)?.kind

describe('classifyCommand', () => {
  it('knows test runners', () => {
    for (const c of [
      'npm test', 'npm t', 'npm run test:unit', 'pnpm test -- --watch=false', 'yarn test', 'bun test',
      'npx vitest run tests/a.test.ts', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test',
      'swift test', 'npx playwright test', 'node --test', 'make test', './gradlew connectedCheck',
      'xcodebuild -scheme App test -destination "platform=iOS Simulator"'
    ]) expect(kind(c), c).toBe('test')
  })

  it('knows checks, builds and installs', () => {
    expect(kind('npm run typecheck')).toBe('typecheck')
    expect(kind('npx tsc --noEmit')).toBe('typecheck')
    expect(kind('npm run lint')).toBe('lint')
    expect(kind('npx eslint src')).toBe('lint')
    expect(kind('npm run build:mac')).toBe('build')
    expect(kind('xcodebuild -scheme App archive')).toBe('build')
    expect(kind('cargo build --release')).toBe('build')
    expect(kind('npm ci')).toBe('install')
    expect(kind('pip install -r requirements.txt')).toBe('install')
    expect(kind('git commit -m "x"')).toBe('commit')
    expect(kind('git push origin main')).toBe('push')
  })

  it('finds the interesting part of a compound command', () => {
    expect(classifyCommand('cd /repo/app && npm test 2>&1 | tail -40')).toMatchObject({ kind: 'test', detail: 'npm test' })
    // Tests win over the type-check run before them.
    expect(kind('npm run typecheck && npm test')).toBe('test')
    expect(kind('/bin/zsh -lc \'npm test\'')).toBe('test')
  })

  it('leaves everything else alone', () => {
    for (const c of ['ls -la', 'git status', 'cat package.json', 'grep -rn test src', 'echo npm test', 'npm run dev', 'rg testing']) {
      expect(kind(c), c).toBeUndefined()
    }
    expect(classifyCommand(undefined)).toBeNull()
  })
})

describe('activityToolLabel', () => {
  it('says what a shell command is for', () => {
    expect(activityToolLabel('Bash', { command: 'cd app && npx vitest run 2>&1 | tail' })).toBe('Running tests · npx vitest run')
    expect(activityToolLabel('Bash', { command: 'ls' })).toBe('Bash · ls')
    expect(activityToolLabel('Edit', { file_path: '/a/b.ts' })).toBe('Editing b.ts')
  })

  it('feeds the sidebar line, while permission prompts keep the raw command', () => {
    const turn = reduceAgentActivity(undefined, { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 1).activity
    const running = reduceAgentActivity(turn, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }, 2).activity
    expect(describeActivity(running, 'working')).toBe('Running tests · npm test')
    const asking = reduceAgentActivity(running, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }, 3).activity
    expect(describeActivity(asking, 'attention')).toBe('Permission: Bash · npm test')
  })
})
