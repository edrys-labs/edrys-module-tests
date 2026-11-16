import { BrowserContext, Frame } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * A fake Web Serial API (`navigator.serial`) with an Arduino behind it: an
 * ATmega328P with an STK500v1 bootloader (optiboot or the old ATmegaBOOT),
 * for station modules that flash boards. Unlike fake-serial.ts it is binary
 * and has `setSignals`, so the DTR reset into the bootloader works.
 *
 * The board resets when the port opens and when DTR goes low and high again.
 * After a reset its bootloader listens for one second (longer while it gets
 * commands), at `bootBaud` only; then the program in its flash runs. A
 * running program prints `bootText` and collects what is written to it.
 *
 *   await arduino(frame).print('hello\n')   // the running program prints
 *   await arduino(frame).written()          // text the program received
 *   await arduino(frame).flashed()          // flash content as hex, up to the last written byte
 *   await arduino(frame).set({ junk: [0, 0xfe] })   // bytes before the first answer
 *   await arduino(frame).unplug()
 */

export interface FakeArduinoOptions {
  /** Baud rate of the bootloader: 115200 (optiboot) or 57600 (old Nano bootloader). */
  bootBaud?: number
  /** Chip signature; 1e 95 0f is the ATmega328P. */
  signature?: number[]
  /** Printed by the program each time it starts. */
  bootText?: string
}

/** Context hook: install the fake board in every module iframe of this context. */
export async function installFakeArduino(context: BrowserContext, options: FakeArduinoOptions = {}) {
  await context.addInitScript(fakeArduino, { moduleOrigin: MODULE_ORIGIN, options })
}

