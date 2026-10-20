import { BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import { MODULE_ORIGIN, moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * edrys.js in a module that embeds its own iframe (a sandbox, a preview, a widget).
 *
 * The child frame posts to the module window as soon as it loads, before edrys-Lite's first
 * message. edrys.js used to trust, and pin, the origin of the first message it got, so the
 * child's opaque origin ("null") was pinned, everything from edrys-Lite was rejected and the
 * module never became ready. Only the embedding page (window.parent) may talk to edrys.js.
 *
 * The module is a test fixture, not a checkout: it is answered by the route below, at the
 * module origin, as a plain and as an inlined (<meta name="fetch">, data: URL) module.
 */

const MODULE = 'e2e-nested-frame'
const INLINE = 'e2e-nested-frame-inline'
// time for a message to travel between peers
const SYNC = 15_000

// The child keeps posting from the moment it loads, so some posts surely arrive before
// edrys-Lite's first message.
const CHILD = `<script>
  const post = () => parent.postMessage({ type: 'ready', event: 'update', username: 'child' }, '*')
  post()
  setInterval(post, 20)
</script>`

function moduleHtml(inline: boolean) {
  return `<!doctype html>
<html>
<head>
  <title>Nested frame</title>
  ${inline ? '<meta name="fetch" content="true">' : ''}
  <script src="https://edrys-labs.github.io/module/edrys.js"></script>
</head>
<body>
  <!-- ${INLINE} -->
  <iframe id="child" sandbox="allow-scripts" srcdoc="${CHILD.replace(/"/g, '&quot;')}"></iframe>
  <div id="status">loading</div>
  <div id="early">0</div>
  <ul id="log"></ul>
  <button id="send">send</button>
  <script>
    const child = document.getElementById('child')
    // child posts that arrived before onReady: shows the race was actually run
    let early = 0
    window.addEventListener('message', (e) => {
      if (e.source === child.contentWindow && !Edrys.ready) {
        document.getElementById('early').textContent = String(++early)
      }
    })
    Edrys.onReady(() => {
      document.getElementById('status').textContent = 'ready ' + Edrys.role + ' ' + Edrys.username
    })
    Edrys.onMessage(({ subject, body }) => {
      const li = document.createElement('li')
      li.textContent = subject + ':' + body
      document.getElementById('log').appendChild(li)
    })
    document.getElementById('send').onclick = () => Edrys.sendMessage('hello', 'from ' + Edrys.role)
  </script>
</body>
</html>`
}

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  // registered after serveModules, so it takes precedence for this path
  await context.route(`${MODULE_ORIGIN}/${MODULE}/**`, (route) => {
    const inline = new URL(route.request().url()).pathname.endsWith('/inline.html')
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: moduleHtml(inline),
    })
  })
}

async function ready(s: Session, inline: boolean): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE, 30_000, inline ? INLINE : undefined)
  await expect(frame.locator('#status')).toHaveText(/^ready /, { timeout: 30_000 })
  return frame
}

for (const inline of [false, true]) {
  test.describe(`edrys.js with a nested iframe (${inline ? 'inlined data: module' : 'cross-origin module'})`, () => {
    let teacher: Session | undefined
    let student: Session | undefined

    test.afterEach(async () => {
      await closeSessions(teacher, student)
      teacher = student = undefined
    })

    test('the module becomes ready although its child frame posts first, and messages still flow', async ({
      browser,
    }) => {
      const created = await createClass(browser, prepare)
      teacher = created.teacher
      await setModules(teacher, [{ url: moduleUrl(MODULE, inline ? 'inline.html' : 'index.html') }])
      student = await joinClass(browser, created.classUrl, prepare)

      const teacherFrame = await ready(teacher, inline)
      const studentFrame = await ready(student, inline)
      // the side menu overlays the module's left part, where the button is
      await closeSideMenu(teacher)
      await closeSideMenu(student)

      // the child really did post before edrys-Lite's first message ...
      expect(Number(await teacherFrame.locator('#early').textContent())).toBeGreaterThan(0)
      // ... and neither its origin nor its fake 'update' was taken
      await expect(teacherFrame.locator('#status')).toHaveText(/^ready teacher (?!child)/)
      await expect(studentFrame.locator('#status')).toHaveText(/^ready student (?!child)/)

      // A message is not queued: one sent before the peers have connected and verified each
      // other is lost, so send again until one arrives.
      const delivers = async (from: Frame, to: Frame, text: string) =>
        expect(async () => {
          await from.locator('#send').click()
          await expect(to.locator('#log')).toContainText(text, { timeout: 2_000 })
        }).toPass({ timeout: SYNC })

      await delivers(teacherFrame, studentFrame, 'hello:from teacher')
      await delivers(studentFrame, teacherFrame, 'hello:from student')
    })
  })
}
