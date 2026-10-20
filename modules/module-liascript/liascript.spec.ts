import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import {
  Session,
  closeSessions,
  createClass,
  enterRoom,
  joinClass,
  openStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules, servePublished } from '../../lib/modules'

/**
 * module-liascript in a real edrys-Lite. The module embeds the hosted
 * LiaScript player (https://liascript.github.io/course/), so these tests need
 * network access to it; course files come from COURSE_ORIGIN, a fake site
 * answered by the test.
 *
 * LIASCRIPT_BUILD=<dir> runs them against a local LiaScript build instead
 * (`npx parcel build --public-url . --dist-dir <dir> src/entry/app/index.html`
 * in a LiaScript checkout), served as LOCAL_PLAYER and set as the module's
 * `player`, e.g. to check a change to LiaScript's Edrys backend.
 *
 * In classroom mode LiaScript's Edrys backend (LiaScript
 * src/typescript/sync/Edrys) talks to the module over postMessage: it sends
 * {subject: 'init'} and expects {subject: 'init', body: true} back, then sends
 * its Yjs updates with the LiaScript room as subject, which the module relays
 * to the other peers with Edrys.sendMessage. RECORDER, installed in every
 * LiaScript frame, keeps what the frame received from the module.
 */

const MODULE = 'module-liascript'
// over https, as published: LiaScript's classroom needs crypto.subtle, i.e. a secure context, which a frame
// only is when all its ancestors are
const ENTRY = moduleUrl(MODULE, '', { secure: true })
const LOCAL_BUILD = process.env.LIASCRIPT_BUILD
const LOCAL_PLAYER = 'https://e2e-liascript.test/course/'
const LIASCRIPT = LOCAL_BUILD ? LOCAL_PLAYER : 'https://liascript.github.io/course/'
// https: LiaScript is served over https and would block an http course as mixed content
const COURSE_ORIGIN = 'https://e2e-course.test'
// a fake LiaScript player (the `player` setting): shows the query it was opened with
const PLAYER = 'https://e2e-player.test/lia/'
const EMPTY = 'No course yet: set course (the URL of a LiaScript course) or content (LiaScript Markdown) in the module settings.'
// LiaScript is a large app loaded from the network
const LOAD = 60_000
// time for a message to travel between peers
const SYNC = 15_000

