import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, joinClass, openStation, setModules } from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-markdown-it in a real edrys-Lite: a teacher and a student in the
 * lobby (the module is shown everywhere), plus a station for stationConfig.
 *
 * The module sets <meta name="fetch">, so edrys-Lite inlines it as a data:
 * URL; INLINE (the UML plugin URL, in index.html and module.yaml) identifies that frame.
 */

const MODULE = 'module-markdown-it'
const INLINE = 'markdown-it-textual-uml@0.12.0'
// time for a change to travel between peers
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once onReady has rendered the content (body gets class "loaded"). */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE, 30_000, INLINE)
  await expect(frame.locator('body.loaded')).toBeAttached({ timeout: 30_000 })
  return frame
}

/**
 * The rendered text, re-resolving the frame: it is replaced when the module
 * reloads (e.g. after a config change), and a detaching frame reads as ''.
 */
async function shownText(s: Session): Promise<string> {
  const frame = await moduleFrame(s, MODULE, 30_000, INLINE)
  return frame
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch(() => '')
}

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-markdown-it', () => {
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

  test('each role sees the general content followed by its own content', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'index.html'),
        config: { content: '# For everyone' },
        teacherConfig: { content: 'Only for teachers' },
        studentConfig: { content: 'Only for students' },
        stationConfig: { content: 'Only for stations' },
      },
    ])
    student = await addStudent(browser, classUrl)
    const station = await openStation(teacher!, classUrl)

    const t = await ready(teacher!)
    await expect(t.getByRole('heading', { name: 'For everyone' })).toBeVisible()
    await expect(t.locator('body')).toContainText('Only for teachers')
    await expect(t.locator('body')).not.toContainText('Only for students')

    const stu = await ready(student)
    await expect(stu.getByRole('heading', { name: 'For everyone' })).toBeVisible()
    await expect(stu.locator('body')).toContainText('Only for students')
    await expect(stu.locator('body')).not.toContainText('Only for teachers')
    // the loading text is replaced by the content
    await expect(stu.locator('body')).not.toContainText('Loading…')

    const st = await ready(station)
    await expect(st.locator('body')).toContainText('Only for stations')
    await expect(st.locator('body')).not.toContainText('Only for teachers')

    // General content comes first.
    expect((await shownText(student)).indexOf('For everyone')).toBeLessThan(
      (await shownText(student)).indexOf('Only for students')
    )
  })

  test('formulas, code, HTML, links and PlantUML diagrams are rendered', async ({ browser }) => {
    const content = [
      'Inline formula $\\frac{1}{2}$ here.',
      '',
      '```js',
      'const answer = 42',
      '```',
      '',
      '<em id="raw-html">raw html</em>',
      '',
      'Visit https://example.com today.',
      '',
      '```dot',
      'digraph { a -> b }',
      '```',
    ].join('\n')
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content } }])
    student = await addStudent(browser, classUrl)

    const stu = await ready(student)
    await expect(stu.locator('.katex').first()).toBeVisible()
    await expect(stu.locator('pre.hljs .hljs-keyword')).toHaveText('const')
    await expect(stu.locator('#raw-html')).toHaveText('raw html')
    const link = stu.getByRole('link', { name: 'https://example.com' })
    await expect(link).toHaveAttribute('href', 'https://example.com')
    // opens in a new tab instead of replacing the module's content
    await expect(link).toHaveAttribute('target', '_blank')
    // dot/plantuml/ditaa fences become an image rendered by the PlantUML server
    await expect(stu.locator('img[alt="uml diagram"]')).toHaveAttribute(
      'src',
      /^https:\/\/www\.plantuml\.com\/plantuml\/svg\//
    )
  })

  test('mermaid diagrams are rendered', async ({ browser }) => {
    const content = [
      '```mermaid',
      'graph TD',
      '  A[Start] --> B{Is it working?}',
      '  B -- Yes --> C[Great]',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  Student->>Station: run code',
      '  Station-->>Student: output',
      '```',
    ].join('\n')
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content } }])
    student = await addStudent(browser, classUrl)

    const stu = await ready(student)
    // Mermaid's "Syntax error" graphic is an <svg> too, so check for the drawn labels.
    await expect(stu.locator('.mermaid svg').first()).toContainText('Is it working?', { timeout: 10_000 })
    await expect(stu.locator('.mermaid svg').nth(1)).toContainText('run code')
    await expect(stu.locator('body')).not.toContainText('Syntax error')
  })

  test('a student who joins later sees the content', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content: 'Task 1: read this' } }])
    await ready(teacher!)

    student = await addStudent(browser, classUrl)
    await ready(student)
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('Task 1: read this')
  })

  test('content edited by the teacher during class reaches students without a reload', async ({ browser }) => {
    // edrys-Lite reloads the module's iframe when its configuration changes
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content: 'Old task' } }])
    student = await addStudent(browser, classUrl)
    await ready(student)
    await expect.poll(() => shownText(student!)).toContain('Old task')

    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content: 'New task' } }])
    await expect.poll(() => shownText(student!), { timeout: SYNC }).toContain('New task')
  })

  test('a library that fails to load is reported instead of a blank module', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, 'index.html'), config: { content: '# Task' } }])
    student = await joinClass(browser, classUrl, async (context) => {
      await prepare(context)
      // e.g. a school proxy blocking jsDelivr
      await context.route('https://cdn.jsdelivr.net/npm/markdown-it-textual-uml@*/**', (route) => route.abort())
    })

    const stu = await ready(student)
    await expect(stu.locator('.error')).toContainText('Markdown-IT could not render the content')
    await expect(stu.locator('body')).not.toContainText('Loading…')
  })

  test('the YAML declaration renders the same content', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'module.yaml'),
        config: { content: ['# From YAML', '', '```mermaid', 'graph TD', '  A[Start] --> B[Done]', '```'].join('\n') },
        studentConfig: { content: 'Student part' },
      },
    ])
    student = await addStudent(browser, classUrl)

    const stu = await ready(student)
    await expect(stu.getByRole('heading', { name: 'From YAML' })).toBeVisible()
    await expect(stu.locator('body')).toContainText('Student part')
    await expect(stu.locator('.mermaid svg')).toContainText('Start', { timeout: 10_000 })
  })

  test('the YAML declaration works without a general config', async ({ browser }) => {
    await setModules(teacher!, [
      {
        url: moduleUrl(MODULE, 'module.yaml'),
        // parses to null, like a module entry without a config key (e.g. an imported class)
        config: 'null',
        studentConfig: { content: 'Only the student part' },
      },
    ])
    student = await addStudent(browser, classUrl)

    const stu = await ready(student)
    await expect(stu.locator('body')).toContainText('Only the student part')
  })
})
