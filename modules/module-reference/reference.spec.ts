import { Browser, BrowserContext, Frame, Locator, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, joinClass, openStation, setModules } from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-reference in a real edrys-Lite: a teacher and students in the lobby
 * (the module is shown everywhere). It renders the Edrys data it gets, sends
 * and lists messages, and evaluates the snippet in its code editor, each in
 * its own tab (Data, Messages, State).
 */

const MODULE = 'module-reference'
// time for a change to travel between peers
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once the badge says the first onUpdate after onReady arrived.
 * In the lobby the side menu stays open over the module and takes its clicks, so close it.
 */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect(frame.locator('#badge')).toHaveText('ready', { timeout: 30_000 })
  await closeSideMenu(s)
  return frame
}

/** Switch to a tab: Data, Messages or State. */
async function tab(frame: Frame, name: string) {
  await frame.getByRole('tab', { name }).click()
  await expect(frame.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
}

/** A key/value pair (`<dl><div><dt>Label</dt><dd>value</dd></div>`), first one inside `scope`. */
const row = (scope: Frame | Locator, label: string) =>
  scope.locator(`xpath=//dl/div[dt[normalize-space()="${label}"]]`).first()

/** The value shown for a label. */
const field = (scope: Frame | Locator, label: string) => row(scope, label).locator('dd')

async function send(frame: Frame, subject: string, body: string, recipient = 'all') {
  await tab(frame, 'Messages')
  await frame.getByLabel('Subject').fill(subject)
  await frame.getByLabel('Body').fill(body)
  await frame.getByLabel('To').selectOption(recipient)
  await frame.getByRole('button', { name: 'Send message' }).click()
}

/** The received-message entry with exactly this subject. */
const received = (frame: Frame, subject: string) =>
  frame.locator('details', { has: frame.locator('summary .subject').getByText(subject, { exact: true }) })

/** The live state of the peer's own room, in the State tab. */
const roomState = (frame: Frame) => frame.locator('.room-state')

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-reference', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, [
      {
        url: moduleUrl(MODULE),
        config: { shared: 'for everyone' },
        teacherConfig: { only: 'teachers' },
        studentConfig: { only: 'students' },
        stationConfig: { bench: 3 },
      },
    ])
    student = await addStudent(browser, classUrl)
  })

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = student = undefined
  })

  test('each role sees its own data and only its own role config', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)

    // the header names role and room; Data is the first tab
    await expect(t.locator('.status')).toContainText('teacher · Lobby')
    await expect(stu.locator('.status')).toContainText('student · Lobby')
    await expect(t.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true')

    await expect(field(t, 'Role')).toHaveText('teacher')
    await expect(field(stu, 'Role')).toHaveText('student')
    await expect(field(t, 'Username')).not.toBeEmpty()
    await expect(field(t, 'URL')).toHaveText(moduleUrl(MODULE))

    await expect(field(t, 'Config')).toContainText('"shared": "for everyone"')
    await expect(field(stu, 'Config')).toContainText('"shared": "for everyone"')

    await expect(field(t, 'Teacher config')).toContainText('"only": "teachers"')
    await expect(row(t, 'Student config')).toHaveCount(0)
    await expect(field(stu, 'Student config')).toContainText('"only": "students"')
    await expect(row(stu, 'Teacher config')).toHaveCount(0)

    await tab(stu, 'Messages')
    await expect(stu.getByText('No messages received yet...')).toBeVisible()
  })

  test('the station sees its own config', async () => {
    // the station window shares the teacher's browser, closed with it
    const station = await openStation(teacher!, classUrl)
    const st = await ready(station)

    await expect(field(st, 'Role')).toHaveText('station')
    await expect(field(st, 'Station config')).toContainText('"bench": 3')
    await expect(row(st, 'Teacher config')).toHaveCount(0)
    await expect(row(st, 'Student config')).toHaveCount(0)
  })

  test('shows where the module is shown', async () => {
    const t = await ready(teacher!)
    await expect(field(t, 'Shown in')).toHaveText('*', { timeout: 5_000 })
  })

  test('both peers are listed under People', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)
    const studentName = (await field(stu, 'Username').textContent())!.trim()
    const teacherName = (await field(t, 'Username').textContent())!.trim()

    const studentEntry = t.locator('details.user', { hasText: studentName })
    await expect(studentEntry).toHaveCount(1, { timeout: SYNC })
    await expect(studentEntry.locator('summary .role')).toHaveText('Student')
    await expect(t.locator('h2', { hasText: 'People' }).locator('.count')).toHaveText('2')

    const teacherEntry = stu.locator('details.user', { hasText: teacherName })
    await expect(teacherEntry).toHaveCount(1, { timeout: SYNC })
    await expect(teacherEntry.locator('summary .role')).toHaveText('Teacher')
  })

  test('a message sent to all reaches the other peer with its subject and body', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)
    const teacherName = (await field(t, 'Username').textContent())!.trim()
    const teacherDisplayName = (await field(t, 'Display name').textContent())!.trim()

    await send(t, 'greeting', 'hello class')

    await tab(stu, 'Messages')
    const entry = received(stu, 'greeting')
    await expect(entry).toHaveCount(1, { timeout: SYNC })
    await entry.locator('summary').click()
    // the sender by display name in the title and details, the username separately
    await expect(entry.locator('summary .from')).toHaveText(teacherDisplayName)
    await expect(entry.locator('summary .preview')).toHaveText('hello class')
    await expect(field(entry, 'From')).toHaveText(teacherDisplayName)
    await expect(field(entry, 'Sender username')).toHaveText(teacherName)
    await expect(field(entry, 'Body')).toHaveText('hello class')
    await expect(field(entry, 'Module')).toHaveText(moduleUrl(MODULE))
    await expect(stu.getByText('No messages received yet...')).toBeHidden()
  })

  test('a message sent to one user reaches only that user', async ({ browser }) => {
    const other = await addStudent(browser, classUrl)
    try {
      const t = await ready(teacher!)
      const stu = await ready(student!)
      const oth = await ready(other)
      const studentName = (await field(stu, 'Username').textContent())!.trim()
      await tab(stu, 'Messages')
      await tab(oth, 'Messages')

      // Messages are not stored: one sent before the teacher is connected to
      // the other student is lost. Ping until it arrives, so that "not received"
      // below means "not addressed to them".
      // If no ping arrives within the window although the student is listed as
      // present, suspect the WebRTC transport, not the module: a half-open peer
      // connection that never completed used to cut a peer off silently (fixed in
      // y-generic 3c15857/fa532ea; see _reviews/module-reference.md).
      let ping = 0
      await expect(async () => {
        await send(t, `ping ${++ping}`, 'are you there')
        await expect(received(oth, `ping ${ping}`)).toHaveCount(1, { timeout: 2_000 })
      }).toPass({ timeout: SYNC })

      // the recipient list fills from the live users
      await expect(t.locator(`select option[value="${studentName}"]`)).toBeAttached({ timeout: SYNC })
      await send(t, 'private', 'only for you', studentName)
      await expect(received(stu, 'private')).toHaveCount(1, { timeout: SYNC })

      // once a later broadcast has arrived, the private one would have too
      await send(t, 'public', 'for all')
      await expect(received(oth, 'public')).toHaveCount(1, { timeout: SYNC })
      await expect(received(oth, 'private')).toHaveCount(0)
    } finally {
      await closeSessions(other)
    }
  })

  test('a structured message body from another module is shown as JSON', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await t.evaluate(() => (window as any).Edrys.sendMessage('structured', { line: 42 }))

    await tab(stu, 'Messages')
    const entry = received(stu, 'structured')
    await expect(entry).toHaveCount(1, { timeout: SYNC })
    await entry.locator('summary').click()
    await expect(field(entry, 'Body')).toContainText('"line": 42', { timeout: 5_000 })
  })

  test('an opened message stays open when a newer one arrives', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await tab(stu, 'Messages')
    await send(t, 'first', 'one')
    await expect(received(stu, 'first')).toHaveCount(1, { timeout: SYNC })
    await received(stu, 'first').locator('summary').click()
    await expect(received(stu, 'first')).toHaveAttribute('open', '')

    await send(t, 'second', 'two')
    await expect(received(stu, 'second')).toHaveCount(1, { timeout: SYNC })
    await expect(received(stu, 'second')).not.toHaveAttribute('open', '', { timeout: 5_000 })
    await expect(received(stu, 'first')).toHaveAttribute('open', '')
  })

  test('evaluating the example writes room state that other peers and late joiners see', async ({ browser }) => {
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await tab(t, 'State')
    await t.getByRole('button', { name: 'Eval' }).click()

    // first locally, so a failure tells "Eval did not run" from "state did not sync"
    await expect(roomState(t)).toContainText('"option": 12')
    // the value of the snippet's last line (reference.counter) is shown under the editor
    await expect(t.locator('.eval-result')).toHaveText('12')
    await tab(stu, 'State')
    await expect(roomState(stu)).toContainText('"option": 12', { timeout: SYNC })
    await expect(roomState(stu)).toContainText('"option2": 13')
    // keys are prefixed, so they can't collide with another module's state in the room
    await expect(roomState(stu)).toContainText('"reference.demo": {')
    await expect(roomState(stu)).toContainText('"reference.counter": 12')

    const late = await addStudent(browser, classUrl)
    try {
      const lateFrame = await ready(late)
      await tab(lateFrame, 'State')
      await expect(roomState(lateFrame)).toContainText('"option": 12', { timeout: SYNC })
    } finally {
      await closeSessions(late)
    }
  })

  test('one tab is shown at a time; arrow keys switch tabs; Messages counts arrivals', async () => {
    const t = await ready(teacher!)
    const stu = await ready(student!)
    const panel = (frame: Frame, id: string) => frame.locator(`#panel-${id}`)

    await expect(panel(stu, 'data')).toBeVisible()
    await expect(panel(stu, 'messages')).toBeHidden()

    // keyboard: the selected tab has focus, arrows move to the neighbour and wrap
    await stu.getByRole('tab', { name: 'Data' }).focus()
    await student!.page.keyboard.press('ArrowRight')
    await expect(stu.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true')
    await expect(stu.getByRole('tab', { name: 'Messages' })).toBeFocused()
    await expect(panel(stu, 'messages')).toBeVisible()
    await expect(panel(stu, 'data')).toBeHidden()
    await student!.page.keyboard.press('ArrowLeft')
    await student!.page.keyboard.press('ArrowLeft')
    await expect(stu.getByRole('tab', { name: 'State' })).toHaveAttribute('aria-selected', 'true')

    // messages arriving while another tab is open are counted on the Messages tab
    await send(t, 'counted', 'x')
    await expect(stu.getByRole('tab', { name: 'Messages' }).locator('.count')).toHaveText('1', { timeout: SYNC })
  })

  test('an error in the evaluated code is shown, and a later run replaces it', async () => {
    const t = await ready(teacher!)
    await tab(t, 'State')
    const result = t.locator('.eval-result')
    await expect(result).toBeHidden()

    // `editor` is the page's CodeMirror instance (a top-level `let`)
    await t.evaluate(() => (globalThis as any).eval('editor').setValue('Edrys.noSuchFunction()'))
    await t.getByRole('button', { name: 'Eval' }).click()
    // browsers word the message differently (WebKit appends details)
    await expect(result).toContainText('TypeError: ')
    await expect(result).toContainText('noSuchFunction')
    await expect(result).toHaveClass(/failed/)

    await t.evaluate(() => (globalThis as any).eval('editor').setValue('1 + 1'))
    await t.getByRole('button', { name: 'Eval' }).click()
    await expect(result).toHaveText('2')
    await expect(result).not.toHaveClass(/failed/)
  })
})
