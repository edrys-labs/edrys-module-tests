import { BrowserContext, Frame } from '@playwright/test'
import { MODULE_ORIGIN } from './modules'

/**
 * Fake cameras and a microphone for module iframes: `getUserMedia` and
 * `enumerateDevices` are replaced, so no device or permission prompt is
 * needed and it works the same in every browser.
 *
 * Each camera paints a solid colour (plus a moving bar, so frames keep
 * changing) into a canvas and streams it with `captureStream()`. A viewer can
 * tell which camera it gets by sampling the colour of its <video>
 * (`videoColor()`). The microphone is a WebAudio oscillator.
 *
 *   await installFakeMedia(context, { cameras: ['red', 'blue'] })
 *   await media(frame).calls()         // constraints of every getUserMedia call
 *   await media(frame).liveTracks()    // tracks handed out and not stopped yet
 *   await media(frame).denyNext('NotAllowedError') // the user blocks the camera
 *
 * Constraints honoured: `video: false`, `audio: false`, and
 * `video.deviceId.exact` (picks the camera, unknown id = OverconstrainedError).
 */

export const COLORS = {
  red: [220, 30, 30],
  green: [30, 180, 60],
  blue: [30, 60, 220],
} as const
export type CameraColor = keyof typeof COLORS

export interface FakeMediaOptions {
  /** One camera per entry, labelled "Fake camera <n>" and showing that colour. Default: one red camera. */
  cameras?: CameraColor[]
  /** Every getUserMedia call fails with this DOMException name (e.g. NotAllowedError: the user blocked it). */
  blocked?: string
}

/** Context hook: install the fake in every module iframe of this context. */
export async function installFakeMedia(context: BrowserContext, options: FakeMediaOptions = {}) {
  const cameras = (options.cameras || ['red']).map((c) => [...COLORS[c]])
  await context.addInitScript(fakeMedia, { moduleOrigin: MODULE_ORIGIN, cameras, blocked: options.blocked || null })
}

// Runs in the page; must be self-contained.
function fakeMedia({
  moduleOrigin,
  cameras,
  blocked,
}: {
  moduleOrigin: string
  cameras: number[][]
  blocked: string | null
}) {
  if (location.origin !== moduleOrigin) return
  // Modules are served from http://e2e-module.test, which is not a secure
  // context, so the browser leaves out navigator.mediaDevices. Published
  // modules run on https, where it exists.
  if (!navigator.mediaDevices) {
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      value: new EventTarget(),
      configurable: true,
    })
  }

  const devices = cameras.map((rgb, i) => ({
    deviceId: `fake-camera-${i + 1}`,
    groupId: 'fake-media',
    kind: 'videoinput',
    label: `Fake camera ${i + 1}`,
    rgb,
  }))

  const control = {
    calls: [] as any[],
    tracks: [] as MediaStreamTrack[],
    deny: null as string | null,
  }
  ;(window as any).__fakeMedia = control

  function cameraTrack(rgb: number[]): MediaStreamTrack {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const ctx = canvas.getContext('2d')!
    let x = 0
    const draw = () => {
      ctx.fillStyle = `rgb(${rgb.join(',')})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // a thin moving bar at the bottom: frames keep changing, the centre stays one colour
      ctx.fillStyle = '#fff'
      ctx.fillRect(x, canvas.height - 10, 20, 10)
      x = (x + 8) % canvas.width
    }
    draw()
    // timers keep running in background tabs where requestAnimationFrame stops
    const timer = setInterval(draw, 66)
    const track = canvas.captureStream(15).getVideoTracks()[0]
    const stop = track.stop.bind(track)
    track.stop = () => {
      clearInterval(timer)
      stop()
    }
    return track
  }

  function micTrack(): MediaStreamTrack {
    const audio = new AudioContext()
    const osc = audio.createOscillator()
    const dest = audio.createMediaStreamDestination()
    osc.connect(dest)
    osc.start()
    return dest.stream.getAudioTracks()[0]
  }

  navigator.mediaDevices.enumerateDevices = async () =>
    devices.map(({ rgb, ...d }) => ({ ...d, toJSON: () => d }) as unknown as MediaDeviceInfo)

  navigator.mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints = {}) => {
    control.calls.push(JSON.parse(JSON.stringify(constraints)))
    if (control.deny || blocked) {
      const name = (control.deny || blocked)!
      control.deny = null
      throw new DOMException(`fake ${name}`, name)
    }
    if (!constraints.video && !constraints.audio) {
      throw new TypeError('At least one of audio and video must be requested')
    }
    const tracks: MediaStreamTrack[] = []
    if (constraints.video) {
      const wanted = typeof constraints.video === 'object' ? (constraints.video.deviceId as any)?.exact : undefined
      const device = wanted ? devices.find((d) => d.deviceId === wanted) : devices[0]
      if (!device) throw new DOMException('fake: no such camera', wanted ? 'OverconstrainedError' : 'NotFoundError')
      tracks.push(cameraTrack(device.rgb))
    }
    if (constraints.audio) tracks.push(micTrack())
    control.tracks.push(...tracks)
    return new MediaStream(tracks)
  }
}

/** Drive the fake media devices of one module frame. */
export function media(frame: Frame) {
  return {
    /** The constraints of every getUserMedia call so far. */
    calls: (): Promise<any[]> => frame.evaluate(() => (window as any).__fakeMedia.calls),
    /** How many tracks handed out by getUserMedia are still live (not stopped). */
    liveTracks: (kind?: 'video' | 'audio'): Promise<number> =>
      frame.evaluate(
        (kind) =>
          (window as any).__fakeMedia.tracks.filter(
            (t: MediaStreamTrack) => t.readyState === 'live' && (!kind || t.kind === kind)
          ).length,
        kind
      ),
    /** The next getUserMedia call fails with this DOMException name (e.g. NotAllowedError). */
    denyNext: (name = 'NotAllowedError'): Promise<void> =>
      frame.evaluate((name) => {
        ;(window as any).__fakeMedia.deny = name
      }, name),
    /** The camera is lost (unplugged, taken by another app): live video tracks end and fire `ended`. */
    unplug: (): Promise<void> =>
      frame.evaluate(() => {
        for (const t of (window as any).__fakeMedia.tracks as MediaStreamTrack[]) {
          if (t.kind !== 'video' || t.readyState !== 'live') continue
          t.stop()
          // stop() itself never fires `ended`; a lost device does
          t.dispatchEvent(new Event('ended'))
        }
      }),
  }
}

/**
 * The colour in the centre of a <video> (default `#video`) as [r, g, b], or
 * null while it has no frame. Works on the viewer's side too: the stream that
 * arrives over WebRTC is not cross-origin tainted.
 */
export function videoColor(frame: Frame, selector = '#video'): Promise<number[] | null> {
  return frame.evaluate((selector) => {
    const video = document.querySelector(selector) as HTMLVideoElement | null
    if (!video || !video.videoWidth || video.readyState < 2) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)
    const d = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
    return [d[0], d[1], d[2]]
  }, selector)
}

/** Name of the fake camera colour nearest to `rgb` (video codecs shift colours a little). */
export function nearestColor(rgb: number[] | null): CameraColor | null {
  if (!rgb) return null
  let best: CameraColor | null = null
  let bestDist = Infinity
  for (const [name, c] of Object.entries(COLORS) as [CameraColor, readonly number[]][]) {
    const dist = c.reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0)
    if (dist < bestDist) {
      bestDist = dist
      best = name
    }
  }
  // far from every camera colour: black/grey frame, not a camera picture
  return bestDist < 3 * 70 ** 2 ? best : null
}
