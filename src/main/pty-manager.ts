import * as pty from 'node-pty'
import type { CondaEnvInfo } from '../shared/conda'
import { getShellEnv } from './shell-env'

interface PtyInstance {
  process: pty.IPty
  projectDir: string
}

interface PtySpawnCallbacks {
  onData?: (data: string) => void
  onExit?: (exitCode: number) => void
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()

  spawn(
    id: string,
    shell: string,
    cwd: string,
    cols: number,
    rows: number,
    args?: string[],
    extraEnv?: Record<string, string>,
    callbacks?: PtySpawnCallbacks,
    condaEnv?: CondaEnvInfo | null
  ): void {
    if (this.instances.has(id)) {
      this.kill(id)
    }
    const proc = pty.spawn(shell, args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...getShellEnv({}, { condaEnv }), COLORTERM: 'truecolor', ...extraEnv }
    })
    if (callbacks?.onData) {
      proc.onData(callbacks.onData)
    }
    if (callbacks?.onExit) {
      proc.onExit(({ exitCode }) => callbacks.onExit?.(exitCode))
    }
    this.instances.set(id, { process: proc, projectDir: cwd })
  }

  write(id: string, data: string): void {
    this.instances.get(id)?.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.instances.get(id)?.process.resize(cols, rows)
    } catch {
      // Process already exited, fd is closed — ignore
    }
  }

  /** Stops reading the PTY: once the kernel buffer fills, the program blocks on its writes. */
  pause(id: string): void {
    try {
      this.instances.get(id)?.process.pause()
    } catch {
      // Already exited.
    }
  }

  resume(id: string): void {
    try {
      this.instances.get(id)?.process.resume()
    } catch {
      // Already exited.
    }
  }

  onData(id: string, callback: (data: string) => void): void {
    this.instances.get(id)?.process.onData(callback)
  }

  onExit(id: string, callback: (exitCode: number) => void): void {
    this.instances.get(id)?.process.onExit(({ exitCode }) => callback(exitCode))
  }

  /** The root pid of every live PTY, by id (the tab's, for tabs). */
  pids(): Map<string, number> {
    const pids = new Map<string, number>()
    for (const [id, instance] of this.instances) {
      if (instance.process.pid > 0) pids.set(id, instance.process.pid)
    }
    return pids
  }

  kill(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.process.kill()
      this.instances.delete(id)
    }
  }

  killAll(): void {
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }
}
