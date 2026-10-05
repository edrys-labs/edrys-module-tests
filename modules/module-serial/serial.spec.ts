import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import {
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
import { installFakeSerial, serial } from '../../lib/fake-serial'

/**
 * module-serial in a real edrys-Lite: a station with a fake serial device,
 * and students in the station's room.
 */

const MODULE = 'module-serial'
// Not in the module's dropdown, so this also covers adding an off-list rate.
const BAUD = 74880
// time for a change to travel between peers
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await installFakeSerial(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once onReady has rendered the status badge. */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect(frame.locator('#badge')).not.toHaveText('loading…', { timeout: 30_000 })
  return frame
}

const badge = (frame: Frame) => frame.locator('#badge')

/** Terminal content as lines, trailing whitespace trimmed. */
function lines(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const buffer = (window as any).term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i).translateToString(true))
    return out
  })
}

const text = async (frame: Frame) => (await lines(frame)).join('\n')

async function connect(station: Frame) {
  await station.locator('#connect-btn').click()
  await expect(badge(station)).toHaveText(`connected · ${BAUD} baud`)
}

async function typeInto(frame: Frame, keys: string) {
  const input = frame.locator('.xterm-helper-textarea')
  await input.focus()
  await input.pressSequentially(keys)
}

/** A student who opens the class link and clicks the station room. */
async function addStudent(browser: Browser, classUrl: string, station: Session) {
  const student = await joinClass(browser, classUrl, prepare)
  await enterRoom(student, await stationRoom(station))
  return student
}

// ---------------------------------------------------------------------------

test.describe('module-serial', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig: { baud: BAUD } }])

    station = await openStation(teacher, classUrl)
    student = await addStudent(browser, classUrl, station)
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('before a device is connected, each role is told what is going on', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)

    await expect(badge(st)).toHaveText('not connected')
    await expect(badge(stu)).toHaveText('not connected')
    expect(await text(st)).toContain('No device connected. Choose a baud rate and click Connect.')
    expect(await text(stu)).toContain('Waiting for the station to connect a device…')

    // Only the station gets the controls; the configured off-list rate is selected.
    await expect(st.locator('#station-controls')).toBeVisible()
    await expect(stu.locator('#station-controls')).toBeHidden()
    await expect(st.locator('#baud')).toHaveValue(String(BAUD))

    // Typing without a device warns once instead of failing silently.
    await typeInto(stu, 'ab')
    const warning = '[no device connected at the station, input is not sent]'
    await expect.poll(() => text(stu)).toContain(warning)
    expect((await text(stu)).split(warning).length - 1).toBe(1)

    // A cancelled port picker is reported, and the station can try again.
    await serial(st).cancelNextRequest()
    await st.locator('#connect-btn').click()
    await expect.poll(() => text(st)).toContain('[could not connect: No port selected by the user.]')
    await expect(badge(st)).toHaveText('not connected')
    await expect(st.locator('#connect-btn')).toBeEnabled()
  })

  test('device output reaches students line by line, and their input reaches the device', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)

    await connect(st)
    expect(await serial(st).baudRate()).toBe(BAUD)
    await expect(badge(stu)).toHaveText(`connected · ${BAUD} baud`, { timeout: SYNC })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain(`Device connected (${BAUD} baud).`)

    // LF-only output: every line starts at column 0 (no staircase).
    await serial(st).emit('first line\nsecond line\nthird line\n')
    await expect
      .poll(async () => (await lines(stu)).filter((l) => l.endsWith(' line')), { timeout: SYNC })
      .toEqual(['first line', 'second line', 'third line'])

    // Scrollback keeps far more than one screen.
    const many = Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n') + '\n'
    await serial(st).emit(many)
    await expect.poll(async () => (await lines(stu)).includes('row 199'), { timeout: SYNC }).toBe(true)
    expect(await lines(stu)).toContain('row 0')

    // Student keystrokes reach the device through the station.
    await typeInto(stu, 'hi')
    await stu.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(() => serial(st).written(), { timeout: SYNC }).toBe('hi\r')
  })

  test('a read error is reported and later output still arrives; unplugging resets the status', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await connect(st)
    await expect(badge(stu)).toHaveText(`connected · ${BAUD} baud`, { timeout: SYNC })

    await serial(st).fail('FramingError')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('[serial error: A framing error was detected.]')

    await serial(st).emit('still alive\n')
    await expect.poll(() => lines(stu), { timeout: SYNC }).toContain('still alive')
    await expect(badge(stu)).toHaveText(`connected · ${BAUD} baud`)

    // Unplugging reloads the module on the station and resets the status for everyone.
    await serial(st).unplug()
    await expect(badge(stu)).toHaveText('not connected', { timeout: SYNC })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('[device disconnected]')
    await expect(badge(await ready(station!))).toHaveText('not connected', { timeout: SYNC })
  })

  test('a student who joins later sees the current status', async ({ browser }) => {
    const st = await ready(station!)
    await connect(st)

    const late = await addStudent(browser, classUrl, station!)
    try {
      const frame = await ready(late)
      await expect(badge(frame)).toHaveText(`connected · ${BAUD} baud`, { timeout: SYNC })
      await expect.poll(() => text(frame)).toContain(`Device connected (${BAUD} baud).`)
    } finally {
      await closeSessions(late)
    }
  })
})
