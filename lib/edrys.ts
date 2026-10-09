import { Browser, BrowserContext, Page, expect } from '@playwright/test'

/**
 * Drive a real edrys-Lite the way people use it:
 *
 *   teacher: creates the class, adds the module, opens the /station window
 *   student: opens the /classroom link and clicks the station room
 *
 * Adding the module calls Classroom.saveClass (what the Settings dialog
 * calls), adapted from edrys-Lite tests/e2e-tests/app/probe-module.ts
 * (commit 63b7b85). Copied rather than imported: an import would load a
 * second copy of @playwright/test from edrys-Lite, which Playwright rejects.
 */

export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:6999'

export interface Session {
  context: BrowserContext
  page: Page
}

/** Runs on a fresh context before its first page opens (routes, init scripts). */
export type Prepare = (context: BrowserContext) => Promise<void>

/** Run `body` (statements using `p` = the app's Peer, ending in `return`) in the page. */
export function inPeer<T = any>(page: Page, body: string): Promise<T> {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`
    function walk(vn) {
      if (!vn) return;
      const c = vn.component;
      if (c && c.proxy && c.proxy.communication && c.proxy.communication.peerID) return c.proxy.communication;
      const s = c && c.subTree && walk(c.subTree);
      if (s) return s;
      for (const k of Array.isArray(vn.children) ? vn.children : []) {
        const h = walk(k);
        if (h) return h;
      }
    }
    const app = document.body && document.body.__vue_app__;
    const p = app && walk(app._container._vnode);
    if (!p) throw new Error('Peer instance not found in Vue tree');
    ${body}
  `) as () => T
  return page.evaluate(fn)
}

/** Wait until the app is up (its Peer exists). */
async function appReady(page: Page) {
  await expect.poll(() => inPeer<boolean>(page, 'return !!p.peerID').catch(() => false), { timeout: 45_000 }).toBe(true)
}

// ---------------------------------------------------------------------------
// Teacher

/** Teacher: create a class. Returns the teacher session and the /classroom link for students. */
export async function createClass(browser: Browser, prepare?: Prepare): Promise<{ teacher: Session; classUrl: string }> {
  const context = await browser.newContext()
  if (prepare) await prepare(context)
  const page = await context.newPage()
  await page.goto(BASE_URL)
  await page.getByText('Create a class').click()
  await appReady(page)
  return { teacher: { context, page }, classUrl: page.url().split('#')[0] }
}

/** Teacher: open the class's /station window (same browser, so same identity). */
export async function openStation(teacher: Session, classUrl: string): Promise<Session> {
  const match = classUrl.match(/\/classroom\/([^/]+)\/([^/?#]+)/)
  if (!match) throw new Error(`not a classroom link: ${classUrl}`)
  const page = await teacher.context.newPage()
  await page.goto(`${BASE_URL}/?/station/${match[1]}/${match[2]}`)
  await appReady(page)

  // The "Station Mode Active" popup (left side) covers the modules; click
  // away from it, on the right side of the page.
  const dialog = page.getByText('Station Mode Active')
  await dialog.waitFor({ timeout: 15_000 })
  const viewport = page.viewportSize()!
  await page.mouse.click(viewport.width - 20, viewport.height / 2)
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  return { context: teacher.context, page }
}

/** The station's room name ("Station <name>"), once its presence is published. */
export async function stationRoom(station: Session): Promise<string> {
  // Peer.user() returns a plain presence object; older edrys-Lite returned a Y.Map.
  const read = () =>
    inPeer<string | null>(
      station.page,
      `const u = p.user(); return u ? (typeof u.get === 'function' ? u.get('room') : u.room) || null : null`
    )
  await expect.poll(read, { timeout: 30_000 }).toBeTruthy()
  return (await read())!
}

// ---------------------------------------------------------------------------
// Student

/** Student: open the class link in a fresh browser. */
export async function joinClass(browser: Browser, classUrl: string, prepare?: Prepare): Promise<Session> {
  const context = await browser.newContext()
  if (prepare) await prepare(context)
  const page = await context.newPage()
  await page.goto(classUrl)
  await appReady(page)
  // the "Connecting to classroom" overlay stays until the class configuration arrived
  await expect(page.getByText('WebRTC-support')).toBeHidden({ timeout: 60_000 })
  return { context, page }
}

/** Enter a room with its arrow button in the sidebar, once the room has shown up there. */
export async function enterRoom(s: Session, room: string) {
  const entry = s.page.getByRole('listbox').filter({ hasText: room })
  await entry.getByRole('button').first().click({ timeout: 45_000 })
}

/**
 * Close the class's side menu (rooms and users). It is a temporary drawer
 * that overlays the left part of the modules, so close it before clicking
 * there or taking screenshots of a module.
 */
export async function closeSideMenu(s: Session) {
  const drawer = s.page.locator('.v-navigation-drawer--temporary').first()
  if (await drawer.evaluate((d) => d.classList.contains('v-navigation-drawer--active'))) {
    await s.page.locator('.v-app-bar-nav-icon').click()
  }
  // wait for the slide-out to finish, not just the class change
  await expect(drawer).not.toBeInViewport()
  // and for its overlay to fade out: until then it takes the clicks meant for the modules
  await expect(s.page.locator('.v-navigation-drawer__scrim')).toHaveCount(0)
}

export async function closeSessions(...sessions: (Session | undefined)[]) {
  for (const s of sessions) {
    if (s) await s.context.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Modules

export interface ModuleEntry {
  url: string
  config?: object | string
  studentConfig?: object | string
  teacherConfig?: object | string
  stationConfig?: object | string
  /** Overrides the module's own `show-in` meta, as the settings form does. */
  showInCustom?: string
}

const asConfig = (c?: object | string) => (c === undefined ? '' : typeof c === 'string' ? c : JSON.stringify(c))

/** Teacher: set the class's modules, as saving the Settings dialog does. */
export async function setModules(teacher: Session, modules: ModuleEntry[]) {
  const entries = modules.map((m, i) => ({
    id: `e2e-module-${i}`,
    url: m.url,
    config: asConfig(m.config),
    studentConfig: asConfig(m.studentConfig),
    teacherConfig: asConfig(m.teacherConfig),
    stationConfig: asConfig(m.stationConfig),
    showInCustom: m.showInCustom ?? '',
    width: 'full',
    height: 'tall',
  }))
  await teacher.page.evaluate(async (entries) => {
    function walk(vn: any): any {
      if (!vn) return
      const c = vn.component
      if (c && c.proxy && typeof c.proxy.saveClass === 'function') return c.proxy
      const s = c && c.subTree && walk(c.subTree)
      if (s) return s
      for (const k of Array.isArray(vn.children) ? vn.children : []) {
        const h = walk(k)
        if (h) return h
      }
    }
    const classroom = walk((document.body as any).__vue_app__._container._vnode)
    if (!classroom) throw new Error('Classroom component not found')
    // Start from classroom.data like the Settings dialog: it carries the URL's
    // communicationConfig, and dropping that reads as a transport change.
    const data = JSON.parse(JSON.stringify(classroom.data))
    data.modules = entries
    // saveClass closes the Settings dialog via its ref, so open it first.
    classroom.showSettings = true
    for (let i = 0; i < 50 && !classroom.$refs.Settings; i++) await new Promise((r) => setTimeout(r, 100))
    classroom.saveClass(data)
    classroom.showSettings = false
  }, entries)
}
