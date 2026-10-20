import { BrowserContext, Frame, Route, expect } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'fs'
import { extname, join, normalize, resolve } from 'path'
import { BASE_URL, Session } from './edrys'

/**
 * Serve modules from the local checkout under a fake cross-origin host, so
 * the tests cover unpublished changes and the module runs cross-origin from
 * the app, as in production.
 *
 *   http://e2e-module.test/<module-name>/...  ->  $EDRYS_MODULES/<module-name>/...
 *
 * The module's published edrys.js is swapped for the one of the edrys-Lite
 * under test, so module and host speak the same API version.
 */

export const MODULE_ORIGIN = 'http://e2e-module.test'
export const MODULES_DIR = resolve(process.env.EDRYS_MODULES || join(__dirname, '..', '..'))

const PUBLISHED_EDRYS_JS = 'https://edrys-labs.github.io/module/edrys.js'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

/** URL of a module's entry point, as a teacher would add it. */
export function moduleUrl(name: string, entry = '') {
  return `${MODULE_ORIGIN}/${name}/${entry}`
}

/** Answer `route` with the file at `path` below `root`. */
async function fulfillFrom(route: Route, root: string, path: string) {
  let file = normalize(join(root, path))
  if (!file.startsWith(root)) return route.fulfill({ status: 403 })
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) return route.fulfill({ status: 404, body: `not found: ${path}` })
  await route.fulfill({
    status: 200,
    contentType: CONTENT_TYPES[extname(file)] || 'application/octet-stream',
    // scrapeModule fetches the entry point from the app's origin
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: readFileSync(file),
  })
}

/** Context hook: serve local modules and the local edrys.js. */
export async function serveModules(context: BrowserContext) {
  await context.route(`${MODULE_ORIGIN}/**`, (route) =>
    fulfillFrom(route, MODULES_DIR, decodeURIComponent(new URL(route.request().url()).pathname))
  )

  await context.route(PUBLISHED_EDRYS_JS, async (route) => {
    const response = await route.fetch({ url: `${BASE_URL}/module/edrys.js` })
    await route.fulfill({ response })
  })
}

/**
 * Context hook: answer a module's published URL from a folder of the local checkout.
 *
 * For built modules whose committed build loads its own files by absolute URL (Parcel's
 * `--public-url`), e.g. module-arduinoview's `docs/`:
 *
 *   servePublished(context, 'https://edrys-labs.github.io/module-arduinoview/', 'module-arduinoview/docs')
 *
 * Those files then come from a different origin than the entry point, unlike in production.
 */
export async function servePublished(context: BrowserContext, publishedPrefix: string, localDir: string) {
  const root = join(MODULES_DIR, localDir)
  await context.route(`${publishedPrefix}**`, (route) =>
    fulfillFrom(route, root, decodeURIComponent(route.request().url().slice(publishedPrefix.length).split(/[?#]/)[0]))
  )
}

/**
 * Scroll the page so the top of this module's iframe sits just below edrys-Lite's fixed app bar.
 *
 * Use it before clicking a module's top row (header controls, back buttons). After a click further
 * down the frame, the page may be scrolled so the top row is under the app bar: Playwright still sees
 * the button as visible, and the click lands on the bar (whose title links home).
 */
export async function revealModuleTop(frame: Frame) {
  const element = await frame.frameElement()
  await element.evaluate((iframe: HTMLElement) => {
    // the app bar is 64px high; leave a little room under it
    const below = 80
    // edrys-Lite may scroll a container rather than the page: scroll the nearest one that scrolls
    let scroller: Element | null = iframe.parentElement
    while (
      scroller &&
      !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
    ) {
      scroller = scroller.parentElement
    }
    ;(scroller || document.scrollingElement!).scrollBy(0, iframe.getBoundingClientRect().top - below)
  })
}

/**
 * The session's iframe of module `name`. Re-resolved each call: frames die on reload and room change.
 *
 * Modules with `<meta name="fetch" content="true">` or a YAML entry point are inlined by edrys-Lite as a
 * `data:` URL, so their frame URL does not start with the module URL. For those, pass `inline`: text that
 * occurs in the module's HTML (e.g. a string from its script), which identifies the `data:` frame.
 */
export async function moduleFrame(s: Session, name: string, timeout = 30_000, inline?: string): Promise<Frame> {
  const prefix = moduleUrl(name)
  // edrys-Lite encodes the inlined HTML with escape()
  const matches = (url: string) =>
    url.startsWith(prefix) || (!!inline && url.startsWith('data:') && unescape(url).includes(inline))
  let frame: Frame | undefined
  await expect
    .poll(
      () => {
        frame = s.page.frames().find((f) => matches(f.url()))
        return !!frame
      },
      { timeout, message: `iframe of ${name} in ${s.page.url()}` }
    )
    .toBe(true)
  return frame!
}
