import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import {
  Session,
  closeSessions,
  createClass,
  enterRoom,
  joinClass,
  openStation,
  reloadStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, revealModuleTop, serveModules } from '../../lib/modules'
import { FakeWebRepl } from '../../lib/fake-webrepl'
import { terminalText } from '../../lib/xterm'

/**
 * module-micropython-webrepl in a real edrys-Lite: a station connected to a
 * fake MicroPython board over WebREPL, and students in the station's room
 * who drive it. The module is shown in station rooms only.
 */

const MODULE = 'module-micropython-webrepl'
// time for a change to travel between peers
const SYNC = 15_000

// one board per test; prepare() installs it in every browser of the test
let board: FakeWebRepl

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  await board.install(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once onReady has rendered the board status. */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect(badge(frame)).not.toHaveText('loading…', { timeout: 30_000 })
  return frame
}

const badge = (frame: Frame) => frame.locator('#badge')
const button = (frame: Frame) => frame.locator('#connect-btn')
const fileStatus = (frame: Frame) => frame.locator('#file-status')

/** Terminal content (xterm.js, exposed by the module as `window.term`). */
const text = terminalText

/** Click Connect / Cancel / Disconnect. It is in the frame's top row, which can sit under the app bar. */
async function clickConnect(frame: Frame) {
  await revealModuleTop(frame)
  await button(frame).click()
}

/**
 * Type into the terminal, as a user does. Into xterm's input textarea, as in module-serial's tests: in Firefox,
 * a click on the terminal of a cross-origin frame does not move the page's keyboard focus into it.
 */
async function typeInto(frame: Frame, keys: string, enter = true) {
  const input = frame.locator('.xterm-helper-textarea')
  await input.focus()
  await input.pressSequentially(keys)
  if (enter) await input.press('Enter')
}

/** Send a message as another module would (the module listens promiscuously). */
async function send(frame: Frame, subject: string, body: any) {
  await frame.evaluate(([s, b]) => (window as any).Edrys.sendMessage(s, b), [subject, body] as const)
}

async function addStudent(browser: Browser, classUrl: string, station: Session) {
  const student = await joinClass(browser, classUrl, prepare)
  await enterRoom(student, await stationRoom(station))
  return student
}

// ---------------------------------------------------------------------------

