import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session, closeSessions, createClass, enterRoom, joinClass, openStation, setModules, stationRoom } from '../../lib/edrys'
import {
  THEME_BACKGROUND,
  moduleBackground,
  moduleFrame,
  moduleTheme,
  moduleUrl,
  serveModules,
  setClassroomTheme,
} from '../../lib/modules'
import { FakeArduinoOptions, arduino, installFakeArduino } from '../../lib/fake-arduino'
import { FakeCompileServer, installFakeCompileServer } from '../../lib/fake-compile-server'

/**
 * module-station-flasher in a real edrys-Lite: students send code (as the
 * editor module does), the station compiles it on a fake compile server and
 * flashes a fake Arduino with an STK500 bootloader over fake Web Serial.
 */

const MODULE = 'module-station-flasher'
const SYNC = 15_000
// a real compile of BLINK on edrys-compile-server (arduino:avr:uno)
const BLINK_HEX = readFileSync(join(__dirname, 'fixtures', 'blink.hex'), 'utf8')
// a real compile of MEGA (arduino:avr:mega): 152 KB, so word addresses go past 0xFFFF
const MEGA_HEX = readFileSync(join(__dirname, 'fixtures', 'mega-152k.hex'), 'utf8')
const MEGA = readFileSync(join(__dirname, 'fixtures', 'mega-152k.ino'), 'utf8')
const MEGA_USB = { usbVendorId: 0x2341, usbProductId: 0x0010 }
const BLINK = '// e2e:blink\nvoid setup(){Serial.begin(9600);pinMode(13,OUTPUT);}\nvoid loop(){Serial.println("e2e:blink");digitalWrite(13,!digitalRead(13));delay(500);}\n'

/** Intel HEX -> the program as a hex string from address 0 (gaps 0xff, even length). */
function programHex(hex: string) {
  const bytes: number[] = []
  let base = 0
  for (const line of hex.split(/\r?\n/)) {
    const type = line.slice(7, 9)
    const data = line.slice(9, 9 + 2 * parseInt(line.slice(1, 3), 16))
    if (type === '02') base = parseInt(data, 16) * 16
    else if (type === '04') base = parseInt(data, 16) * 65536
    else if (type === '00') {
      const address = base + parseInt(line.slice(3, 7), 16)
      for (let i = 0; i < data.length / 2; i++) bytes[address + i] = parseInt(data.slice(2 * i, 2 * i + 2), 16)
    }
  }
  if (bytes.length % 2) bytes.push(0xff)
  return Array.from(bytes, (b) => (b ?? 0xff).toString(16).padStart(2, '0')).join('')
}

const badge = (frame: Frame) => frame.locator('#badge')

function text(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const buffer = (window as any).term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      // a long line xterm wrapped continues the previous one
      if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true)
      else out.push(line.translateToString(true))
    }
    return out.join('\n')
  })
}

async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect(badge(frame)).not.toHaveText(/Loading/, { timeout: 30_000 })
  return frame
}

/** What the editor module does on Run. */
function upload(frame: Frame, code: string, subject = 'execute') {
  return frame.evaluate(([s, c]) => (window as any).Edrys.sendMessage(s, c), [subject, code] as const)
}

interface Setup {
  teacher: Session
  station: Session
  students: Session[]
  server: FakeCompileServer
  classUrl: string
}

async function setup(
  browser: Browser,
  {
    stationConfig = {},
    board = {},
    serverBase,
  }: { stationConfig?: object; board?: FakeArduinoOptions; serverBase?: string } = {},
  studentCount = 1
): Promise<Setup> {
  const server = new FakeCompileServer().done('// e2e:blink', BLINK_HEX)
  // the station runs in the teacher's browser, so the fakes go there
  const prepareTeacher = async (context: BrowserContext) => {
    await serveModules(context)
    await installFakeArduino(context, { bootText: 'program started\n', ...board })
    await installFakeCompileServer(context, server, serverBase)
  }
  const { teacher, classUrl } = await createClass(browser, prepareTeacher)
  await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig }])
  const station = await openStation(teacher, classUrl)
  const room = await stationRoom(station)
  const students: Session[] = []
  for (let i = 0; i < studentCount; i++) {
    const student = await joinClass(browser, classUrl, serveModules)
    await enterRoom(student, room)
    students.push(student)
  }
  return { teacher, station, students, server, classUrl }
}

