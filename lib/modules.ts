import { BrowserContext, Frame, expect } from '@playwright/test'
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

/** Context hook: serve local modules and the local edrys.js. */
export async function serveModules(context: BrowserContext) {
  await context.route(`${MODULE_ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    let file = normalize(join(MODULES_DIR, path))
    if (!file.startsWith(MODULES_DIR)) return route.fulfill({ status: 403 })
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) return route.fulfill({ status: 404, body: `not found: ${path}` })
    await route.fulfill({
      status: 200,
      contentType: CONTENT_TYPES[extname(file)] || 'application/octet-stream',
      // scrapeModule fetches the entry point from the app's origin
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: readFileSync(file),
    })
  })

  await context.route(PUBLISHED_EDRYS_JS, async (route) => {
    const response = await route.fetch({ url: `${BASE_URL}/module/edrys.js` })
    await route.fulfill({ response })
  })
}

/** The session's iframe of module `name`. Re-resolved each call: frames die on reload and room change. */
export async function moduleFrame(s: Session, name: string, timeout = 30_000): Promise<Frame> {
  const prefix = moduleUrl(name)
  let frame: Frame | undefined
  await expect
    .poll(
      () => {
        frame = s.page.frames().find((f) => f.url().startsWith(prefix))
        return !!frame
      },
      { timeout, message: `iframe of ${name} in ${s.page.url()}` }
    )
    .toBe(true)
  return frame!
}
