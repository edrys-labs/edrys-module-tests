import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { spawnSync } from 'child_process'
import { request as httpRequest } from 'http'
import { join } from 'path'
import { Session, closeSessions, createClass, enterRoom, joinClass, openStation, setModules, stationRoom } from '../../lib/edrys'
import { MODULES_DIR, moduleUrl, serveModules } from '../../lib/modules'
import { PyxtermServer, python, pyxtermServerAvailable, startPyxtermServer } from '../../lib/pyxterm-server'
import { terminalText } from '../../lib/xterm'
import { ENTRY, JOIN, MODULE, SYNC, badge, ready, send, typeInto } from './helpers'

/**
 * module-pyxtermjs against the actual pyxtermjs server from the local
 * checkout (lib/pyxterm-server.ts), with the real Socket.IO client the page
 * loads and a real bash. These cover what the fake cannot: the client and
 * server versions working together, PTYs, and the server's own behaviour.
 * Everything else is tested with the fake in pyxtermjs.spec.ts.
 *
 * Shell output is checked through results the shell computes (`echo
 * $((2+3))-x` prints `5-x`), which never appear in the echoed command line.
 */

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// runs code with execute; with this script the whole line reaches the shell in one input
const SCRIPT = 'echo $CODE | base64 --decode | bash'

const lines = async (frame: Frame) => (await terminalText(frame)).split('\n')

/** Type a command into the station's own terminal (goes straight to the server). */
async function run(frame: Frame, command: string) {
  await typeInto(frame, command)
  await frame.locator('.xterm-helper-textarea').press('Enter')
}

/** Status of a Socket.IO handshake sent with this Origin header. */
function handshakeStatus(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { Origin: origin } }, (res) => {
      res.resume()
      resolve(res.statusCode || 0)
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------

test.describe('module-pyxtermjs with the real server', () => {
  test.skip(!pyxtermServerAvailable(), 'needs Python with module-pyxtermjs/requirements.txt (or PYXTERM_PYTHON)')

  let server: PyxtermServer | undefined
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined

  /** Teacher adds the module pointed at the real server, opens the station, a student enters its room. */
  async function setup(browser: Browser, stationConfig: object = {}) {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    await setModules(teacher, [{ url: moduleUrl(MODULE, ENTRY), stationConfig: { server: server!.url, ...stationConfig } }])
    station = await openStation(teacher, created.classUrl)
    student = await joinClass(browser, created.classUrl, prepare)
    await enterRoom(student, await stationRoom(station))
    const st = await ready(station)
    const stu = await ready(student)
    await expect(badge(st)).toHaveText('connected', { timeout: SYNC })
    await expect(badge(stu)).toHaveText('connected', { timeout: JOIN })
    return { st, stu }
  }

  test.beforeEach(async () => {
    server = await startPyxtermServer()
  })

  test.afterEach(async ({}, testInfo) => {
    await closeSessions(teacher, student)
    teacher = station = student = undefined
    if (server && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('pyxtermjs server log', { body: server.log(), contentType: 'text/plain' })
    }
    await server?.stop()
    server = undefined
  })

  test('the station types into its shell over a slow network, and students see the output', async ({ browser }) => {
    const { st, stu } = await setup(browser)

    // A slow network: each polling request takes 500 ms, so the keystrokes typed
    // meanwhile queue up and leave in one batch. WebSocket frames are not affected.
    await teacher!.context.route(`http://127.0.0.1:${server!.port}/socket.io/**`, async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 500))
      await route.continue()
    })

    await run(st, 'echo $((2+3))-hello')
    await expect.poll(() => lines(st), { timeout: SYNC }).toContain('5-hello')
    await expect.poll(() => lines(stu), { timeout: SYNC }).toContain('5-hello')
  })

  test('an allowed student types a command and runs a multi-file project; a file name cannot run a command', async ({ browser }) => {
    const { stu } = await setup(browser, {
      enable: { student: true },
      script: 'echo $CODE | base64 --decode > $FILE\npython3 $FILE',
      filename: 'main.py',
    })

    await run(stu, 'echo $((3+4))-student')
    await expect.poll(() => lines(stu), { timeout: SYNC }).toContain('7-student')

    // module-editor's JSON text; the script has no $FILES, so util.py is written before it runs
    const project = {
      'main.py': 'import util\nprint(f"{util.x}-from-util")',
      'util.py': 'x = 6 * 7',
      'a.txt; echo INJECTED-$((6*7))': 'x',
    }
    await send(stu, 'execute', JSON.stringify({ file: project }))
    await expect.poll(() => lines(stu), { timeout: SYNC }).toContain('42-from-util')
    expect((await terminalText(stu))).not.toContain('INJECTED-42')
  })

  test('the server accepts the module origin, refuses Socket.IO connections from other websites, and does not serve its source', async () => {
    expect(await handshakeStatus(server!.handshake, 'http://e2e-module.test')).toBe(200)
    expect(await handshakeStatus(server!.handshake, 'https://evil.example')).not.toBe(200)
    expect((await fetch(`http://127.0.0.1:${server!.port}/app.py`)).status).toBe(404)
  })

  test('the shell starts in the home directory', async ({ browser }) => {
    const { st, stu } = await setup(browser, { enable: { student: true }, script: SCRIPT })

    await send(stu, 'execute', 'echo "cwd=$PWD" && echo "home=$HOME"')
    await expect.poll(async () => (await lines(st)).some((l) => l.startsWith('home=/')), { timeout: SYNC }).toBe(true)
    const all = await lines(st)
    const cwd = all.find((l) => l.startsWith('cwd=/'))!.slice('cwd='.length)
    const home = all.find((l) => l.startsWith('home=/'))!.slice('home='.length)
    expect(cwd).toBe(home)
  })

  test('the arduino image’s serial plotter draws lab task-2’s whole scan as a radar, for the station and the students', async ({ browser }) => {
    // docker/arduino/serial-plotter.py, run as task-2 runs it after the upload; serial-board.py plays the
    // board. The old plotter had no --type, and redrew only every 50 lines, so the sweep's end was never shown.
    const py = python()
    test.skip(spawnSync(py, ['-c', 'import plotext, serial']).status !== 0, 'needs plotext and pyserial')
    const plotter = join(MODULES_DIR, 'module-pyxtermjs', 'docker', 'arduino', 'serial-plotter.py')
    const board = join(__dirname, 'serial-board.py')
    const { st, stu } = await setup(browser, { enable: { student: true }, script: SCRIPT })

    // the plotter starts before the board's port exists, as after an upload, and waits for it
    await send(stu, 'execute', [
      'port=$(mktemp -u /tmp/board.XXXXXX)',
      `"${py}" "${board}" "$port" &`,
      `"${py}" "${plotter}" -p "$port" --type radar`,
    ].join('\n'))

    // the title carries the last reading: the sweep's final line, sent after the board went quiet
    const drawn = (text: string) => text.includes('last: 0° → 120') && text.includes('90°')
    await expect.poll(async () => drawn(await terminalText(st)), { timeout: SYNC }).toBe(true)
    await expect.poll(async () => drawn(await terminalText(stu)), { timeout: SYNC }).toBe(true)
    expect(await terminalText(st)).not.toContain('Traceback')
  })
})
