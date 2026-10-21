import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, enterRoom, inPeer, joinClass, setModules } from '../../lib/edrys'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-whiteboard in a real edrys-Lite: a teacher and students, in the lobby
 * and in a second room (the module is shown everywhere).
 *
 * The board is Excalidraw's editor, synced through the room's Edrys state. The
 * tests draw through its toolbar and canvas, and read each peer's scene through
 * window.excalidrawAPI, which the module exposes for them (a canvas has no text).
 */

const MODULE = 'module-whiteboard'
// the published URL is docs/index.html, built from src/ (npm run build);
// docs/ is not committed: run `npm run build` in the module before the tests
const ENTRY = 'docs/index.html'
// time for a change to travel between peers
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once onReady has mounted the editor. */
async function ready(s: Session): Promise<Frame> {
  await expect
    .poll(
      async () => {
        const frame = await moduleFrame(s, MODULE)
        return frame.evaluate(() => !!(window as any).excalidrawAPI).catch(() => false)
      },
      { timeout: 30_000, message: `editor of ${MODULE}` }
    )
    .toBe(true)
  return moduleFrame(s, MODULE)
}

interface Shape {
  type: string
  width: number
  height: number
}

/** The shapes on a peer's board (deleted ones left out), sorted by type. */
async function shapes(s: Session): Promise<Shape[]> {
  const frame = await ready(s)
  const list: Shape[] = await frame.evaluate(() =>
    (window as any).excalidrawAPI
      .getSceneElements()
      .map((e: any) => ({ type: e.type, width: Math.round(e.width), height: Math.round(e.height) }))
  )
  return list.sort((a, b) => a.type.localeCompare(b.type))
}

/** Draw a shape with the toolbar tool and a drag over the canvas, as a user does. */
async function draw(s: Session, tool: 'rectangle' | 'ellipse', from: [number, number], to: [number, number]) {
  const frame = await ready(s)
  const before = (await shapes(s)).filter((shape) => shape.type === tool).length
  await closeSideMenu(s)
  // the test id is on the tool's hidden radio input; click its button (the label around it)
  await frame.getByTestId(`toolbar-${tool}`).locator('..').click()
  // the canvas is taller than the window: scrolling it into view would move the page under the drag
  const box = (await frame.locator('canvas.interactive').boundingBox())!
  await s.page.mouse.move(box.x + from[0], box.y + from[1])
  await s.page.mouse.down()
  await s.page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 5 })
  await s.page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 })
  await s.page.mouse.up()
  // the shape is on this peer's own board before anyone looks for it elsewhere
  await expect
    .poll(async () => (await shapes(s)).filter((shape) => shape.type === tool).length, {
      message: `${tool} drawn on ${s.page.url()}`,
    })
    .toBe(before + 1)
}

// right of the style panel that opens on the left when a shape tool is selected
const RECTANGLE: Shape = { type: 'rectangle', width: 120, height: 80 }
const drawRectangle = (s: Session) => draw(s, 'rectangle', [400, 300], [520, 380])
const ELLIPSE: Shape = { type: 'ellipse', width: 100, height: 60 }
const drawEllipse = (s: Session) => draw(s, 'ellipse', [650, 250], [750, 310])

/**
 * Teacher: add the module, by default with a shared board; `null` adds it without any config. Each
 * test adds it once: a config change reloads the module's frame, and a peer could briefly hold a
 * frame of each config.
 */
function addModule(teacher: Session, config: object | null = { synchronize: true }) {
  return setModules(teacher, [{ url: moduleUrl(MODULE, ENTRY), config: config ?? undefined }])
}

const badge = (frame: Frame) => frame.locator('.sync-badge')

