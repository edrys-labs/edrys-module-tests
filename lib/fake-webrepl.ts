import { BrowserContext, WebSocketRoute } from '@playwright/test'

/**
 * A fake MicroPython board with WebREPL enabled, for module-micropython-webrepl.
 *
 * The module opens a WebSocket to the board (or to proxy.py in front of it).
 * `install(context)` answers WebSockets to `ws://webrepl.test…` in that context
 * with this fake, through Playwright's `routeWebSocket`, so no board and no
 * proxy are needed. The board lives in the test process, and tests drive it
 * directly:
 *
 *   const board = new FakeWebRepl()
 *   await board.install(context)
 *   stationConfig: { websocket: board.url }
 *
 *   board.print('hello\r\n')     // the board prints
 *   board.lines                  // every REPL line it got (after the password), in order
 *   board.files.get('main.py')   // files put on it; set entries to have files to get
 *   board.executed               // files run with exec(open(…).read()), and their content then
 *   board.putAckDelay = 3000     // a put is stored and confirmed this much later (slow board, large file)
 *   board.disconnect()           // the board drops every connection
 *   board.down = true            // the board is off: new connections are closed right away
 *   board.interrupts             // Ctrl-C received
 *   board.replies.set('1+1', '2') // what the board prints for a REPL line, before the prompt
 *
 * It speaks the parts of the WebREPL protocol the module uses: the password
 * prompt, the text REPL (echo, one prompt per line) and the binary put/get
 * file transfer ("WA" requests, "WB" responses, 2-byte length-prefixed chunks
 * for get). Like a real board it accepts any number of connections.
 */

const OK = Buffer.from([0x57, 0x42, 0, 0]) // "WB", status 0
const FAIL = Buffer.from([0x57, 0x42, 1, 0]) // "WB", status 1
const CHUNK = 256

type Transfer =
  | { kind: 'idle' }
  | { kind: 'put'; name: string; size: number; data: Buffer }
  | { kind: 'get'; name: string; data: Buffer; offset: number }

export class FakeWebRepl {
  /** The board's address; use it as the module's `websocket` station config. */
  readonly url = 'ws://webrepl.test:8266/'
  password = 'secret'
  /** The board's file system. */
  files = new Map<string, Buffer>()
  /** REPL lines the board received after login, in order. */
  lines: string[] = []
  /** Every `exec(open('<file>').read())`: the file and its content at that moment (null: no such file). */
  executed: { file: string; code: string | null }[] = []
  /** Delay before the board confirms a finished put, in ms. */
  putAckDelay = 0
  /** Connections opened so far. */
  connections = 0
  /** The board is off: connections are closed right away. */
  down = false
  /** Ctrl-C received (interrupts). */
  interrupts = 0
  /** What the board prints for a REPL line, before its next prompt (e.g. 'machine.freq()' -> '240000000'). */
  replies = new Map<string, string>()

  private sockets = new Set<WebSocketRoute>()

  async install(context: BrowserContext) {
    await context.routeWebSocket(/^ws:\/\/webrepl\.test/, (ws) => this.accept(ws))
  }

  /** Connections open right now. */
  get open() {
    return this.sockets.size
  }

  /** The board prints text on every open connection. */
  print(text: string) {
    for (const ws of this.sockets) ws.send(text)
  }

  /** The board drops every connection (reset, Wi-Fi lost). */
  disconnect() {
    for (const ws of this.sockets) ws.close({ code: 1001, reason: 'board reset' }).catch(() => {})
    this.sockets.clear()
  }

  private accept(ws: WebSocketRoute) {
    this.connections++
    if (this.down) {
      ws.close({ code: 1011, reason: 'board is off' }).catch(() => {})
      return
    }
    this.sockets.add(ws)
    let loggedIn = false
    let line = ''
    let transfer: Transfer = { kind: 'idle' }

    // with an onClose handler Playwright no longer completes the page's close() by itself
    ws.onClose((code, reason) => {
      this.sockets.delete(ws)
      ws.close({ code, reason }).catch(() => {})
    })
    ws.send('Password: ')

    const runLine = (text: string) => {
      this.lines.push(text)
      const exec = text.match(/^exec\(open\('([^']+)'\)\.read\(\)\)$/)
      const remove = text.match(/os\.remove\('([^']+)'\)/)
      if (exec) {
        const code = this.files.get(exec[1])?.toString('utf8') ?? null
        this.executed.push({ file: exec[1], code })
        if (code === null) ws.send(`OSError: [Errno 2] ENOENT\r\n`)
      } else if (remove) {
        this.files.delete(remove[1])
      } else if (this.replies.has(text)) {
        ws.send(`${this.replies.get(text)}\r\n`)
      }
      ws.send('>>> ')
    }

    const onText = (text: string) => {
      for (const ch of text) {
        if (!loggedIn) {
          if (ch === '\r' || ch === '\n') {
            if (line === this.password) {
              loggedIn = true
              ws.send('\r\nWebREPL connected\r\n>>> ')
            } else {
              ws.send('\r\nAccess denied\r\n')
              ws.close({ code: 1000 }).catch(() => {})
            }
            line = ''
          } else line += ch
          continue
        }
        if (ch === '\x03') {
          // Ctrl-C: interrupts a running program; at the prompt it drops the line
          line = ''
          this.interrupts++
          ws.send('\r\n>>> ')
        } else if (ch === '\r') {
          ws.send('\r\n')
          const done = line
          line = ''
          runLine(done)
        } else {
          ws.send(ch)
          line += ch
        }
      }
    }

    const onBinary = (data: Buffer) => {
      if (transfer.kind === 'put') {
        const put = transfer
        put.data = Buffer.concat([put.data, data])
        if (put.data.length >= put.size) {
          transfer = { kind: 'idle' }
          // the file exists once the board confirms it (written to flash)
          setTimeout(() => {
            this.files.set(put.name, put.data.subarray(0, put.size))
            ws.send(OK)
          }, this.putAckDelay)
        }
        return
      }

      if (transfer.kind === 'get') {
        // the client sends one 0 byte for "ready for the next chunk"
        const get = transfer
        const chunk = get.data.subarray(get.offset, get.offset + CHUNK)
        get.offset += chunk.length
        const header = Buffer.from([chunk.length & 0xff, chunk.length >> 8])
        ws.send(Buffer.concat([header, chunk]))
        if (chunk.length === 0) {
          transfer = { kind: 'idle' }
          ws.send(OK)
        }
        return
      }

      // WEBREPL_FILE = "<2sBBQLH64s": "WA", op, 0, 8 bytes, size (u32), name length (u16), name
      if (data.length < 18 || data[0] !== 0x57 || data[1] !== 0x41) return
      const op = data[2]
      const size = data.readUInt32LE(12)
      const name = data.subarray(18, 18 + data.readUInt16LE(16)).toString('latin1')
      if (op === 1) {
        transfer = { kind: 'put', name, size, data: Buffer.alloc(0) }
        ws.send(OK)
      } else if (op === 2) {
        const file = this.files.get(name)
        if (!file) return ws.send(FAIL)
        transfer = { kind: 'get', name, data: file, offset: 0 }
        ws.send(OK)
      }
    }

    ws.onMessage((message) => (typeof message === 'string' ? onText(message) : onBinary(message)))
  }
}
