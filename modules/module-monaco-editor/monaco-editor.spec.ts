import { Browser, BrowserContext, Frame, Locator, expect, test } from '@playwright/test'
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
 * module-monaco-editor in a real edrys-Lite: a teacher and a student in the
 * lobby (the module is shown everywhere). The code is a Y.Text in the room's
 * shared state, so typing on one peer shows up on the others; Execute sends
 * the code (or the selection) as a message under `runCommand`.
 */

const MODULE = 'module-monaco-editor'
// the published URL is docs/index.html, built from src/ (npm run build);
// docs/ is not committed: run `npm run build` in the module before the tests
const ENTRY = 'docs/index.html'
// time for a change to travel between peers
const SYNC = 15_000

const CODE = 'int first = 1;\nint second = 2;'
// Both are opt-in: one shared document, and a language selector for teachers and stations.
const SHARED = { synchronize: true, showLanguageSelector: true }

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** Wait until onReady has created the editor, then close the side menu that covers it in the lobby. */
async function whenReady(s: Session, frame: Frame): Promise<Frame> {
  await expect(frame.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 })
  await expect(frame.locator('#lang-badge')).not.toBeEmpty()
  await closeSideMenu(s)
  return frame
}

/** The module's iframe, once the editor is up. */
async function ready(s: Session): Promise<Frame> {
  return whenReady(s, await moduleFrame(s, MODULE))
}

/** The iframe loaded from exactly `url`, for rooms with two editors (moduleFrame matches by prefix). */
async function readyAt(s: Session, url: string): Promise<Frame> {
  let frame: Frame | undefined
  await expect.poll(() => !!(frame = s.page.frames().find((f) => f.url() === url)), { timeout: 30_000 }).toBe(true)
  return whenReady(s, frame!)
}

/**
 * Scroll the app so this module's iframe is in the window. A "tall" module is
 * taller than the window, so `end` brings its bottom control bar into view.
 * Chromium also stops painting cross-origin iframes that are off-screen.
 */
async function scrollTo(frame: Frame, block: 'start' | 'end') {
  const element = await frame.frameElement()
  await element.evaluate((e, block) => (e as Element).scrollIntoView({ block }), block)
}

/** The editor's text as rendered. Monaco reuses line nodes, so order them by position. */
async function code(frame: Frame): Promise<string> {
  await scrollTo(frame, 'start')
  return frame.evaluate(() =>
    (Array.from(document.querySelectorAll('.view-lines .view-line')) as HTMLElement[])
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map((line) => (line.textContent || '').replace(/ /g, ' '))
      .join('\n')
  )
}

/**
 * Monaco's hidden input element. Send keys to it, not to `page.keyboard`:
 * after a click into a cross-origin iframe, Firefox can leave focus on the
 * app, and a typed `/` then opens its Quick Find bar instead of editing.
 */
const editorInput = (frame: Frame) => frame.locator('.monaco-editor textarea')

/** Type at the end of the code. Plain words only: Monaco auto-closes brackets and quotes. */
async function typeAtEnd(frame: Frame, text: string) {
  await scrollTo(frame, 'start')
  await frame.locator('.monaco-editor .view-lines').click()
  await editorInput(frame).press('Control+End')
  await editorInput(frame).pressSequentially(text)
}

/** Record the messages this frame receives from any module, to read them with `received()`. */
async function listen(frame: Frame) {
  await frame.evaluate(() => {
    const w = window as any
    w.__e2eMessages = []
    w.Edrys.onMessage((m: any) => w.__e2eMessages.push({ subject: m.subject, body: m.body }), true)
  })
}

const received = (frame: Frame): Promise<{ subject: string; body: string }[]> =>
  frame.evaluate(() => (window as any).__e2eMessages)

const execute = (frame: Frame) => frame.getByRole('button', { name: 'Execute' })
const reset = (frame: Frame) => frame.getByRole('button', { name: 'Reset' })

