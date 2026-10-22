import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import {
  Session,
  closeSessions,
  createClass,
  enterRoom,
  joinClass,
  openStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODULES_DIR, moduleFrame, moduleUrl, serveModules } from '../../lib/modules'
import { FakeMediaOptions, installFakeMedia, media } from '../../lib/fake-media'
import { FakePeerServer } from '../../lib/fake-peerjs'
import { FakeStreamRelay } from '../../lib/fake-ws-relay'
import { localWebRTCLaunchOptions } from '../../lib/local-webrtc'
import {
  MODULE,
  NO_WEBKIT_VIDEO,
  NO_WEBKIT_WEBSOCKET,
  SYNC,
  badge,
  cameraSelect,
  expectCamera,
  lastCall,
  loader,
  loaderText,
  ready,
  reloadButton,
  showing,
  streamName,
  tracks,
} from './helpers'

/**
 * module-streaming in a real edrys-Lite: a station with fake cameras streams
 * to students in its room. WebRTC media flows for real between the browsers;
 * only the PeerJS signaling server (FakePeerServer) and, for the websocket
 * method, the stream relay (FakeStreamRelay) are faked. The real servers are
 * covered by real-server.spec.ts.
 */

test.use({ launchOptions: localWebRTCLaunchOptions })

let peerjs: FakePeerServer
let relay: FakeStreamRelay

function prepareWith(options: FakeMediaOptions = {}) {
  return async (context: BrowserContext) => {
    await serveModules(context)
    await installFakeMedia(context, options)
    await peerjs.install(context)
    await relay.install(context)
  }
}

/** The stationConfig edrys-Lite's settings form saves untouched, from the module's schema. */
function formDefaults(): Record<string, unknown> {
  const html = readFileSync(join(MODULES_DIR, MODULE, 'index.html'), 'utf8')
  const content = html.match(/name="module-config"\s+content="([^"]*)"/)![1]
  // the schema is a JS-style object literal (single quotes, trailing commas)
  // eslint-disable-next-line no-new-func
  const schema = new Function(`return (${content})`)().stationConfig
  const byType: Record<string, unknown> = { boolean: false, number: 0 }
  return Object.fromEntries(
    Object.entries<any>(schema).map(([key, field]) => [
      key,
      field.default !== undefined
        ? field.default
        : field.type === 'radio-button'
          ? field.options[0]
          : byType[field.type] ?? '',
    ])
  )
}

// ---------------------------------------------------------------------------

