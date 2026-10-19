import { BrowserContext, Page, Route } from '@playwright/test'

/**
 * A fake station-lights server (station-lights-module's `station-lights-server`)
 * for module iframes. The module posts to `http://localhost:3000/api/light`
 * and `/api/heartbeat`; this answers those requests in the browser and records
 * them, so neither the server nor an Elgato light is needed.
 *
 *   const lights = new FakeLightServer()
 *   await lights.install(context)   // in every context that should reach "localhost:3000"
 *   lights.lights(page)             // bodies of POST /api/light, optionally only from one page
 *   lights.heartbeats(page)         // bodies of POST /api/heartbeat
 *   lights.from(page)               // every request a page's module frames made
 *   lights.down = true              // requests fail like a refused connection
 *   lights.status = 500             // the server answers with this status
 *
 * One instance can serve several contexts; each request remembers the page
 * (tab) whose frame sent it, because the station shares the teacher's context.
 */

export const LIGHTS_SERVER = 'http://localhost:3000'

export interface LightRequest {
  method: string
  path: string
  body: any
  page: Page | null
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export class FakeLightServer {
  requests: LightRequest[] = []
  down = false
  status = 200

  async install(context: BrowserContext) {
    await context.route(`${LIGHTS_SERVER}/**`, (route) => this.handle(route))
  }

  private async handle(route: Route) {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (this.down) return route.abort('connectionrefused')

    let page: Page | null = null
    try {
      page = request.frame().page()
    } catch {}
    let body: any = null
    try {
      body = request.postDataJSON()
    } catch {}
    this.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body, page })

    await route.fulfill({
      status: this.status,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify(this.status === 200 ? { status: 'OK' } : { error: 'fake failure' }),
    })
  }

  from(page?: Page) {
    return this.requests.filter((r) => !page || r.page === page)
  }

  lights(page?: Page) {
    return this.from(page)
      .filter((r) => r.method === 'POST' && r.path === '/api/light')
      .map((r) => r.body)
  }

  heartbeats(page?: Page) {
    return this.from(page)
      .filter((r) => r.method === 'POST' && r.path === '/api/heartbeat')
      .map((r) => r.body)
  }
}