const RECORDER = `
  if (location.origin === '${new URL(LIASCRIPT).origin}') {
    window.__e2eReceived = []
    window.addEventListener('message', (e) => {
      if (e.source === window.parent) {
        try { window.__e2eReceived.push(JSON.parse(JSON.stringify(e.data ?? null))) } catch (_) {}
      }
    })
  }
`

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  if (LOCAL_BUILD) await servePublished(context, LOCAL_PLAYER, LOCAL_BUILD)
  await context.addInitScript(RECORDER)
  await context.route(`${COURSE_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/plain; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: `# Course ${new URL(route.request().url()).pathname}\n\nServed for the test.\n`,
    })
  )
  await context.route(`${PLAYER}**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1 id="query"></h1><script>query.textContent = decodeURIComponent(location.search.slice(1))</script>',
    })
  )
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The LiaScript player inside the module, once onReady has set its URL. */
async function player(s: Session): Promise<Frame> {
  let child: Frame | undefined
  await expect
    .poll(
      async () => {
        const frame = await moduleFrame(s, MODULE)
        child = frame.childFrames().find((f) => f.url().startsWith(LIASCRIPT))
        return !!child
      },
      { timeout: 30_000, message: `LiaScript frame of ${MODULE}` }
    )
    .toBe(true)
  return child!
}

/** The heading of the first slide LiaScript shows; '' while it loads. */
async function heading(s: Session): Promise<string> {
  const frame = await player(s)
  return (await frame.locator('h1').first().innerText({ timeout: 5_000 }).catch(() => '')).trim()
}

/**
 * What the module's player URL decodes to: the course URL, or the classroom object wrapping it.
 * Read from the module's iframe src, because LiaScript rewrites its own address once a classroom opens.
 */
async function playerTarget(s: Session): Promise<any> {
  await player(s)
  const src = await (await moduleFrame(s, MODULE)).locator('iframe').getAttribute('src')
  const query = decodeURIComponent(src!.slice(LIASCRIPT.length + 1).split('#')[0])
  try {
    return JSON.parse(Buffer.from(query, 'base64').toString('utf8'))
  } catch {
    return query
  }
}

/** Messages the module posted into this peer's LiaScript frame. */
const received = async (s: Session): Promise<any[]> =>
  (await player(s)).evaluate(() => (window as any).__e2eReceived || [])

/** Post a message from this peer's LiaScript frame to the module, as LiaScript's Edrys backend does. */
async function liaSends(s: Session, subject: string, body: any) {
  await (await player(s)).evaluate(([subject, body]) => window.parent.postMessage({ subject, body }, '*'), [
    subject,
    body,
  ] as const)
}

/** A module config that uses the LiaScript under test (the local build, if any). */
const lia = (config: object) => (LOCAL_BUILD ? { ...config, player: LOCAL_PLAYER } : config)

/** The module's own message line (loading, empty or error state). */
const message = async (s: Session) => (await moduleFrame(s, MODULE)).locator('#message')

/** A student who opens the class link (and stays in the lobby). */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-liascript', () => {
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

  test('content from the config is shown to every role', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: lia({ content: '# Inline course\n\nHello class.' }) }])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => heading(teacher!), { timeout: LOAD }).toBe('Inline course')
    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Inline course')
  })

  test('a course URL is loaded, and wins over content', async ({ browser }) => {
    await setModules(teacher!, [
      { url: ENTRY, config: lia({ course: `${COURSE_ORIGIN}/intro.md`, content: '# Should not be shown' }) },
    ])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Course /intro.md')
    expect(await playerTarget(student)).toBe(`${COURSE_ORIGIN}/intro.md`)
  })

  test('without a course or content, the module says what to set', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY }])
    student = await addStudent(browser, classUrl)

    for (const s of [teacher!, student]) {
      await expect(await message(s)).toHaveText(EMPTY, { timeout: SYNC })
      await expect((await moduleFrame(s, MODULE)).locator('#player')).toBeHidden()
    }
  })

  test('while LiaScript loads, the module says so', async ({ browser }) => {
    // hold the player's page back, as on a slow connection
    let release!: () => void
    let requested = false
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = async (context: BrowserContext) => {
      await prepare(context)
      await context.route((url) => url.href.startsWith(`${LIASCRIPT}?`), async (route) => {
        requested = true
        await held
        // on to the next handler (the local build, if any), not straight to the network
        await route.fallback()
      })
    }
    await setModules(teacher!, [{ url: ENTRY, config: lia({ content: '# Slow course' }) }])
    student = await joinClass(browser, classUrl, slow)

    await expect.poll(() => requested, { timeout: SYNC }).toBe(true)
    const loading = await message(student)
    await expect(loading).toHaveText('Loading LiaScript…')
    // shown after a short delay, so fast loads don't flicker
    await expect.poll(() => loading.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.6')
    release()
    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Slow course')
    await expect(await message(student)).toBeHidden()
  })

  test('the player setting replaces the hosted LiaScript', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: { player: PLAYER, content: '# Own player' } }])
    student = await addStudent(browser, classUrl)

    const shown = async () => {
      const child = (await moduleFrame(student!, MODULE)).childFrames().find((f) => f.url().startsWith(PLAYER))
      return child ? child.locator('#query').innerText().catch(() => '') : ''
    }
    await expect.poll(shown, { timeout: SYNC }).toMatch(/^data:text\/plain;base64,/)
    const query = (await shown()).slice('data:text/plain;base64,'.length)
    expect(Buffer.from(query, 'base64').toString('utf8')).toBe('# Own player')
  })

  test('a player setting that is not a URL is reported', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: { player: 'not a url', content: '# x' } }])
    student = await addStudent(browser, classUrl)

    await expect(await message(student)).toHaveText(
      'The player setting is not a URL: not a url. Fix or clear it in the module settings.',
      { timeout: SYNC }
    )
  })

  test('content with non-ASCII characters is shown as written', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: lia({ content: '# Grüße → 😀\n\nÄÖÜ' }) }])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Grüße → 😀')
  })

  test('a class without a general config shows the empty state', async ({ browser }) => {
    // parses to null, like a module entry without a config key
    await setModules(teacher!, [{ url: ENTRY, config: 'null' }])
    student = await addStudent(browser, classUrl)

    await expect(await message(student)).toHaveText(EMPTY, { timeout: SYNC })
  })

  test('without classroom mode, the course is opened on its own', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: lia({ content: '# Alone' }) }])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Alone')
    expect(String(await playerTarget(student))).toMatch(/^data:text\/plain;base64,/)
  })

  test('classroom mode is used in the lobby too, with one classroom for everyone there', async ({ browser }) => {
    await setModules(teacher!, [{ url: ENTRY, config: lia({ classroom: true, content: '# Lobby' }) }])
    student = await addStudent(browser, classUrl)

    await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Lobby')
    const target = await playerTarget(student)
    expect(target).toMatchObject({ backend: 'edrys', mode: 0 })
    expect(target.room).toMatch(/\/Lobby$/)
    expect((await playerTarget(teacher!)).room).toBe(target.room)
  })

  test.describe('classroom mode in a room', () => {
    let station: Session | undefined

    test.beforeEach(async ({ browser }) => {
      await setModules(teacher!, [{ url: ENTRY, config: lia({ classroom: true, content: '# Shared course' }) }])
      station = await openStation(teacher!, classUrl)
      student = await addStudent(browser, classUrl)
      await enterRoom(student, await stationRoom(station))
    })

    test('both peers open LiaScript with the Edrys backend and the same room', async () => {
      const room = await stationRoom(station!)
      const target = await playerTarget(student!)

      expect(target).toMatchObject({ backend: 'edrys' })
      expect(target.room).toMatch(new RegExp(`/${room}$`))
      expect(target.course).toMatch(/^data:text\/plain;base64,/)
      expect((await playerTarget(station!)).room).toBe(target.room)
    })

    test('the module answers LiaScript’s init handshake, once', async () => {
      const answers = async (s: Session) => (await received(s)).filter((m) => m?.subject === 'init')

      await liaSends(student!, 'init', null)
      await expect.poll(() => answers(student!), { timeout: SYNC }).toEqual([{ subject: 'init', body: true }])
    })

    test('LiaScript’s messages reach the other peer once, and nothing else is relayed', async () => {
      // any change to the class (here: shared state written by the station's module) reaches the
      // student's module window as an edrys-Lite 'state' event, which must not be relayed
      await (await moduleFrame(station!, MODULE)).evaluate(() => (window as any).Edrys.getState('e2e', 'Value', 1))
      await player(station!)
      await liaSends(student!, 'e2e-ping', { n: 1 })

      const pings = async (s: Session) => (await received(s)).filter((m) => m?.subject === 'e2e-ping')
      await expect.poll(() => pings(station!), { timeout: SYNC }).toEqual([{ subject: 'e2e-ping', body: { n: 1 } }])
      expect(await pings(student!)).toEqual([])
      expect((await received(station!)).filter((m) => typeof m?.subject !== 'string')).toEqual([])
    })

    test('the course is shown in classroom mode', async () => {
      await expect.poll(() => heading(student!), { timeout: LOAD }).toBe('Shared course')
    })

    test('after both users connect in LiaScript’s classroom dialog, they see each other and can chat', async () => {
      // Review finding #2: the hosted LiaScript's Edrys backend never sends its document updates
      test.fail(!LOCAL_BUILD, 'LiaScript Edrys backend fixed only in a local build so far')

      // LiaScript opens its classroom dialog prefilled from the URL (backend Edrys, the room); each user connects
      for (const s of [station!, student!]) {
        await (await player(s)).getByRole('button', { name: 'connect', exact: true }).click({ timeout: LOAD })
      }

      // LiaScript counts the users of the classroom on its classroom button (in a collapsed toolbar menu)
      for (const s of [station!, student!]) {
        await expect((await player(s)).getByTitle('Classroom', { exact: true })).toHaveText('Classroom (2)', {
          timeout: SYNC,
        })
      }

      // and a chat message reaches the other user. LiaScript keeps re-rendering its chat button, which Playwright
      // never sees as stable, so the click is dispatched
      const stu = await player(student!)
      await stu.getByTitle('Open chat').first().dispatchEvent('click')
      await stu.locator('textarea').last().fill('hello from the student')
      await stu.getByTitle('Send message').dispatchEvent('click')

      // the station is told about it, and reads it
      const st = await player(station!)
      const unread = st.getByTitle('You have unread chat messages').first()
      await expect(unread).toBeAttached({ timeout: SYNC })
      await unread.dispatchEvent('click')
      await expect(st.getByText('hello from the student')).toBeVisible()
    })
  })
})
