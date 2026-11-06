import { describe, expect, it } from 'vitest'
import { bypassAllows, type ChatEvent } from '../src/shared/claude-chat'

describe('bypassAllows', () => {
  it('allows permission asks only in Bypass', () => {
    expect(bypassAllows('bypassPermissions', 'Bash')).toBe(true)
    expect(bypassAllows('auto', 'Bash')).toBe(false)
    expect(bypassAllows('default', 'Bash')).toBe(false)
    expect(bypassAllows(undefined, 'Bash')).toBe(false)
  })

  it('still asks questions and plans in Bypass', () => {
    expect(bypassAllows('bypassPermissions', 'AskUserQuestion')).toBe(false)
    expect(bypassAllows('bypassPermissions', 'ExitPlanMode')).toBe(false)
  })
})

describe('ChatSession in Bypass', () => {
  async function makeSession() {
    const { ChatSession } = await import('../src/main/claude-chat/chat-session')
    const events: ChatEvent[] = []
    const session = new ChatSession({
      cwd: '/tmp',
      sessionId: 's',
      resume: false,
      executable: 'claude',
      env: {},
      onEvent: (event) => { events.push(event) },
      onHook: () => {},
      onPromptResolved: () => {},
      onExit: () => {},
      log: () => {}
    })
    type Can = (tool: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ behavior: string }>
    const internals = session as unknown as {
      canUseTool: Can
      noteMode(message: Record<string, unknown>): void
      held: Map<string, unknown>
      query: { setPermissionMode(mode: string): Promise<void> } | null
    }
    const ask = (tool: string, id: string) => internals.canUseTool(tool, { command: 'cd x && echo > y' }, {
      requestId: id,
      toolUseID: `tu-${id}`,
      signal: new AbortController().signal,
      decisionReason: 'Compound command contains cd with output redirection'
    })
    return { session, internals, events, ask }
  }

  it("answers the CLI's own asks without a card once the CLI reports Bypass", async () => {
    const { internals, events, ask } = await makeSession()
    internals.noteMode({ type: 'system', subtype: 'status', permissionMode: 'bypassPermissions' })
    await expect(ask('Bash', 'p1')).resolves.toMatchObject({ behavior: 'allow' })
    expect(events.some((e) => e.t === 'prompt')).toBe(false)
  })

  it('shows a card in Auto, and allows it when the tab switches to Bypass', async () => {
    const { session, internals, events, ask } = await makeSession()
    internals.noteMode({ type: 'system', subtype: 'init', permissionMode: 'auto' })
    const bash = ask('Bash', 'p1')
    void ask('AskUserQuestion', 'p2')
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(2)

    internals.query = { setPermissionMode: async () => {} }
    await session.setPermissionMode('bypassPermissions')
    await expect(bash).resolves.toMatchObject({ behavior: 'allow' })
    // The question still waits for the user.
    expect([...internals.held.keys()]).toEqual(['p2'])
  })

  it('keeps asking when the CLI refuses Bypass', async () => {
    const { session, internals, events, ask } = await makeSession()
    internals.noteMode({ type: 'system', subtype: 'init', permissionMode: 'default' })
    void ask('Bash', 'p1')
    internals.query = { setPermissionMode: async () => { throw new Error('bypass disabled by policy') } }
    await expect(session.setPermissionMode('bypassPermissions')).rejects.toThrow()
    expect([...internals.held.keys()]).toEqual(['p1'])
    void ask('Bash', 'p2')
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(2)
  })

  it('does not trust a mode the CLI has not reported', async () => {
    const { events, ask } = await makeSession()
    void ask('Bash', 'p1')
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(1)
  })
})
