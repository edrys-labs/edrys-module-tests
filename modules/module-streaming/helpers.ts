import { Frame, expect } from '@playwright/test'
import { Session } from '../../lib/edrys'
import { moduleFrame } from '../../lib/modules'
import { CameraColor, media, nearestColor, videoColor } from '../../lib/fake-media'

/** Shared by streaming.spec.ts (fake servers) and real-server.spec.ts. */

export const MODULE = 'module-streaming'

/**
 * Skip reasons for browser gaps (checked in bare pages, without edrys):
 * Playwright's WebKit on Linux encodes no frames of a canvas-captured track
 * over WebRTC (0 framesEncoded), so the fake camera of a WebKit station never
 * reaches a viewer; it also has no MediaRecorder or captureStream, which the
 * websocket method needs.
 */
export const NO_WEBKIT_VIDEO = 'Playwright WebKit (Linux) sends no frames of a canvas-captured fake camera'
export const NO_WEBKIT_WEBSOCKET = 'Playwright WebKit has no MediaRecorder or captureStream (websocket method)'
// a WebRTC stream has to be negotiated through the class's messages first
export const SYNC = 30_000

/** The module's iframe, once Edrys.onReady has run in it. */
export async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 30_000 })
  return frame
}

/** Which fake camera the frame's <video> shows (null: no picture). */
export const showing = async (frame: Frame) => nearestColor(await videoColor(frame).catch(() => null))

export async function expectCamera(frame: Frame, color: CameraColor, timeout = SYNC) {
  // Chromium does not render an off-screen cross-origin iframe, so a fake
  // camera painted in it sends black frames: look at it, as a viewer would.
  // Only when it is fully off-screen: scrolling a visible frame can put its
  // top (and the module's buttons) under edrys-Lite's fixed app bar.
  await (await frame.frameElement()).evaluate((e: Element) => {
    const r = e.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= innerHeight) e.scrollIntoView({ block: 'center' })
  })
  await expect.poll(() => showing(frame), { timeout, message: `video shows the ${color} camera` }).toBe(color)
}

/** Tracks of the stream playing in the frame's <video>. */
export const tracks = (frame: Frame) =>
  frame.evaluate(() => {
    const s = (document.getElementById('video') as HTMLVideoElement).srcObject as MediaStream | null
    return { video: s?.getVideoTracks().length ?? 0, audio: s?.getAudioTracks().length ?? 0 }
  })

export const loader = (frame: Frame) => frame.locator('#loader')
export const loaderText = (frame: Frame) => frame.locator('.loader-text')
export const streamName = (frame: Frame) => frame.locator('#stream-name')
export const reloadButton = (frame: Frame) => frame.getByRole('button', { name: 'Reconnect stream' })
export const badge = (frame: Frame) => frame.locator('#status')
export const cameraSelect = (frame: Frame) => frame.locator('#camera-select')

/** Constraints of the module's last getUserMedia call. */
export const lastCall = async (frame: Frame) => (await media(frame).calls()).at(-1)
