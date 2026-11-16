import { BrowserContext } from '@playwright/test'

/**
 * A fake of edrys-compile-server's job API (POST /compile, GET /jobs/:id),
 * which station flasher modules use to turn students' code into a hex file.
 *
 *   const server = await installFakeCompileServer(context)
 *   server.done('// e2e:blink', hexText)        // code containing the marker compiles
 *   server.fail('// e2e:typo', 'sketch.ino:1: error: ...')
 *   server.queued(2)                            // each job waits 2 polls in the queue first
 *   server.offline()                            // requests fail like a network error
 *   server.requests                             // { fqbn, files, main, headers } per POST /compile
 *
 * Code without a matching marker gets a compile error, so a missing fixture
 * shows up in the module.
 */

export const COMPILE_SERVER = 'http://localhost:8080'

export interface CompileRequest {
  fqbn: string
  files: { name: string; content: string }[]
  main?: string
  headers: Record<string, string>
}

type Result = { status: 'done'; log: string; artifact: { type: 'hex'; data: string } } | { status: 'error'; log: string }

export class FakeCompileServer {
  readonly requests: CompileRequest[] = []
  private results: { marker: string; result: Result }[] = []
  private jobs = new Map<string, { result: Result; polls: number }>()
  private queuePolls = 0
  private isOffline = false

  done(marker: string, hex: string, log = 'Sketch uses 2002 bytes (6%) of program storage space.\n') {
    this.results.push({ marker, result: { status: 'done', log, artifact: { type: 'hex', data: hex } } })
    return this
  }

  fail(marker: string, log: string) {
    this.results.push({ marker, result: { status: 'error', log } })
    return this
  }

  queued(polls: number) {
    this.queuePolls = polls
    return this
  }

  offline(offline = true) {
    this.isOffline = offline
    return this
  }

  /** @internal */
  submit(request: CompileRequest): string | null {
    this.requests.push(request)
    if (this.isOffline) return null
    const code = request.files.map((f) => f.content).join('\n')
    const hit = this.results.find((r) => code.includes(r.marker))
    const result: Result = hit
      ? hit.result
      : { status: 'error', log: 'fake-compile-server: no result recorded for this code\n' }
    const id = Math.random().toString(16).slice(2).padEnd(32, '0')
    this.jobs.set(id, { result, polls: 0 })
    return id
  }

  /** @internal */
  poll(id: string): object | null {
    const job = this.jobs.get(id)
    if (!job) return null
    job.polls++
    if (job.polls <= this.queuePolls) return { status: 'queued', position: this.queuePolls - job.polls + 1 }
    if (job.polls === this.queuePolls + 1) return { status: 'compiling' }
    return job.result
  }

  /** @internal */
  get offlineNow() {
    return this.isOffline
  }
}

/** Context hook: answer the compile server's requests from `server`. */
export async function installFakeCompileServer(
  context: BrowserContext,
  server = new FakeCompileServer(),
  base = COMPILE_SERVER
): Promise<FakeCompileServer> {
  await context.route(`${base}/**`, async (route) => {
    const request = route.request()
    const cors = {
      'Access-Control-Allow-Origin': request.headers()['origin'] || '*',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Station-Id',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (server.offlineNow) return route.abort('internetdisconnected')

    const json = (status: number, body: object) =>
      route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
    const path = new URL(request.url()).pathname

    if (request.method() === 'POST' && path === '/compile') {
      let body: any = {}
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {}
      const id = server.submit({ fqbn: body.fqbn, files: body.files || [], main: body.main, headers: request.headers() })
      if (!id) return route.abort('internetdisconnected')
      return json(202, { jobId: id })
    }
    const match = path.match(/^\/jobs\/([0-9a-f]+)$/)
    if (request.method() === 'GET' && match) {
      const view = server.poll(match[1])
      return view ? json(200, view) : json(404, { error: 'unknown or expired job' })
    }
    return json(404, { error: 'not found' })
  })
  return server
}
