import { BrowserContext, Frame } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * A fake Web Serial API (`navigator.serial`) for module iframes, with one
 * device behind it. Tests drive the device from the outside:
 *
 *   await serial(frame).emit('hello\n')   // device prints
 *   await serial(frame).written()         // what the module wrote to it
 *   await serial(frame).fail()            // recoverable read error
 *   await serial(frame).unplug()          // device lost
 *
 * Mirrors the parts of the spec modules rely on: `readable` is replaced after
 * a recoverable error and becomes null when the device is lost, and the port
 * fires `disconnect` on unplug.
 */

/**
 * Context hook: install the fake in every module iframe of this context.
 *
 * `rememberGrants`: like a real browser, a port chosen once in the picker is
 * returned by `getPorts()` after a reload too (kept in the module origin's
 * localStorage). Off by default: then `getPorts()` only knows ports chosen
 * since the page loaded.
 */
export async function installFakeSerial(context: BrowserContext, { rememberGrants = false } = {}) {
  await context.addInitScript(fakeSerial, { moduleOrigin: MODULE_ORIGIN, rememberGrants })
}

// Runs in the page; must be self-contained.
function fakeSerial({ moduleOrigin, rememberGrants }: { moduleOrigin: string; rememberGrants: boolean }) {
  if (location.origin !== moduleOrigin) return
  const GRANT_KEY = '__fakeSerialGranted'

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null
    writable: WritableStream<Uint8Array> | null = null
    baudRate: number | null = null
    written = ''
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null

    async open({ baudRate }: { baudRate: number }) {
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError')
      if (!(baudRate > 0)) throw new TypeError(`Invalid baudRate: ${baudRate}`)
      if (control.openError) throw new DOMException(control.openError, 'NetworkError')
      this.baudRate = baudRate
      this.newReadable()
      this.writable = new WritableStream({
        write: (chunk) => {
          this.written += decoder.decode(chunk, { stream: true })
        },
      })
    }

    async close() {
      this.readable = this.writable = null
    }

    getInfo() {
      return { usbVendorId: 0x2341, usbProductId: 0x0043 }
    }

    newReadable() {
      this.readable = new ReadableStream({ start: (c) => (this.controller = c) })
    }

    emit(text: string) {
      this.controller?.enqueue(encoder.encode(text))
    }

    // Like a BreakError/FramingError: the current stream errors, a new one
    // takes its place, and the port stays open.
    fail(name = 'FramingError') {
      const old = this.controller
      this.newReadable()
      old?.error(new DOMException('A framing error was detected.', name))
    }

    unplug() {
      this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'))
      this.readable = this.writable = null
      this.dispatchEvent(new Event('disconnect'))
    }
  }

  const port = new FakePort()
  const control = {
    port,
    /** `requestPort()` rejects as if the user cancelled the picker. */
    cancelNextRequest: false,
    /** `open()` rejects with this message (e.g. port busy). */
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
      if (rememberGrants) localStorage.setItem(GRANT_KEY, '1')
      return port
    }
    async getPorts() {
      const granted = control.requests > 0 || (rememberGrants && localStorage.getItem(GRANT_KEY) === '1')
      return granted ? [port] : []
    }
  })()

  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true })
  ;(window as any).__fakeSerial = control
}

/** Drive the fake device inside a module frame. */
export function serial(frame: Frame) {
  const run = <T>(fn: (c: any, arg: any) => T, arg?: any) =>
    frame.evaluate(([src, a]) => new Function('c', 'a', `return (${src})(c, a)`)((window as any).__fakeSerial, a), [
      fn.toString(),
      arg,
    ] as const) as Promise<T>

  return {
    emit: (text: string) => run((c, t) => c.port.emit(t), text),
    fail: (name?: string) => run((c, n) => c.port.fail(n), name),
    unplug: () => run((c) => c.port.unplug()),
    written: () => run<string>((c) => c.port.written),
    baudRate: () => run<number | null>((c) => c.port.baudRate),
    isOpen: () => run<boolean>((c) => !!c.port.readable),
    cancelNextRequest: () => run((c) => (c.cancelNextRequest = true)),
    failNextOpen: (message: string) => run((c, m) => (c.openError = m), message),
  }
}
