import { BrowserContext, Frame, expect, test } from '@playwright/test'
import {
  Session,
  closeSessions,
  createClass,
  enterRoom,
  inPeer,
  joinClass,
  openStation,
  reloadStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'
import { LIGHTS_SERVER } from '../../lib/fake-lights'
import {
  FakeElgato,
  LightsServer,
  lightsServerUnavailable,
  startFakeElgato,
  startLightsServer,
} from '../../lib/lights-server'

/**
 * station-lights-module against its real server (station-lights-server), with
 * a fake Elgato light behind it. Checks the server's heartbeat logic, which
 * the in-browser FakeLightServer does not model.
 */

const MODULE = 'station-lights-module'
// the fake Elgato listens here; server.js adds the port
const LIGHT_IP = '127.0.0.1'
const SYNC = 15_000
// server.js: a station is inactive after 15 s without heartbeat, checked every 10 s
const HEARTBEAT_TIMEOUT = 15_000
const SWEEP = 10_000

let elgato: FakeElgato
let server: LightsServer

// The station reaches the real server; a student's machine has none.
const prepareStation = async (context: BrowserContext) => {
  await serveModules(context)
  await server.route(context)
}
const prepareStudent = async (context: BrowserContext) => {
  await serveModules(context)
  await context.route(`${LIGHTS_SERVER}/**`, (route) => route.abort('connectionrefused'))
}

async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect.poll(() => frame.evaluate(() => (window as any).Edrys?.ready).catch(() => false), { timeout: 30_000 }).toBe(true)
  return frame
}

const roomOf = (s: Session) =>
  inPeer<string | null>(s.page, `const u = p.user(); return u ? (typeof u.get === 'function' ? u.get('room') : u.room) : null`)

/** Heartbeats sent to the server so far (only the station loads the module). */
const heartbeats = () => server.requests.filter((p) => p === '/api/heartbeat').length

test.describe('station-lights-module with the real server', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined

  test.beforeEach(async ({ browser }) => {
    const unavailable = await lightsServerUnavailable()
    test.skip(!!unavailable, unavailable || '')

    elgato = await startFakeElgato()
    server = await startLightsServer()

    const created = await createClass(browser, prepareStation)
    teacher = created.teacher
    await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig: { lightIp: LIGHT_IP } }])
    station = await openStation(teacher, created.classUrl)
    student = await joinClass(browser, created.classUrl, prepareStudent)
  })

  test.afterEach(async ({}, testInfo) => {
    if (server && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('server log', { body: server.log(), contentType: 'text/plain' })
    }
    await closeSessions(teacher, student)
    await server?.stop()
    await elgato?.stop()
    teacher = station = student = undefined
  })

  test('after a station reload, the light stays on while a student is in the station', async () => {
    await ready(station!)
    const room = await stationRoom(station!)
    await enterRoom(student!, room)
    await expect.poll(() => elgato.on, { timeout: SYNC }).toBe(true)

    // Reload right after a heartbeat (which now carries "on"), so the student is back before the
    // old instance times out.
    const beats = heartbeats()
    await expect.poll(heartbeats, { timeout: SWEEP + 5_000 }).toBeGreaterThan(beats)
    const before = elgato.puts.length
    await reloadStation(station!)
    await ready(station!)
    // edrys-Lite usually moves the student to the Lobby while the station's room is gone
    if ((await roomOf(student!)) !== room) await enterRoom(student!, room)
    // the reloaded station switches the light on again (after an "off" on load if the student was moved out)
    await expect.poll(() => elgato.puts.slice(before).at(-1)?.on, { timeout: SYNC }).toBe(1)
    const lit = elgato.puts.length

    // "Stays on" can only be checked by waiting out the server's timeout and sweep.
    await station!.page.waitForTimeout(HEARTBEAT_TIMEOUT + SWEEP + 2_000)
    expect(elgato.puts.slice(lit)).toEqual([])
    expect(elgato.on).toBe(true)
  })
})

test.describe('station-lights server input checks', () => {
  test.beforeEach(async () => {
    const unavailable = await lightsServerUnavailable()
    test.skip(!!unavailable, unavailable || '')
    elgato = await startFakeElgato()
    server = await startLightsServer()
  })

  test.afterEach(async () => {
    await server?.stop()
    await elgato?.stop()
  })

  test('rejects anything but an IP address, and CORS requests from other origins', async () => {
    const post = (path: string, body: object, origin = 'http://e2e-module.test') =>
      fetch(`http://127.0.0.1:3000${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(body),
      })

    for (const ip of ['127.0.0.1:8080/admin?', 'example.com', 'localhost', '']) {
      expect((await post('/api/light', { on: 1, ip })).status, ip).toBe(400)
      expect((await post('/api/heartbeat', { stationId: 's', lightIp: ip, lightState: true })).status, ip).toBe(400)
    }
    expect((await fetch(`http://127.0.0.1:3000/api/light?ip=${encodeURIComponent('127.0.0.1:9123/x#')}`)).status).toBe(400)
    expect(elgato.puts).toEqual([])

    // an allowed origin gets the CORS header, another page does not (its browser blocks the answer)
    const allowed = await post('/api/light', { on: 1, ip: LIGHT_IP })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://e2e-module.test')
    const other = await post('/api/light', { on: 0, ip: LIGHT_IP }, 'https://evil.example')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})
