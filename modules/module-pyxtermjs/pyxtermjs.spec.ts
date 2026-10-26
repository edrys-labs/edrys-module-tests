import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, enterRoom, joinClass, openStation, setModules, stationRoom } from '../../lib/edrys'
import { moduleUrl, serveModules } from '../../lib/modules'
import { installFakePyxterm, pty } from '../../lib/fake-pyxterm'
import { terminalSize, terminalText } from '../../lib/xterm'
import {
  ENTRY,
  JOIN,
  MODULE,
  SYNC,
  b64,
  badge,
  checkbox,
  controls,
  flush,
  occurrences,
  ready,
  scriptBox,
  send,
  serverInput,
  typeInto,
} from './helpers'

/**
 * module-pyxtermjs in a real edrys-Lite: a station that connects to a fake
 * pyxtermjs terminal server (lib/fake-pyxterm.ts), and students in the
 * station's room who see its output and, when allowed, type into it. Other
 * modules send code with the `execute` subject; the station runs it through
 * its script. The fake records exactly what reaches the shell.
 * real-server.spec.ts runs a few of these flows against the actual server.
 */

const SERVER = 'http://127.0.0.1:5999/pty'

const prepareWith = (serverUp: boolean) => async (context: BrowserContext) => {
  await serveModules(context)
  await installFakePyxterm(context, { up: serverUp })
}

/** Everything the server received, as one string. */
const received = async (station: Frame) => (await pty(station).inputs()).join('')

// ---------------------------------------------------------------------------