async function connect(st: Frame) {
  await st.locator('#connect-btn').click()
  await expect(badge(st)).toHaveText(/^Running · /, { timeout: SYNC })
}

test.describe('module-station-flasher', () => {
  let s: Setup | undefined

  test.afterEach(async () => {
    if (s) await closeSessions(s.teacher, ...s.students)
    s = undefined
  })

  test("a student's code is compiled, flashed and runs; output and input go through the station", async ({ browser }) => {
    // the class's own compile server, with a token
    s = await setup(browser, {
      stationConfig: { server: 'http://compile.e2e.test/', token: 'e2e-token-0123456789abcdef' },
      serverBase: 'http://compile.e2e.test',
    })
    const st = await ready(s.station)
    const stu = await ready(s.students[0])

    await expect(badge(stu)).toHaveText('No board connected', { timeout: SYNC })
    await connect(st)
    await expect(badge(stu)).toHaveText('Running · Arduino Uno · 9600 baud', { timeout: SYNC })
    // junk before the bootloader's first answer must not break the upload
    // and answers take as long as on a real board, so the flash is long enough to watch
    await arduino(st).set({ junk: [0x00, 0xfe, 0x33], answerDelay: 15 })

    s.server.queued(2)
    await upload(stu, BLINK)
    // the student sees where the job is
    await expect(badge(stu)).toHaveText(/Compiling your code · server queue #\d/, { timeout: SYNC })
    await expect(badge(stu)).toHaveText(/Flashing your code · \d+ %/, { timeout: SYNC })
    await expect(badge(stu)).toHaveText('Running · Arduino Uno · 9600 baud', { timeout: SYNC })

    // the board holds exactly the compiled program
    expect(await arduino(st).uploads()).toBe(1)
    expect(await arduino(st).flashed()).toBe(programHex(BLINK_HEX))
    // the junk didn't cost a sync retry (js-stk500v1 2.0.3 cut such answers short)
    expect(await arduino(st).syncs()).toBe(3)

    // the compile server got the sketch for the configured board, with the station's id
    const request = s.server.requests[0]
    expect(request.fqbn).toBe('arduino:avr:uno')
    expect(request.files).toEqual([{ name: 'sketch.ino', content: BLINK }])
    expect(request.headers['x-station-id']).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(request.headers['authorization']).toBe('Bearer e2e-token-0123456789abcdef')

    // the compile log, then the program's output reach the student
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('Sketch uses 2002 bytes')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('program started')
    // the monitor is back at the configured baud
    expect(await arduino(st).baudRate()).toBe(9600)
    // opening the port reset the board; print once the program runs again
    await expect.poll(() => arduino(st).mode(), { timeout: SYNC }).toBe('program')
    await arduino(st).print('e2e:blink\n')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('e2e:blink')

    // student keystrokes reach the running program
    const input = stu.locator('.xterm-helper-textarea')
    await input.focus()
    await input.pressSequentially('hi')
    await expect.poll(() => arduino(st).written(), { timeout: SYNC }).toBe('hi')
  })

  test('a compile error reaches the room without escape sequences, and nothing is flashed', async ({ browser }) => {
    s = await setup(browser)
    s.server.fail('// e2e:typo', "sketch.ino:2:1: error: 'digitalWrit' was not declared\x1b[2J\x1b]0;owned\x07\n")
    const st = await ready(s.station)
    const stu = await ready(s.students[0])
    await connect(st)

    await upload(stu, '// e2e:typo\nvoid setup(){}\nvoid loop(){digitalWrit(13,1);}\n')
    await expect(badge(stu)).toHaveText(/^Compile error in /, { timeout: SYNC })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain("error: 'digitalWrit' was not declared")
    // the clear-screen sequence was not executed (the earlier lines are still there) and the OSC is text-free
    const shown = await text(stu)
    expect(shown).toContain('Upload code with the editor')
    expect(shown).toContain('the board still runs the previous program')
    expect(await arduino(st).uploads()).toBe(0)
    // the board keeps running and the monitor stays open
    expect(await arduino(st).isOpen()).toBe(true)
  })

  test("one flash at a time: a student's newer code replaces their waiting one and keeps its place", async ({ browser }) => {
    s = await setup(browser, {}, 2)
    s.server.done('// e2e:second', BLINK_HEX).done('// e2e:other', BLINK_HEX)
    const st = await ready(s.station)
    const [a, b] = await Promise.all(s.students.map(ready))
    await connect(st)

    s.server.queued(3)
    await upload(a, BLINK) // runs first
    await expect(badge(a)).toHaveText(/Compiling your code/, { timeout: SYNC })
    await upload(b, '// e2e:other first try\n')
    await expect(b.locator('#queue')).toHaveText('Your code is #1 in line', { timeout: SYNC })
    await expect(a.locator('#queue')).toHaveText('1 waiting', { timeout: SYNC })
    // b changes the code while waiting: multi-file this time, as the editor sends it
    await upload(b, JSON.stringify({ file: { 'sketch.ino': '// e2e:other\n#include "pins.h"\n', 'pins.h': '#define LED 13\n' } }))

    await expect.poll(() => s!.server.requests.length, { timeout: 60_000 }).toBe(2)
    await expect(badge(b)).toHaveText('Running · Arduino Uno · 9600 baud', { timeout: 60_000 })
    expect(s.server.requests[1].files).toEqual([
      { name: 'sketch.ino', content: '// e2e:other\n#include "pins.h"\n' },
      { name: 'pins.h', content: '#define LED 13\n' },
    ])
    expect(await arduino(st).uploads()).toBe(2)
    await expect(b.locator('#queue')).toHaveText('')
  })

  test('an old Nano bootloader is flashed at 57600 baud; the wrong board setting gets a hint', async ({ browser }) => {
    s = await setup(browser, { stationConfig: { board: 'Arduino Nano (old bootloader)' }, board: { bootBaud: 57600 } })
    const st = await ready(s.station)
    const stu = await ready(s.students[0])
    await connect(st)
    await expect(badge(stu)).toHaveText('Running · Arduino Nano (old bootloader) · 9600 baud', { timeout: SYNC })

    await upload(stu, BLINK)
    await expect.poll(() => arduino(st).uploads(), { timeout: 30_000 }).toBe(1)
    expect(s.server.requests[0].fqbn).toBe('arduino:avr:nano')
    expect(await arduino(st).flashed()).toBe(programHex(BLINK_HEX))

    // a bootloader that doesn't answer at the station's baud, as when the wrong Nano variant is set
    await arduino(st).set({ bootBaud: 9 })
    await upload(stu, BLINK + '// again\n')
    await expect(badge(stu)).toHaveText('Flashing failed', { timeout: 30_000 })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('the board did not answer')
    // the monitor is open again afterwards
    await expect.poll(() => arduino(st).baudRate(), { timeout: SYNC }).toBe(9600)
    expect(await arduino(st).isOpen()).toBe(true)
  })

  test('a Mega 2560 is flashed with STK500v2, also above 128 KB', async ({ browser }) => {
    s = await setup(browser, { stationConfig: { board: 'Arduino Mega 2560' }, board: { protocol: 'stk500v2' } })
    s.server.done('// e2e:mega-huge', MEGA_HEX)
    const st = await ready(s.station)
    const stu = await ready(s.students[0])
    await arduino(st).set({ ...MEGA_USB, junk: [0x00, 0x1b, 0xfe] })
    await connect(st)
    await expect(badge(stu)).toHaveText('Running · Arduino Mega 2560 · 9600 baud', { timeout: SYNC })

    await upload(stu, MEGA)
    await expect(badge(stu)).toHaveText(/Flashing your code · \d+ %/, { timeout: SYNC })
    await expect(badge(stu)).toHaveText('Running · Arduino Mega 2560 · 9600 baud', { timeout: 60_000 })
    expect(s.server.requests[0].fqbn).toBe('arduino:avr:mega')
    expect(await arduino(st).uploads()).toBe(1)
    expect(await arduino(st).flashed()).toBe(programHex(MEGA_HEX))
    // no warning about the board: its USB id matches the setting
    expect(await text(stu)).not.toContain('looks like')

    await expect.poll(() => arduino(st).mode(), { timeout: SYNC }).toBe('program')
    await arduino(st).print('mega-big 15\n')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('mega-big 15')
  })

  test('a board whose USB id differs from the setting is pointed out', async ({ browser }) => {
    // the class says Uno, the station has a Mega
    s = await setup(browser, { stationConfig: { board: 'Arduino Uno' }, board: { protocol: 'stk500v2' } })
    const st = await ready(s.station)
    const stu = await ready(s.students[0])
    await arduino(st).set(MEGA_USB)
    await connect(st)
    await expect
      .poll(() => text(stu), { timeout: SYNC })
      .toContain("the station's board looks like an Arduino Mega 2560, but the class is set to Arduino Uno")

    await upload(stu, BLINK)
    await expect(badge(stu)).toHaveText('Flashing failed', { timeout: 60_000 })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('It looks like an Arduino Mega 2560: set board')
    expect(await arduino(st).uploads()).toBe(0)
  })

  test("a board the flasher can't flash is named, its code isn't compiled, the monitor still works", async ({
    browser,
  }) => {
    s = await setup(browser)
    const st = await ready(s.station)
    const stu = await ready(s.students[0])
    // an Arduino Nano ESP32, as on an Arduino Alvik
    await arduino(st).set({ usbVendorId: 0x2341, usbProductId: 0x0070 })
    await connect(st)

    await expect(badge(stu)).toHaveText("Running · Arduino Nano ESP32 (can't be flashed) · 9600 baud", { timeout: SYNC })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain("the board at the station (Arduino Nano ESP32) can't be flashed")

    await upload(stu, BLINK)
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain("code was not uploaded.")
    expect(s.server.requests).toHaveLength(0)
    expect(await arduino(st).uploads()).toBe(0)

    await expect.poll(() => arduino(st).mode(), { timeout: SYNC }).toBe('program')
    await arduino(st).print('esp32 says hi\n')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('esp32 says hi')
  })

  test('without a board or a reachable server, the room is told what to do', async ({ browser }) => {
    s = await setup(browser)
    const st = await ready(s.station)
    const stu = await ready(s.students[0])

    // no board yet: nothing is sent to the server
    await upload(stu, BLINK)
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('no board connected at the station')
    expect(s.server.requests).toHaveLength(0)

    // the class's server is down
    await connect(st)
    s.server.offline()
    await upload(stu, BLINK)
    await expect(badge(stu)).toHaveText('Compile server problem', { timeout: SYNC })
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('compile server not reachable at http://localhost:8080')

    // this station overrides the address in its settings; that one is down too
    await st.locator('#settings-btn').click()
    await expect(st.locator('#server')).toHaveAttribute('placeholder', 'http://localhost:8080')
    await st.locator('#server').fill('http://down.e2e.test/')
    await st.locator('#server').press('Tab')
    await upload(stu, BLINK + '// again\n')
    await expect.poll(() => text(stu), { timeout: SYNC }).toContain('compile server not reachable at http://down.e2e.test')

    // a student who joins later sees the station's state
    const late = await joinClass(browser, s.classUrl, serveModules)
    s.students.push(late)
    await enterRoom(late, await stationRoom(s.station))
    await expect(badge(await ready(late))).toHaveText('Compile server problem', { timeout: SYNC })
  })

  test("the module follows the classroom's light or dark theme, the terminal stays dark", async ({ browser }) => {
    s = await setup(browser)
    const stu = await ready(s.students[0])
    const xterm = () => stu.evaluate(() => (window as any).term.getOption('theme').background)

    for (const theme of ['dark', 'light'] as const) {
      await setClassroomTheme(s.students[0], theme)
      await expect.poll(() => moduleTheme(stu)).toBe(theme)
      await expect.poll(() => moduleBackground(stu)).toBe(THEME_BACKGROUND[theme])
      await expect.poll(xterm).toBe(theme === 'dark' ? '#14171c' : '#1b2029')
    }
  })
})
