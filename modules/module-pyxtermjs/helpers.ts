import { Frame, expect } from '@playwright/test'
import { Session } from '../../lib/edrys'
import { moduleFrame } from '../../lib/modules'

/**
 * Helpers shared by the module-pyxtermjs specs (fake server and real server).
 *
 * The module is served from dist/, the build that GitHub Pages publishes.
 * dist/ is not committed: run `npm run build` in the module before the tests.
 */

export const MODULE = 'module-pyxtermjs'
export const ENTRY = 'dist/index.html'
// time for a message to travel between peers
export const SYNC = 15_000
// time for a new peer's first answer from the station: its first messages can be lost
// while the WebRTC connection stalls and is rebuilt (~15 s, edrys-Lite 546d376), and
// the module keeps sending `join`. Same budget as edrys-Lite's waitForMesh.
export const JOIN = 45_000

/** The module's iframe, once Edrys.onReady has run and the terminal exists. */
export async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 30_000 })
  await frame.waitForFunction(() => !!(window as any).term)
  return frame
}

export const badge = (frame: Frame) => frame.locator('.status .badge')
export const controls = (frame: Frame) => frame.locator('.controls')
export const scriptBox = (frame: Frame) => frame.locator('#app textarea')
export const serverInput = (frame: Frame) => frame.locator('.controls input[type="url"]')
export const checkbox = (frame: Frame, role: 'student' | 'teacher') =>
  frame.locator('.controls label').filter({ hasText: role }).locator('input')

export async function typeInto(frame: Frame, keys: string) {
  const input = frame.locator('.xterm-helper-textarea')
  await input.focus()
  await input.pressSequentially(keys)
}

/** Send a message from the module's frame, as the module or another module would. */
export async function send(frame: Frame, subject: string, body: any) {
  await frame.evaluate(([subject, body]) => (window as any).Edrys.sendMessage(subject, body), [subject, body] as const)
}

/**
 * Wait until the station has handled everything `student` sent so far: send a
 * `join` and wait for the station's answer. Messages from one peer arrive in
 * order, so anything sent before the join has been handled by then.
 */
export async function flush(student: Frame, execute = 'execute') {
  await student.evaluate(
    (subject) =>
      new Promise<void>((resolve) => {
        const Edrys = (window as any).Edrys
        const off = Edrys.onMessage(({ subject: s }: any) => {
          if (s === subject) {
            off()
            resolve()
          }
        })
        Edrys.sendMessage('join', null)
      }),
    'connect_' + execute
  )
}

export const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

export const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
