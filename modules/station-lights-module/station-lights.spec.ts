import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import {
  ModuleEntry,
  Session,
  closeSessions,
  createClass,
  enterRoom,
  joinClass,
  openStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'
import { FakeLightServer } from '../../lib/fake-lights'

/**
 * station-lights-module in a real edrys-Lite: a station that switches an
 * Elgato light through its local light server (faked), and students who enter
 * and leave the station's room.
 */

const MODULE = 'station-lights-module'
const LIGHT_IP = '10.0.0.42'
// time for a change to travel between peers (the module also polls every 2 s)
const SYNC = 15_000

let lights: FakeLightServer

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await lights.install(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once Edrys.onReady has run (the module renders nothing new then). */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect.poll(() => frame.evaluate(() => (window as any).Edrys?.ready).catch(() => false), { timeout: 30_000 }).toBe(true)
  return frame
}

const users = (frame: Frame) => frame.locator('#users-num')
const light = (frame: Frame) => frame.locator('#light-status')

/** Reconfigure the module and wait until the station runs it with the new settings. */
async function reconfigure(teacher: Session, station: Session, entry: Omit<ModuleEntry, 'url'>) {
  const old = await moduleFrame(station, MODULE)
  await setModules(teacher, [{ url: moduleUrl(MODULE), ...entry }])
  await expect.poll(() => old.isDetached(), { timeout: 30_000 }).toBe(true)
  lights.requests = []
  return ready(station)
}

/** A student who opens the class link (still in the lobby). */
const addStudent = (browser: Browser, classUrl: string) => joinClass(browser, classUrl, prepare)

// ---------------------------------------------------------------------------

test.describe('station-lights-module', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    lights = new FakeLightServer()
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig: { lightIp: LIGHT_IP } }])

    station = await openStation(teacher, classUrl)
    student = await addStudent(browser, classUrl)
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('the light goes on with the first student in the station and off when the last one leaves', async ({
    browser,
  }) => {
    const st = await ready(station!)
    const room = await stationRoom(station!)

    // Empty station: nobody counted, the light is switched off once on load, heartbeats report "off".
    await expect(users(st)).toHaveText('0')
    await expect(light(st)).toHaveText('off')
    await expect(st.locator('#message')).toBeHidden()
    await expect
      .poll(() => lights.lights(station!.page))
      .toEqual([{ on: 0, brightness: 50, temperature: 213, ip: LIGHT_IP }])
    await expect.poll(() => lights.heartbeats(station!.page).length, { timeout: SYNC }).toBeGreaterThan(0)
    const beat = lights.heartbeats(station!.page)[0]
    expect(beat).toMatchObject({ lightIp: LIGHT_IP, lightState: false })
    expect(beat.stationId).toContain(room)

    const second = await addStudent(browser, classUrl)
    try {
      await enterRoom(student!, room)
      await expect(users(st)).toHaveText('1', { timeout: SYNC })
      await expect(light(st)).toHaveText('on')
      await expect
        .poll(() => lights.lights(station!.page).at(-1))
        .toEqual({ on: 1, brightness: 50, temperature: 213, ip: LIGHT_IP })

      // A second student does not switch again, and the light stays on while one is left.
      await enterRoom(second, room)
      await expect(users(st)).toHaveText('2', { timeout: SYNC })
      await enterRoom(student!, 'Lobby')
      await expect(users(st)).toHaveText('1', { timeout: SYNC })
      await expect(light(st)).toHaveText('on')
      expect(lights.lights(station!.page).map((b) => b.on)).toEqual([0, 1])

      await enterRoom(second, 'Lobby')
      await expect(users(st)).toHaveText('0', { timeout: SYNC })
      await expect(light(st)).toHaveText('off')
      await expect.poll(() => lights.lights(station!.page).map((b) => b.on)).toEqual([0, 1, 0])
    } finally {
      await closeSessions(second)
    }
  })

  test("a student in another station does not switch this station's light on", async () => {
    const other = await openStation(teacher!, classUrl)
    const st = await ready(station!)
    const ot = await ready(other)
    expect(await stationRoom(other)).not.toBe(await stationRoom(station!))

    await enterRoom(student!, await stationRoom(station!))
    await expect(users(st)).toHaveText('1', { timeout: SYNC })
    await expect(light(st)).toHaveText('on')

    // "Stays off" can only be checked by waiting: give the other station a few presence updates and retries.
    await other.page.waitForTimeout(6_000)
    expect(lights.lights(other.page).map((b) => b.on)).toEqual([0])
    await expect(users(ot)).toHaveText('0')
    await expect(light(ot)).toHaveText('off')
  })

  test('only the station talks to the light server; students in its room do not', async () => {
    // The module's own show-in is "station, station-only"; a teacher may widen it to everyone in the station.
    const st = await reconfigure(teacher!, station!, { stationConfig: { lightIp: LIGHT_IP }, showInCustom: 'station' })
    await enterRoom(student!, await stationRoom(station!))
    const stu = await ready(student!)
    await expect(light(st)).toHaveText('on', { timeout: SYNC })
    await expect(users(stu)).toHaveText('1', { timeout: SYNC })
    await expect(light(stu)).toHaveText('station only')
    await expect(stu.locator('#message')).toHaveText('Only the station switches the light.')

    // The student's browser would post to localhost:3000 on the student's own machine.
    expect(lights.from(student!.page)).toEqual([])
    // The teacher (in the Lobby) does not load the module at all.
    expect(lights.from(teacher!.page)).toEqual([])
  })

  test('when the light server is down, the station says so and catches up once it is back', async () => {
    const st = await ready(station!)
    await expect(light(st)).toHaveText('off')
    lights.down = true

    await enterRoom(student!, await stationRoom(station!))
    await expect(users(st)).toHaveText('1', { timeout: SYNC })
    await expect(light(st)).toHaveText('error')
    await expect(st.locator('#message')).toContainText('the light server at http://localhost:3000 failed')

    lights.down = false
    // the next retry (every 5 s) switches the light on after all
    await expect.poll(() => lights.lights(station!.page).at(-1)?.on, { timeout: SYNC }).toBe(1)
    await expect(light(st)).toHaveText('on')
    await expect(st.locator('#message')).toBeHidden()
  })

  test('without a lightIp, the station says what to configure and sends nothing', async () => {
    const st = await reconfigure(teacher!, station!, { stationConfig: {} })
    await expect(light(st)).toHaveText('not configured')
    await expect(st.locator('#message')).toContainText('Set lightIp')
    // no switch on load and no heartbeat (sent right after onReady)
    expect(lights.from(station!.page)).toEqual([])
  })
})
