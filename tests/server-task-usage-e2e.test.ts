import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RelayServer } from '../relay/src/server.ts'
import { DesktopRouting } from '../src/main/servers/desktop-routing'
import type { MachineUsage } from '../src/shared/task-usage'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

/**
 * A server samples its own tabs and its desktop shows them: a server terminal
 * that keeps a core busy reaches the desktop's usage, named as the server is.
 */
describe.skipIf(process.platform === 'win32')('a server\'s task usage on its desktop (real relay)', () => {
  let relay: RelayServer | undefined
  let server: TestServer | undefined
  let desktop: TestDesktop | undefined
  const dirs: string[] = []

  afterAll(async () => {
    desktop?.close()
    await server?.close()
    await relay?.close()
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pushes a busy server tab\'s CPU to the desktop', { timeout: 60_000 }, async () => {
    ;({ relay } = await startTestRelay())
    server = await startTestServer(relay.url)
    desktop = startTestDesktop(relay.url)
    await pairByCode(desktop, server)

    const seen: Array<{ serverId: string; label: string; usage: MachineUsage | null }> = []
    const routing = new DesktopRouting({ configDir: desktop.dir, windows: { send: () => {}, broadcast: () => {} }, log: () => {} })
    routing.attachHost({
      getProjectsData: () => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }),
      onProjectsChanged: () => () => {},
      taskUsage: { setForeign: (serverId, label, usage) => { seen.push({ serverId, label, usage }) } }
    })
    routing.attachHub(desktop.hub)

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-usage-e2e-'))
    dirs.push(cwd)
    // A shell loop rather than `yes`: macOS hides nothing of /bin/sh's tree from the parent walk.
    await desktop.hub.call(server.id, 'win:1', 'pty-spawn', ['burn', '/bin/sh', cwd, 80, 24, ['-c', 'while :; do :; done'], {}, undefined, undefined])

    const serverId = server.id
    await waitFor(() => seen.some(s => s.serverId === serverId && (s.usage?.tabs.burn?.cpu ?? 0) >= 40), 'the busy tab\'s CPU on the desktop', 30_000)
    const last = seen.filter(s => s.serverId === serverId && s.usage?.tabs.burn).at(-1)!
    expect(last.label).not.toBe('')
    expect(last.usage!.cores).toBe(os.cpus().length)
    expect(last.usage!.tabs.burn.procs).toBeGreaterThanOrEqual(1)
    expect(last.usage!.tabs.burn.rss).toBeGreaterThan(0)

    await desktop.hub.call(server.id, 'win:1', 'pty-kill', ['burn'])
  })
})
