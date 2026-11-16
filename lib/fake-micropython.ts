import { BrowserContext, Frame } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * A fake Web Serial API (`navigator.serial`) with a MicroPython board behind
 * it, for station modules that copy .py files over the raw REPL. It answers
 * as a real Calliope mini 2 (MicroPython 1.9.2) did when measured:
 *
 *   Ctrl-C            stops the running program, "KeyboardInterrupt", ">>> "
 *   Ctrl-A            "\r\nraw REPL; CTRL-B to exit\r\n>"
 *   code + Ctrl-D     "OK<stdout>\x04<stderr>\x04>"
 *   Ctrl-D (no code)  "OK\r\nsoft reboot\r\nraw REPL; CTRL-B to exit\r\n>"
 *   Ctrl-B            the banner and ">>> "
 *
 * In the raw REPL it understands only what the module sends to write files:
 * `_f=open('name','wb')`, `_f.write(b'...')`, `_f.close()`; other code runs
 * without output. Code longer than `maxCode` fails with MemoryError, as on
 * the Calliope's 16 KB of RAM. In the normal REPL, `import <name>` "runs"
 * <name>.py: it prints `running <name>` and every line of the file starting
 * with `#>` (without the `#>`), then keeps running and collects what is
 * written to it, until Ctrl-C.
 *
 *   await micropython(frame).files()     // {name: content} on the board
 *   await micropython(frame).written()   // text the running program received
 *   await micropython(frame).set({ silent: true })   // no MicroPython (e.g. a MakeCode program)
 */

export interface FakeMicroPythonOptions {
  /** USB id the port reports; default a Calliope mini 1.x/2.x (SEGGER J-Link, 1366:1025). */
  usbVendorId?: number
  usbProductId?: number
  /** Longest code the raw REPL compiles without MemoryError. */
  maxCode?: number
}

/** Context hook: install the fake board in every module iframe of this context. */
export async function installFakeMicroPython(context: BrowserContext, options: FakeMicroPythonOptions = {}) {
  await context.addInitScript(fakeMicroPython, { moduleOrigin: MODULE_ORIGIN, options })
}

