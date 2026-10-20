import { BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, enterRoom, inPeer, joinClass, setModules } from '../../lib/edrys'
import { MODULE_ORIGIN, moduleUrl, serveModules } from '../../lib/modules'

/**
 * Two modules on one page that share a state key (two editors, or an editor and a viewer),
 * and module awareness (cursors) of peers that leave.
 *
 * edrys-Lite relays a module's own Yjs and awareness updates to the other peers, and used to
 * drop them for every module iframe on its own page, to avoid echoing them to the sender: two
 * modules on one page never saw each other's edits or cursors until reload. And nothing removed
 * a departed peer's module awareness; y-protocols only dropped it as outdated, after ~30 s.
 *
 * The module is a test fixture, answered by the route below at the module origin, as `a.html`
 * and `b.html`. Frame a (on the teacher) creates the shared Y.Text; both show its content and the
 * awareness labels ("<frame> <role>") of the other clients in the same state key.
 *
 * A module frame that loads later (room switch, reload) used to see only awareness changes, so
 * idle peers showed up only when y-protocols renewed their state (every 15 s); edrys-Lite now
 * hands a loading frame every current state.
 *
 * Runs over both transports: they detect a departed peer differently (WebRTC: the connection
 * closes; WebSocket: heartbeats stop, ~15-22 s), and only the signed leave is fast on both.
 */

const MODULE = 'e2e-shared-state'
// time for a message to travel between peers
const SYNC = 15_000
// a peer that closes its page is gone well before y-protocols' 30 s timeout
const LEAVE = 5_000

const HTML = `<!doctype html>
<html>
<head>
  <title>Shared state</title>
  <script src="https://edrys-labs.github.io/module/edrys.js"></script>
</head>
<body>
  <div id="status">loading</div>
  <div id="text"></div>
  <ul id="peers"></ul>
  <script>
    const frame = location.pathname.split('/').pop().replace('.html', '')
    let text
    // Frame b binds once frame a's Y.Text has reached it (a creating its own would fork the key).
    function bind() {
      const room = Edrys.getState()
      if (text || !room) return
      if (frame === 'a' && Edrys.role === 'teacher' && !room.has('text')) Edrys.getState('text', 'Text')
      if (!room.has('text')) return
      text = room.get('text')
      const show = () => (document.getElementById('text').textContent = text.toString())
      text.observe(show)
      show()
    }
    window.typeText = (s) => text.insert(text.length, s)

    Edrys.onReady(() => {
      bind()
      Edrys.getState().observe(bind)

      const awareness = Edrys.getState('text', 'Awareness')
      const showPeers = () => {
        const list = document.getElementById('peers')
        list.replaceChildren()
        awareness.getStates().forEach((state, id) => {
          if (id === awareness.clientID || !state.label) return
          const li = document.createElement('li')
          li.textContent = state.label
          list.appendChild(li)
        })
      }
      awareness.on('change', showPeers)
      awareness.setLocalStateField('label', frame + ' ' + Edrys.role)
      document.getElementById('status').textContent = 'ready'
    })
  </script>
</body>
</html>`

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  // registered after serveModules, so it takes precedence for this path
  await context.route(`${MODULE_ORIGIN}/${MODULE}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: HTML,
    }),
  )
}

async function ready(s: Session, file: 'a' | 'b'): Promise<Frame> {
  const url = moduleUrl(MODULE, `${file}.html`)
  let frame: Frame | undefined
  await expect
    .poll(() => (frame = s.page.frames().find((f) => f.url().startsWith(url))) !== undefined, { timeout: 30_000 })
    .toBe(true)
  await expect(frame!.locator('#status')).toHaveText('ready', { timeout: 30_000 })
  return frame!
}

const peers = (frame: Frame) => frame.locator('#peers li')

for (const transport of ['webrtc', 'ws'] as const) {
  test.describe(`module frames sharing a state key (${transport})`, () => {
    let teacher: Session | undefined
    let student: Session | undefined

    test.afterEach(async () => {
      await closeSessions(teacher, student)
      teacher = student = undefined
    })

    test.beforeEach(async ({ browser }) => {
      const created = await createClass(browser, prepare)
      teacher = created.teacher
      let classUrl = created.classUrl
      if (transport === 'ws') {
        // the default WebSocket relay, kept in the URL, as edrys-Lite's own e2e tests switch to it
        classUrl += '#comm=ws'
        await teacher.page.goto(classUrl)
        await expect
          .poll(
            () => inPeer<string>(teacher!.page, 'return p.provider && p.provider.constructor.name').catch(() => ''),
            { timeout: 30_000 },
          )
          .toContain('Websocket')
      }
      await setModules(teacher, [{ url: moduleUrl(MODULE, 'a.html') }, { url: moduleUrl(MODULE, 'b.html') }])
      student = await joinClass(browser, classUrl, prepare)
    })

    test("two frames on one page see each other's edits and awareness", async () => {
      const a = await ready(teacher!, 'a')
      const b = await ready(teacher!, 'b')
      const sa = await ready(student!, 'a')

      // b gets a's Y.Text (created in a) and a's edit; a gets b's edit
      await expect(async () => {
        await a.evaluate(() => (window as any).typeText('from-a '))
        await expect(b.locator('#text')).toContainText('from-a', { timeout: 2_000 })
      }).toPass({ timeout: SYNC })
      await b.evaluate(() => (window as any).typeText('from-b'))
      await expect(a.locator('#text')).toContainText('from-b', { timeout: SYNC })
      // and the remote peer still gets both
      await expect(sa.locator('#text')).toContainText(/from-a.*from-b/, { timeout: SYNC })

      // each frame shows the other frame's label, and the student's frames
      await expect(peers(a)).toContainText(['b teacher'], { timeout: SYNC })
      await expect(peers(b)).toContainText(['a teacher'], { timeout: SYNC })
      await expect
        .poll(async () => (await peers(a).allTextContents()).sort(), { timeout: SYNC })
        .toEqual(['a student', 'b student', 'b teacher'])
    })

    test('a peer that closes its page has its module awareness removed for the others', async () => {
      const a = await ready(teacher!, 'a')
      await ready(student!, 'a')
      await ready(student!, 'b')
      await expect
        .poll(async () => (await peers(a).allTextContents()).sort(), { timeout: SYNC })
        .toEqual(['a student', 'b student', 'b teacher'])

      const closed = Date.now()
      await student!.page.close({ runBeforeUnload: true })
      await expect
        .poll(async () => (await peers(a).allTextContents()).sort(), { timeout: LEAVE })
        .toEqual(['b teacher'])
      test.info().annotations.push({ type: 'removed after', description: `${Date.now() - closed} ms` })
    })

    test("a module that loads later shows the others' awareness at once, without waiting for a renewal", async () => {
      let a = await ready(teacher!, 'a')
      await ready(student!, 'a')
      await ready(student!, 'b')
      const labels = (frame: Frame) => async () => (await peers(frame).allTextContents()).sort()
      await expect.poll(labels(a), { timeout: SYNC }).toEqual(['a student', 'b student', 'b teacher'])

      // the student is idle from here; leaving and re-entering the room remounts the teacher's frames
      await inPeer(teacher!.page, "p.addRoom('Room 1'); return true")
      await enterRoom(teacher!, 'Room 1')
      await enterRoom(teacher!, 'Lobby')
      a = await ready(teacher!, 'a')
      const loaded = Date.now()
      await expect.poll(labels(a), { timeout: 3_000 }).toEqual(['a student', 'b student', 'b teacher'])
      test.info().annotations.push({ type: 'shown after', description: `${Date.now() - loaded} ms` })
    })
  })
}
