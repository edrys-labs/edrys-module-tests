import { ChildProcess, spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { MODULES_DIR } from './modules'

/**
 * The real pyxtermjs terminal server (Flask + Socket.IO), started from the
 * local module-pyxtermjs checkout. The one exception to "servers are faked":
 * it is for the few tests that check the server itself and the real
 * Socket.IO client against it. Specs skip themselves when no Python with the
 * server's requirements is found (`pyxtermServerAvailable()`).
 *
 *   const server = await startPyxtermServer()
 *   server.url        // http://127.0.0.1:<port>/pty, the module's `server` config
 *   server.log()      // everything the server printed
 *   await server.stop()
 *
 * The shell is a plain `bash --norc --noprofile` with a fixed prompt, so its
 * output is predictable. Python: $PYXTERM_PYTHON, else the checkout's
 * venv/bin/python, else python3.
 */

const CHECKOUT = join(MODULES_DIR, 'module-pyxtermjs')

export function python(): string {
  if (process.env.PYXTERM_PYTHON) return process.env.PYXTERM_PYTHON
  const venv = join(CHECKOUT, 'venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

/** Whether the server can run here: the checkout exists and Python has its requirements. */
export function pyxtermServerAvailable(): boolean {
  if (!existsSync(join(CHECKOUT, 'pyxtermjs', 'app.py'))) return false
  const check = spawnSync(python(), ['-c', 'import flask, flask_socketio, flask_cors'], { cwd: CHECKOUT })
  return check.status === 0
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      server.close(() => resolve(port))
    })
  })
}

export interface PyxtermServer {
  port: number
  /** Socket.IO namespace URL, as the module's `server` config wants it. */
  url: string
  /** Handshake URL of the Engine.IO polling transport, for requests from the test itself. */
  handshake: string
  log(): string
  stop(): Promise<void>
}

export async function startPyxtermServer(): Promise<PyxtermServer> {
  const port = await freePort()
  let output = ''
  const child: ChildProcess = spawn(
    python(),
    ['-m', 'pyxtermjs', '--port', String(port), '--command', 'bash', '--cmd-args', '--norc --noprofile'],
    {
      cwd: CHECKOUT,
      // own process group, so stop() also ends the shells the server forked
      detached: true,
      env: {
        ...process.env,
        PS1: '$ ',
        TERM: 'xterm-256color',
        // the server only accepts Socket.IO from the listed origins (and its own pages)
        PYXTERM_ORIGINS: 'http://e2e-module.test',
      },
    }
  )
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))

  const handshake = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`pyxtermjs server exited (${child.exitCode}):\n${output}`)
    try {
      if ((await fetch(handshake)).ok) break
    } catch {}
    if (Date.now() > deadline) {
      kill(child)
      throw new Error(`pyxtermjs server did not answer on port ${port}:\n${output}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/pty`,
    handshake,
    log: () => output,
    stop: async () => {
      kill(child)
      if (child.exitCode === null) await new Promise((r) => child.once('exit', r))
    },
  }
}

function kill(child: ChildProcess) {
  try {
    process.kill(-child.pid!, 'SIGKILL')
  } catch {}
}
