import { Browser, BrowserContext, Frame, Page, expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  ModuleEntry,
  Session,
  closeSessions,
  closeSideMenu,
  createClass,
  joinClass,
  openStation,
  setModules,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * code-logger in a real edrys-Lite: a teacher and a student in the lobby
 * (the module is shown everywhere). The teacher starts monitoring, and every
 * `execute` message sent in the room (by any module, e.g. module-monaco-editor)
 * is listed with its sender and date, kept in the teacher's IndexedDB, and can
 * be downloaded as JSON and loaded again.
 *
 * Nothing is shared state: the log lives only in the browser that monitors.
 */

const MODULE = 'code-logger'
const ENTRY = 'index.html'
// the editor that sends `execute`; docs/ is built from src/ (npm run build in the module)
const EDITOR = 'module-monaco-editor'
const EDITOR_ENTRY = 'docs/index.html'
// The logger is teacher-only by default (show-in "*, teacher-only"), so students send their
// code from another module that every role gets
const SENDER = 'module-reference'
// time for a message to travel between peers
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once Edrys is ready. What onReady renders depends on
 * the role (controls for teachers, a note for others), so wait for
 * `Edrys.ready` itself: messages are only delivered from then on.
 */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  // a frame that is still (re)loading reads as not ready
  await expect
    .poll(() => frame.evaluate(() => (window as any).Edrys?.ready === true).catch(() => false), { timeout: 30_000 })
    .toBe(true)
  await closeSideMenu(s)
  return frame
}

/** The student's sending module, once Edrys is ready in it. */
async function sender(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, SENDER)
  await expect
    .poll(() => frame.evaluate(() => (window as any).Edrys?.ready === true).catch(() => false), { timeout: 30_000 })
    .toBe(true)
  await closeSideMenu(s)
  return frame
}

/** Send `body` under `subject` from this frame, as an editor's Execute button does. */
const send = (frame: Frame, body: unknown, subject = 'execute') =>
  frame.evaluate(([subject, body]) => (window as any).Edrys.sendMessage(subject, body), [subject, body] as const)

/** Record the bodies this frame receives from any module, to read them with `received()`. */
async function listen(frame: Frame) {
  await frame.evaluate(() => {
    const w = window as any
    w.__e2eMessages = []
    w.Edrys.onMessage((m: any) => w.__e2eMessages.push(m.body), true)
  })
}

const received = (frame: Frame): Promise<unknown[]> => frame.evaluate(() => (window as any).__e2eMessages)

/** The frame's Edrys username, which the logger keeps as "FromId". */
const usernameOf = (frame: Frame) => frame.evaluate(() => (window as any).Edrys.username as string)

/** The name edrys shows for the frame's user, which the logger shows as "From". */
const displayNameOf = (frame: Frame) => frame.evaluate(() => (window as any).Edrys.liveUser.displayName as string)

const button = (frame: Frame, name: string) => frame.getByRole('button', { name, exact: true })
const backButton = (frame: Frame) => button(frame, 'Back')
const prevButton = (frame: Frame) => button(frame, 'Previous page')
const nextButton = (frame: Frame) => button(frame, 'Next page')
const badge = (frame: Frame) => frame.locator('#status-badge')
const emptyState = (frame: Frame) => frame.locator('#empty-log')
const startButton = (frame: Frame) => button(frame, 'Start Monitoring')
const entries = (frame: Frame) => frame.locator('.submission-wrapper')
const codes = (frame: Frame) => frame.locator('.submission-wrapper code')

/** Start monitoring on the teacher's logger. */
async function startMonitoring(frame: Frame) {
  await startButton(frame).click()
  await expect(button(frame, 'Stop')).toBeVisible()
}

/** Click Download and return the saved file's name and parsed content. */
async function download(page: Page, frame: Frame): Promise<{ name: string; content: any }> {
  const [file] = await Promise.all([page.waitForEvent('download'), button(frame, 'Download').click()])
  return { name: file.suggestedFilename(), content: JSON.parse(readFileSync(await file.path(), 'utf8')) }
}

