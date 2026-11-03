import { BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, openStation, setModules } from '../../lib/edrys'
import {
  THEME_BACKGROUND,
  moduleBackground,
  moduleFrame,
  moduleTheme,
  moduleUrl,
  serveModules,
  setClassroomTheme,
} from '../../lib/modules'

/**
 * module-hardware-control in a real edrys-Lite: a station with its local AD2
 * server, answered by the test.
 */

const MODULE = 'module-hardware-control'
const SERVER = 'http://localhost:5005'
const COMPONENTS = JSON.stringify([
  { type: 'button', name: 'Button 1', pin: 4 },
  { type: 'potentiometer', name: 'Voltage Control', channel: 0 },
])

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await context.route(`${SERVER}/**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify({ status: 'ok' }),
    })
  )
}

/** The module's iframe, once Edrys.onReady has run. */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect
    .poll(() => frame.evaluate(() => (window as any).Edrys?.ready).catch(() => false), { timeout: 30_000 })
    .toBe(true)
  return frame
}

test.describe('module-hardware-control', () => {
  let teacher: Session | undefined
  let station: Session | undefined

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    await setModules(teacher, [
      { url: moduleUrl(MODULE), stationConfig: { serverUrl: SERVER, components: COMPONENTS } },
    ])
    station = await openStation(teacher, created.classUrl)
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher)
    teacher = station = undefined
  })

  test("the module follows the classroom's light or dark theme", async () => {
    const st = await ready(station!)
    await expect(st.locator('#status-text')).toHaveText('Connected')
    await expect(st.locator('.component-card')).toHaveCount(2)

    for (const theme of ['dark', 'light'] as const) {
      await setClassroomTheme(station!, theme)
      await expect.poll(() => moduleTheme(st)).toBe(theme)
      await expect.poll(() => moduleBackground(st)).toBe(THEME_BACKGROUND[theme])
    }
  })
})
