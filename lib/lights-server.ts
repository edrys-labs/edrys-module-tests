import { BrowserContext } from '@playwright/test'
import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { IncomingMessage, Server, createServer } from 'http'
import { join } from 'path'
import { MODULES_DIR, MODULE_ORIGIN } from './modules'
import { LIGHTS_SERVER } from './fake-lights'

/**
 * The real station-lights server (station-lights-module/station-lights-server),
 * started from the local checkout, with a fake Elgato Key Light behind it. For
 * the tests that check the server's own logic (heartbeat timeouts), which the
 * in-browser FakeLightServer does not model.
 *
 *   const elgato = await startFakeElgato()  // 127.0.0.1:9123, use '127.0.0.1' as lightIp
 *   const server = await startLightsServer()
 *   await server.route(context)             // module requests to localhost:3000 go to it
 *   elgato.on, elgato.puts                  // the light's state, every PUT body it got
 *   server.log()
 *   await server.stop(); await elgato.stop()
 *
 * The server's port (3000) and the light's port (9123) are fixed in server.js,
 * so specs skip themselves when they are taken or the server's node_modules
 * are missing (`lightsServerAvailable()`).
 */

const CHECKOUT = join(MODULES_DIR, 'station-lights-module', 'station-lights-server')
const SERVER_PORT = 3000
const ELGATO_PORT = 9123

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, () => s.close(() => resolve(true)))
  })
}

/** Why the real server cannot run here, or null when it can. */
export async function lightsServerUnavailable(): Promise<string | null> {
  if (!existsSync(join(CHECKOUT, 'node_modules', 'express'))) return `run npm install in ${CHECKOUT}`
  if (!(await portFree(SERVER_PORT))) return `port ${SERVER_PORT} is in use`
  if (!(await portFree(ELGATO_PORT))) return `port ${ELGATO_PORT} is in use`
  return null
}

export interface FakeElgato {
  /** Whether the light is on right now. */
  on: boolean
  /** Every `lights[0]` the server PUT, in order. */
  puts: { on: number; brightness: number; temperature: number }[]
  stop(): Promise<void>
}

async function body(req: IncomingMessage): Promise<any> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : null
}

export async function startFakeElgato(): Promise<FakeElgato> {
  const light: FakeElgato = { on: false, puts: [], stop: async () => {} }
  const server: Server = createServer(async (req, res) => {
    if (req.url !== '/elgato/lights') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'PUT') {
      const state = (await body(req)).lights[0]
      light.puts.push(state)
      light.on = !!state.on
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ numberOfLights: 1, lights: [{ on: light.on ? 1 : 0, brightness: 50, temperature: 213 }] }))
  })
  await new Promise<void>((resolve) => server.listen(ELGATO_PORT, '127.0.0.1', resolve))
  light.stop = () => new Promise((resolve) => server.close(() => resolve()))
  return light
}

export interface LightsServer {
  log(): string
  /** Paths of the requests forwarded by route(), in order (e.g. '/api/heartbeat'). */
  requests: string[]
  /** Send the context's requests to localhost:3000 to this server (from the test process, not the browser). */
  route(context: BrowserContext): Promise<void>
  stop(): Promise<void>
}

export async function startLightsServer(): Promise<LightsServer> {
  let output = ''
  const child: ChildProcess = spawn(process.execPath, ['server.js'], {
    cwd: CHECKOUT,
    // the server only answers CORS requests from the listed origins
    env: { ...process.env, ALLOWED_ORIGINS: MODULE_ORIGIN },
  })
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))

  const deadline = Date.now() + 15_000
  while (!output.includes('running')) {
    if (child.exitCode !== null) throw new Error(`station-lights server exited (${child.exitCode}):\n${output}`)
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`station-lights server did not start:\n${output}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  const requests: string[] = []
  return {
    log: () => output,
    requests,
    // Forwarded by Playwright rather than sent by the browser, so the test does not
    // depend on the browser's rules for a public origin calling localhost.
    route: (context) =>
      context.route(`${LIGHTS_SERVER}/**`, async (route) => {
        if (route.request().method() !== 'OPTIONS') requests.push(new URL(route.request().url()).pathname)
        const url = route.request().url().replace(LIGHTS_SERVER, `http://127.0.0.1:${SERVER_PORT}`)
        await route.fulfill({ response: await route.fetch({ url }) })
      }),
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      await exited
    },
  }
}