test.describe('module-pyxtermjs', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  /** Teacher adds the module with this station config, opens the station, a student enters its room. */
  async function setup(browser: Browser, stationConfig: object, serverUp = true) {
    const prepare = prepareWith(serverUp)
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, [{ url: moduleUrl(MODULE, ENTRY), stationConfig }])
    station = await openStation(teacher, classUrl)
    student = await addStudent(browser, prepare)
    return { st: await ready(station), stu: await ready(student) }
  }

  async function addStudent(browser: Browser, prepare = prepareWith(true)) {
    const s = await joinClass(browser, classUrl, prepare)
    await enterRoom(s, await stationRoom(station!))
    return s
  }

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('the station connects to the configured server, only it gets the controls, and an allowed student types', async ({ browser, browserName }) => {
    const { st, stu } = await setup(browser, { server: SERVER, enable: { student: true, teacher: false } })

    await expect(badge(st)).toHaveText('connected')
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })
    expect(await pty(st).urls()).toEqual([SERVER])

    // station controls reflect the config
    await expect(controls(st)).toBeVisible()
    await expect(serverInput(st)).toHaveValue(SERVER)
    await expect(checkbox(st, 'student')).toBeChecked()
    await expect(checkbox(st, 'teacher')).not.toBeChecked()
    await expect(scriptBox(st)).toHaveValue('echo $CODE | base64 --decode')

    // students see the terminal, not the controls
    await expect(controls(stu)).toHaveCount(0)
    await expect(scriptBox(stu)).toHaveCount(0)
    // the station's screen replaces the student's on join (#6); it has the welcome text too
    await expect.poll(() => terminalText(stu), { timeout: SYNC }).toContain('Welcome to pyxterm.js!')

    // shell output reaches students
    await pty(st).output('hello from the shell\r\n')
    await expect.poll(() => terminalText(stu), { timeout: SYNC }).toContain('hello from the shell')
    expect(await terminalText(st)).toContain('hello from the shell')

    // the allowed student types, and the shell's echo comes back
    await typeInto(stu, 'ls -la')
    await stu.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain('ls -la\r')
    await expect.poll(() => terminalText(stu), { timeout: SYNC }).toContain('ls -la')

    // ctrl+shift+v pastes, once: through the browser's own paste. It used to paste twice in real browsers (the
    // module also read the clipboard); that read delivers nothing under Playwright, so only the once is checked.
    // Only Chromium has clipboard permissions to grant; the other browsers cannot fill the clipboard here.
    if (browserName !== 'chromium') return
    await teacher!.context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await station!.page.evaluate(() => navigator.clipboard.writeText('echo pasted-once'))
    await st.locator('.xterm-helper-textarea').focus()
    await st.locator('.xterm-helper-textarea').press('Control+Shift+V')
    await expect.poll(() => received(st)).toContain('echo pasted-once')
    await st.page().waitForTimeout(500)
    expect(occurrences(await received(st), 'echo pasted-once')).toBe(1)
  })

  test('an unreachable server is shown to everyone with what to do, and the station keeps retrying until it is up', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER }, false)

    await expect(badge(st)).toHaveText('disconnected')
    await expect(badge(stu)).toHaveText('disconnected', { timeout: JOIN })
    await expect.poll(() => terminalText(st)).toContain(`Cannot reach the terminal server at ${SERVER}`)
    await expect.poll(() => terminalText(stu), { timeout: SYNC }).toContain('The station is not connected to its terminal server.')

    // more attempts than the old limit of 10; the fake retries every 50 ms
    await expect.poll(() => pty(st).retries()).toBeGreaterThan(10)
    await pty(st).start()
    await expect(badge(st)).toHaveText('connected')
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })
    expect(await pty(st).connects()).toBe(1)
    // the station said it once, not on every attempt
    expect(occurrences(await terminalText(st), 'Cannot reach the terminal server')).toBe(1)
  })

  test('who may type: the checkboxes, with the role taken from the class, not from the message subject', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER, enable: { student: false, teacher: true } })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })

    // the student types, is told once that typing is off (#15), and nothing reaches the shell
    await typeInto(stu, 'echo typed-off')
    await stu.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(() => terminalText(stu), { timeout: SYNC }).toContain('Typing is not enabled for students at this station.')
    expect(occurrences(await terminalText(stu), 'Typing is not enabled')).toBe(1)

    // what the module sends when the student types, and the same claiming other roles
    await send(stu, 'input_student_execute', 'echo as-student\r')
    await send(stu, 'input_station_execute', 'echo as-station\r')
    await send(stu, 'input_teacher_execute', 'echo as-teacher\r')
    await flush(stu)
    expect(await received(st)).not.toContain('typed-off')
    expect(await received(st)).not.toContain('as-student')
    expect(await received(st)).not.toContain('as-station')
    expect(await received(st)).not.toContain('as-teacher')

    // a real teacher in the station's room may type, since the station allows teachers
    await enterRoom(teacher!, await stationRoom(station!))
    const tea = await ready(teacher!)
    await expect(badge(tea)).toHaveText('connected', { timeout: JOIN })
    await typeInto(tea, 'echo from-teacher')
    await tea.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain('echo from-teacher\r')
    expect(await terminalText(tea)).not.toContain('Typing is not enabled')

    // the student, once the station allows students
    await checkbox(st, 'student').check()
    await typeInto(stu, 'echo from-student')
    await stu.locator('.xterm-helper-textarea').press('Enter')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain('echo from-student\r')
    expect(await received(st)).not.toContain('as-student')
  })

  test('code sent with execute runs only when the station allows the sender', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER, script: 'echo $CODE | base64 --decode | sh' })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })

    await send(stu, 'execute', 'echo from-student-off')
    await flush(stu)
    expect(await received(st)).not.toContain(b64('echo from-student-off'))

    // a module on the station itself may always
    await send(st, 'execute', 'echo from-station')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain(b64('echo from-station'))

    await checkbox(st, 'student').check()
    await send(stu, 'execute', 'echo from-student-on')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain(b64('echo from-student-on'))
    expect(await received(st)).not.toContain(b64('echo from-student-off'))
  })

  test('a project sent with execute runs as one input through the workflow, its files safely in the sketch folder', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER, enable: { student: true }, workflow: 'arduino-avr', port: '/dev/ttyUSB3' })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })

    // the workflow's script is shown to the station
    await expect(scriptBox(st)).toHaveValue(/arduino-cli compile -b \$BOARD \$SKETCH/)

    // a project as an object (module-editor's JSON text: real-server.spec.ts); the main file is the
    // one named like `filename` (Sketch.ino), not the first
    const code = 'void setup() {}\nvoid loop() {}\n'
    const unsafe = { 'a.txt; touch pwned': 'semicolon', '../up.txt': 'parent', '/tmp/abs.txt': 'absolute', '.bashrc': 'dotfile' }
    await send(stu, 'execute', { file: { 'util.h': 'int twice(int x);', 'Sketch.ino': code, ...unsafe } })
    await expect.poll(() => received(st), { timeout: SYNC }).toContain(b64(code))

    const inputs = (await pty(st).inputs()).filter((input) => input.includes(b64(code)))
    expect(inputs).toHaveLength(1)
    const sent = inputs[0]
    // two ctrl+c first, to stop what is running
    expect(sent.startsWith('\u0003\u0003\n')).toBe(true)
    expect(occurrences(sent, b64(code))).toBe(1)
    expect(sent).toContain('SKETCH=$(basename Sketch.ino .ino)')
    expect(sent).toContain(`echo ${b64(code)} | base64 --decode > $SKETCH/$SKETCH.ino`)
    expect(sent).toContain(`(cd $SKETCH && echo ${b64('int twice(int x);')} | base64 --decode > 'util.h')`)
    expect(sent).toContain('arduino-cli compile -b arduino:avr:uno $SKETCH')
    expect(sent).toContain('arduino-cli upload -b arduino:avr:uno -p /dev/ttyUSB3 $SKETCH')
    expect(sent).toContain('arduino-cli monitor -p /dev/ttyUSB3 -c baudrate=9600')
    for (const content of Object.values(unsafe)) expect(await received(st)).not.toContain(b64(content))
  })

  test('config.execute changes the subject the station listens to', async ({ browser }) => {
    const { st, stu } = await setup(browser, {
      server: SERVER,
      enable: { student: true },
      execute: 'run-shell',
      script: 'echo $CODE | base64 --decode | sh',
    })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })

    await send(stu, 'execute', 'echo wrong subject')
    await send(stu, 'run-shell', 'echo right subject')

    await expect.poll(() => received(st), { timeout: SYNC }).toContain(b64('echo right subject'))
    await flush(stu, 'run-shell')
    expect(await received(st)).not.toContain(b64('echo wrong subject'))
  })

  test('after reload, input and execute reach the shell once', async ({ browser }) => {
    const { st, stu } = await setup(browser, {
      server: SERVER,
      enable: { student: true },
      script: 'echo $CODE | base64 --decode | sh',
    })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })

    for (let n = 2; n <= 3; n++) {
      await st.getByRole('button', { name: 'reconnect' }).click()
      await expect.poll(() => pty(st).connects()).toBe(n)
      await expect(badge(st)).toHaveText('connected')
    }

    await send(stu, 'input_student_execute', 'echo once\r')
    await send(stu, 'execute', 'echo executed')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain('echo once\r')
    await expect.poll(() => received(st), { timeout: SYNC }).toContain(b64('echo executed'))
    await flush(stu)
    expect(occurrences(await received(st), 'echo once\r')).toBe(1)
    expect(occurrences(await received(st), b64('echo executed'))).toBe(1)
  })

  test('a student who joins later sees the status and what is on the station terminal', async ({ browser }) => {
    const { st } = await setup(browser, { server: SERVER })
    await pty(st).output('line one\r\n')
    await pty(st).output('line two\r\n')
    await pty(st).output('prompt$ ')
    await expect.poll(() => terminalText(st)).toContain('prompt$')

    const late = await addStudent(browser)
    try {
      const frame = await ready(late)
      await expect(badge(frame)).toHaveText('connected', { timeout: JOIN })
      await expect.poll(() => terminalText(frame), { timeout: SYNC }).toContain('prompt$')
      await expect.poll(() => terminalText(frame), { timeout: SYNC }).toContain('line one')
    } finally {
      await closeSessions(late)
    }
  })

  test('the station owns the terminal size: a student resize changes nothing, a station resize reaches the student', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })
    // the student takes the station's columns; rows may be more, see below
    await expect.poll(async () => (await terminalSize(stu)).cols, { timeout: SYNC }).toBe((await terminalSize(st)).cols)

    // the module waits 50 ms after a resize; give a student's resize time to go out
    await student!.page.setViewportSize({ width: 700, height: 720 })
    await stu.waitForTimeout(500)
    await flush(stu)

    const size = await terminalSize(st)
    expect((await terminalSize(stu)).cols).toBe(size.cols)
    expect((await terminalSize(stu)).rows).toBeGreaterThanOrEqual(size.rows)
    expect((await pty(st).resizes()).at(-1)).toEqual(size)

    await station!.page.setViewportSize({ width: 900, height: 500 })
    await expect.poll(async () => (await terminalSize(st)).cols).not.toBe(size.cols)
    const resized = await terminalSize(st)
    await expect.poll(async () => (await terminalSize(stu)).cols, { timeout: SYNC }).toBe(resized.cols)
    expect((await pty(st).resizes()).at(-1)).toEqual(resized)
  })

  test('a student frame taller than the station’s fills its height, except while a program owns the screen', async ({ browser }) => {
    const { st, stu } = await setup(browser, { server: SERVER })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })
    // the station's controls and script box take height the student has for rows
    await station!.page.setViewportSize({ width: 900, height: 500 })
    await student!.page.setViewportSize({ width: 900, height: 900 })
    await stu.waitForTimeout(500)
    await flush(stu)
    const size = await terminalSize(st)

    await expect.poll(async () => (await terminalSize(stu)).rows, { timeout: SYNC }).toBeGreaterThan(size.rows)
    expect((await terminalSize(stu)).cols).toBe(size.cols)
    const tall = (await terminalSize(stu)).rows

    // vim, less, man position and scroll by the station's rows
    await pty(st).output('\x1b[?1049h')
    await expect.poll(() => terminalSize(stu), { timeout: SYNC }).toEqual(size)
    await pty(st).output('\x1b[?1049l')
    await expect.poll(async () => (await terminalSize(stu)).rows, { timeout: SYNC }).toBe(tall)
    expect((await pty(st).resizes()).at(-1)).toEqual(size)
  })
})
