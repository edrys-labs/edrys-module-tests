import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, enterRoom, joinClass, openStation, setModules, stationRoom } from '../../lib/edrys'
import { THEME_BACKGROUND, moduleBackground, moduleFrame, moduleTheme, moduleUrl, serveModules, setClassroomTheme } from '../../lib/modules'
import { installFakePyxterm, pty } from '../../lib/fake-pyxterm'
import { terminalText } from '../../lib/xterm'

/**
 * module-serial-plotter next to module-pyxtermjs in a station room. The fake
 * pyxtermjs server (lib/fake-pyxterm.ts) prints what serial-plotter.py --emit
 * prints: OSC sequences with the samples, plus a status line. The terminal
 * module at the station sends that output to the room as `pty-output_<execute>`;
 * the plotter on every peer reads the samples out of it.
 *
 * module-pyxtermjs is served from its dist/: run `npm run build` there first.
 */

const PLOTTER = 'module-serial-plotter'
const TERMINAL = 'module-pyxtermjs'
const SERVER = 'http://127.0.0.1:5999/pty'
// time for a message to travel between peers
const SYNC = 15_000
// a new peer's first messages can be lost while WebRTC settles (see module-pyxtermjs/helpers.ts)
const JOIN = 45_000

/** What serial-plotter.py --emit prints for one batch. */
const osc = (payload: object) => `\x1b]7770;edrys-plot;${JSON.stringify(payload)}\x07`

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await installFakePyxterm(context)
}

async function plotter(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, PLOTTER)
  // polling, not rAF: Chromium pauses rAF in a cross-origin frame outside the viewport
  await frame.waitForFunction(() => !!(window as any).serialPlot, null, { timeout: 30_000, polling: 100 })
  return frame
}

async function terminal(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, TERMINAL)
  await frame.waitForFunction(() => !!(window as any).term, null, { timeout: 30_000, polling: 100 })
  return frame
}

const snapshot = (frame: Frame) => frame.evaluate(() => (window as any).serialPlot.snapshot())
const pill = (frame: Frame) => frame.locator('#status')
const readout = (frame: Frame) => frame.locator('#readout')
const empty = (frame: Frame) => frame.locator('#empty')