/** Click "Load Logs from File" and pick a file with `content`. */
async function loadFile(page: Page, frame: Frame, content: string) {
  mkdirSync(test.info().outputDir, { recursive: true })
  const path = join(test.info().outputDir, 'upload.json')
  writeFileSync(path, content)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button(frame, 'Load Logs from File').click()])
  await chooser.setFiles(path)
}

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('code-logger', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  /** Teacher creates the class with `modules` and the sending module, then a student joins the lobby. */
  async function start(browser: Browser, modules: ModuleEntry[] = [{ url: moduleUrl(MODULE, ENTRY) }]) {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    await setModules(teacher, [...modules, { url: moduleUrl(SENDER, 'index.html') }])
    classUrl = created.classUrl
    student = await addStudent(browser, classUrl)
  }

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = student = undefined
  })

  test('the teacher sees the start screen and an empty log after starting', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)

    await expect(startButton(t)).toBeVisible()
    await expect(button(t, 'Load Logs from DB')).toBeVisible()
    await expect(button(t, 'Load Logs from File')).toBeVisible()
    // which room is logged, and that it only covers this room (review finding #7)
    const room = await t.evaluate(() => (window as any).Edrys.liveUser.room as string)
    await expect(t.locator('#room-name')).toHaveText(room)
    await expect(t.locator('.hint.main')).toContainText('this room')
    await expect(badge(t)).toHaveText('idle')

    await startMonitoring(t)
    await expect(badge(t)).toHaveText('monitoring')
    await expect(entries(t)).toHaveCount(0)
    await expect(emptyState(t)).toHaveText('No code has been run in this room yet. Waiting…')
    await expect(startButton(t)).toBeHidden()
    // nothing to download yet
    await expect(button(t, 'Download')).toBeDisabled()
    // Back is disabled while monitoring, Clear until stopped
    await expect(button(t, 'Clear')).toBeDisabled()
    await expect(backButton(t)).toBeDisabled()

    await button(t, 'Stop').click()
    await expect(badge(t)).toHaveText('stopped')
    await expect(emptyState(t)).toHaveText('This log is empty.')
    await backButton(t).click()
    await expect(badge(t)).toHaveText('idle')
    await expect(startButton(t)).toBeVisible()
  })

  test("a student's Execute in module-monaco-editor is logged on the teacher's side", async ({ browser }) => {
    await start(browser, [
      { url: moduleUrl(MODULE, ENTRY) },
      { url: moduleUrl(EDITOR, EDITOR_ENTRY), config: { value: 'int led = 13;' } },
    ])
    const t = await ready(teacher!)
    await startMonitoring(t)

    const editor = await moduleFrame(student!, EDITOR)
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 })
    await closeSideMenu(student!)
    const editorElement = await editor.frameElement()
    await editorElement.evaluate((e) => (e as Element).scrollIntoView({ block: 'end' }))
    await button(editor, 'Execute').click()

    await expect(codes(t)).toHaveText(['int led = 13;'], { timeout: SYNC })
    const from = await displayNameOf(await sender(student!))
    await expect(entries(t).first()).toContainText(`From: ${from}`)
    await expect(entries(t).first()).toContainText('Date:')
  })

  test('only `execute` messages sent while monitoring are logged', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await listen(t)

    // before Start: not logged
    await send(stu, 'before start')
    await expect.poll(() => received(t), { timeout: SYNC }).toContain('before start')
    await startMonitoring(t)
    await send(stu, 'other subject', 'run')
    await send(stu, 'logged')
    await expect(codes(t)).toHaveText(['logged'], { timeout: SYNC })

    // after Stop: not logged any more
    await button(t, 'Stop').click()
    await send(stu, 'after stop')
    await expect.poll(() => received(t), { timeout: SYNC }).toContain('after stop')
    await expect(codes(t)).toHaveText(['logged'])
  })

  test('code that looks like HTML is shown as text', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)

    const code = '#include <stdio.h>\n<img src=x onerror="document.body.dataset.pwned=1">'
    await send(stu, code)
    await expect(codes(t)).toHaveText([code], { timeout: SYNC })
    await expect(t.locator('body[data-pwned]')).toHaveCount(0)
  })

  test('ten entries per page, with Previous and Next', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)

    for (let i = 1; i <= 11; i++) await send(stu, `run ${i}`)
    await expect(entries(t)).toHaveCount(10, { timeout: SYNC })
    await expect(codes(t).first()).toHaveText('run 1')
    await expect(prevButton(t)).toBeDisabled()
    await expect(nextButton(t)).toBeEnabled({ timeout: SYNC })
    await expect(t.locator('#page-info')).toHaveText('1 / 2')

    await nextButton(t).click()
    await expect(codes(t)).toHaveText(['run 11'])
    await expect(t.locator('#page-info')).toHaveText('2 / 2')
    await expect(nextButton(t)).toBeDisabled()
    await prevButton(t).click()
    await expect(entries(t)).toHaveCount(10)
  })

  test('Clear empties the log after Stop', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)
    await send(stu, 'to be cleared')
    await expect(entries(t)).toHaveCount(1, { timeout: SYNC })

    await button(t, 'Stop').click()
    await button(t, 'Clear').click()
    await expect(entries(t)).toHaveCount(0)
  })

  test('a log is kept in the browser and can be loaded again', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)
    for (const code of ['saved one', 'saved two', 'saved three', 'saved four']) await send(stu, code)
    await expect(entries(t)).toHaveCount(4, { timeout: SYNC })

    await button(t, 'Stop').click()
    await backButton(t).click()
    await expect(entries(t)).toHaveCount(0)

    // the dialog asks for a choice first
    await button(t, 'Load Logs from DB').click()
    await button(t, 'Load').click()
    await expect(t.locator('#load-error')).toHaveText('Please select a log.')

    await t.locator('#logs-select').selectOption({ index: 1 })
    await button(t, 'Load').click()
    // in the order they arrived
    await expect(codes(t)).toHaveText(['saved one', 'saved two', 'saved three', 'saved four'])
    // a loaded log is not live
    await expect(button(t, 'Stop')).toBeDisabled()
  })

  test('a downloaded log can be loaded from the file', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)
    await send(stu, 'void loop() {}')
    await expect(entries(t)).toHaveCount(1, { timeout: SYNC })
    await button(t, 'Stop').click()

    const file = await download(teacher!.page, t)
    expect(file.name).toMatch(/^code-log_.+\.json$/)
    expect(file.content).toEqual([
      expect.objectContaining({
        From: await displayNameOf(stu),
        FromId: await usernameOf(stu),
        Code: 'void loop() {}',
        Date: expect.any(String),
      }),
    ])

    await backButton(t).click()
    await loadFile(teacher!.page, t, JSON.stringify(file.content))
    await expect(codes(t)).toHaveText(['void loop() {}'])
    await expect(entries(t).first()).toContainText(`From: ${await displayNameOf(stu)}`)
    await expect(badge(t)).toHaveText('loaded from file')
  })

  test('a file that is not JSON is rejected with a message', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)

    const dialog = teacher!.page.waitForEvent('dialog')
    await loadFile(teacher!.page, t, 'not json')
    const alert = await dialog
    expect(alert.message()).toContain('Invalid file format')
    await alert.accept()
    await expect(startButton(t)).toBeVisible()
  })

  // Review finding #8: the logged subject was fixed to `execute` (fixed)
  test('runCommand sets the logged subjects', async ({ browser }) => {
    await start(browser, [{ url: moduleUrl(MODULE, ENTRY), config: { runCommand: 'run, flash' } }])
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await listen(t)
    await expect(t.locator('#subjects')).toHaveText('run, flash')

    await startMonitoring(t)
    await send(stu, 'not logged', 'execute')
    await expect.poll(() => received(t), { timeout: SYNC }).toContain('not logged')
    await send(stu, 'via run', 'run')
    await send(stu, 'via flash', 'flash')
    await expect(codes(t)).toHaveText(['via run', 'via flash'], { timeout: SYNC })
  })

  test('an empty runCommand, as the settings form saves it, logs `execute`', async ({ browser }) => {
    await start(browser, [{ url: moduleUrl(MODULE, ENTRY), config: { runCommand: '' } }])
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await expect(t.locator('#subjects')).toHaveText('execute')

    await startMonitoring(t)
    await send(stu, 'default subject')
    await expect(codes(t)).toHaveText(['default subject'], { timeout: SYNC })
  })

  // Review finding #9: IndexedDB mixed all classes and swallowed errors (fixed)
  test('saved logs: only this class is listed, older logs still load', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)
    await send(stu, 'this class')
    await expect(entries(t)).toHaveCount(1, { timeout: SYNC })
    await button(t, 'Stop').click()
    await backButton(t).click()

    // a log of another class, and one saved before classes were stored
    await t.evaluate(async () => {
      const db = (0, eval)('db')
      await db.logs.put({ id: 'other', classId: 'another-class', room: 'Elsewhere', startedAt: new Date().toISOString() })
      await db.entries.add({ logId: 'other', From: 'x', Date: 'y', Code: 'other class' })
      await db.logs.put({
        id: 'User: abc_Station 1_Date: 1/2/2025, 10:00:00 AM',
        studentsSubmissions: [{ From: 'old', Date: '1/2/2025', Code: 'older format' }],
      })
    })

    await button(t, 'Load Logs from DB').click()
    const options = t.locator('#logs-select option:not([disabled])')
    await expect(options).toHaveCount(2)
    await expect(options.nth(0)).toContainText(await t.evaluate(() => (window as any).Edrys.liveUser.room))
    await expect(options.nth(1)).toHaveText('Station 1 - 1/2/2025, 10:00:00 AM (older format)')
    await expect(t.locator('#logs-select')).not.toContainText('Elsewhere')

    await t.locator('#logs-select').selectOption({ index: 2 })
    await button(t, 'Load').click()
    await expect(codes(t)).toHaveText(['older format'])
  })

  test('logs saved by the previous version survive the database upgrade', async ({ browser }) => {
    await start(browser)
    let t = await ready(teacher!)

    // Replace the database with one as the published module (Dexie version 1 = IndexedDB version 10) left it
    await t.evaluate(async () => {
      ;(0, eval)('db').close()
      const done = (request: IDBRequest | IDBOpenDBRequest) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      await done(indexedDB.deleteDatabase('CodeLogger'))
      const open = indexedDB.open('CodeLogger', 10)
      open.onupgradeneeded = () => open.result.createObjectStore('logs', { keyPath: 'id' })
      const idb = (await done(open)) as IDBDatabase
      const store = idb.transaction('logs', 'readwrite').objectStore('logs')
      await done(
        store.put({
          id: 'User: abc_Station 2_Date: 3/4/2025, 9:00:00 AM',
          studentsSubmissions: [{ From: 'old', Date: '3/4/2025', Code: 'kept after upgrade' }],
        })
      )
      idb.close()
    })

    // the module opens the database again with the new schema
    await t.evaluate(() => location.reload())
    t = await ready(teacher!)
    await button(t, 'Load Logs from DB').click()
    await expect(t.locator('#logs-select option:not([disabled])')).toHaveText([
      'Station 2 - 3/4/2025, 9:00:00 AM (older format)',
    ])
    await t.locator('#logs-select').selectOption({ index: 1 })
    await button(t, 'Load').click()
    await expect(codes(t)).toHaveText(['kept after upgrade'])
  })

  test('a log that cannot be saved is still shown, with an error', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    // e.g. the browser's storage quota is used up
    await t.evaluate(() => {
      const db = (0, eval)('db')
      db.entries.add = () => Promise.reject(new DOMException('full', 'QuotaExceededError'))
    })

    await startMonitoring(t)
    await send(stu, 'still shown')
    await expect(codes(t)).toHaveText(['still shown'], { timeout: SYNC })
    await expect(t.locator('#storage-error')).toContainText('Could not save the log in this browser (QuotaExceededError)')
    await expect(t.locator('#storage-error')).toContainText('download the log')
  })

  // Review finding #6: a loaded file replaces the log before it is validated (fixed)
  test('a JSON file that is not a code log is rejected and monitoring still works', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)

    const dialog = teacher!.page.waitForEvent('dialog')
    await loadFile(teacher!.page, t, JSON.stringify({ not: 'a log' }))
    const alert = await dialog
    expect(alert.message()).toContain('Invalid file format')
    await alert.accept()

    await startMonitoring(t)
    await send(stu, 'after a bad file')
    await expect(codes(t)).toHaveText(['after a bad file'], { timeout: SYNC })
  })

  // Review finding #1: Download stays disabled after Clear (fixed)
  test('Download works again after Clear', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)
    await button(t, 'Stop').click()
    await button(t, 'Clear').click()
    await backButton(t).click()

    await startMonitoring(t)
    await send(stu, 'second session')
    await expect(entries(t)).toHaveCount(1, { timeout: SYNC })
    await expect(button(t, 'Download')).toBeEnabled({ timeout: 2_000 })
  })

  // Review finding #2: From/Date are inserted as HTML (fixed)
  test('sender and date from a loaded file are shown as text', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)

    const from = '<img src=x onerror="document.body.dataset.pwned=1">'
    await loadFile(teacher!.page, t, JSON.stringify([{ From: from, Date: '1.1.2026', Code: 'int x;' }]))
    await expect(codes(t)).toHaveText(['int x;'])
    await expect(t.locator('body[data-pwned]')).toHaveCount(0, { timeout: 2_000 })
    await expect(entries(t).first()).toContainText(from, { timeout: 2_000 })
  })

  // Review finding #3: a message whose body is not a string breaks the log (fixed)
  test('a message with a non-string body does not stop later code from being logged', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await sender(student!)
    await startMonitoring(t)

    await send(stu, { file: { 'main.cpp': 'int a;' } })
    await send(stu, 'still logged')
    await expect(entries(t).filter({ hasText: 'still logged' })).toHaveCount(1, { timeout: SYNC })
  })

  // Review finding #4: students can monitor everyone's code (fixed by show-in "*, teacher-only")
  test('by default only teachers get the logger', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    await expect(startButton(t)).toBeVisible()

    // once the student's and the station's other module is there, the logger would be too
    await sender(student!)
    expect(student!.page.frames().some((f) => f.url().startsWith(moduleUrl(MODULE)))).toBe(false)

    const station = await openStation(teacher!, classUrl)
    await sender(station)
    expect(station.page.frames().some((f) => f.url().startsWith(moduleUrl(MODULE)))).toBe(false)
  })
})
