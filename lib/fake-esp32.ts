import { BrowserContext, Frame } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * A fake Web Serial API (`navigator.serial`) with an ESP32 board behind it,
 * and a fake esptool-js served in place of the real one from jsdelivr, for
 * station modules that flash ESP32 boards.
 *
 * It does what the real boards did on the bench, so a module that skips one
 * of the steps they need fails here too:
 * - classic devkit (CH340, one port): RTS with DTR low holds EN low; when EN
 *   is released the chip starts, in the bootloader only if IO0 (DTR high,
 *   RTS low) is low at that moment;
 * - Arduino Nano ESP32 (native USB): an Arduino sketch reboots into the ROM
 *   bootloader when its port is opened at 1200 baud and sets the "force
 *   download" flag; the bootloader is another USB device (303a:1001); a reset
 *   with that flag still set lands in the bootloader again; the sketch's
 *   Serial output only flows while DTR is on;
 * - esptool-js's after("hard_reset") sends no reset pulse (as 0.7.1).
 *
 *   await esp32(frame).print('hello\n')    // the running sketch prints
 *   await esp32(frame).flashed()           // {offset: hex} written by the last upload
 *   await esp32(frame).state()             // mode, port, uploads, …
 */

export const ESPTOOL_URL = 'https://cdn.jsdelivr.net/npm/esptool-js@0.7.1/bundle.js'

export interface FakeEsp32Options {
  kind: 'classic' | 'nano'
  /** What esptool-js reports as the chip; defaults to the kind's real chip. */
  chip?: string
  /** What runs on a Nano ESP32 before the first upload: an Arduino sketch or MicroPython. */
  firmware?: 'arduino' | 'micropython'
  /** Printed by the program each time it starts. */
  bootText?: string
}

/** Context hook: the fake board in every module iframe, the fake esptool-js for every request. */
export async function installFakeEsp32(context: BrowserContext, options: FakeEsp32Options) {
  await context.route(ESPTOOL_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: FAKE_ESPTOOL,
    })
  )
  await context.addInitScript(fakeEsp32, { moduleOrigin: MODULE_ORIGIN, options })
}

// The part of esptool-js 0.7.1's API the module uses. The chip side lives in
// the fake port (port.__esp).
const FAKE_ESPTOOL = `
export class Transport {
  constructor(device) { this.device = device; this._DTR_state = false }
  async connect(baud = 115200) { await this.device.open({ baudRate: baud }) }
  async disconnect() { try { await this.device.close() } catch {} }
  async setRTS(state) { await this.device.setSignals({ requestToSend: state }); await this.setDTR(this._DTR_state) }
  async setDTR(state) { this._DTR_state = state; await this.device.setSignals({ dataTerminalReady: state }) }
}
export class ESPLoader {
  constructor({ transport }) { this.transport = transport }
  get esp() { return this.transport.device.__esp }
  async main(mode = 'default_reset') {
    await this.transport.connect(115200)
    return this.esp.connect(mode)
  }
  async writeFlash({ fileArray, reportProgress }) {
    for (let i = 0; i < fileArray.length; i++) {
      const { data, address } = fileArray[i]
      const total = Math.max(1, Math.ceil(data.length / 2))
      reportProgress?.(i, Math.floor(total / 2), total)
      // a small real flash takes seconds: long enough for the room to see it
      await new Promise((r) => setTimeout(r, 500))
      this.esp.write(address, data)
      reportProgress?.(i, total, total)
    }
  }
  async writeReg(addr, value, mask = 0xffffffff) { this.esp.writeReg(addr, value, mask) }
  // like the real one: no reset pulse
  async after() {}
}
`

