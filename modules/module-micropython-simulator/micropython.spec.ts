import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { ModuleEntry, Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-micropython-simulator in a real edrys-Lite: a teacher and a student
 * in the lobby (the module is shown everywhere). An editor module sends
 * MicroPython code with the `execute` subject; the module runs it in its
 * copy of the Calliope mini 3 or micro:bit v2 simulator and shows the serial
 * output.
 */

const MODULE = 'module-micropython-simulator'
// time for a message to travel between peers, or for the simulator to load and react
const SYNC = 20_000

// the hosts of the original simulators: the module must not load anything from them
const HOSTED = /simulator\.python\.calliope\.cc|python-simulator\.usermbit\.org/
const hostedRequests: string[] = []

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  context.on('request', (request) => {
    if (HOSTED.test(request.url())) hostedRequests.push(request.url())
  })
  // keeps every AudioContext a page creates, to see whether the board's sound runs
  await context.addInitScript(() => {
    const Original = window.AudioContext
    if (!Original) return
    ;(window as any).__e2eAudio = []
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options)
        ;(window as any).__e2eAudio.push(this)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once Edrys.onReady has run and the simulator said it is ready.
 * Closes the side menu, which would cover the module's buttons and the board.
 */
async function ready(s: Session): Promise<Frame> {
  await closeSideMenu(s)
  const frame = await moduleFrame(s, MODULE)
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 30_000 })
  await expect(badge(frame)).not.toHaveText('loading', { timeout: 45_000 })
  return frame
}

const stdout = (frame: Frame) => frame.locator('#stdout')
const badge = (frame: Frame) => frame.locator('#status')

/** The simulator's iframe inside the module. */
function simulator(frame: Frame): Frame {
  const sim = frame.childFrames()[0]
  if (!sim) throw new Error('no simulator iframe')
  return sim
}

/** Send a program as an editor module does (promiscuous listeners get it, the sender too). */
async function run(frame: Frame, code: string, subject = 'execute') {
  await frame.evaluate(([subject, code]) => (window as any).Edrys.sendMessage(subject, code), [subject, code])
}

/** Click the board's play button (shown before the first program and after Stop). */
async function play(frame: Frame) {
  await simulator(frame).locator('.play-button').click({ timeout: SYNC })
}

/** Send a line with the input field. */
async function type(frame: Frame, text: string) {
  await frame.locator('#stdin').fill(text)
  await frame.locator('#stdin').press('Enter')
}

/** Click Stop; scrolled to the top first, so the header isn't under edrys' app bar. */
async function clickStop(s: Session, frame: Frame) {
  await s.page.evaluate(() => {
    for (const e of [document.scrollingElement, ...Array.from(document.querySelectorAll('*'))]) if (e?.scrollTop) e.scrollTop = 0
  })
  await frame.locator('#stop').click()
}

async function setup(teacher: Session, entry: Omit<ModuleEntry, 'url'> = {}) {
  await setModules(teacher, [{ url: moduleUrl(MODULE, 'index.html'), ...entry }])
}

function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

/** The control of sensor `id` below the board. */
const sensor = (frame: Frame, id: string) => frame.locator(`#sensors [data-sensor="${id}"]`)

const HELLO = 'from calliopemini import *\nprint("hello from the simulator")'

// ---------------------------------------------------------------------------