// Runs in the page; must be self-contained.
function fakeMicroPython({ moduleOrigin, options }: { moduleOrigin: string; options: FakeMicroPythonOptions }) {
  if (location.origin !== moduleOrigin) return

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const BANNER = '\r\nMicroPython v1.9.2-34-gd64154c73 on 2017-09-01; Calliope mini v1.1.1 with nRF51822\r\nType "help()" for more information.\r\n>>> '
  const RAW = '\r\nraw REPL; CTRL-B to exit\r\n>'

  const board = {
    usbVendorId: options.usbVendorId ?? 0x1366,
    usbProductId: options.usbProductId ?? 0x1025,
    // measured on a Calliope mini 2 right after a soft reset: `_f.write(b'...')`
    // of 1549 characters works, 1805 fails with MemoryError
    maxCode: options.maxCode ?? 1500,
    /** Doesn't answer at all (no MicroPython on it). */
    silent: false,
    /** Milliseconds before the board's answers arrive. */
    answerDelay: 1,
    /** Milliseconds boot.py takes after a soft reboot (an Alvik waiting for Wi-Fi: 15 s). */
    bootDelay: 0,
    /** Name -> file content as bytes. */
    files: {} as Record<string, number[]>,
    mode: 'repl' as 'repl' | 'raw' | 'running',
    /** The program that runs, as `import` named it. */
    running: '',
    written: '',
    softResets: 0,
    /** Longest code the raw REPL got in one exec. */
    longestCode: 0,
    imports: [] as string[],
  }

  /** b'...' or '...' -> bytes (the escapes the module writes). */
  function literal(text: string): number[] | null {
    const m = /^b?'((?:[^'\\]|\\.)*)'$/s.exec(text)
    if (!m) return null
    const out: number[] = []
    const body = m[1]
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      if (c !== '\\') {
        out.push(...encoder.encode(c))
        continue
      }
      const e = body[++i]
      if (e === 'x') {
        out.push(parseInt(body.slice(i + 1, i + 3), 16))
        i += 2
      } else out.push(({ n: 10, r: 13, t: 9 } as Record<string, number>)[e] ?? e.charCodeAt(0))
    }
    return out
  }

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    writable: WritableStream<Uint8Array> | null = null
    baudRate: number | null = null
    signals = { dataTerminalReady: false, requestToSend: false }
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null
    private line = ''
    private code = ''
    private openFile: string | null = null

    async open({ baudRate }: { baudRate: number }) {
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      this.baudRate = baudRate
      this.readable = new ReadableStream({ start: (c) => (this.controller = c) })
      this.writable = new WritableStream({ write: (chunk) => this.receive(chunk) })
    }

    async close() {
      if (this.readable?.locked || this.writable?.locked) {
        throw new DOMException('Cannot close a port with locked streams.', 'InvalidStateError')
      }
      this.readable = this.writable = null
      this.controller = null
    }

    async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
      Object.assign(this.signals, signals)
    }

    getInfo() {
      return { usbVendorId: board.usbVendorId, usbProductId: board.usbProductId }
    }

    send(text: string) {
      const chunk = encoder.encode(text)
      setTimeout(() => this.controller?.enqueue(chunk), board.answerDelay)
    }

    private receive(chunk: Uint8Array) {
      if (board.silent) return
      for (const ch of decoder.decode(chunk, { stream: true })) this.char(ch)
    }

    private char(ch: string) {
      if (ch === '\x03') {
        if (board.mode === 'running') this.send('Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nKeyboardInterrupt: \r\n>>> ')
        else if (board.mode === 'repl') this.send('\r\n>>> ')
        if (board.mode !== 'raw') board.mode = 'repl'
        this.line = ''
        return
      }
      if (board.mode === 'running') {
        board.written += ch
        return
      }
      if (board.mode === 'repl') {
        if (ch === '\x01') {
          board.mode = 'raw'
          this.code = ''
          this.send(RAW)
        } else if (ch === '\r') {
          this.send('\r\n')
          const m = /^import (\w+)$/.exec(this.line.trim())
          this.line = ''
          if (m && board.files[m[1] + '.py']) this.run(m[1])
          else this.send(m ? `ImportError: no module named '${m[1]}'\r\n>>> ` : '>>> ')
        } else {
          this.line += ch
          this.send(ch) // echo
        }
        return
      }
      // raw REPL
      if (ch === '\x02') {
        board.mode = 'repl'
        this.send(BANNER)
      } else if (ch === '\x01') {
        this.code = ''
        this.send(RAW)
      } else if (ch === '\x04') {
        const code = this.code
        this.code = ''
        if (!code) {
          board.softResets++
          this.openFile = null
          this.send('OK\r\nsoft reboot\r\n')
          setTimeout(() => this.send(RAW.slice(2)), board.bootDelay)
        } else this.exec(code)
      } else this.code += ch
    }

    private exec(code: string) {
      board.longestCode = Math.max(board.longestCode, code.length)
      if (code.length > board.maxCode) {
        this.send('OK\x04Traceback (most recent call last):\r\nMemoryError: memory allocation failed\r\n\x04>')
        return
      }
      let m
      if ((m = /^_f=open\((.+),'wb'\)$/s.exec(code))) {
        const name = literal(m[1])
        if (name) {
          this.openFile = decoder.decode(Uint8Array.from(name))
          board.files[this.openFile] = []
        }
      } else if ((m = /^_f\.write\((.+)\)$/s.exec(code))) {
        const bytes = literal(m[1])
        if (!this.openFile || !bytes) {
          this.send("OK\x04Traceback (most recent call last):\r\nNameError: name '_f' isn't defined\r\n\x04>")
          return
        }
        board.files[this.openFile].push(...bytes)
      } else if (code === '_f.close()') this.openFile = null
      this.send('OK\x04\x04>')
    }

    private run(name: string) {
      board.mode = 'running'
      board.running = name
      board.written = ''
      board.imports.push(name)
      const source = decoder.decode(Uint8Array.from(board.files[name + '.py']))
      const printed = source
        .split('\n')
        .filter((l) => l.startsWith('#>'))
        .map((l) => l.slice(2) + '\r\n')
        .join('')
      this.send(`running ${name}\r\n` + printed)
    }

    unplug() {
      this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'))
      this.readable = this.writable = null
      this.dispatchEvent(new Event('disconnect'))
    }
  }

  const port = new FakePort()
  const control = { port, board, requests: 0 }

  const serial = new (class extends EventTarget {
    async requestPort() {
      control.requests++
      return port
    }
    async getPorts() {
      return control.requests > 0 ? [port] : []
    }
  })()

  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
  ;(window as any).__fakeMicroPython = control
}

/** Drive the fake board inside a module frame. */
export function micropython(frame: Frame) {
  const run = <T>(fn: (c: any, arg: any) => T, arg?: any) =>
    frame.evaluate(([src, a]) => new Function('c', 'a', `return (${src})(c, a)`)((window as any).__fakeMicroPython, a), [
      fn.toString(),
      arg,
    ] as const) as Promise<T>

  return {
    /** Files on the board, as UTF-8 text. */
    files: () =>
      run<Record<string, string>>((c) =>
        Object.fromEntries(
          Object.entries(c.board.files as Record<string, number[]>).map(([k, v]) => [k, new TextDecoder().decode(Uint8Array.from(v))])
        )
      ),
    written: () => run<string>((c) => c.board.written),
    mode: () => run<string>((c) => c.board.mode),
    imports: () => run<string[]>((c) => c.board.imports),
    softResets: () => run<number>((c) => c.board.softResets),
    longestCode: () => run<number>((c) => c.board.longestCode),
    signals: () => run<{ dataTerminalReady: boolean; requestToSend: boolean }>((c) => c.port.signals),
    print: (text: string) => run((c, t) => c.port.send(t), text),
    set: (changes: { silent?: boolean; maxCode?: number; answerDelay?: number; bootDelay?: number }) => run((c, ch) => Object.assign(c.board, ch), changes),
  }
}
