import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { Server } from 'http'
import { Socket } from 'net'
import { join, resolve } from 'path'
import { IClient, PeerServer } from 'peer'
import { MODULES_DIR } from './modules'
import { freePort } from './pyxterm-server'

/**
 * The real servers behind `Edrys.sendStream` / `Edrys.onStream`, for the few
 * tests that check the module against them instead of the fakes
 * (fake-peerjs.ts, fake-ws-relay.ts). Both run on 127.0.0.1 and a free port.
 *
 *   const peer = await startPeerServer()   // the `peer` npm package, in this process
 *   stationConfig: { peerServerConfig: peer.config }
 *
 *   const relay = await startStreamRelay() // websocket-server checkout, as a child process
 *   stationConfig: { streamMethod: 'websocket', websocketUrl: relay.url }
 *   relay.log()                            // what the relay printed
 *
 * The relay is `$STREAM_RELAY_DIR`, else `websocket-server` next to the
 * Edrys_Modules folder; specs skip its tests when `streamRelayAvailable()` is
 * false (checkout missing or `npm install` not run).
 */

// ---------------------------------------------------------------------------
// PeerJS server

export interface PeerJSServer {
  port: number
  /** The module's `peerServerConfig`. */
  config: { host: string; port: number; path: string; secure: boolean }
  /** Ids of the peers connected right now. */
  ids(): string[]
  stop(): Promise<void>
}

export async function startPeerServer(): Promise<PeerJSServer> {
  const port = await freePort()
  const ids = new Set<string>()
  const sockets = new Set<Socket>()
  const server = await new Promise<Server>((done) => {
    const app = PeerServer({ host: '127.0.0.1', port, path: '/' }, (s) => done(s as Server))
    app.on('connection', (client: IClient) => ids.add(client.getId()))
    app.on('disconnect', (client: IClient) => ids.delete(client.getId()))
  })
  // WebSockets are not closed by server.close(); end them so stop() returns
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return {
    port,
    config: { host: '127.0.0.1', port, path: '/', secure: false },
    ids: () => [...ids],
    stop: () =>
      new Promise<void>((done) => {
        sockets.forEach((s) => s.destroy())
        server.close(() => done())
      }),
  }
}

// ---------------------------------------------------------------------------
// WebSocket stream relay

const RELAY_DIR = resolve(process.env.STREAM_RELAY_DIR || join(MODULES_DIR, '..', 'websocket-server'))

/** Whether the relay can run here: the checkout exists with its dependencies installed. */
export function streamRelayAvailable(): boolean {
  return existsSync(join(RELAY_DIR, 'src', 'server.js')) && existsSync(join(RELAY_DIR, 'node_modules'))
}

export interface StreamRelay {
  port: number
  /** The module's `websocketUrl`. */
  url: string
  log(): string
  stop(): Promise<void>
}

export async function startStreamRelay(): Promise<StreamRelay> {
  const port = await freePort()
  let output = ''
  const child: ChildProcess = spawn(process.execPath, ['src/server.js', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: RELAY_DIR,
    env: { ...process.env, NO_COLOR: '1' },
  })
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))

  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`stream relay exited (${child.exitCode}):\n${output}`)
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      break // any HTTP answer: it listens
    } catch {}
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`stream relay did not answer on port ${port}:\n${output}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  return {
    port,
    url: `ws://127.0.0.1:${port}/stream`,
    log: () => output,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGKILL')
      await new Promise((r) => child.once('exit', r))
    },
  }
}