test.describe('module-micropython-simulator', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
  })

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = student = undefined
    expect(hostedRequests).toEqual([])
    hostedRequests.length = 0
  })

  test('before any code arrives, the board is shown with an idle terminal', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)

    await expect(badge(t)).toHaveText('idle')
    await expect(stdout(t)).toHaveText(
      'Waiting for code from an editor module (subject execute). Programs for the Calliope mini 3 start with from calliopemini import *.'
    )
    expect(simulator(t).url()).toBe(moduleUrl(MODULE, 'simulators/calliope-mini-3/simulator.html'))
    await expect(simulator(t).locator('svg').first()).toBeVisible()
    for (const id of ['#send', '#stdin', '#stop']) await expect(t.locator(id)).toBeDisabled()
  })

  test('a program starts as soon as it is sent, a new one replaces it', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)

    // no click on the board needed
    await run(t, HELLO)
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })
    await expect(badge(t)).toHaveText('running')
    for (const id of ['#send', '#stdin', '#stop']) await expect(t.locator(id)).toBeEnabled()

    // a new program clears the terminal
    await run(t, 'print("second program")')
    await expect(stdout(t)).toContainText('second program', { timeout: SYNC })
    await expect(stdout(t)).not.toContainText('hello from the simulator')
  })

  test('input() reads a line from the input field, after the program the >>> prompt works', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, 'name = input("name? ")\nprint("hi", name)')
    await expect(stdout(t)).toContainText('name? ', { timeout: SYNC })

    await type(t, 'Ada')
    // MicroPython echoes the line
    await expect(stdout(t)).toContainText('name? Ada\nhi Ada', { timeout: SYNC })
    await expect(t.locator('#stdin')).toHaveValue('')

    // the program has ended: the board is at the >>> prompt
    await expect(stdout(t)).toContainText('Type "help()" for more information.\n>>> ', { timeout: SYNC })
    await t.locator('#stdin').fill('6*7')
    await t.locator('#send').click()
    await expect(stdout(t)).toContainText('>>> 6*7\n42\n>>> ', { timeout: SYNC })

    // the prompt edits its line with \b and escape codes: only the result is shown
    await t.evaluate(() => (window as any).post({ kind: 'serial_input', data: 'abc\x1b[D\x1b[DX\r' }))
    await expect(stdout(t)).toContainText(">>> aXbc\nTraceback (most recent call last):", { timeout: SYNC })
    await expect(stdout(t)).toContainText("NameError: name 'aXbc' isn't defined")
    expect(await stdout(t).textContent()).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
  })

  test('an error in the program shows its traceback', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, 'print("before")\n1/0')
    await expect(stdout(t)).toContainText(
      'before\nTraceback (most recent call last):\n  File "main.py", line 2, in <module>\nZeroDivisionError: divide by zero',
      { timeout: SYNC }
    )
    // the board keeps running: it scrolls the error over its display, then starts the >>> prompt
    await expect(badge(t)).toHaveText('running')
  })

  test('stop ends the program, play starts it again', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, 'from calliopemini import *\nn = 0\nwhile True:\n    n += 1\n    print("tick", n)\n    sleep(100)')
    await expect(stdout(t)).toContainText('tick 3', { timeout: SYNC })

    await clickStop(teacher!, t)
    await expect(badge(t)).toHaveText('stopped')
    await expect(stdout(t)).toContainText('execution stopped')
    for (const id of ['#send', '#stdin', '#stop']) await expect(t.locator(id)).toBeDisabled()
    const stopped = await stdout(t).textContent()
    await t.waitForTimeout(1_000)
    expect(await stdout(t).textContent()).toBe(stopped)

    // the board's play button runs the last program from the beginning
    await play(t)
    await expect(badge(t)).toHaveText('running')
    await expect(stdout(t)).toContainText('tick 1', { timeout: SYNC })
    await expect(stdout(t)).not.toContainText('execution stopped')
  })

  test('a multi-file project goes onto the board, main.py runs', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, JSON.stringify({ file: { 'util.py': 'def twice(x):\n    return 2 * x', 'main.py': 'import util\nprint("twice", util.twice(21))' } }))
    await expect(stdout(t)).toContainText('twice 42', { timeout: SYNC })

    // a project without .py file is an error
    await run(t, JSON.stringify({ file: { 'notes.txt': 'hi' } }))
    await expect(stdout(t).locator('.error')).toHaveText('the project has no .py file (files: notes.txt)\n')
    await expect(badge(t)).toHaveText('error')
  })

  test('output is shown as text, not HTML', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, 'print("<img src=x onerror=\\"window.__e2eXss=1\\">")')
    await expect(stdout(t)).toContainText('<img src=x onerror="window.__e2eXss=1">', { timeout: SYNC })
    expect(await t.locator('#stdout img').count()).toBe(0)
    expect(await t.evaluate(() => (window as any).__e2eXss)).toBeUndefined()
  })

  test('board microbit-v2 runs the micro:bit simulator', async () => {
    await setup(teacher!, { config: { board: 'microbit-v2' } })
    const t = await ready(teacher!)
    expect(simulator(t).url()).toBe(moduleUrl(MODULE, 'simulators/microbit-v2/simulator.html'))
    await expect(stdout(t)).toContainText('from microbit import *')

    await run(t, 'from microbit import *\nprint("hello micro:bit")')
    await expect(stdout(t)).toContainText('hello micro:bit', { timeout: SYNC })
  })

  test('by default, a program runs only for the peer who sent it', async ({ browser }) => {
    await setup(teacher!)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await run(stu, HELLO)
    await expect(stdout(stu)).toContainText('hello from the simulator', { timeout: SYNC })
    await t.waitForTimeout(2_000)
    await expect(badge(t)).toHaveText('idle')
    await expect(stdout(t)).not.toContainText('hello from the simulator')
    expect(await stu.evaluate(() => (window as any).Edrys.getState('micropython:execute', 'Value'))).toBeFalsy()
  })

  test('with synchronize, a program runs on every peer, also on one who joins later, and Stop is shared', async ({ browser }) => {
    await setup(teacher!, { config: { synchronize: true } })
    const t = await ready(teacher!)
    await run(t, HELLO)
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })

    // a student who joins later gets the program from the room state; it starts once the board has loaded
    student = await addStudent(browser, classUrl)
    const stu = await ready(student)
    await expect(badge(stu)).toHaveText('running', { timeout: SYNC })
    await expect(stdout(stu)).toContainText('hello from the simulator', { timeout: SYNC })

    // a new program reaches both
    await run(stu, 'print("from the student")')
    for (const frame of [stu, t]) await expect(stdout(frame)).toContainText('from the student', { timeout: SYNC })

    await clickStop(student, stu)
    for (const frame of [stu, t]) await expect(badge(frame)).toHaveText('stopped', { timeout: SYNC })
    expect(await t.evaluate(() => (window as any).Edrys.getState('micropython:execute', 'Value'))).toBeFalsy()
  })

  test('sound: the program runs before any click, the audio starts with the first click on the board', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, 'import music\nmusic.play(music.BA_DING)\nprint("after the sound")')
    // playing doesn't wait for a click
    await expect(stdout(t)).toContainText('after the sound', { timeout: SYNC })

    const sim = simulator(t)
    const audio = () => sim.evaluate(() => (window as any).__e2eAudio.map((c: AudioContext) => c.state))
    await expect.poll(audio).toHaveLength(1)

    await sim.locator('svg').first().click()
    await expect.poll(audio).toEqual(['running'])
  })

  test('sensors: none by default', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await expect(t.locator('#sensors > *')).toHaveCount(0)
    await expect(t.locator('#sensors')).toBeHidden()
  })

  test('sensors: a slider with a range sets the value the program reads, also for the next program', async () => {
    await setup(teacher!, { config: { sensors: 'temperature:0:40' } })
    const t = await ready(teacher!)
    const slider = sensor(t, 'temperature').locator('input')
    await expect(sensor(t, 'temperature')).toContainText('Temperature')
    await expect(slider).toHaveAttribute('min', '0')
    await expect(slider).toHaveAttribute('max', '40')
    await expect(slider).toHaveValue('21')
    await expect(sensor(t, 'temperature').locator('output')).toHaveText('21 °C')

    await slider.fill('35')
    await expect(sensor(t, 'temperature').locator('output')).toHaveText('35 °C')
    await run(t, 'from calliopemini import *\nprint("T", temperature())')
    await expect(stdout(t)).toContainText('T 35', { timeout: SYNC })

    // the board keeps the value for the next program
    await run(t, 'from calliopemini import *\nprint("again", temperature())')
    await expect(stdout(t)).toContainText('again 35', { timeout: SYNC })
    await expect(slider).toHaveValue('35')
  })

  test('sensors: a range without the current value moves the board into it', async () => {
    await setup(teacher!, { config: { sensors: 'temperature:25:40' } })
    const t = await ready(teacher!)
    await expect(sensor(t, 'temperature').locator('input')).toHaveValue('25')
    await run(t, 'from calliopemini import *\nprint("T", temperature())')
    await expect(stdout(t)).toContainText('T 25', { timeout: SYNC })
  })

  test('sensors: the gesture choice reaches the program', async () => {
    await setup(teacher!, { config: { sensors: 'gesture' } })
    const t = await ready(teacher!)
    await run(t, 'from calliopemini import *\nwhile True:\n    if accelerometer.was_gesture("shake"):\n        print("shaken")\n    sleep(50)')
    await expect(badge(t)).toHaveText('running')
    await sensor(t, 'gesture').locator('select').selectOption('shake')
    await expect(stdout(t)).toContainText('shaken', { timeout: SYNC })
  })

  test('sensors: all shows every sensor but buttons and pins, ranges follow the program', async () => {
    await setup(teacher!, { config: { sensors: 'all' } })
    const t = await ready(teacher!)
    const ids = await t.locator('#sensors [data-sensor]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sensor))
    expect(ids).toEqual([
      'accelerometerX', 'accelerometerY', 'accelerometerZ', 'gesture',
      'compassX', 'compassY', 'compassZ', 'compassHeading',
      'lightLevel', 'soundLevel', 'temperature',
    ])
    await expect(sensor(t, 'compassHeading').locator('output')).toHaveText('0°')

    const x = sensor(t, 'accelerometerX').locator('input')
    await expect(x).toHaveAttribute('max', '2000')
    await run(t, 'from calliopemini import *\naccelerometer.set_range(8)\nprint("range set")')
    await expect(stdout(t)).toContainText('range set', { timeout: SYNC })
    await expect(x).toHaveAttribute('max', '8000')
    await expect(x).toHaveAttribute('min', '-8000')
  })

  test('sensors: invalid entries are skipped', async () => {
    await setup(teacher!, { config: { sensors: 'temperature:0:99, buttonA, nope, gesture:1:2, LIGHTLEVEL, none' } })
    const t = await ready(teacher!)
    const ids = await t.locator('#sensors [data-sensor]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sensor))
    expect(ids).toEqual(['lightLevel'])
  })

  test('sensors: values are local, also with synchronize', async ({ browser }) => {
    await setup(teacher!, { config: { sensors: 'temperature', synchronize: true } })
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await sensor(t, 'temperature').locator('input').fill('40')
    await run(stu, 'from calliopemini import *\nprint("T", temperature())')
    await expect(stdout(t)).toContainText('T 40', { timeout: SYNC })
    await expect(stdout(stu)).toContainText('T 21', { timeout: SYNC })
    await expect(sensor(stu, 'temperature').locator('input')).toHaveValue('21')
  })
})
