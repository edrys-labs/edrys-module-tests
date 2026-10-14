import { BrowserContext, Frame } from '@playwright/test'

/**
 * A fake pyxtermjs terminal server for module-pyxtermjs (and other modules
 * that talk to it through the Socket.IO client).
 *
 * The module loads the Socket.IO client from cdnjs and connects to the
 * server's `/pty` namespace. Instead of speaking Engine.IO, the client script
 * itself is replaced by a small fake `io` whose sockets talk to an in-page
 * server, like `navigator.serial` is replaced by fake-serial. Tests drive the
 * server inside the frame that holds the socket (the station):
 *
 *   await pty(frame).output('hello\r\n')   // the shell prints
 *   await pty(frame).inputs()              // every `pty-input` the server got, in order
 *   await pty(frame).resizes()             // every `resize` the server got
 *   await pty(frame).stop()                // server goes away (open sockets disconnect)
 *   await pty(frame).start()               // server is back (connects and retries succeed)
 *   await pty(frame).connects()            // how many sockets the module opened
 *
 * With `echo` on (the default) the server echoes input back like a shell
 * with a tty does, `\r` as `\r\n`. While the server is down, sockets retry
 * like the real client (up to `reconnectionAttempts`), but every 50 ms
 * instead of with backoff; `pty(frame).retries()` counts them.
 */

const SOCKET_IO_CLIENT = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/**'

export interface FakePyxtermOptions {
  /** The server is reachable when the module first connects (default true). */
  up?: boolean
  /** Echo input back as output (default true). */
  echo?: boolean
}

/** Context hook: serve the fake Socket.IO client to module iframes. */
export async function installFakePyxterm(context: BrowserContext, options: FakePyxtermOptions = {}) {
  const settings = { up: options.up ?? true, echo: options.echo ?? true }
  await context.route(SOCKET_IO_CLIENT, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: `(${fakeSocketIo.toString()})(${JSON.stringify(settings)});`,
    })
  )
}

// Runs in the page; must be self-contained.
function fakeSocketIo(settings: { up: boolean; echo: boolean }) {
  const control: any = {
    up: settings.up,
    echo: settings.echo,
    sockets: [] as any[],
    inputs: [] as string[],
    resizes: [] as { cols: number; rows: number }[],
  }

  // the real client backs off up to reconnectionDelayMax; tests should not wait that long
  const RETRY_MS = 50

  class FakeSocket {
    connected = false
    closed = false
    handlers: Record<string, Function[]> = {}
    attempts = 0
    // retries since the socket was created, for tests
    retries = 0

    constructor(public url: string, public opts: any = {}) {
      control.sockets.push(this)
      // like the real client: connects asynchronously, after the caller added its handlers
      setTimeout(() => this.open(), 0)
    }

    on(event: string, fn: Function) {
      ;(this.handlers[event] ||= []).push(fn)
      return this
    }

    // like the real client: retry after a failed connect or a lost server, up to
    // `reconnectionAttempts` (default: no limit); every RETRY_MS instead of with backoff
    retry() {
      if (this.closed || this.opts.reconnection === false) return
      if (this.attempts >= (this.opts.reconnectionAttempts ?? Infinity)) return
      this.attempts++
      this.retries++
      setTimeout(() => this.open(), RETRY_MS)
    }

    removeAllListeners() {
      this.handlers = {}
      return this
    }

    fire(event: string, ...args: any[]) {
      for (const fn of this.handlers[event] || []) fn(...args)
    }

    open() {
      if (this.closed) return
      if (!control.up) {
        this.fire('connect_error', new Error('xhr poll error'))
        return this.retry()
      }
      this.connected = true
      this.attempts = 0
      this.fire('connect')
    }

    emit(event: string, data: any) {
      if (!this.connected) return this
      if (event === 'pty-input') {
        control.inputs.push(String(data?.input))
        if (control.echo) this.fire('pty-output', { output: String(data?.input).replace(/\r/g, '\r\n') })
      } else if (event === 'resize') {
        control.resizes.push({ cols: data?.cols, rows: data?.rows })
      }
      return this
    }

    close() {
      this.closed = true
      if (this.connected) {
        this.connected = false
        this.fire('disconnect', 'io client disconnect')
      }
      return this
    }

    disconnect() {
      return this.close()
    }
  }

  control.output = (text: string) => {
    for (const s of control.sockets) if (s.connected) s.fire('pty-output', { output: text })
  }
  control.stop = () => {
    control.up = false
    for (const s of control.sockets) {
      if (s.connected) {
        s.connected = false
        s.fire('disconnect', 'transport close')
        s.retry()
      }
    }
  }
  control.start = () => (control.up = true)

  const io: any = (url: string, opts?: any) => new FakeSocket(url, opts)
  io.connect = io
  ;(window as any).io = io
  ;(window as any).__fakePyxterm = control
}

/** Drive the fake server inside the module frame that holds the socket. */
export function pty(frame: Frame) {
  const run = <T>(fn: (c: any, arg: any) => T, arg?: any) =>
    frame.evaluate(([src, a]) => new Function('c', 'a', `return (${src})(c, a)`)((window as any).__fakePyxterm, a), [
      fn.toString(),
      arg,
    ] as const) as Promise<T>

  return {
    output: (text: string) => run((c, t) => c.output(t), text),
    inputs: () => run<string[]>((c) => c.inputs.slice()),
    resizes: () => run<{ cols: number; rows: number }[]>((c) => c.resizes.slice()),
    stop: () => run((c) => c.stop()),
    start: () => run((c) => c.start()),
    echo: (on: boolean) => run((c, v) => (c.echo = v), on),
    connects: () => run<number>((c) => c.sockets.length),
    retries: () => run<number>((c) => c.sockets.reduce((n: number, s: any) => n + s.retries, 0)),
    urls: () => run<string[]>((c) => c.sockets.map((s: any) => s.url)),
  }
}