/** Click a button in the control bar, which sits at the bottom of the iframe. */
async function press(frame: Frame, button: (frame: Frame) => Locator) {
  await scrollTo(frame, 'end')
  await button(frame).click()
}
const languageSelect = (frame: Frame) => frame.locator('#lang-select')
const languageBadge = (frame: Frame) => frame.locator('#lang-badge')

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-monaco-editor', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  /** Teacher creates the class with `modules`, then a student joins the lobby. */
  async function start(browser: Browser, modules: ModuleEntry[]) {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, modules)
    student = await addStudent(browser, classUrl)
  }

  const withConfig = (config: object): ModuleEntry[] => [{ url: moduleUrl(MODULE, ENTRY), config }]

  test.afterEach(async () => {
    // a station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = student = undefined
  })

  test('each role sees the configured code once, and only its own controls', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE, language: 'python' }))
    const t = await ready(teacher!)
    const stu = await ready(student!)

    // the initial value is inserted once, not once per peer
    await expect.poll(() => code(t)).toBe(CODE)
    await expect.poll(() => code(stu)).toBe(CODE)

    // teacher: Execute, Reset (there is a value to reset to) and the language selector
    await expect(execute(t)).toBeVisible()
    await expect(reset(t)).toBeVisible()
    await expect(languageSelect(t)).toBeVisible()
    await expect(languageSelect(t)).toHaveValue('python')
    await expect(languageBadge(t)).toBeHidden()

    // student: Execute only; the language is shown, not selectable
    await expect(execute(stu)).toBeVisible()
    await expect(reset(stu)).toBeHidden()
    await expect(languageSelect(stu)).toBeHidden()
    await expect(languageBadge(stu)).toHaveText('python')
  })

  test('the station gets Reset and the language selector', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE }))
    // the station window shares the teacher's browser, closed with it
    const st = await ready(await openStation(teacher!, classUrl))

    await expect.poll(() => code(st)).toBe(CODE)
    await expect(execute(st)).toBeVisible()
    await expect(reset(st)).toBeVisible()
    await expect(languageSelect(st)).toBeVisible()
  })

  test('typing on one peer shows up on the other, both ways', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE }))
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await expect.poll(() => code(stu)).toBe(CODE)

    await expect(stu.locator('#sync-dot')).toHaveAttribute('aria-label', /^Shared/)

    await typeAtEnd(t, ' // from teacher')
    await expect.poll(() => code(stu), { timeout: SYNC }).toBe(`${CODE} // from teacher`)

    await typeAtEnd(stu, ' and student')
    await expect.poll(() => code(t), { timeout: SYNC }).toBe(`${CODE} // from teacher and student`)
  })

  test('Execute sends the code, or only the selection, under runCommand', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE, runCommand: 'e2e-run' }))
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await expect.poll(() => code(stu)).toBe(CODE)
    await listen(t)

    await press(stu, execute)
    await expect.poll(() => received(t), { timeout: SYNC }).toContainEqual({ subject: 'e2e-run', body: CODE })

    // select the last line
    await stu.locator('.monaco-editor .view-lines').click()
    await editorInput(stu).press('Control+End')
    await editorInput(stu).press('Shift+Home')
    await press(stu, execute)
    await expect.poll(() => received(t), { timeout: SYNC }).toContainEqual({ subject: 'e2e-run', body: 'int second = 2;' })
  })

  test('Reset restores the configured code for everyone', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE }))
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await typeAtEnd(stu, ' // broken')
    await expect.poll(() => code(t), { timeout: SYNC }).toBe(`${CODE} // broken`)

    await press(t, reset)
    await expect.poll(() => code(t)).toBe(CODE)
    await expect.poll(() => code(stu), { timeout: SYNC }).toBe(CODE)
  })

  test("the teacher's language choice reaches the students", async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE, language: 'cpp' }))
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await expect(languageBadge(stu)).toHaveText('cpp')

    await languageSelect(t).selectOption('python')
    await expect(languageBadge(stu)).toHaveText('python', { timeout: SYNC })
  })

  test('a student who joins later sees the current code', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE }))
    const t = await ready(teacher!)
    await typeAtEnd(t, ' // edited')

    const late = await addStudent(browser, classUrl)
    try {
      const frame = await ready(late)
      await expect.poll(() => code(frame), { timeout: SYNC }).toBe(`${CODE} // edited`)
    } finally {
      await closeSessions(late)
    }
  })

  test('a student who joins later sees the current language', async ({ browser }) => {
    await start(browser, withConfig({ ...SHARED, value: CODE, language: 'cpp' }))
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await languageSelect(t).selectOption('python')
    await expect(languageBadge(stu)).toHaveText('python', { timeout: SYNC })

    const late = await addStudent(browser, classUrl)
    try {
      const frame = await ready(late)
      await expect(languageBadge(frame)).toHaveText('python', { timeout: SYNC })
    } finally {
      await closeSessions(late)
    }
  })

  test('readOnly and theme are applied', async ({ browser }) => {
    await start(browser, withConfig({ value: CODE, readOnly: true, theme: 'vs-dark' }))
    const t = await ready(teacher!)
    const stu = await ready(student!)

    for (const frame of [t, stu]) {
      await expect(frame.locator('.monaco-editor.vs-dark')).toBeVisible()
      await expect(execute(frame)).toBeHidden()
      await expect(reset(frame)).toBeHidden()
    }

    // typing is a local action, so its absence shows right away
    await typeAtEnd(t, ' // not allowed')
    expect(await code(t)).toBe(CODE)
  })

  test('without synchronize, every peer edits its own copy', async ({ browser }) => {
    await start(browser, withConfig({ value: CODE }))
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await expect.poll(() => code(stu)).toBe(CODE)
    await expect(t.locator('#sync-dot')).toHaveAttribute('aria-label', /^Local only/)
    await listen(stu)

    await typeAtEnd(t, ' // only mine')
    // Execute travels the same way as a state update would; once the student
    // has the message, a synced edit would have arrived too.
    await press(t, execute)
    await expect.poll(() => received(stu), { timeout: SYNC }).toContainEqual({
      subject: 'execute',
      body: `${CODE} // only mine`,
    })
    expect(await code(stu)).toBe(CODE)
  })

  test('two editors with different editorIds in one room stay independent', async ({ browser }) => {
    const first = moduleUrl(MODULE, ENTRY)
    const second = moduleUrl(MODULE, `${ENTRY}?second`)
    await start(browser, [
      { url: first, config: { ...SHARED, editorId: 'one', value: '// first' } },
      { url: second, config: { ...SHARED, editorId: 'two', value: '// second' } },
    ])
    const t1 = await readyAt(teacher!, first)
    const s1 = await readyAt(student!, first)
    const s2 = await readyAt(student!, second)
    await expect.poll(() => code(s2)).toBe('// second')

    await typeAtEnd(t1, ' edited')
    await expect.poll(() => code(s1), { timeout: SYNC }).toBe('// first edited')
    expect(await code(s2)).toBe('// second')
  })

  test('a config saved with the settings form does what the teacher ticked', async ({ browser }) => {
    // What ModuleConfigForm saves when the teacher fills in value and language and
    // ticks only synchronize: other booleans false, radios on their first option,
    // the rest empty. Review finding #1: this used to switch synchronize off.
    await start(
      browser,
      withConfig({
        editorId: '',
        value: CODE,
        runCommand: '',
        language: 'python',
        theme: 'auto',
        synchronize: true,
        readOnly: false,
        showLanguageSelector: false,
      })
    )
    const t = await ready(teacher!)
    const stu = await ready(student!)

    // the teacher did not ask for the selector, so it shows the badge
    await expect(languageSelect(t)).toBeHidden()
    await expect(languageBadge(t)).toHaveText('python')

    await typeAtEnd(t, ' // from teacher')
    await expect.poll(() => code(stu), { timeout: SYNC }).toBe(`${CODE} // from teacher`)

    // empty fields fall back to their defaults
    await listen(t)
    await press(stu, execute)
    await expect.poll(() => received(t), { timeout: SYNC }).toContainEqual({
      subject: 'execute',
      body: `${CODE} // from teacher`,
    })
  })
})
