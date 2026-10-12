import { BrowserContext } from '@playwright/test'

/**
 * A fake of Wokwi's Arduino compile server (https://hexi.wokwi.com), which
 * module-avr8js and similar modules use to turn a sketch into a hex file.
 *
 * Installed per browser context, driven from the test:
 *
 *   const hexi = await installFakeHexi(context)
 *   hexi.respond('// e2e:blink', blinkResponse) // sketches containing the marker
 *   hexi.offline()                              // requests fail like a network error
 *   hexi.delay(2000)                            // answers arrive later
 *   hexi.requests                               // the sketches that were sent
 *   hexi.files                                  // the extra files sent with each sketch
 *
 * Responses have the server's shape ({ stdout, stderr, hex }); record real
 * ones once with curl and keep them as fixtures. A sketch without a matching
 * marker gets a compile error, so a missing fixture shows up in the module.
 */

export interface HexiResponse {
  stdout: string
  stderr: string
  hex: string
}

export interface HexiFile {
  name: string
  content: string
}

export class FakeHexi {
  readonly requests: string[] = []
  readonly files: HexiFile[][] = []
  private responses: { marker: string; response: HexiResponse }[] = []
  private isOffline = false
  private delayMs = 0

  respond(marker: string, response: HexiResponse) {
    this.responses.push({ marker, response })
    return this
  }

  offline(offline = true) {
    this.isOffline = offline
    return this
  }

  delay(ms: number) {
    this.delayMs = ms
    return this
  }

  /** @internal */
  answer(sketch: string, files: HexiFile[] = []): HexiResponse | null {
    this.requests.push(sketch)
    this.files.push(files)
    if (this.isOffline) return null
    const hit = this.responses.find((r) => sketch.includes(r.marker))
    return hit
      ? hit.response
      : { stdout: '\n', stderr: 'fake-hexi: no response recorded for this sketch\n', hex: '' }
  }

  /** @internal */
  get wait() {
    return this.delayMs
  }
}

/** Context hook: answer the compile server's /build requests from `hexi`. */
export async function installFakeHexi(context: BrowserContext, hexi = new FakeHexi()): Promise<FakeHexi> {
  await context.route('https://hexi.wokwi.com/**', async (route) => {
    const request = route.request()
    // the module's fetch is CORS with a JSON body, so the browser preflights it
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })

    let sketch = ''
    let files: HexiFile[] = []
    try {
      const body = JSON.parse(request.postData() || '{}')
      sketch = body.sketch || ''
      files = body.files || []
    } catch {}
    const response = hexi.answer(sketch, files)
    if (hexi.wait) await new Promise((r) => setTimeout(r, hexi.wait))
    if (!response) return route.abort('internetdisconnected')
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(response) })
  })
  return hexi
}