// Runs in the page; must be self-contained.
function fakeEsp32({ moduleOrigin, options }: { moduleOrigin: string; options: FakeEsp32Options }) {
  if (location.origin !== moduleOrigin) return

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const nano = options.kind === 'nano'

  const board = {
    chip: options.chip ?? (nano ? 'ESP32-S3 (QFN56) (revision v0.2)' : 'ESP32-D0WD-V3 (revision v3.1)'),
    firmware: options.firmware ?? 'arduino',
    bootText: options.bootText ?? '',
    /** off | program | rom */
    mode: 'program' as string,
    forceDownload: false,
    /** offset -> hex of the last upload */
    flash: {} as Record<number, string>,
    uploads: 0,
    resets: 0,
    regWrites: [] as number[][],
    written: '',
    dead: false,
  }

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    writable: WritableStream<Uint8Array> | null = null
    baudRate: number | null = null
    dtr = false
    rts = false
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null

    constructor(
      readonly role: 'uart' | 'sketch' | 'rom',
      readonly usb: { usbVendorId: number; usbProductId: number }
    ) {
      super()
    }

    get present() {
      if (this.role === 'uart') return board.mode !== 'off'
      return board.mode === (this.role === 'sketch' ? 'program' : 'rom')
    }

    getInfo() {
      return { ...this.usb }
    }

    async open({ baudRate }: { baudRate: number }) {
      if (!this.present) throw new DOMException('The device has been lost.', 'NetworkError')
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      this.baudRate = baudRate
      this.readable = new ReadableStream({ start: (c) => (this.controller = c) })
      this.writable = new WritableStream({
        write: (chunk) => {
          if (board.mode === 'program') board.written += decoder.decode(chunk, { stream: true })
        },
      })
      // opening raises DTR and RTS together (no reset on a devkit)
      this.dtr = this.rts = true
      // the Arduino core reboots into the ROM bootloader on 1200 baud
      if (this.role === 'sketch' && baudRate === 1200 && board.firmware === 'arduino') {
        setTimeout(() => {
          board.forceDownload = true
          switchMode('rom')
        }, 50)
      }
    }

    async close() {
      if (this.readable?.locked || this.writable?.locked) {
        throw new DOMException('Cannot close a port with locked streams.', 'InvalidStateError')
      }
      this.readable = this.writable = null
      this.controller = null
    }

    async setSignals({ dataTerminalReady, requestToSend }: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
      if (!this.readable) throw new DOMException('The port is closed.', 'InvalidStateError')
      const enBefore = !(this.rts && !this.dtr)
      if (dataTerminalReady !== undefined) this.dtr = dataTerminalReady
      if (requestToSend !== undefined) this.rts = requestToSend
      const en = !(this.rts && !this.dtr)
      const io0Low = this.dtr && !this.rts
      // the sketch port is TinyUSB CDC: DTR/RTS don't reset anything
      if (this.role !== 'sketch' && !enBefore && en) reset(io0Low)
    }

    send(bytes: Uint8Array) {
      setTimeout(() => this.controller?.enqueue(bytes), 1)
    }

    lose() {
      try {
        this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'))
      } catch {}
      this.readable = this.writable = null
      this.controller = null
      this.dispatchEvent(new Event('disconnect'))
    }

    /** The chip side of the fake esptool-js */
    __esp = {
      connect: (mode: string) => {
        if (board.dead) throw new Error('Failed to connect with the device')
        // a classic devkit is put into the bootloader by esptool's own reset
        if (this.role === 'uart' && mode !== 'no_reset' && mode !== 'no_reset_no_sync') board.mode = 'rom'
        if (board.mode !== 'rom' || this.role === 'sketch') throw new Error('Failed to connect with the device')
        return board.chip
      },
      write: (address: number, data: Uint8Array) => {
        if (board.mode !== 'rom') throw new Error('Serial data stream stopped')
        // kept until the chip starts the program, so a flash that never starts shows as none
        pendingWrite[address] = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
      },
      writeReg: (addr: number, value: number, mask: number) => {
        board.regWrites.push([addr, value, mask])
        // ESP32-S3 RTC_CNTL_OPTION1_REG, bit 0: force download boot
        if (addr === 0x6000812c && mask & 1) board.forceDownload = !!(value & 1)
      },
    }
  }

  let pendingWrite: Record<number, string> = {}

  const ports: FakePort[] = nano
    ? [new FakePort('sketch', { usbVendorId: 0x2341, usbProductId: 0x0070 }), new FakePort('rom', { usbVendorId: 0x303a, usbProductId: 0x1001 })]
    : [new FakePort('uart', { usbVendorId: 0x1a86, usbProductId: 0x7523 })]
  const granted = new Set<FakePort>()

  function announce(port: FakePort) {
    if (!granted.has(port)) return
    const event = new Event('connect')
    Object.defineProperty(event, 'target', { value: port })
    serial.dispatchEvent(event)
  }

  function startProgram() {
    if (Object.keys(pendingWrite).length) {
      board.flash = pendingWrite
      pendingWrite = {}
      board.uploads++
    }
    const port = ports.find((p) => p.role !== 'rom')!
    if (board.bootText) setTimeout(() => print(board.bootText), 20)
    return port
  }

  // Nano ESP32: the sketch and the bootloader are two USB devices
  function switchMode(mode: 'program' | 'rom') {
    if (board.mode === mode) return
    const before = ports.find((p) => p.present)
    board.mode = mode
    if (mode === 'program') startProgram()
    const after = ports.find((p) => p.present)
    if (before !== after) {
      before?.lose()
      setTimeout(() => after && announce(after), 30)
    }
  }

  function reset(io0Low: boolean) {
    board.resets++
    if (nano) {
      switchMode(board.forceDownload ? 'rom' : 'program')
    } else {
      board.mode = io0Low ? 'rom' : 'program'
      if (board.mode === 'program') startProgram()
    }
  }

  function print(text: string) {
    if (board.mode !== 'program') return
    const port = ports.find((p) => p.role !== 'rom')!
    // TinyUSB CDC sends nothing while the host hasn't raised DTR
    if (port.role === 'sketch' && !port.dtr) return
    port.send(encoder.encode(text))
  }

  const control = { board, ports, granted, requests: 0, cancelNextRequest: false, print }

  const serial = new (class extends EventTarget {
    // like Chrome's chooser, it lists a device as soon as it appears
    async requestPort({ filters = [] }: { filters?: { usbVendorId?: number; usbProductId?: number }[] } = {}) {
      control.requests++
      if (control.cancelNextRequest) {
        control.cancelNextRequest = false
        throw new DOMException('No port selected by the user.', 'NotFoundError')
      }
      const matches = (p: FakePort) =>
        !filters.length ||
        filters.some(
          (f) =>
            (f.usbVendorId === undefined || f.usbVendorId === p.usb.usbVendorId) &&
            (f.usbProductId === undefined || f.usbProductId === p.usb.usbProductId)
        )
      for (let i = 0; i < 40; i++) {
        const port = ports.find((p) => p.present && matches(p))
        if (port) {
          granted.add(port)
          return port
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new DOMException('No port selected by the user.', 'NotFoundError')
    }
    async getPorts() {
      return ports.filter((p) => granted.has(p) && p.present)
    }
  })()

  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
  ;(window as any).__fakeEsp32 = control
}

/** Drive the fake board inside a module frame. */
export function esp32(frame: Frame) {
  const run = <T>(fn: (c: any, arg: any) => T, arg?: any) =>
    frame.evaluate(([src, a]) => new Function('c', 'a', `return (${src})(c, a)`)((window as any).__fakeEsp32, a), [
      fn.toString(),
      arg,
    ] as const) as Promise<T>

  return {
    print: (text: string) => run((c, t) => c.print(t), text),
    written: () => run<string>((c) => c.board.written),
    /** {offset: hex} written by the last upload */
    flashed: () => run<Record<string, string>>((c) => c.board.flash),
    state: () =>
      run<{ mode: string; uploads: number; forceDownload: boolean; requests: number; granted: string[]; openPort: string | null }>(
        (c) => ({
          mode: c.board.mode,
          uploads: c.board.uploads,
          forceDownload: c.board.forceDownload,
          requests: c.requests,
          granted: [...c.granted].map((p: any) => p.role),
          openPort: c.ports.find((p: any) => p.readable)?.role ?? null,
        })
      ),
    set: (changes: { firmware?: string; dead?: boolean; chip?: string }) => run((c, ch) => Object.assign(c.board, ch), changes),
  }
}
