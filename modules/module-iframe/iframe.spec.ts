import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, joinClass, openStation, setModules } from '../../lib/edrys'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODULES_DIR, moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-iframe in a real edrys-Lite: a teacher and a student in the lobby
 * (the module is shown everywhere), plus a station for stationConfig.
 *
 * The module sets <meta name="fetch">, so edrys-Lite inlines it as a data:
 * URL; INLINE (its empty-state message) identifies that frame.
 *
 * The embedded pages come from EMBED_ORIGIN, a fake site answered by the test,
 * so they are cross-origin to the module as a real external page would be.
 */

const MODULE = 'module-iframe'
const INLINE = 'Nothing to show yet'
const EMBED_ORIGIN = 'http://e2e-embed.test'
// time for a change to travel between peers
const SYNC = 15_000

/** A page of the fake site: shows its path, and whether it may go fullscreen. */
function embedPage(path: string) {
  return `<!DOCTYPE html>
<html>
  <body>
    <h1>Embedded ${path}</h1>
    <p id="fullscreen"></p>
    <script>
      document.getElementById('fullscreen').textContent = 'fullscreen: ' + document.fullscreenEnabled
    </script>
  </body>
</html>`
}

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await context.route(`${EMBED_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: embedPage(new URL(route.request().url()).pathname) })
  )
}

const page = (path: string) => `${EMBED_ORIGIN}${path}`

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's own iframe that holds the embedded page, once onReady has set
 * its src or srcdoc. Re-resolved each call: the module frame is replaced when
 * the module reloads (e.g. after a config change).
 */
async function embedded(s: Session): Promise<Frame> {
  let child: Frame | undefined
  await expect
    .poll(
      async () => {
        const frame = await moduleFrame(s, MODULE, 30_000, INLINE)
        child = frame.childFrames()[0]
        // the iframe starts with an empty src, i.e. about:blank
        return !!child && child.url() !== 'about:blank'
      },
      { timeout: 30_000, message: `embedded frame of ${MODULE}` }
    )
    .toBe(true)
  return child!
}

/** The text of the embedded page; '' while the frame is being replaced. */
async function shownText(s: Session): Promise<string> {
  const child = await embedded(s)
  return child
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch(() => '')
}

/** What edrys-Lite's settings form saves for an untouched section of the module's schema: every field ''. */
function formDefaults(section: string): Record<string, string> {
  const html = readFileSync(join(MODULES_DIR, MODULE, 'index.html'), 'utf8')
  const content = html.match(/name="module-config"\s+content="([^"]*)"/)![1]
  // the schema is a JS-style object literal (single quotes, trailing commas)
  // eslint-disable-next-line no-new-func
  const schema = new Function(`return (${content})`)()[section]
  return Object.fromEntries(Object.keys(schema).map((key) => [key, '']))
}

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-iframe', () => {
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
  })

  test('src: every role sees the configured page', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { src: page('/task') } }])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => shownText(teacher!), { timeout: SYNC }).toContain('Embedded /task')
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /task')
    expect((await embedded(student)).url()).toBe(page('/task'))
  })

  test('srcdoc: inline HTML is rendered', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        config: { srcdoc: '<h1 id="inline">Inline task</h1><button onclick="this.textContent=\'clicked\'">go</button>' },
      },
    ])
    student = await addStudent(browser, classUrl)

    const child = await embedded(student)
    await expect(child.locator('#inline')).toHaveText('Inline task')
    // scripts in the HTML run
    await closeSideMenu(student)
    await child.getByRole('button', { name: 'go' }).click()
    await expect(child.getByRole('button')).toHaveText('clicked')
  })

  test('src takes precedence over srcdoc', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        config: { src: page('/wins'), srcdoc: '<p>should not be shown</p>' },
      },
    ])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /wins')
    expect(await shownText(student)).not.toContain('should not be shown')
  })

  test('a page changed by the teacher during class reaches students without a reload', async ({ browser }) => {
    // edrys-Lite reloads the module's iframe when its configuration changes
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { src: page('/old') } }])
    student = await addStudent(browser, classUrl)
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /old')

    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { src: page('/new') } }])
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /new')
  })

  test('each role sees the page from its own config', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        config: { src: page('/general') },
        teacherConfig: { src: page('/solution') },
        studentConfig: { src: page('/exercise') },
        stationConfig: { srcdoc: '<p>station view</p>' },
      },
    ])
    student = await addStudent(browser, classUrl)
    const station = await openStation(teacher!, classUrl)

    await expect.poll(() => shownText(teacher!), { timeout: SYNC }).toContain('Embedded /solution')
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /exercise')
    await expect.poll(() => shownText(station), { timeout: SYNC }).toContain('station view')
  })

  test('a class without a general config still uses the role config', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        // parses to null, like a module entry without a config key (e.g. an imported class)
        config: 'null',
        studentConfig: { src: page('/exercise') },
      },
    ])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /exercise')
  })

  // in Firefox this also needs `fullscreen *` in edrys-Lite's module iframe (Module.vue): a bare
  // `fullscreen` only allows the src origin, which an inlined (data:) module never matches
  test('an embedded page may go fullscreen (e.g. a video player)', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { src: page('/video') } }])
    student = await addStudent(browser, classUrl)

    const child = await embedded(student)
    await expect(child.locator('#fullscreen')).toHaveText('fullscreen: true', { timeout: SYNC })
  })

  test('without a page configured, the module says what to set', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html') }])
    student = await addStudent(browser, classUrl)

    for (const s of [teacher!, student]) {
      const frame = await moduleFrame(s, MODULE, 30_000, INLINE)
      await expect(frame.locator('#message')).toHaveText(
        'Nothing to show yet: set src (a URL) or srcdoc (HTML) in the module settings.',
        { timeout: SYNC }
      )
      await expect(frame.locator('iframe')).toBeHidden()
    }
  })

  test('role sections the settings form saves empty fall back to the general config', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        config: { ...formDefaults('config'), src: page('/general') },
        teacherConfig: formDefaults('teacherConfig'),
        studentConfig: formDefaults('studentConfig'),
        stationConfig: formDefaults('stationConfig'),
      },
    ])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => shownText(teacher!), { timeout: SYNC }).toContain('Embedded /general')
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /general')
  })

  test('the embedded page fills the module without a scrollbar of its own', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { src: page('/task') } }])
    student = await addStudent(browser, classUrl)
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Embedded /task')

    const frame = await moduleFrame(student, MODULE, 30_000, INLINE)
    const size = await frame.evaluate(() => {
      const iframe = document.querySelector('iframe')!.getBoundingClientRect()
      const page = document.scrollingElement!
      return {
        overflow: page.scrollHeight - page.clientHeight,
        width: iframe.width - window.innerWidth,
        height: iframe.height - window.innerHeight,
      }
    })
    expect(size).toEqual({ overflow: 0, width: 0, height: 0 })
  })
})