test.describe('module-serial-plotter', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined

  async function setup(browser: Browser, plotterConfig: object = {}, execute = 'execute') {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    await setModules(teacher, [
      { url: moduleUrl(TERMINAL, 'dist/index.html'), stationConfig: { server: SERVER, execute } },
      { url: moduleUrl(PLOTTER), config: plotterConfig, showInCustom: 'station' },
    ])
    station = await openStation(teacher, created.classUrl)
    student = await joinClass(browser, created.classUrl, prepare)
    await enterRoom(student, await stationRoom(station))
    const term = await terminal(station)
    // the student's terminal gets the station's output once its join was answered
    await terminal(student)
    return { term, st: await plotter(station), stu: await plotter(student) }
  }

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('a radar split across output chunks shows on the station and the student, and the terminal does not show the sequences', async ({ browser }) => {
    const { term, st, stu } = await setup(browser)

    for (const frame of [st, stu]) {
      await expect(pill(frame)).toHaveText('Waiting for data')
      await expect(empty(frame)).toContainText('serial-plotter.py --emit')
    }

    const first = osc({ type: 'radar', start: true, samples: [] }) + 'no scan yet'
    const batch = osc({ type: 'radar', samples: [[10, 120], [11, 118], [90, 42]] }) + '\r\x1b[Klast: 90° → 42'
    const cut = batch.indexOf('[90')
    await pty(term).output('serial-plotter: /dev/ttyACM0 (9600 baud) → plot module\r\n' + first)
    // one sequence over two outputs, cut inside the JSON and inside the marker of the next one
    await pty(term).output(batch.slice(0, cut))
    await pty(term).output(batch.slice(cut) + '\x1b]7770;edr')
    await pty(term).output('ys-plot;{"type":"radar","samples":[[91,44]]}\x07')

    for (const frame of [st, stu]) {
      await expect.poll(() => snapshot(frame), { timeout: JOIN }).toMatchObject({ type: 'radar', radar: 4, last: [91, 44] })
      await expect(pill(frame)).toHaveText('Receiving')
      await expect(readout(frame)).toHaveText('91° → 44')
      await expect(empty(frame)).toBeHidden()
    }

    // the terminals show the status line, never the hidden sequences
    const text = await terminalText(term)
    expect(text).toContain('last: 90° → 42')
    expect(text).not.toContain('edrys-plot')
    expect(await terminalText(await terminal(student!))).not.toContain('edrys-plot')

    // after a while without data, then when the plotter exits
    await expect(pill(stu)).toHaveText('No new data', { timeout: 10_000 })
    await pty(term).output(osc({ type: 'radar', stop: true, samples: [] }) + '\r\n')
    await expect(pill(stu)).toHaveText('Plotter stopped', { timeout: SYNC })
  })

  test('line plot: named series, a new run starts empty, maxPoints limits what is kept', async ({ browser }) => {
    const { term, stu } = await setup(browser, { maxPoints: 10 })

    const samples = Array.from({ length: 30 }, (_, i) => ({ temp: i, hum: 100 - i }))
    await pty(term).output(osc({ type: 'line', start: true, samples: [] }))
    await pty(term).output(osc({ type: 'line', samples: samples.slice(0, 20) }))
    await pty(term).output(osc({ type: 'line', samples: samples.slice(20) }))

    await expect.poll(() => snapshot(stu), { timeout: JOIN }).toMatchObject({ type: 'line', count: 30 })
    const { series } = await snapshot(stu)
    expect(Object.keys(series)).toEqual(['temp', 'hum'])
    // keeps maxPoints, dropping old points in steps of up to half of it
    expect(series.temp.length).toBeGreaterThanOrEqual(10)
    expect(series.temp.length).toBeLessThanOrEqual(15)
    expect(series.temp.at(-1)).toBe(29)
    await expect(readout(stu)).toHaveText(/temp\s*29\s*hum\s*71/)

    // the next run of the plotter
    await pty(term).output(osc({ type: 'line', start: true, samples: [{ volt: 3.3 }] }))
    await expect.poll(() => snapshot(stu), { timeout: SYNC }).toMatchObject({ count: 1, series: { volt: [3.3] } })
  })

  test('ignores the subject from anyone but the station, and listens to the configured terminal', async ({ browser }) => {
    const { term, st, stu } = await setup(browser, { execute: 'radar' }, 'radar')

    // a student sends the terminal's subject itself: not the station, ignored everywhere
    await stu.evaluate(
      (body) => (window as any).Edrys.sendMessage('pty-output_radar', body),
      osc({ type: 'radar', samples: [[45, 99]] })
    )
    // the station's output, on the configured subject, does arrive
    await pty(term).output(osc({ type: 'radar', samples: [[30, 50]] }))
    for (const frame of [st, stu]) {
      await expect.poll(() => snapshot(frame), { timeout: JOIN }).toMatchObject({ radar: 1, last: [30, 50] })
    }
    // messages from one peer arrive in order: by this second sample the student's has long arrived
    await pty(term).output(osc({ type: 'radar', samples: [[31, 51]] }))
    for (const frame of [st, stu]) {
      await expect.poll(() => snapshot(frame), { timeout: SYNC }).toMatchObject({ radar: 2, last: [31, 51] })
    }
  })

  test('follows the classroom theme', async ({ browser }) => {
    const { term, stu } = await setup(browser)
    await pty(term).output(osc({ type: 'radar', samples: [[90, 42]] }))
    await expect.poll(() => snapshot(stu), { timeout: JOIN }).toMatchObject({ radar: 1 })

    const ink = () => stu.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--plot-1').trim())
    for (const theme of ['dark', 'light'] as const) {
      await setClassroomTheme(student!, theme)
      await expect.poll(() => moduleTheme(stu)).toBe(theme)
      await expect.poll(() => moduleBackground(stu)).toBe(THEME_BACKGROUND[theme])
    }
    const light = await ink()
    await setClassroomTheme(student!, 'dark')
    await expect.poll(ink).not.toBe(light)
  })
})