// Runs in the page; must be self-contained.
function fakeArduino({ moduleOrigin, options }: { moduleOrigin: string; options: FakeArduinoOptions }) {
  if (location.origin !== moduleOrigin) return

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const board = {
    bootBaud: options.bootBaud ?? 115200,
    signature: options.signature ?? [0x1e, 0x95, 0x0f],
    bootText: options.bootText ?? '',
    /** Sent once before the bootloader's first answer after a reset. */
    junk: [] as number[],
    /** The bootloader never answers (a board without one, or a wrong baud). */
    dead: false,
    flash: new Uint8Array(32768).fill(0xff),
    flashEnd: 0,
    resets: 0,
    uploads: 0,
    /** GET_SYNC commands answered; more than 3 per upload means retries. */
    syncs: 0,
    written: '',
    mode: 'off' as 'off' | 'bootloader' | 'program',
  }

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    writable: WritableStream<Uint8Array> | null = null
    baudRate: number | null = null
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null
    private dtr = true
    private buffer: number[] = []
    private address = 0
    private junkSent = false
    private bootTimer: any = null

    async open({ baudRate }: { baudRate: number }) {
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      if (!(baudRate > 0)) throw new TypeError(`Invalid baudRate: ${baudRate}`)
      if (control.openError) throw new DOMException(control.openError, 'NetworkError')
      this.baudRate = baudRate
      this.readable = new ReadableStream({ start: (c) => (this.controller = c) })
      this.writable = new WritableStream({ write: (chunk) => this.receive(chunk) })
      // opening asserts DTR, which resets the board
      this.dtr = true
      this.reset()
    }

    async close() {
      if (this.readable?.locked || this.writable?.locked) {
        throw new DOMException('Cannot close a port with locked streams.', 'InvalidStateError')
      }
      this.readable = this.writable = null
      this.controller = null
    }

    async setSignals({ dataTerminalReady }: { dataTerminalReady?: boolean }) {
      if (!this.readable) throw new DOMException('The port is closed.', 'InvalidStateError')
      if (dataTerminalReady === undefined) return
      if (!this.dtr && dataTerminalReady) this.reset()
      this.dtr = dataTerminalReady
    }

    getInfo() {
      return { usbVendorId: 0x2341, usbProductId: 0x0043 }
    }

    private send(bytes: number[] | Uint8Array) {
      const chunk = Uint8Array.from(bytes)
      setTimeout(() => this.controller?.enqueue(chunk), 1)
    }

    print(text: string) {
      if (board.mode === 'program') this.send(encoder.encode(text))
    }

    private reset() {
      board.resets++
      board.mode = 'bootloader'
      this.buffer = []
      this.junkSent = false
      this.armBootTimer()
    }

    private armBootTimer() {
      clearTimeout(this.bootTimer)
      this.bootTimer = setTimeout(() => this.startProgram(), 1000)
    }

    private startProgram() {
      clearTimeout(this.bootTimer)
      board.mode = 'program'
      if (board.flashEnd && board.bootText && this.readable) this.send(encoder.encode(board.bootText))
    }

    private receive(chunk: Uint8Array) {
      if (board.mode === 'program') {
        board.written += decoder.decode(chunk, { stream: true })
        return
      }
      if (board.mode !== 'bootloader' || board.dead || this.baudRate !== board.bootBaud) return
      this.buffer.push(...chunk)
      this.armBootTimer()
      this.stk500()
    }

    // The STK500v1 subset optiboot implements
    private stk500() {
      const need = (b: number[]) => {
        const c = b[0]
        if (c === 0x42) return 22 // SET_DEVICE
        if (c === 0x55) return 4 // LOAD_ADDRESS
        if (c === 0x74) return 5 // READ_PAGE
        if (c === 0x64) return b.length >= 3 ? 5 + ((b[1] << 8) | b[2]) : Infinity // PROG_PAGE
        return 2
      }
      while (this.buffer.length && this.buffer.length >= need(this.buffer)) {
        const n = need(this.buffer)
        const cmd = this.buffer.splice(0, n)
        const out: number[] = []
        if (!this.junkSent) {
          out.push(...board.junk)
          this.junkSent = true
        }
        if (cmd[n - 1] !== 0x20) {
          this.send([...out, 0x15]) // NOSYNC
          continue
        }
        const c = cmd[0]
        if (c === 0x30) {
          board.syncs++
          out.push(0x14, 0x10)
        } else if (c === 0x75) out.push(0x14, ...board.signature, 0x10)
        else if (c === 0x55) {
          this.address = (cmd[1] | (cmd[2] << 8)) * 2
          out.push(0x14, 0x10)
        } else if (c === 0x64) {
          const data = cmd.slice(4, n - 1)
          board.flash.set(data, this.address)
          board.flashEnd = Math.max(board.flashEnd, this.address + data.length)
          out.push(0x14, 0x10)
        } else if (c === 0x74) {
          const length = (cmd[1] << 8) | cmd[2]
          out.push(0x14, ...board.flash.slice(this.address, this.address + length), 0x10)
        } else if (c === 0x50) {
          // (optiboot erases page by page; erasing here keeps flashed() to this upload)
          board.flash.fill(0xff)
          board.flashEnd = 0
          out.push(0x14, 0x10)
        } else if (c === 0x51) {
          board.uploads++
          out.push(0x14, 0x10)
          setTimeout(() => this.startProgram(), 5)
        } else out.push(0x14, 0x10)
        this.send(out)
      }
    }

    unplug() {
      clearTimeout(this.bootTimer)
      board.mode = 'off'
      this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'))
      this.readable = this.writable = null
      this.dispatchEvent(new Event('disconnect'))
    }
  }

  const port = new FakePort()
  const control = {
    port,
    board,
    cancelNextRequest: false,
    openError: '' as string,
    requests: 0,
  }

  const serial = new (class extends EventTarget {
    async requestPort() {
      control.requests++
      if (control.cancelNextRequest) {
        control.cancelNextRequest = false
        throw new DOMException('No port selected by the user.', 'NotFoundError')
      }
      return port
    }
    async getPorts() {
      return control.requests > 0 ? [port] : []
    }
  })()

  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
  ;(window as any).__fakeArduino = control
}

/** Drive the fake board inside a module frame. */
export function arduino(frame: Frame) {
  const run = <T>(fn: (c: any, arg: any) => T, arg?: any) =>
    frame.evaluate(([src, a]) => new Function('c', 'a', `return (${src})(c, a)`)((window as any).__fakeArduino, a), [
      fn.toString(),
      arg,
    ] as const) as Promise<T>

  return {
    print: (text: string) => run((c, t) => c.port.print(t), text),
    written: () => run<string>((c) => c.board.written),
    /** Flash content as hex, from address 0 up to the last written byte. */
    flashed: () =>
      run<string>((c) =>
        Array.from(c.board.flash.slice(0, c.board.flashEnd) as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join('')
      ),
    uploads: () => run<number>((c) => c.board.uploads),
    syncs: () => run<number>((c) => c.board.syncs),
    baudRate: () => run<number | null>((c) => c.port.baudRate),
    isOpen: () => run<boolean>((c) => !!c.port.readable),
    mode: () => run<string>((c) => c.board.mode),
    set: (changes: { junk?: number[]; dead?: boolean; signature?: number[]; bootText?: string; bootBaud?: number }) =>
      run((c, ch) => Object.assign(c.board, ch), changes),
    unplug: () => run((c) => c.port.unplug()),
    cancelNextRequest: () => run((c) => (c.cancelNextRequest = true)),
  }
}
