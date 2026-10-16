import { Browser, BrowserContext, expect, test } from '@playwright/test'
import { Session, closeSessions, createClass, enterRoom, joinClass, openStation, setModules, stationRoom } from '../../lib/edrys'
import { moduleUrl, serveModules } from '../../lib/modules'
import { CameraColor, installFakeMedia } from '../../lib/fake-media'
import { installLocalWebRTC, localWebRTCLaunchOptions } from '../../lib/local-webrtc'
import { PeerJSServer, StreamRelay, startPeerServer, startStreamRelay, streamRelayAvailable } from '../../lib/stream-servers'
import { MODULE, NO_WEBKIT_VIDEO, NO_WEBKIT_WEBSOCKET, cameraSelect, expectCamera, loader, ready, streamName } from './helpers'

/**
 * module-streaming against the real servers (lib/stream-servers.ts): a local
 * PeerJS server (the `peer` package, via `peerServerConfig`) and the
 * websocket-server checkout's `/stream` relay. These catch what the fakes in
 * streaming.spec.ts cannot: a protocol change in either server. Only the main
 * paths are here; failures and edge cases stay with the fakes.
 */

test.use({ launchOptions: localWebRTCLaunchOptions })

const cameras: CameraColor[] = ['red', 'blue']

function prepareWith(withCameras: boolean) {
  return async (context: BrowserContext) => {
    await serveModules(context)
    await installFakeMedia(context, withCameras ? { cameras } : {})
    await installLocalWebRTC(context)
  }
}

let teacher: Session | undefined
let station: Session | undefined
let student: Session | undefined
let classUrl = ''

/** Teacher adds the module, opens the station; a student enters its room unless `student: false`. */
async function setup(browser: Browser, stationConfig: object, options: { student?: boolean } = {}) {
  const created = await createClass(browser, prepareWith(true))
  teacher = created.teacher
  classUrl = created.classUrl
  await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig }])
  station = await openStation(teacher, classUrl)
  if (options.student !== false) student = await addStudent(browser)
}

async function addStudent(browser: Browser) {
  const s = await joinClass(browser, classUrl, prepareWith(false))
  await enterRoom(s, await stationRoom(station!))
  return s
}

async function teardown() {
  // the station window shares the teacher's browser
  await closeSessions(teacher, student)
  teacher = station = student = undefined
}

// ---------------------------------------------------------------------------

test.describe('module-streaming with a real PeerJS server', () => {
  test.skip(({ browserName }) => browserName === 'webkit', NO_WEBKIT_VIDEO)
  let peer: PeerJSServer | undefined

  test.beforeEach(async () => {
    peer = await startPeerServer()
  })

  test.afterEach(async () => {
    await teardown()
    await peer?.stop()
    peer = undefined
  })

  test('the stream goes through the configured server, camera switches included', async ({ browser }) => {
    await setup(browser, { streamName: 'Bench', peerServerConfig: peer!.config })
    const st = await ready(station!)
    const stu = await ready(student!)

    // the station's stream peer registered here, not at the PeerJS cloud
    await expect.poll(() => peer!.ids().some((id) => id.startsWith('stream_')), { timeout: 15_000 }).toBe(true)

    await expectCamera(stu, 'red')
    await expect(loader(stu)).toBeHidden()
    await expect(streamName(stu)).toHaveText('Bench')

    await cameraSelect(st).selectOption({ label: 'Fake camera 2' })
    await expectCamera(stu, 'blue')
  })

  test('a student who joins later gets the running stream', async ({ browser }) => {
    await setup(browser, { streamName: 'Bench', peerServerConfig: peer!.config }, { student: false })
    await expectCamera(await ready(station!), 'red', 15_000)

    student = await addStudent(browser)
    await expectCamera(await ready(student), 'red')
  })
})

test.describe('module-streaming with the real stream relay', () => {
  test.skip(!streamRelayAvailable(), 'needs the websocket-server checkout with npm install (or STREAM_RELAY_DIR)')
  test.skip(({ browserName }) => browserName === 'webkit', NO_WEBKIT_WEBSOCKET)

  let relay: StreamRelay | undefined

  test.beforeEach(async () => {
    relay = await startStreamRelay()
  })

  test.afterEach(async ({}, testInfo) => {
    await teardown()
    if (relay && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('relay.log', { body: relay.log(), contentType: 'text/plain' })
    }
    await relay?.stop()
    relay = undefined
  })

  const config = () => ({ streamName: 'Bench', streamMethod: 'websocket', websocketUrl: relay!.url, audio: false })

  test('the stream goes through the relay, camera switches included', async ({ browser }) => {
    await setup(browser, config())
    const st = await ready(station!)
    const stu = await ready(student!)

    await expectCamera(stu, 'red')
    await expect(loader(stu)).toBeHidden()

    await cameraSelect(st).selectOption({ label: 'Fake camera 2' })
    await expectCamera(stu, 'blue')
  })

  test('a student who joins later gets the running stream', async ({ browser }) => {
    await setup(browser, config(), { student: false })
    await expectCamera(await ready(station!), 'red', 15_000)

    student = await addStudent(browser)
    await expectCamera(await ready(student), 'red')
  })
})
