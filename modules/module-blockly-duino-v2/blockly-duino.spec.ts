import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODULES_DIR, moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-blockly-duino-v2 in a real edrys-Lite: a teacher and a student in
 * the lobby (the module is shown everywhere). Peers share one Blockly
 * workspace through `xml` messages; the run button sends the generated
 * Arduino code with the `execute` subject (or config.runCommand).
 */

const MODULE = 'module-blockly-duino-v2'
const ENTRY = 'index.html'
// time for a change to travel between peers (the module debounces sends by 2 s)
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once Blockly is up and Edrys.onReady has run. The
 * module shows nothing of its own after onReady, so this waits for
 * Edrys.ready (the handler runs in the same task that sets it).
 */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE, 60_000)
  await expect(frame.locator('.blocklyToolboxDiv')).toBeVisible({ timeout: 60_000 })
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 60_000 })
  return frame
}

/** The generated Arduino code, as shown in the code pane next to the blocks. */
function code(frame: Frame): Promise<string> {
  return frame
    .locator('#content_code .ace_content')
    .textContent({ timeout: 5_000 })
    .then((t) => t || '')
    .catch(() => '')
}

/** A "delay (in ms)" block; the generated code then contains `delay(<ms>);`. */
const delayXml = (ms: number, y = 50) =>
  '<xml xmlns="https://developers.google.com/blockly/xml">' +
  `<block type="board_base_delay" x="50" y="${y}"><value name="DELAY_TIME">` +
  `<block type="math_number"><field name="NUM">${ms}</field></block>` +
  '</value></block></xml>'

/** A "digital write" block, which has a pin dropdown; the code then contains `digitalWrite(<pin>, HIGH);`. */
const digitalWriteXml = (pin: number, y = 50) =>
  '<xml xmlns="https://developers.google.com/blockly/xml">' +
  `<block type="board_base_inout_digital_write" x="50" y="${y}">` +
  `<field name="PIN">${pin}</field><field name="STAT">HIGH</field></block></xml>`

/**
 * Add a delay block, as if dropped from the toolbox. Dragging from the flyout
 * is slow and depends on its layout; adding through Blockly fires the same
 * change events the module listens to.
 */
async function addDelay(frame: Frame, ms: number, y: number) {
  await frame.evaluate(
    (xml) => {
      const w = window as any
      w.Blockly.Xml.domToWorkspace(w.Blockly.Xml.textToDom(xml), w.Code.workspace)
    },
    delayXml(ms, y)
  )
  await expect.poll(() => code(frame)).toContain(`delay(${ms});`)
}

/** The pins a new "digital write" block offers, which depend on the board. */
function digitalPins(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const block = (window as any).Code.workspace.newBlock('board_base_inout_digital_write')
    const pins = block.getField('PIN').getOptions().map((o: string[]) => o[1])
    block.dispose()
    return pins
  })
}

/**
 * Reload the module from inside, as Setup does on a language or renderer
 * switch, and return the new frame once Edrys.onReady has run in it (the
 * frame can be replaced).
 */
async function reloadModule(s: Session): Promise<Frame> {
  await (await moduleFrame(s, MODULE))
    .evaluate(() => {
      ;(window as any).__e2eOld = true
      location.reload()
    })
    .catch(() => {})
  await expect
    .poll(async () => (await moduleFrame(s, MODULE)).evaluate(() => !(window as any).__e2eOld && (window as any).Edrys?.ready === true).catch(() => false), {
      timeout: 60_000,
    })
    .toBe(true)
  return ready(s)
}

/** Record every message of this module the frame receives, like a terminal module listening for `execute`. */
async function listen(frame: Frame) {
  await frame.evaluate(() => {
    const w = window as any
    w.__e2eMessages = []
    w.Edrys.onMessage(({ subject, body }: any) => w.__e2eMessages.push({ subject, body }), true)
  })
}

async function received(frame: Frame, subject: string): Promise<string[]> {
  const all: { subject: string; body: string }[] = await frame.evaluate(() => (window as any).__e2eMessages)
  return all.filter((m) => m.subject === subject).map((m) => m.body)
}

/** True if `marker` disappears from the frame's generated code within `ms`. */
function lostWithin(frame: Frame, marker: string, ms: number): Promise<boolean> {
  return frame
    .waitForFunction(
      (m) => !(document.querySelector('#content_code .ace_content')?.textContent || '').includes(m),
      marker,
      { timeout: ms }
    )
    .then(
      () => true,
      () => false
    )
}