/** The module's keys in the room's shared state (whiteboard:element:…, whiteboard:file:…). */
async function sharedKeys(s: Session): Promise<string[]> {
  return (await ready(s)).evaluate(() =>
    [...((window as any).Edrys.getState()?.keys() || [])].filter((key: string) => key.startsWith('whiteboard:'))
  )
}

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-whiteboard', () => {
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

  test('every peer starts with an empty board that fills the module', async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)

    for (const s of [teacher!, student]) {
      const frame = await ready(s)
      await expect(frame.getByTestId('toolbar-rectangle')).toBeVisible()
      await expect(frame.getByText('Loading whiteboard…')).toBeHidden()
      await expect(badge(frame)).toHaveText('Shared with this room')
      expect(await shapes(s)).toEqual([])
    }

    const frame = await ready(student)
    const size = await frame.evaluate(() => {
      const board = document.getElementById('board')!.getBoundingClientRect()
      return { width: board.width - window.innerWidth, height: board.height - window.innerHeight }
    })
    expect(size).toEqual({ width: 0, height: 0 })
  })

  test('a drawing on one peer shows up on the others, both ways', async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)
    await ready(teacher!)
    await ready(student)

    await drawRectangle(teacher!)
    expect(await shapes(teacher!)).toEqual([RECTANGLE])
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])

    await drawEllipse(student)
    await expect.poll(() => shapes(teacher!), { timeout: SYNC }).toEqual([ELLIPSE, RECTANGLE])
  })

  test('deleting a shape removes it for everyone', async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)
    await drawRectangle(teacher!)
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])

    // the shape is still selected after drawing it
    const frame = await ready(teacher!)
    await frame.locator('canvas.interactive').press('Delete')
    expect(await shapes(teacher!)).toEqual([])
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([])
  })

  test('a student who joins later sees the board as it is', async ({ browser }) => {
    await addModule(teacher!)
    await drawRectangle(teacher!)

    student = await addStudent(browser, classUrl)
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])
  })

  test('the board survives a reload', async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)
    await drawRectangle(student)
    await expect.poll(() => shapes(teacher!), { timeout: SYNC }).toEqual([RECTANGLE])

    await student.page.reload()
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])
  })

  test('each room has its own board', async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)
    await drawRectangle(teacher!)
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])

    await inPeer(teacher!.page, `p.addRoom('Group A'); return true`)
    await enterRoom(student, 'Group A')
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([])

    // a drawing in Group A stays there
    await drawEllipse(student)
    expect(await shapes(student)).toEqual([ELLIPSE])
    await enterRoom(student, 'Lobby')
    await expect.poll(() => shapes(student!), { timeout: SYNC }).toEqual([RECTANGLE])
    expect(await shapes(teacher!)).toEqual([RECTANGLE])
  })

  test('a student who joins after a room was added gets a working board', async ({ browser }) => {
    await addModule(teacher!)
    await inPeer(teacher!.page, `p.addRoom('Group A'); return true`)
    student = await addStudent(browser, classUrl)

    await drawRectangle(student)
    await expect.poll(() => shapes(teacher!), { timeout: SYNC }).toEqual([RECTANGLE])
  })

  test("peers see each other's pointer with their name", async ({ browser }) => {
    await addModule(teacher!)
    student = await addStudent(browser, classUrl)
    const frame = await ready(teacher!)
    await ready(student)

    await closeSideMenu(teacher!)
    const box = (await frame.locator('canvas.interactive').boundingBox())!
    await teacher!.page.mouse.move(box.x + 300, box.y + 200)
    await teacher!.page.mouse.move(box.x + 310, box.y + 210)

    const teacherName = await frame.evaluate(() => (window as any).Edrys.liveUser.displayName)
    await expect
      .poll(
        async () =>
          (await ready(student!)).evaluate(() =>
            [...(window as any).excalidrawAPI.getAppState().collaborators.values()]
              .filter((c: any) => c.pointer)
              .map((c: any) => c.username)
          ),
        { timeout: SYNC }
      )
      .toEqual([teacherName])
  })

  test('without synchronize, each peer draws on a board of their own', async ({ browser }) => {
    // nothing configured, as when the module is added without opening its settings
    await addModule(teacher!, null)
    student = await addStudent(browser, classUrl)

    for (const s of [teacher!, student]) {
      await expect(badge(await ready(s))).toHaveText('Only you see this board')
    }
    await drawRectangle(teacher!)
    await drawEllipse(student)
    expect(await shapes(teacher!)).toEqual([RECTANGLE])
    expect(await shapes(student)).toEqual([ELLIPSE])
    // nothing of either board went into the room's shared state
    expect(await sharedKeys(teacher!)).toEqual([])
    expect(await sharedKeys(student)).toEqual([])
  })

  test('synchronize unticked in the settings form keeps the boards apart', async ({ browser }) => {
    await addModule(teacher!, { synchronize: false })
    student = await addStudent(browser, classUrl)

    await expect(badge(await ready(student))).toHaveText('Only you see this board')
    await drawRectangle(teacher!)
    expect(await shapes(teacher!)).toEqual([RECTANGLE])
    expect(await shapes(student)).toEqual([])
    expect(await sharedKeys(teacher!)).toEqual([])
  })
})
