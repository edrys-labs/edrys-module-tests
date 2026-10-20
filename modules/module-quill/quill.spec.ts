import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { ModuleEntry, Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import { moduleFrame, moduleUrl, revealModuleTop, serveModules } from '../../lib/modules'

/**
 * module-quill in a real edrys-Lite: a teacher and a student in the lobby
 * (the module has no show-in, so it is shown everywhere). The document is a
 * Y.Text under the room key `quill-text`, bound to Quill with y-quill, so
 * edits on one peer show up on the others.
 */

const MODULE = 'module-quill'
// the published URL serves docs/index.html, the committed Parcel build of src/index.html
const ENTRY = 'docs/index.html'
// time for a change to travel between peers
const SYNC = 15_000

// a 1x1 PNG; Quill's uploader only checks the file type and inserts it as a data: URL
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const VIDEO = 'https://www.youtube.com/embed/dQw4w9WgXcQ'
// one document for the room; without it every person edits their own copy
const SHARED = { synchronize: true }
// the edrys.js URL modules load; serveModules answers it with the local one
const PUBLISHED_EDRYS_JS = 'https://edrys-labs.github.io/module/edrys.js'

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** Wait until onReady has created the editor, then close the side menu that covers it in the lobby. */
async function whenReady(s: Session, frame: Frame): Promise<Frame> {
  // not the toolbar: read-only students have none
  await expect(frame.locator('.ql-editor')).toBeVisible({ timeout: 30_000 })
  await expect(frame.locator('#status')).toBeHidden()
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

const editor = (frame: Frame) => frame.locator('.ql-editor')

/** The document as plain text (Quill's getText via the module's `window.editor`), without the trailing newline. */
const text = (frame: Frame) => frame.evaluate(() => ((window as any).editor.getText() as string).replace(/\n$/, ''))

/** Type at the end of the document. Keys go to the editor itself, not page.keyboard (see the monaco spec). */
async function typeAtEnd(frame: Frame, keys: string) {
  await editor(frame).click()
  await editor(frame).press('Control+End')
  await editor(frame).pressSequentially(keys)
}

/**
 * Click a toolbar button, e.g. `bold`, `link`, `formula`, `image`, `video`.
 * A click into the editor can scroll the toolbar under edrys-Lite's app bar, so reveal it first.
 */
async function tool(frame: Frame, name: string) {
  await revealModuleTop(frame)
  await frame.locator(`.ql-toolbar button.ql-${name}`).click()
}

/** Enter `value` in Quill's tooltip (link, video, formula) and save it with Enter. */
async function fillTooltip(frame: Frame, value: string) {
  const input = frame.locator('.ql-tooltip.ql-editing input[type=text]')
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
}

/**
 * Upload an image through the toolbar: the image button creates a hidden file
 * input and opens the picker. Playwright's filechooser event does not fire for
 * this cross-origin frame, so the file is set on that input, as the picker would.
 */
async function uploadImage(frame: Frame, name: string, buffer: Buffer) {
  await editor(frame).click()
  await editor(frame).press('Control+End')
  await tool(frame, 'image')
  await frame.locator('.ql-toolbar input.ql-image[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer })
}

/** A `width` × `height` PNG (a gradient), drawn on a canvas in `frame`. */
async function makePng(frame: Frame, width: number, height: number): Promise<Buffer> {
  const url = await frame.evaluate(
    ([width, height]) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, '#36c')
      gradient.addColorStop(1, '#fc3')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
      return canvas.toDataURL('image/png')
    },
    [width, height]
  )
  return Buffer.from(url.split(',')[1], 'base64')
}

/** Size in bytes of the image a data: URL holds. */
const dataUrlBytes = (url: string) => Math.ceil(((url.length - url.indexOf(',') - 1) * 3) / 4)

const BLOCKED_VIDEO = 'Video blocked: only YouTube and Vimeo videos can be embedded.'

// ---------------------------------------------------------------------------

test.describe('module-quill', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  /** Teacher creates the class with `modules`, then a student joins the lobby. */
  async function start(
    browser: Browser,
    modules: ModuleEntry[] = [{ url: moduleUrl(MODULE, ENTRY), config: SHARED }],
    prep: (context: BrowserContext) => Promise<void> = prepare
  ) {
    const created = await createClass(browser, prep)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, modules)
    student = await joinClass(browser, classUrl, prep)
  }

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = student = undefined
  })

  test('each role sees an empty, editable document with the toolbar', async ({ browser }) => {
    await start(browser)
    for (const frame of [await ready(teacher!), await ready(student!)]) {
      await expect(frame.locator('#status')).toBeHidden()
      await expect(frame.locator('.ql-toolbar .badge')).toHaveText('shared')
      await expect(editor(frame)).toHaveClass(/ql-blank/)
      await expect(editor(frame)).toHaveAttribute('data-placeholder', 'Start collaborating...')
      await expect(editor(frame)).toHaveAttribute('contenteditable', 'true')
      for (const name of ['bold', 'link', 'image', 'video', 'clean']) {
        await expect(frame.locator(`.ql-toolbar button.ql-${name}`)).toBeVisible()
      }
      // readable hover texts, also used as the accessible names
      await expect(frame.getByRole('button', { name: /^Bold \((Ctrl\+|⌘)B\)$/ })).toHaveAttribute('title', /^Bold/)
      await expect(frame.locator('.ql-toolbar button.ql-list[value=ordered]')).toHaveAttribute('title', 'Numbered list')
      await expect(frame.locator('.ql-toolbar .ql-picker.ql-color .ql-picker-label')).toHaveAttribute(
        'title',
        'Text colour'
      )
    }
  })

  test('typing and formatting on one peer show up on the other, both ways', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await typeAtEnd(t, 'Hello')
    await editor(t).press('Control+a')
    await tool(t, 'bold')
    await expect(t.locator('.ql-editor strong')).toHaveText('Hello')
    await expect(stu.locator('.ql-editor strong')).toHaveText('Hello', { timeout: SYNC })

    await typeAtEnd(stu, ' world')
    await expect.poll(() => text(t), { timeout: SYNC }).toBe('Hello world')
  })

  test('a student who joins later sees the current document', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    await typeAtEnd(t, 'Agenda')
    await editor(t).press('Enter')
    await editor(t).pressSequentially('warm-up first')
    // the first student has it, so the teacher's edit is out
    await expect.poll(async () => text(await ready(student!)), { timeout: SYNC }).toBe('Agenda\nwarm-up first')

    const late = await joinClass(browser, classUrl, prepare)
    try {
      await expect.poll(async () => text(await ready(late)), { timeout: SYNC }).toBe('Agenda\nwarm-up first')
    } finally {
      await closeSessions(late)
    }
  })

  test('an uploaded image and an embedded video reach the other peer', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await uploadImage(t, 'pixel.png', PIXEL)
    await expect(stu.locator('.ql-editor img')).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: SYNC })

    await tool(t, 'video')
    await fillTooltip(t, VIDEO)
    const video = stu.locator('.ql-editor iframe.ql-video')
    await expect(video).toHaveAttribute('src', VIDEO, { timeout: SYNC })
    await expect(video).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups')
  })

  test('a large photo is scaled down before it is shared', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await uploadImage(t, 'photo.png', await makePng(t, 3000, 2000))
    const image = stu.locator('.ql-editor img')
    await expect(image).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: SYNC })
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([
      1280, 853,
    ])
    expect(dataUrlBytes((await image.getAttribute('src'))!)).toBeLessThanOrEqual(500 * 1024)
  })

  test('images over the configured limit, or unreadable ones, are refused with a message', async ({ browser }) => {
    await start(browser, [{ url: moduleUrl(MODULE, ENTRY), config: { ...SHARED, maxImageKB: 1 } }])
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await uploadImage(t, 'photo.png', await makePng(t, 2000, 1000))
    await expect(t.locator('#status')).toHaveText(
      'Image not added: "photo.png" is too large even after scaling it down (limit 1 KB).'
    )

    await uploadImage(t, 'notes.png', Buffer.from('this is not an image'))
    await expect(t.locator('#status')).toHaveText('Image not added: "notes.png" could not be read as an image.')

    // still fine below the limit
    await uploadImage(t, 'pixel.png', PIXEL)
    await expect(stu.locator('.ql-editor img')).toHaveCount(1, { timeout: SYNC })
    await expect(t.locator('.ql-editor img')).toHaveCount(1)
    // the message goes away by itself
    await expect(t.locator('#status')).toBeHidden({ timeout: 15_000 })
  })

  test('YouTube and Vimeo watch links become players, also when typed with http', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    const links = {
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ': 'https://www.youtube.com/embed/dQw4w9WgXcQ?showinfo=0',
      'https://vimeo.com/76979871': 'https://player.vimeo.com/video/76979871/',
    }
    for (const link of Object.keys(links)) {
      await editor(t).click()
      await editor(t).press('Control+End')
      await tool(t, 'video')
      await fillTooltip(t, link)
    }
    await expect
      .poll(() => stu.locator('.ql-editor iframe.ql-video').evaluateAll((v) => v.map((f) => f.getAttribute('src'))), {
        timeout: SYNC,
      })
      .toEqual(Object.values(links))
  })

  test('videos from other sites are blocked for everyone', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await tool(t, 'video')
    await fillTooltip(t, 'https://example.com/login')
    for (const frame of [t, stu]) {
      const video = frame.locator('.ql-editor iframe.ql-video')
      await expect(video).toHaveAttribute('src', 'about:blank', { timeout: SYNC })
      await expect(video).toHaveAttribute('sandbox', '')
      await expect(video).toHaveAttribute('srcdoc', new RegExp(BLOCKED_VIDEO))
      await expect(frame.frameLocator('.ql-editor iframe.ql-video').getByText(BLOCKED_VIDEO)).toBeVisible()
    }
  })

  test('with blockRemoteImages, only images stored in the document are shown', async ({ browser }) => {
    await start(browser, [{ url: moduleUrl(MODULE, ENTRY), config: { ...SHARED, blockRemoteImages: true } }])
    const t = await ready(teacher!)
    const stu = await ready(student!)

    // a student links an image from another site, directly in the shared text
    await stu.evaluate(() => {
      const ytext = (window as any).ytext
      ytext.insertEmbed(0, { image: 'https://example.com/tracker.png' })
    })
    await expect(t.locator('.ql-editor img')).toHaveAttribute('src', '//:0', { timeout: SYNC })

    await uploadImage(t, 'pixel.png', PIXEL)
    await expect(stu.locator('.ql-editor img').nth(1)).toHaveAttribute('src', /^data:image\/png;base64,/, {
      timeout: SYNC,
    })
  })

  test('unsafe links and embeds written into the shared text by a peer are neutralised', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    // A student bypasses the toolbar and writes the Y.Text directly (the module exposes it as window.ytext).
    await stu.evaluate(() => {
      const ytext = (window as any).ytext
      ytext.insert(0, 'click me', { link: 'javascript:alert(document.domain)' })
      ytext.insertEmbed(ytext.length, { video: 'javascript:alert(1)' })
      ytext.insertEmbed(ytext.length, { image: 'javascript:alert(2)' })
    })

    await expect(t.locator('.ql-editor a')).toHaveText('click me', { timeout: SYNC })
    await expect(t.locator('.ql-editor a')).toHaveAttribute('href', 'about:blank')
    await expect(t.locator('.ql-editor iframe.ql-video')).toHaveAttribute('src', 'about:blank')
    await expect(t.locator('.ql-editor iframe.ql-video')).toHaveAttribute('srcdoc', new RegExp(BLOCKED_VIDEO))
    await expect(t.locator('.ql-editor img')).toHaveAttribute('src', '//:0')
  })

  test('a formula from the toolbar is rendered for everyone', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await typeAtEnd(t, 'Area: ')
    await tool(t, 'formula')
    await fillTooltip(t, 'a^2')
    for (const frame of [t, stu]) {
      const formula = frame.locator('.ql-editor .ql-formula')
      await expect(formula).toHaveAttribute('data-value', 'a^2', { timeout: SYNC })
      // rendered by KaTeX, not shown as TeX source; with KaTeX's CSS its MathML copy is
      // clipped to 1px (without it the formula shows twice)
      await expect(formula.locator('.katex-html')).toBeVisible()
      expect((await formula.locator('.katex-mathml').boundingBox())!.width).toBeLessThanOrEqual(1)
    }
  })

  test('when the shared text is replaced, every editor follows the new one', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)
    await typeAtEnd(t, 'old text')
    await expect.poll(() => text(stu), { timeout: SYNC }).toBe('old text')

    await stu.evaluate(() => {
      const room = (window as any).Edrys.getState()
      // edrys.js's own Y.Text class, taken from the existing value
      const YText = room.get('quill-text').constructor
      const replacement = new YText()
      replacement.insert(0, 'new text')
      room.set('quill-text', replacement)
    })
    await expect.poll(() => text(t), { timeout: SYNC }).toBe('new text')

    // and both sides keep editing the same document afterwards
    await typeAtEnd(t, ' from teacher')
    await expect.poll(() => text(stu), { timeout: SYNC }).toBe('new text from teacher')
  })

  test('two Quill modules with different editorIds in one room keep separate documents', async ({ browser }) => {
    const first = moduleUrl(MODULE, ENTRY)
    const second = moduleUrl(MODULE, `${ENTRY}?second`)
    await start(browser, [
      { url: first, config: { ...SHARED, editorId: 'one' } },
      { url: second, config: { ...SHARED, editorId: 'two' } },
    ])
    const t1 = await readyAt(teacher!, first)
    const s1 = await readyAt(student!, first)
    const s2 = await readyAt(student!, second)

    await typeAtEnd(t1, 'only in the first')
    await expect.poll(() => text(s1), { timeout: SYNC }).toBe('only in the first')
    expect(await text(s2)).toBe('')
  })

  test('without synchronize, each person edits their own copy, kept across reloads', async ({ browser }) => {
    const local = moduleUrl(MODULE, ENTRY)
    // a shared editor in the same room, used as a barrier: once the student sees what the
    // teacher typed there afterwards, a synced local edit would have arrived as well
    const barrier = moduleUrl(MODULE, `${ENTRY}?barrier`)
    await start(browser, [{ url: local }, { url: barrier, config: { ...SHARED, editorId: 'barrier' } }])
    const t = await readyAt(teacher!, local)
    const stu = await readyAt(student!, local)

    for (const frame of [t, stu]) {
      await expect(frame.locator('.ql-toolbar .badge')).toHaveText('local only')
      await expect(editor(frame)).toHaveAttribute('data-placeholder', 'Start writing...')
    }

    await typeAtEnd(t, 'teacher copy')
    await typeAtEnd(await readyAt(teacher!, barrier), 'go')
    await expect.poll(async () => text(await readyAt(student!, barrier)), { timeout: SYNC }).toBe('go')
    expect(await text(stu)).toBe('')

    // the copy is saved in the teacher's browser
    await teacher!.page.reload()
    await expect.poll(async () => text(await readyAt(teacher!, local)), { timeout: SYNC }).toBe('teacher copy')
  })

  test('students with readOnly can read the shared document but not edit it', async ({ browser }) => {
    await start(browser, [{ url: moduleUrl(MODULE, ENTRY), config: SHARED, studentConfig: { readOnly: true } }])
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await expect(editor(stu)).toHaveAttribute('contenteditable', 'false')
    await expect(stu.locator('.ql-toolbar')).toBeHidden()
    await expect(editor(stu)).toHaveAttribute('data-placeholder', 'Nothing here yet.')
    await expect(editor(t)).toHaveAttribute('contenteditable', 'true')
    await expect(t.locator('.ql-toolbar')).toBeVisible()

    await typeAtEnd(t, 'Read this first')
    await expect.poll(() => text(stu), { timeout: SYNC }).toBe('Read this first')
  })

  test('the placeholder and the basic toolbar are applied', async ({ browser }) => {
    await start(browser, [
      { url: moduleUrl(MODULE, ENTRY), config: { ...SHARED, placeholder: 'Your answer…', toolbar: 'basic' } },
    ])
    const t = await ready(teacher!)
    await expect(editor(t)).toHaveAttribute('data-placeholder', 'Your answer…')
    for (const name of ['bold', 'list', 'link', 'image', 'formula']) {
      await expect(t.locator(`.ql-toolbar button.ql-${name}`).first()).toBeVisible()
    }
    for (const name of ['video', 'code-block', 'script', 'direction']) {
      await expect(t.locator(`.ql-toolbar button.ql-${name}`)).toHaveCount(0)
    }
    await expect(t.locator('.ql-toolbar .ql-picker')).toHaveCount(0)
  })

  test("the others' cursors are shown with their name, and go away when they leave", async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const stu = await ready(student!)

    await typeAtEnd(t, 'Hello')
    const cursor = stu.locator('.ql-cursor')
    await expect(cursor).toHaveCount(1, { timeout: SYNC })
    // the short peer id, as in module-monaco-editor's cursor labels, kept visible: quill-cursors
    // would hide it 3 s after the last move (a timer, so this waits on purpose)
    const name = cursor.locator('.ql-cursor-name')
    await expect(name).toHaveText(/^[0-9a-f]{8}$/)
    // on the first line the label still fits inside the editor, not under the toolbar
    const top = (selector: string) => stu.locator(selector).evaluate((e) => e.getBoundingClientRect().top)
    expect(await top('.ql-cursor .ql-cursor-flag')).toBeGreaterThanOrEqual(await top('.ql-container'))
    await student!.page.waitForTimeout(3_500)
    await expect(name).toBeVisible()
    await expect(cursor.locator('.ql-cursor-caret')).toHaveCSS('background-color', /^rgb/)

    // a second student joins, types, and closes the page
    const late = await joinClass(browser, classUrl, prepare)
    try {
      await typeAtEnd(await ready(late), ' world')
      await expect(cursor).toHaveCount(2, { timeout: SYNC })
      await late.page.close({ runBeforeUnload: true })
      await expect(cursor).toHaveCount(1, { timeout: SYNC })
    } finally {
      await closeSessions(late)
    }
  })

  test('the whole editor fits inside the module frame', async ({ browser }) => {
    await start(browser)
    const t = await ready(teacher!)
    const overflow = () =>
      t.evaluate(() => document.querySelector('.ql-container')!.getBoundingClientRect().bottom - window.innerHeight)

    expect(await overflow()).toBeLessThanOrEqual(0)
    // a narrower window wraps the toolbar into more rows
    await teacher!.page.setViewportSize({ width: 700, height: 720 })
    await expect.poll(() => t.evaluate(() => window.innerWidth)).toBeLessThan(700)
    await expect.poll(overflow).toBeLessThanOrEqual(0)
  })

  test('in dark mode the editor follows the dark theme', async ({ browser }) => {
    await start(browser)
    await teacher!.page.emulateMedia({ colorScheme: 'dark' })
    const t = await ready(teacher!)

    // the vs-dark surface of module-monaco-editor, and toolbar icons in its bar text colour instead of Quill's #444
    await expect.poll(() => t.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(30, 30, 30)')
    await expect
      .poll(() => t.evaluate(() => getComputedStyle(document.querySelector('.ql-toolbar .ql-bold .ql-stroke')!).stroke))
      .toBe('rgb(204, 204, 204)')
  })

  test('until the classroom is ready, the module says it is loading', async ({ browser }) => {
    // edrys.js whose onReady never fires, as when the classroom never connects
    await start(browser, undefined, async (context) => {
      await prepare(context)
      await context.route(PUBLISHED_EDRYS_JS, (route) =>
        route.fulfill({ contentType: 'text/javascript', body: 'window.Edrys = { onReady() {} }' })
      )
    })
    const frame = await moduleFrame(teacher!, MODULE)
    await expect(frame.locator('#status')).toHaveText('Loading editor…')
    await expect(frame.locator('.ql-toolbar')).toHaveCount(0)
    // after a while it explains why
    await expect(frame.locator('#status')).toContainText('Still waiting for the classroom to connect', {
      timeout: 15_000,
    })
  })

  test('when edrys.js cannot be loaded, the module shows an error', async ({ browser }) => {
    await start(browser, undefined, async (context) => {
      await prepare(context)
      await context.route(PUBLISHED_EDRYS_JS, (route) => route.fulfill({ status: 404, body: 'not found' }))
    })
    const frame = await moduleFrame(teacher!, MODULE)
    const status = frame.locator('#status')
    await expect(status).toHaveRole('alert')
    await expect(status).toContainText('Could not start the editor: edrys.js could not be loaded.')
    await expect(status).toContainText('check the module URL in the class settings')
  })
})