/** The run button, by its accessible name (English). */
const runButton = (frame: Frame) => frame.getByRole('button', { name: 'Run', exact: true })

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-blockly-duino-v2', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
  })

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = student = undefined
  })

  test('without a config, everyone starts with an empty Arduino program', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)

    for (const frame of [await ready(teacher!), await ready(student)]) {
      await expect.poll(() => code(frame)).toMatch(/void setup\(\) \{\s*\}\s*void loop\(\) \{\s*\}/)
      await expect(frame.locator('.blocklyBlockCanvas .blocklyDraggable')).toHaveCount(0)
      // no board is set, so the Arduino Uno's pins are used
      await expect(frame.locator('#boardLabel')).toHaveText('· Arduino Uno')
      // the toolbox offers the Arduino blocks
      await expect(frame.locator('.blocklyTreeLabel', { hasText: 'Arduino' }).first()).toBeVisible()
    }
  })

  test('the configured program and board are loaded for every peer', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_mega' } }])
    student = await addStudent(browser, classUrl)

    for (const frame of [await ready(teacher!), await ready(student)]) {
      await expect.poll(() => code(frame), { timeout: SYNC }).toContain('delay(1111);')
      await expect(frame.locator('.blocklyBlockCanvas .blocklyDraggable').first()).toBeVisible()
      await expect(frame.locator('#boardMenu')).toHaveValue('arduino_mega')
    }
  })

  test('without a board, blocks with a pin dropdown use the Arduino Uno pins', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    expect(await digitalPins(t)).toEqual(Array.from({ length: 14 }, (_, i) => String(i)))
    await t.evaluate((xml) => {
      const w = window as any
      w.Blockly.Xml.domToWorkspace(w.Blockly.Xml.textToDom(xml), w.Code.workspace)
    }, digitalWriteXml(13))
    await expect.poll(() => code(t)).toContain('digitalWrite(13, HIGH);')
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('digitalWrite(13, HIGH);')
    await expect(stu.locator('#edrysErrors')).toBeHidden()
  })

  test('a program with a pin block survives a module reload, and the module keeps writing changes', async ({ browser }) => {
    // pin 50 exists only on the Mega
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: digitalWriteXml(50), board: 'arduino_mega' } }])
    student = await addStudent(browser, classUrl)
    let stu = await ready(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('digitalWrite(50, HIGH);')

    stu = await reloadModule(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('digitalWrite(50, HIGH);')
    await expect(stu.locator('#boardLabel')).toHaveText('· Arduino Mega')
    await expect(stu.locator('#edrysErrors')).toBeHidden()

    // Code.init finished, so the change listener is in place and writes to the room
    await addDelay(stu, 2222, 200)
    await expect
      .poll(() => stu.evaluate(() => (window as any).Edrys.getState('blocklyXml', 'Value') as string), { timeout: SYNC })
      .toContain('>2222<')
  })

  test('after a module reload, the program and later changes of the others arrive', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    let stu = await ready(student)
    // a change that reaches the student without a room update in edrys-Lite
    await addDelay(t, 1111, 50)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')

    stu = await reloadModule(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')
    await addDelay(t, 3333, 200)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(3333);')
  })

  test('blocks added by one peer show up for the other', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await addDelay(stu, 2222, 50)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(2222);')

    await addDelay(t, 3333, 200)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(3333);')
    expect(await code(stu)).toContain('delay(2222);')
  })

  test('the run button sends the generated code with the execute subject', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111) } }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')
    await listen(t)

    await closeSideMenu(student)
    await runButton(stu).click()
    await expect.poll(() => received(t, 'execute'), { timeout: SYNC }).toHaveLength(1)
    const [sent] = await received(t, 'execute')
    expect(sent).toContain('void loop()')
    expect(sent).toContain('delay(1111);')
  })

  test('config.runCommand changes the subject the run button sends', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), runCommand: 'flash' } }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)
    await listen(t)

    await closeSideMenu(student)
    await runButton(stu).click()
    await expect.poll(() => received(t, 'flash'), { timeout: SYNC }).toEqual([expect.stringContaining('delay(1111);')])
    // sent once, with the configured subject only
    expect(await received(t, 'execute')).toEqual([])
  })

  test('a run that cannot be sent is reported', async () => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    const t = await ready(teacher!)
    await closeSideMenu(teacher!)
    // enabled once the module is connected
    await expect(runButton(t)).toBeEnabled()

    await t.evaluate(() => {
      ;(window as any).Edrys.sendMessage = () => {
        throw new Error('no connection')
      }
    })
    await runButton(t).click()
    await expect(t.getByRole('alert')).toContainText('The code could not be sent: no connection')
    await expect(t.getByRole('status')).toHaveText('error')
  })

  test('the top bar shows the sync state, and the run button has a name', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)
    const status = stu.getByRole('status')

    await expect(status).toHaveText('saved')
    await expect(runButton(stu)).toHaveAttribute('title', 'Run')

    // an edit is "sending" until it is written to the room (2 s later)
    await addDelay(stu, 2222, 50)
    await expect(status).toHaveText('sending…')
    await expect(status).toHaveText('saved', { timeout: SYNC })
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(2222);')
    await expect(t.getByRole('status')).toHaveText('saved')

    // selecting a block changes nothing to send
    await closeSideMenu(student)
    await stu.locator('.blocklyBlockCanvas .blocklyDraggable').first().click()
    await expect(status).toHaveText('saved')

    // a narrow module keeps the top bar on one row, with the status and run button
    await student.page.setViewportSize({ width: 360, height: 700 })
    await expect(status).toBeVisible()
    await expect(runButton(stu)).toBeInViewport({ ratio: 1 })
    // one 32 px row below the strip kept free for edrys's module name; two rows would be ~77 px
    expect((await stu.locator('#topBar').boundingBox())!.height).toBeLessThan(60)
    expect(await stu.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

  test('the example programs load as start programs', async () => {
    const examples: [string, string][] = [
      ['blink.xml', 'digitalWrite(LED_BUILTIN, LOW);'],
      ['click_color.xml', 'pinMode(3, INPUT);'],
      ['servo_potentio.xml', 'analogRead(A0)'],
    ]
    for (const [file, expected] of examples) {
      const xml = readFileSync(join(MODULES_DIR, MODULE, 'examples', file), 'utf8')
      await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: xml } }])
      // the module reloads for the new config (the frame can be replaced)
      await expect
        .poll(async () => (await moduleFrame(teacher!, MODULE)).evaluate(() => (window as any).editor?.getValue() || '').catch(() => ''), {
          timeout: 60_000,
        })
        .toContain(expected)
      await expect((await ready(teacher!)).getByRole('alert')).toBeHidden()
    }
  })

  test('a student who joins later sees the current program', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111) } }])
    const t = await ready(teacher!)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(1111);')
    await addDelay(t, 2222, 200)

    student = await addStudent(browser, classUrl)
    const stu = await ready(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(2222);')
  })

  test('a student who joins later does not reset the program of the others', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111) } }])
    const t = await ready(teacher!)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(1111);')
    await addDelay(t, 2222, 200)

    student = await addStudent(browser, classUrl)
    await ready(student)
    // A joining peer publishes its workspace 2 s after onReady; watch the teacher's program past that.
    expect(await lostWithin(t, 'delay(2222);', 10_000)).toBe(false)
  })

  test('an edit made right after receiving a change is kept', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await addDelay(t, 2222, 50)
    await expect.poll(() => code(stu), { timeout: SYNC, intervals: [100] }).toContain('delay(2222);')
    // The teacher keeps working right away, within the 2 s after the student received the change.
    await addDelay(t, 3333, 200)

    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(3333);')
    expect(await code(t)).toContain('delay(3333);')
  })

  test('an unknown board name is reported, and the configured program still loads and syncs', async ({ browser }) => {
    await setModules(teacher!, [
      // a plausible typo for arduino_mega
      { url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_mega2560' } },
    ])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await expect(stu.getByRole('alert')).toContainText('Unknown board "arduino_mega2560"')
    // tells the teacher what to use instead
    await expect(stu.getByRole('alert')).toContainText('arduino_mega,')
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')

    await addDelay(stu, 2222, 200)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(2222);')
  })

  test('a start program that cannot be loaded is reported, and edits still sync', async ({ browser }) => {
    await setModules(teacher!, [
      // a block type of BlocklyDuino v1, as in the module's own examples/
      { url: moduleUrl(MODULE, ENTRY), config: { code: '<xml><block type="base_delay"></block></xml>' } },
    ])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    for (const frame of [t, stu]) {
      await expect(frame.getByRole('alert')).toContainText('The start program in the module settings could not be loaded')
      await expect(frame.locator('#syncStatus')).toHaveText('error')
    }

    await addDelay(stu, 2222, 200)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(2222);')
  })

  test('a valid config shows no error', async () => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_uno' } }])
    const t = await ready(teacher!)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(1111);')
    await expect(t.getByRole('alert')).toBeHidden()
  })

  test('the teacher picks a board in the board dialog, and it applies to the whole room', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_mega' } }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)
    await expect(stu.locator('#boardMenu')).toHaveValue('arduino_mega')
    await expect(stu.locator('#boardLabel')).toHaveText('· Arduino Mega')
    // the Mega's digital pins 0-53
    expect(await digitalPins(stu)).toEqual(Array.from({ length: 54 }, (_, i) => String(i)))
    await closeSideMenu(teacher!)

    await t.locator('#boardButton').click()
    await expect(t.locator('#boardListModal')).toBeInViewport()
    await t.locator('#boardDescriptionSelector').selectOption('arduino_nano')
    await expect(t.locator('#board_mini_picture')).toHaveAttribute('src', /arduino_nano\.jpg$/)
    await t.locator('#boardListModalDialogOkay').click()
    // the modal slides out of view when closed
    await expect(t.locator('#boardListModal')).not.toBeInViewport()
    await expect(t.locator('#boardMenu')).toHaveValue('arduino_nano')

    await expect(stu.locator('#boardMenu')).toHaveValue('arduino_nano', { timeout: SYNC })
    await expect(stu.locator('#boardLabel')).toHaveText('· Arduino Nano')
    await expect(t.locator('#boardLabel')).toHaveText('· Arduino Nano')
    // the blocks now offer the Nano's pins 0-13
    expect(await digitalPins(stu)).toEqual(Array.from({ length: 14 }, (_, i) => String(i)))
    // the blocks are reloaded for the new board, not duplicated
    for (const frame of [t, stu]) {
      await expect(frame.locator('.blocklyBlockCanvas > .blocklyDraggable')).toHaveCount(1)
      expect((await code(frame)).match(/delay\(1111\);/g)).toHaveLength(1)
    }

    // a student joining now gets the picked board, not config.board
    const late = await addStudent(browser, classUrl)
    try {
      await expect((await ready(late)).locator('#boardMenu')).toHaveValue('arduino_nano', { timeout: SYNC })
    } finally {
      await closeSessions(late)
    }
  })

  test('the board dialog closes with its close button and by clicking beside it', async () => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    const t = await ready(teacher!)
    await closeSideMenu(teacher!)

    await t.locator('#boardButton').click()
    await expect(t.locator('#boardListModal')).toBeInViewport()
    await t.locator('#closeModalBoards').click()
    await expect(t.locator('#boardListModal')).not.toBeInViewport()

    await t.locator('#boardButton').click()
    await expect(t.locator('#boardListModal')).toBeInViewport()
    await t.locator('#overlayForModals').click({ position: { x: 10, y: 10 } })
    await expect(t.locator('#boardListModal')).not.toBeInViewport()
    await expect(t.locator('#boardMenu')).toHaveValue('arduino_uno')
  })

  test('students get no board button, and nobody gets the desktop-only buttons', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await expect(t.getByRole('button', { name: 'Board' })).toBeVisible()
    await expect(stu.getByRole('button', { name: 'Board' })).toBeHidden()
    for (const frame of [t, stu]) {
      // the desktop app's controls, and the tools and IoT popups that nothing opened
      for (const id of ['verifyButton', 'serialButton', 'serialConnectButton', 'uploadButton', 'portListModal', 'toolsPopup', 'iotPopup']) {
        await expect(frame.locator(`#${id}`)).toHaveCount(0)
      }
      await expect(runButton(frame)).toHaveCount(1)
    }
  })

  test('the help dialog opens from the menu and fits a narrow module', async () => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    const t = await ready(teacher!)
    await closeSideMenu(teacher!)
    // it was centred with the size of `top`, the cross-origin edrys page, which throws
    await teacher!.page.setViewportSize({ width: 500, height: 700 })

    const help = t.locator('#helpModal')
    await t.locator('#menuButton').click()
    // the text of a menu entry works like its icon
    await t.locator('#helpButton_span_menu').click()
    await expect(help).toContainText('BlocklyDuino')
    // centred, and not cut off on either side
    await expect
      .poll(() => help.evaluate((e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth }))
      .toBe(true)

    // it covers the menu at this width, so it has its own close button
    await help.getByRole('button', { name: 'Close' }).click()
    await expect(help).toBeHidden()

    // and opens again
    await t.locator('#menuButton').click()
    await t.locator('#helpButton').click()
    await expect(help).toBeVisible()
  })

  test('Reset brings the room back to the start program and board, and keeps other modules\' storage', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_mega' } }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')

    // the class works on: a new block and another board
    await addDelay(stu, 2222, 200)
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('delay(2222);')
    await closeSideMenu(teacher!)
    await t.locator('#boardButton').click()
    await t.locator('#boardDescriptionSelector').selectOption('arduino_uno')
    await t.locator('#boardListModalDialogOkay').click()
    await expect(stu.locator('#boardLabel')).toHaveText('· Arduino Uno', { timeout: SYNC })

    // modules served from the same origin share localStorage
    await t.evaluate(() => localStorage.setItem('another-module', 'keep me'))

    await t.locator('#menuButton').click()
    await t.locator('#resetButton_span_menu').click()
    await t.locator('#customDialogOkay').click()

    for (const frame of [t, stu]) {
      await expect.poll(() => code(frame), { timeout: SYNC }).not.toContain('delay(2222);')
      expect(await code(frame)).toContain('delay(1111);')
      await expect(frame.locator('#boardLabel')).toHaveText('· Arduino Mega', { timeout: SYNC })
    }
    expect(await t.evaluate(() => localStorage.getItem('another-module'))).toBe('keep me')
  })

  test('closing Setup leaves the edrys page where it was', async () => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY) }])
    const t = await ready(teacher!)
    await closeSideMenu(teacher!)
    const iframe = teacher!.page.locator('iframe').first()
    const before = await iframe.boundingBox()

    const panel = t.locator('#lateral-panel-setup-bloc')
    await t.locator('#menuButton').click()
    await t.locator('#parametersButton_span_menu').click()
    await expect(panel).toBeInViewport()
    await t.locator('#setup_header').getByRole('button', { name: 'Close' }).click()
    await expect(panel).not.toBeInViewport()

    // Focus went to the panel's hidden checkbox, far off to the right. Where the
    // module and edrys share an origin, that scrolls the edrys page sideways and
    // cuts off the module (the harness serves modules cross-origin, so check focus).
    expect(await t.evaluate(() => document.activeElement?.id)).toBe('menuButton')
    expect((await iframe.boundingBox())!.x).toBe(before!.x)
  })

  test('Setup: each user picks language and block theme, and keeps them when the module reloads', async ({ browser }) => {
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111) } }])
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    let stu = await ready(student)
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')
    await closeSideMenu(student)

    const panel = stu.locator('#lateral-panel-setup-bloc')
    await stu.locator('#menuButton').click()
    await stu.locator('#parametersButton_span_menu').click()
    await expect(panel).toBeInViewport()

    // the theme applies at once
    await stu.getByLabel('choose block theme').selectOption('high_contrast')
    await expect.poll(() => stu.evaluate(() => (window as any).Code.workspace.getTheme().name)).toMatch(/high.?contrast/i)

    // the language reloads the module (the frame is looked up again: it can be replaced)
    await stu.locator('#languageMenu').selectOption('de')
    await expect
      .poll(async () => (await moduleFrame(student!, MODULE)).locator('.blocklyTreeLabel', { hasText: 'Logik' }).count().catch(() => 0), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)
    stu = await ready(student)
    await expect(stu.locator('#themeMenu')).toHaveValue('high_contrast')
    await expect.poll(() => stu.evaluate(() => (window as any).Code.workspace.getTheme().name)).toMatch(/high.?contrast/i)
    await expect(stu.locator('#runButton')).toHaveAccessibleName('Ausführen')
    await expect(stu.getByRole('status')).toHaveText('gespeichert')
    // the program comes back from the room
    await expect.poll(() => code(stu), { timeout: SYNC }).toContain('delay(1111);')
    await expect(panel).not.toBeInViewport()

    // only for this user
    await expect(t.locator('.blocklyTreeLabel', { hasText: 'Logic' }).first()).toBeVisible()
    await expect(t.locator('#themeMenu')).toHaveValue('classic')

    // and kept when edrys reloads the module from its plain URL (e.g. a new room or settings)
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), config: { code: delayXml(1111), board: 'arduino_nano' } }])
    // the new config shows once the reloaded frame is up
    await expect
      .poll(async () => (await moduleFrame(student!, MODULE)).locator('#boardLabel').textContent({ timeout: 1_000 }).catch(() => ''), {
        timeout: 60_000,
      })
      .toBe('· Arduino Nano')
    stu = await ready(student)
    await expect(stu.locator('.blocklyTreeLabel', { hasText: 'Logik' }).first()).toBeVisible()
    await expect(stu.locator('#themeMenu')).toHaveValue('high_contrast')
  })
})