test.describe('module-micropython-webrepl', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  async function startClass(browser: Browser, stationConfig: object) {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
    await setModules(teacher, [{ url: moduleUrl(MODULE), stationConfig }])
    station = await openStation(teacher, classUrl)
    student = await addStudent(browser, classUrl, station)
  }

  /** The station (or `controller`, e.g. a teacher) clicks Connect; `typist` logs in to the board. */
  async function connectAndLogin(typist: Frame, controller?: Frame) {
    await clickConnect(controller ?? (await ready(station!)))
    await expect.poll(() => board.open, { timeout: SYNC }).toBe(1)
    await expect.poll(() => text(typist), { timeout: SYNC }).toContain('Password:')
    await typeInto(typist, board.password)
    await expect.poll(() => text(typist), { timeout: SYNC }).toContain('WebREPL connected')
  }

  test.beforeEach(async () => {
    board = new FakeWebRepl()
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test.describe('with a board address configured', () => {
    test.beforeEach(async ({ browser }) => {
      await startClass(browser, { websocket: board.url })
    })

    test('before connecting, the station shows the board address and nobody is connected', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)

      await expect(st.locator('#url')).toHaveValue(board.url)
      await expect(st.locator('#url')).toBeVisible()
      // students get the status and the terminal: no button, address or file boxes
      await expect(button(stu)).toBeHidden()
      await expect(stu.locator('#url')).toBeHidden()
      await expect(stu.locator('#files')).toBeHidden()
      await expect(st.locator('#files')).toBeVisible()
      // self charging is off unless configured
      await expect(st.locator('#self-charge-box')).toBeHidden()
      await expect(badge(st)).toHaveText('not connected')
      await expect(badge(stu)).toHaveText('not connected')
      await expect(button(st)).toHaveText('Connect')
      await expect(fileStatus(st)).toHaveText('no file transfer yet')
      // an address is configured: no hint
      await expect(st.locator('#hint')).toBeHidden()
      expect(board.connections).toBe(0)
    })

    test('the station connects to the board, and a student uses the REPL', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)

      await connectAndLogin(stu)
      await expect(badge(st)).toHaveText('connected', { timeout: SYNC })
      await expect(badge(stu)).toHaveText('connected')
      await expect(button(st)).toHaveText('Disconnect')
      // the station sees the same session
      await expect.poll(() => text(st), { timeout: SYNC }).toContain('WebREPL connected')

      await typeInto(stu, 'print(6*7)')
      await expect.poll(() => board.lines, { timeout: SYNC }).toContain('print(6*7)')
      board.print('the answer is 42\r\n')
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('the answer is 42')

      // the station disconnects again
      await clickConnect(st)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(0)
      await expect(button(st)).toHaveText('Connect', { timeout: SYNC })
      await expect(badge(stu)).toHaveText('not connected', { timeout: SYNC })
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('Disconnected')
    })

    test('a changed websocket config reaches the room', async () => {
      const st = await ready(station!)
      await expect(st.locator('#url')).toHaveValue(board.url)

      const other = board.url + 'other'
      await setModules(teacher!, [{ url: moduleUrl(MODULE), stationConfig: { websocket: other } }])
      // edrys-Lite reloads the module with the new config; the old frame may detach mid-poll
      const url = async () =>
        (await moduleFrame(station!, MODULE)).locator('#url').inputValue({ timeout: 1_000 }).catch(() => null)
      await expect.poll(url, { timeout: SYNC }).toBe(other)
    })

    test('when the board drops the connection, the station reconnects by itself', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)
      await expect(button(st)).toHaveText('Disconnect', { timeout: SYNC })

      board.disconnect()
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('Disconnected')
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(1)
      expect(board.connections).toBe(2)
      await expect(badge(stu)).toHaveText('connected', { timeout: SYNC })
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('Password:')
    })

    test('while the board is off, the station retries until someone stops it', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)

      board.down = true
      board.disconnect()
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain(`[cannot reach ${board.url}, retrying…]`)
      await expect.poll(() => board.connections, { timeout: SYNC }).toBeGreaterThan(2)

      // the button stops the retries, whatever it shows at that moment
      await clickConnect(st)
      await expect(button(st)).toHaveText('Connect', { timeout: SYNC })
      await expect(st.locator('#url')).toBeEnabled()
      await expect(badge(stu)).toHaveText('not connected', { timeout: SYNC })

      board.down = false
      await clickConnect(st)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(1)
      await expect(badge(stu)).toHaveText('connected', { timeout: SYNC })
    })

    test('a student cannot disconnect, change the address or move files, not even from the console', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)
      const studentState = (key: string) => stu.evaluate((k) => (window as any).Edrys.getState(k, 'Value'), key)

      // what the hidden controls would send
      await send(stu, 'connect_request', false)
      await send(stu, 'set_url', 'ws://attacker.test/')
      await send(stu, 'put_file', { filename: 'main.py', data: new Uint8Array([1, 2, 3]) })
      await send(stu, 'run_self_charge', '')
      // messages from one peer arrive in order: once this ran, the station has handled the ones above
      await send(stu, 'execute', 'print("still connected")\n')
      await expect
        .poll(() => board.executed, { timeout: SYNC })
        .toEqual([{ file: 'temp_code.py', code: 'print("still connected")\n' }])
      expect(board.open).toBe(1)
      expect(board.connections).toBe(1)
      expect(board.files.has('main.py')).toBe(false)
      expect(board.lines).not.toContain("exec(open('self_charge.py').read())")
      await expect(st.locator('#url')).toHaveValue(board.url)

      // writing the shared state directly: the station puts it back
      await stu.evaluate(() => {
        const Edrys = (window as any).Edrys
        Edrys.updateState(() => {
          Edrys.getState('wanted', 'Value', false)
          Edrys.getState('url', 'Value', 'ws://attacker.test/')
        })
      })
      await expect.poll(() => studentState('wanted'), { timeout: SYNC }).toBe(true)
      await expect.poll(() => studentState('url'), { timeout: SYNC }).toBe(board.url)
      expect(board.open).toBe(1)
      expect(board.connections).toBe(1)
      await expect(badge(stu)).toHaveText('connected')
    })

    test('a teacher in the room connects and disconnects the station', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await enterRoom(teacher!, await stationRoom(station!))
      const tea = await ready(teacher!)

      await connectAndLogin(stu, tea)
      await expect(badge(st)).toHaveText('connected', { timeout: SYNC })
      await expect(button(tea)).toHaveText('Disconnect', { timeout: SYNC })
      await clickConnect(tea)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(0)
      await expect(badge(stu)).toHaveText('not connected', { timeout: SYNC })
    })

    test('a teacher can change the board address after disconnecting', async () => {
      const st = await ready(station!)
      await enterRoom(teacher!, await stationRoom(station!))
      const tea = await ready(teacher!)

      await clickConnect(tea)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(1)
      await expect(tea.locator('#url')).toBeDisabled({ timeout: SYNC })

      await clickConnect(tea)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(0)
      await expect(tea.locator('#url')).toBeEnabled({ timeout: SYNC })
      const other = board.url + 'other'
      await tea.locator('#url').fill(other)
      await expect(st.locator('#url')).toHaveValue(other, { timeout: SYNC })
    })

    test('a student who joins later can type into the running session', async ({ browser }) => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      const late = await addStudent(browser, classUrl, station!)
      try {
        const frame = await ready(late)
        await expect(badge(frame)).toHaveText('connected', { timeout: SYNC })
        await typeInto(frame, 'x = 1')
        await expect.poll(() => board.lines, { timeout: SYNC }).toContain('x = 1')
      } finally {
        await closeSessions(late)
      }
    })

    test('a student who joins later sees the earlier terminal output', async ({ browser }) => {
      const stu = await ready(student!)
      await connectAndLogin(stu)
      board.print('output from before\r\n')
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('output from before')

      const late = await addStudent(browser, classUrl, station!)
      try {
        const frame = await ready(late)
        await expect.poll(() => text(frame), { timeout: SYNC }).toContain('output from before')
      } finally {
        await closeSessions(late)
      }
    })

    test('every student in the room can type, not only the one who logged in', async ({ browser }) => {
      const other = await addStudent(browser, classUrl, station!)
      try {
        const bystander = await ready(student!)
        const typist = await ready(other)
        await connectAndLogin(typist)
        await expect(badge(bystander)).toHaveText('connected', { timeout: SYNC })

        await typeInto(bystander, 'y = 2')
        await expect.poll(() => board.lines, { timeout: SYNC }).toContain('y = 2')
      } finally {
        await closeSessions(other)
      }
    })

    test('code sent with the execute subject is uploaded and run on the board', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      const code = 'print("from the editor")\nfor i in range(3):\n    print(i)\n'
      await send(stu, 'execute', code)
      await expect.poll(() => board.executed, { timeout: SYNC }).toEqual([{ file: 'temp_code.py', code }])
      // a program still running is interrupted before the new one starts
      expect(board.interrupts).toBe(1)
    })

    test('code still runs in full when the upload takes longer than two seconds', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      board.putAckDelay = 3_000
      const code = 'print("large program")\n'
      await send(stu, 'execute', code)
      await expect.poll(() => board.executed, { timeout: SYNC }).toEqual([{ file: 'temp_code.py', code }])
    })

    test('runs sent in quick succession each run their own code, in order', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      board.putAckDelay = 1_000
      await send(stu, 'execute', 'print("first")\n')
      await send(stu, 'execute', 'print("second")\n')
      await expect
        .poll(() => board.executed, { timeout: SYNC })
        .toEqual([
          { file: 'temp_code.py', code: 'print("first")\n' },
          { file: 'temp_code.py', code: 'print("second")\n' },
        ])
    })

    test('code sent while the station is not connected is reported, not lost silently', async () => {
      const stu = await ready(student!)
      await send(stu, 'execute', 'print("nobody hears this")\n')
      await expect.poll(() => text(stu), { timeout: SYNC }).toContain('[code not run: not connected]')
      expect(board.connections).toBe(0)
    })

    test('a file the station picks is sent to the board, and everyone sees the status', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)

      // students have no file boxes; the station's user sends a file
      await st.locator('#put-file-select').setInputFiles({
        name: 'main.py',
        mimeType: 'text/x-python',
        buffer: Buffer.from('print("boot")\n'),
      })
      await st.getByRole('button', { name: 'Send to device' }).click()
      await expect.poll(() => board.files.get('main.py')?.toString(), { timeout: SYNC }).toBe('print("boot")\n')
      await expect(fileStatus(st)).toHaveText('Sent main.py, 14 bytes', { timeout: SYNC })
      await expect(fileStatus(stu)).toHaveText('Sent main.py, 14 bytes', { timeout: SYNC })
    })

    test('a teacher in the room sends a file to the board through the station', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)

      await enterRoom(teacher!, await stationRoom(station!))
      const tea = await ready(teacher!)
      await tea.locator('#put-file-select').setInputFiles({
        name: 'lib.py',
        mimeType: 'text/x-python',
        buffer: Buffer.from('X = 1\n'),
      })
      await tea.getByRole('button', { name: 'Send to device' }).click()
      await expect.poll(() => board.files.get('lib.py')?.toString(), { timeout: SYNC }).toBe('X = 1\n')
      await expect(fileStatus(tea)).toHaveText('Sent lib.py, 6 bytes', { timeout: SYNC })
      await expect(fileStatus(st)).toHaveText('Sent lib.py, 6 bytes')
    })

    test('a file a teacher gets from the board is downloaded by the teacher', async () => {
      board.files.set('data.csv', Buffer.from('t,v\n1,2\n'))
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)
      let stationDownloads = 0
      station!.page.on('download', () => stationDownloads++)

      // a teacher in the station room has the Get box (students do not)
      await enterRoom(teacher!, await stationRoom(station!))
      const tea = await ready(teacher!)
      const download = teacher!.page.waitForEvent('download', { timeout: SYNC })
      await tea.locator('#get_filename').fill('data.csv')
      await tea.getByRole('button', { name: 'Get from device' }).click()
      // the transfer itself works: the station reports it to everyone
      await expect(fileStatus(st)).toHaveText('Got data.csv, 8 bytes', { timeout: SYNC })
      await expect(fileStatus(tea)).toHaveText('Got data.csv, 8 bytes', { timeout: SYNC })
      const file = await download
      expect(file.suggestedFilename()).toBe('data.csv')
      expect(readFileSync(await file.path(), 'utf8')).toBe('t,v\n1,2\n')
      // the station's machine does not get a copy
      expect(stationDownloads).toBe(0)
    })

    test('a file name sent by a peer is shown as text, not run as HTML', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)
      // students may not ask for files; a teacher's file name reaches every peer's status line
      await enterRoom(teacher!, await stationRoom(station!))
      const tea = await ready(teacher!)

      const name = '<img src=x onerror="document.body.dataset.injected=1">'
      await send(tea, 'get_file', { id: 'xss', filename: name })
      // the board has no such file
      await expect(fileStatus(st)).toContainText('Failed getting', { timeout: SYNC })
      await expect(fileStatus(stu)).toContainText('<img', { timeout: SYNC })
      expect(await st.evaluate(() => document.body.dataset.injected ?? null)).toBeNull()
      expect(await stu.evaluate(() => document.body.dataset.injected ?? null)).toBeNull()
      await expect(fileStatus(st)).toContainText('<img')
    })

    test('a station that reloads during a session connects to the board again', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      await reloadStation(station!)
      const st = await ready(station!)
      await expect.poll(() => board.connections, { timeout: SYNC }).toBe(2)
      await expect(button(st)).toHaveText('Disconnect', { timeout: SYNC })
    })
  })

  test.describe('without a board address', () => {
    test.beforeEach(async ({ browser }) => {
      await startClass(browser, {})
    })

    test('each role is told how to get one, and the hint goes once an address is typed', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)

      await expect(st.locator('#hint')).toContainText("set 'websocket' in the module's station settings")
      await expect(stu.locator('#hint')).toContainText('Ask your teacher')
      await expect(st.locator('#url')).toHaveValue('')

      await st.locator('#url').fill(board.url)
      await expect(st.locator('#hint')).toBeHidden()
      await expect(stu.locator('#hint')).toBeHidden({ timeout: SYNC })
      await clickConnect(st)
      await expect.poll(() => board.open, { timeout: SYNC }).toBe(1)
    })
  })

  test.describe('with a custom execute subject', () => {
    test.beforeEach(async ({ browser }) => {
      await startClass(browser, { websocket: board.url, execute: 'run-micropython' })
    })

    test('the station runs code sent with the configured subject only', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)

      await send(stu, 'execute', 'print("ignored")\n')
      await send(stu, 'run-micropython', 'print("custom")\n')
      await expect
        .poll(() => board.executed, { timeout: SYNC })
        .toEqual([{ file: 'temp_code.py', code: 'print("custom")\n' }])
    })
  })

  test.describe('next to another module', () => {
    // shown in every room, and loaded by URL (not inlined), so moduleFrame finds it by name
    const OTHER = 'module-reference'

    test.beforeEach(async ({ browser }) => {
      const created = await createClass(browser, prepare)
      teacher = created.teacher
      classUrl = created.classUrl
      await setModules(teacher, [
        { url: moduleUrl(MODULE), stationConfig: { websocket: board.url } },
        { url: moduleUrl(OTHER) },
      ])
      station = await openStation(teacher, classUrl)
      student = await addStudent(browser, classUrl, station)
    })

    test('other modules can send code to execute, but cannot type into the board', async () => {
      const stu = await ready(student!)
      await connectAndLogin(stu)
      const other = await moduleFrame(student!, OTHER)
      await other.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 30_000 })

      // messages from one peer arrive in order: once the execute ran, the keystrokes would have too
      await send(other, 'data', 'typed_by_another_module = 1\r')
      await send(other, 'execute', 'print("from the editor")\n')
      await expect
        .poll(() => board.executed, { timeout: SYNC })
        .toEqual([{ file: 'temp_code.py', code: 'print("from the editor")\n' }])
      expect(board.lines).not.toContain('typed_by_another_module = 1')
    })
  })

  test.describe('with self charging', () => {
    test.beforeEach(async ({ browser }) => {
      await startClass(browser, { websocket: board.url, self_charge_alvik: true })
    })

    test('the self charge script runs on the button and when the last student leaves', async () => {
      const st = await ready(station!)
      const stu = await ready(student!)
      await connectAndLogin(stu)
      const selfCharge = "exec(open('self_charge.py').read())"

      // students have the Self Charge box hidden; the station has it
      await st.getByRole('button', { name: 'Run Self Charge' }).click()
      await expect.poll(() => board.lines.filter((l) => l === selfCharge).length, { timeout: SYNC }).toBe(1)

      // the student goes back to the lobby (enterRoom expects the side menu open)
      await student!.page.locator('.v-app-bar-nav-icon').click()
      await expect(student!.page.locator('.v-navigation-drawer--temporary').first()).toBeInViewport()
      await enterRoom(student!, 'Lobby')
      // the station checks for an empty room every 5 s
      await expect.poll(() => board.lines.filter((l) => l === selfCharge).length, { timeout: SYNC }).toBe(2)
    })
  })
})