test.describe('module-streaming', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(() => {
    peerjs = new FakePeerServer()
    relay = new FakeStreamRelay()
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
    peerjs.close()
  })

  /** Teacher adds the module (one entry per stationConfig), opens the station, a student enters its room. */
  async function setup(
    browser: Browser,
    stationConfigs: object[],
    options: { station?: FakeMediaOptions; student?: boolean } = {}
  ) {
    const created = await createClass(browser, prepareWith(options.station))
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(
      teacher,
      stationConfigs.map((stationConfig) => ({ url: moduleUrl(MODULE), stationConfig }))
    )
    station = await openStation(teacher, classUrl)
    if (options.student !== false) student = await addStudent(browser)
  }

  /** A student who opens the class link and clicks the station room. */
  async function addStudent(browser: Browser) {
    const s = await joinClass(browser, classUrl, prepareWith())
    await enterRoom(s, await stationRoom(station!))
    return s
  }

  const hasModule = (s: Session) => s.page.frames().some((f) => f.url().startsWith(moduleUrl(MODULE)))

  /**
   * Reload the station window the way a user does. Students in its room stay
   * there (edrys-Lite waits for a station that drops out) and keep the module.
   * From inside the page: Playwright's page.reload() in Firefox skips what
   * edrys-Lite does when the station leaves.
   */
  async function reloadStation() {
    const loaded = station!.page.waitForEvent('load')
    await station!.page.evaluate(() => setTimeout(() => location.reload()))
    await loaded
  }

  test('the station streams its camera to a student, both show the stream name', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamName: 'Lab bench' }])
    const st = await ready(station!)
    const stu = await ready(student!)

    // Station: own camera preview, stream name and default quality.
    await expectCamera(st, 'red', 15_000)
    await expect(loader(st)).toBeHidden()
    await expect(badge(st)).toHaveText('live')
    await expect(streamName(st)).toHaveText('Lab bench')
    await expect(st.locator('.stream-quality')).toHaveText('medium')
    expect((await lastCall(st)).video.width).toEqual({ ideal: 1280 })

    // Student: the station's picture, no audio by default, and the same name.
    expect((await lastCall(st)).audio).toBe(false)
    await expectCamera(stu, 'red')
    await expect(loader(stu)).toBeHidden()
    await expect(badge(stu)).toHaveText('live')
    await expect(streamName(stu)).toHaveText('Lab bench')
    expect(await tracks(stu)).toEqual({ video: 1, audio: 0 })

    // One camera: no camera picker for anyone.
    await expect(cameraSelect(st)).toBeHidden()
    await expect(cameraSelect(stu)).toBeHidden()
  })

  test('stationConfig is applied: quality, mirror and rotation, audio off', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamQuality: 'low', mirrorX: true, rotate: 180, audio: false }])
    const st = await ready(station!)
    const stu = await ready(student!)

    await expectCamera(st, 'red', 15_000)
    const call = await lastCall(st)
    expect(call.video.width).toEqual({ ideal: 640 })
    expect(call.audio).toBe(false)
    await expect(st.locator('.stream-quality')).toHaveText('low')

    await expectCamera(stu, 'red')
    expect(await tracks(stu)).toEqual({ video: 1, audio: 0 })
    for (const frame of [st, stu]) {
      const transform = await frame.locator('#video').evaluate((v) => (v as HTMLElement).style.transform)
      expect(transform).toBe('scaleX(-1) scaleY(1) rotate(180deg)')
    }
  })

  test('an audio-only station streams sound to the student', async ({ browser }) => {
    await setup(browser, [{ video: false, audio: true }])
    const st = await ready(station!)
    const stu = await ready(student!)

    await expect.poll(() => lastCall(st), { timeout: 15_000 }).toMatchObject({ video: false, audio: true })
    await expect.poll(() => tracks(stu), { timeout: SYNC }).toEqual({ video: 0, audio: 1 })
    await expect(loader(stu)).toBeHidden()
    // the station never asks for the camera
    expect((await media(st).calls()).filter((c: any) => c.video)).toEqual([])
  })

  test('with two cameras the station switches, the student follows and the old camera is released', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamName: 'Bench' }], { station: { cameras: ['red', 'blue'] } })
    const st = await ready(station!)
    const stu = await ready(student!)

    // Only the station gets the picker.
    await expect(cameraSelect(st)).toBeVisible()
    await expect(cameraSelect(st).locator('option')).toHaveText(['Fake camera 1', 'Fake camera 2'])
    await expect(cameraSelect(stu)).toBeHidden()
    await expectCamera(stu, 'red')

    await cameraSelect(st).selectOption({ label: 'Fake camera 2' })
    await expectCamera(st, 'blue', 15_000)
    await expectCamera(stu, 'blue')
    expect(await media(st).liveTracks('video')).toBe(1)

    // The choice survives a reload of the station.
    await reloadStation()
    const st2 = await ready(station!)
    await expect(cameraSelect(st2)).toHaveValue('fake-camera-2')
    await expectCamera(st2, 'blue', 15_000)
    await expectCamera(await ready(student!), 'blue')
  })

  test('a student who joins later gets the running stream', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamName: 'Bench' }], { student: false })
    const st = await ready(station!)
    await expectCamera(st, 'red', 15_000)

    student = await addStudent(browser)
    const stu = await ready(student)
    await expectCamera(stu, 'red')
    await expect(streamName(stu)).toHaveText('Bench')
  })

  test('after the station reloads, the student stays in its room and gets the stream again', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamName: 'Bench' }])
    await ready(station!)
    await expectCamera(await ready(student!), 'red')

    await reloadStation()
    await ready(station!)
    expect(hasModule(student!)).toBe(true)
    const stu = await ready(student!)
    await expectCamera(stu, 'red')
    await expect(streamName(stu)).toHaveText('Bench')
  })

  test('⟳ reconnects the student, and re-acquires the camera on the station', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    await setup(browser, [{ streamName: 'Bench' }])
    const st = await ready(station!)
    const stu = await ready(student!)
    await expectCamera(stu, 'red')

    // Student: only its own connection is rebuilt.
    const stationCalls = (await media(st).calls()).length
    await reloadButton(stu).click()
    await expect(loaderText(stu)).toHaveText('Reconnecting to stream...')
    await expect(loader(stu)).toBeHidden({ timeout: SYNC })
    await expectCamera(stu, 'red')
    expect((await media(st).calls()).length).toBe(stationCalls)

    // Station: a fresh capture replaces the old one, the student keeps watching.
    await reloadButton(st).click()
    await expect.poll(() => media(st).calls().then((c) => c.length)).toBe(stationCalls + 1)
    await expect.poll(() => media(st).liveTracks('video')).toBe(1)
    await expectCamera(st, 'red')
    await expectCamera(stu, 'red')
  })

  test('errors: a blocked camera is reported on the station, the student is told nothing arrives', async ({
    browser,
  }) => {
    await setup(browser, [{ streamName: 'Bench' }], { station: { blocked: 'NotAllowedError' } })
    const st = await ready(station!)
    const stu = await ready(student!)

    await expect(loaderText(st)).toHaveText('Camera blocked: allow access for this site in the browser settings', {
      timeout: 15_000,
    })
    await expect(st.locator('.loader')).toBeHidden() // no spinner on an error
    await expect(badge(st)).toHaveText('no stream')
    await expect(loaderText(stu)).toHaveText('Connecting to stream... (This may take a moment)')
    await expect(badge(stu)).toHaveText('connecting')
    // after 20 s without a frame the module reconnects once by itself, after another 20 s it gives up
    await expect(loaderText(stu)).toHaveText('Reconnecting to stream...', { timeout: 30_000 })
    await expect(loaderText(stu)).toHaveText('No stream available yet. Press the reconnect button to retry.', { timeout: 30_000 })
  })

  test('errors: video and audio both switched off is reported on the station', async ({ browser }) => {
    await setup(browser, [{ video: false, audio: false }], { student: false })
    const st = await ready(station!)

    await expect(loaderText(st)).toHaveText('Both video and audio are disabled in station config', {
      timeout: 15_000,
    })
  })

  test('the websocket method streams through the relay, camera switches included', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_WEBSOCKET)
    await setup(
      browser,
      [{ streamName: 'Bench', streamMethod: 'websocket', websocketUrl: relay.url, audio: false }],
      { station: { cameras: ['red', 'blue'] } }
    )
    const st = await ready(station!)
    const stu = await ready(student!)

    await expectCamera(stu, 'red')
    await expect(loader(stu)).toBeHidden()
    expect(Object.values(relay.rooms())).toEqual([expect.objectContaining({ source: true, viewers: 1 })])

    await cameraSelect(st).selectOption({ label: 'Fake camera 2' })
    await expectCamera(stu, 'blue')
  })

  // -------------------------------------------------------------------------

  test('a config saved from the settings form with only a stream name still streams video', async ({ browser }) => {
    await setup(browser, [{ ...formDefaults(), streamName: 'Lab bench' }], { student: false })
    const st = await ready(station!)
    await expectCamera(st, 'red', 15_000)
    expect(await lastCall(st)).toMatchObject({ video: { width: { ideal: 1280 } }, audio: false })
    await expect(st.locator('.stream-quality')).toHaveText('medium')
  })

  test('the station does not play its own microphone back', async ({ browser }) => {
    await setup(browser, [{ streamName: 'Bench', audio: true }], { student: false })
    const st = await ready(station!)
    await expectCamera(st, 'red', 15_000)
    expect(await tracks(st)).toEqual({ video: 1, audio: 1 })
    await expect(st.locator('#video')).toHaveJSProperty('muted', true)
  })

  test("a student's message cannot reload the station", async ({ browser }) => {
    await setup(browser, [{ streamName: 'Bench' }])
    const st = await ready(station!)
    const stu = await ready(student!)
    // mark this page load, and note when the student's message arrives
    await st.evaluate(() => {
      const w = window as any
      w.__marker = true
      w.Edrys.onMessage((m: any) => {
        if (m.subject === 'reload') w.__reloadAt = Date.now()
      })
    })

    await stu.evaluate(() => (window as any).Edrys.sendMessage('reload', true))
    // the module reloads 100 ms after the message; still the same page 2 s later = not reloaded
    await expect
      .poll(
        async () => {
          const frame = await moduleFrame(station!, MODULE)
          return frame
            .evaluate(() => {
              const w = window as any
              if (!w.__marker) return 'station reloaded'
              return w.__reloadAt && Date.now() - w.__reloadAt > 2000 ? 'kept' : 'waiting'
            })
            .catch(() => 'waiting')
        },
        { timeout: 15_000 }
      )
      .toBe('kept')
  })

  test('two streams in one station reach the student separately', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    const [A, B] = ['Microscope left', 'Microscope right']
    await setup(browser, [{ streamName: A }, { streamName: B }], { station: { cameras: ['red', 'blue'] } })
    const prefix = moduleUrl(MODULE)
    const frames = async (s: Session) => {
      let found: Frame[] = []
      await expect
        .poll(() => (found = s.page.frames().filter((f) => f.url().startsWith(prefix))).length, { timeout: 30_000 })
        .toBe(2)
      for (const f of found) await f.waitForFunction(() => (window as any).Edrys?.ready === true)
      return found
    }
    const byName = async (list: Frame[], name: string) => {
      for (const f of list) if ((await streamName(f).textContent()) === name) return f
      throw new Error(`no frame shows ${name}`)
    }
    const names = (list: Frame[]) => Promise.all(list.map((f) => streamName(f).textContent())).then((n) => n.sort())

    const stFrames = await frames(station!)
    await expect.poll(() => names(stFrames), { timeout: 15_000 }).toEqual([A, B])
    await cameraSelect(await byName(stFrames, B)).selectOption({ label: 'Fake camera 2' })
    await expectCamera(await byName(stFrames, B), 'blue', 15_000)

    const stuFrames = await frames(student!)
    await expect.poll(() => names(stuFrames), { timeout: SYNC }).toEqual([A, B])
    await expectCamera(await byName(stuFrames, A), 'red')
    await expectCamera(await byName(stuFrames, B), 'blue')
  })

  test('a student whose media connection never comes up is told to retry', async ({ browser }) => {
    peerjs.dropMediaAnswers = true
    await setup(browser, [{ streamName: 'Bench' }])
    await ready(station!)
    const stu = await ready(student!)

    await expect.poll(() => tracks(stu), { timeout: SYNC }).toEqual({ video: 1, audio: 0 })
    expect(await showing(stu)).toBeNull()
    // after 20 s without a frame the module reconnects once by itself, after another 20 s it gives up
    await expect(loaderText(stu)).toHaveText('Reconnecting to stream...', { timeout: 30_000 })
    await expect(loaderText(stu)).toHaveText('No stream available yet. Press the reconnect button to retry.', { timeout: 30_000 })
  })

  test('a lost camera is reported on the station', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)
    // the fake unplug dispatches an untrusted `ended`, which Firefox delivers to track.onended but not to
    // addEventListener listeners; a real lost camera fires a trusted event
    test.skip(browserName === 'firefox', 'Firefox ignores the fake unplug\'s synthetic ended event')

    await setup(browser, [{ streamName: 'Bench' }])
    const st = await ready(station!)
    const stu = await ready(student!)
    await expectCamera(st, 'red', 15_000)
    await expectCamera(stu, 'red')

    await media(st).unplug()
    await expect(loaderText(st)).toHaveText('Camera disconnected, retrying…', { timeout: 10_000 })
    await expect(loader(st)).toBeVisible()
    // the camera works again: the station re-acquires it, the student keeps watching
    await expect(loader(st)).toBeHidden({ timeout: 15_000 })
    await expectCamera(st, 'red')
    expect(await media(st).liveTracks('video')).toBe(1)
    await expectCamera(stu, 'red')
  })

  test('a failed camera switch is shown on the station, and quick switches end on the last camera', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', NO_WEBKIT_VIDEO)

    await setup(browser, [{ streamName: 'Bench' }], { station: { cameras: ['red', 'blue'] } })
    const st = await ready(station!)
    const stu = await ready(student!)
    await expectCamera(st, 'red', 15_000)
    await expectCamera(stu, 'red')

    await media(st).denyNext('NotReadableError')
    await cameraSelect(st).selectOption({ label: 'Fake camera 2' })
    await expect(loaderText(st)).toHaveText('Camera is in use by another program', { timeout: 10_000 })
    await expect(loader(st)).toBeVisible()

    await st.evaluate(() => {
      const select = document.getElementById('camera-select') as HTMLSelectElement
      for (const index of [1, 0, 1]) {
        select.selectedIndex = index
        select.dispatchEvent(new Event('change'))
      }
    })
    await expectCamera(st, 'blue')
    await expect(loader(st)).toBeHidden()
    await expect.poll(() => media(st).liveTracks('video')).toBe(1)
    await expectCamera(stu, 'blue')
  })
})
