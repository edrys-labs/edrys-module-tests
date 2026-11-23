import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import {
  THEME_BACKGROUND,
  moduleBackground,
  moduleFrame,
  moduleTheme,
  moduleUrl,
  revealModuleTop,
  serveModules,
  setClassroomTheme,
} from '../../lib/modules'

/**
 * module-blockly-micropython in a real edrys-Lite: a teacher and students in
 * the lobby (the module is shown everywhere). BlockMirror shows the program
 * as blocks and as Python; with synchronize, peers share one program (Python
 * text) in the room's state; without it, each keeps their own copy in their
 * browser; the run button sends the Python with the `execute` subject (or
 * config.runCommand), which module-micropython-simulator runs.
 */

const MODULE = 'module-blockly-micropython'
const SIMULATOR = 'module-micropython-simulator'
// time for a change to travel between peers (the module debounces sends by 0.5 s)
const SYNC = 15_000

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

const START = 'from calliopemini import *\n\nwhile True:\n    display.scroll(temperature())\n    sleep(1000)\n'

// ---------------------------------------------------------------------------
// Module-specific helpers

/** The module's iframe, once the editor is up and Edrys.onReady has run. */
async function ready(s: Session): Promise<Frame> {
  await closeSideMenu(s)
  const frame = await moduleFrame(s, MODULE, 60_000)
  await expect(frame.locator('.blocklyToolboxDiv')).toBeVisible({ timeout: 60_000 })
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true, null, { timeout: 60_000 })
  await expect(frame.locator('#run')).toBeEnabled({ timeout: 10_000 })
  return frame
}

/** The program, as the editor holds it (window.BlocklyMicroPython is the module's own API). */
const code = (frame: Frame) => frame.evaluate(() => (window as any).BlocklyMicroPython.getCode() as string)

/** The text in the Python view. */
const pythonView = (frame: Frame) =>
  frame.evaluate(() => (window as any).BlocklyMicroPython.editor.textEditor.codeMirror.getValue() as string)

/** The text of the blocks in the block view (not the toolbox flyout). */
const blockText = (frame: Frame) =>
  frame.evaluate(() => {
    const ws = (window as any).BlocklyMicroPython.editor.blockEditor.workspace
    // Blockly draws spaces in labels as non-breaking spaces
    return (ws.getCanvas().textContent as string).replace(/ /g, ' ')
  })

/** Number of top-level blocks (stacks) in the block view. */
const topBlocks = (frame: Frame) =>
  frame.evaluate(() => (window as any).BlocklyMicroPython.editor.blockEditor.workspace.getTopBlocks().length as number)

/** An edit in the Python view, as typing does: the text replaced through CodeMirror. */
async function typePython(frame: Frame, text: string) {
  await frame.evaluate((text) => {
    const cm = (window as any).BlocklyMicroPython.editor.textEditor.codeMirror
    cm.setValue(text)
  }, text)
}

/** An edit in the block view: the first number block gets a new value. */
async function setFirstNumber(frame: Frame, value: number) {
  await frame.evaluate((value) => {
    const ws = (window as any).BlocklyMicroPython.editor.blockEditor.workspace
    const block = ws.getAllBlocks(false).find((b: any) => b.type === 'ast_Num')
    if (!block) throw new Error('no number block')
    block.setFieldValue(String(value), 'NUM')
  }, value)
}

/** Record the messages of the room in the frame (promiscuous), to see what the run button sends. */
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

const status = (frame: Frame) => frame.locator('#status')

/** The toolbox's Calliope blocks (the categories before the separator), as Python snippets. */
const calliopeSnippets = (frame: Frame) =>
  frame.evaluate(() => {
    const toolbox = (window as any).BlockMirrorBlockEditor.prototype.TOOLBOXES.calliope
    const out: string[] = []
    for (const category of toolbox) {
      if (typeof category === 'string') break
      out.push(...category.blocks)
    }
    return out as string[]
  })

/** Each snippet's Python as the generator writes it when that block alone is dragged in, with the imports it adds. */
const generated = (frame: Frame, snippets: string[]) =>
  frame.evaluate((snippets) => {
    const w = window as any
    return snippets.map((snippet) => {
      const xml = w.BlocklyMicroPython.editor.textToBlocks.convertSource('toolbox.py', snippet).rawXml
      const ws = new w.Blockly.Workspace()
      w.Blockly.Xml.domToWorkspace(xml, ws)
      const code: string = w.python.pythonGenerator.workspaceToCode(ws)
      ws.dispose()
      return code
    })
  }, snippets)

/** Teacher: add the module with a shared program (synchronize), plus `config`. */
function addModule(teacher: Session, config: object = {}) {
  return setModules(teacher, [{ url: moduleUrl(MODULE, 'index.html'), config: { synchronize: true, ...config } }])
}

function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-blockly-micropython', () => {
  let teacher: Session | undefined
  let student: Session | undefined
  let late: Session | undefined
  let classUrl = ''

  test.beforeEach(async ({ browser }) => {
    const created = await createClass(browser, prepare)
    teacher = created.teacher
    classUrl = created.classUrl
  })

  test.afterEach(async () => {
    await closeSessions(teacher, student, late)
    teacher = student = late = undefined
  })

  test('the start program is shown as blocks and as Python for every peer', async ({ browser }) => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    student = await addStudent(browser, classUrl)
    const s = await ready(student)

    for (const f of [t, s]) {
      await expect.poll(() => code(f)).toBe(START)
      await expect.poll(() => pythonView(f)).toBe(START)
      // the import and the while loop
      await expect.poll(() => topBlocks(f)).toBe(2)
      await expect(status(f)).toHaveText('Saved')
    }
    // the Calliope calls get their own labels
    for (const label of ['scroll text', 'temperature', 'pause (ms)']) {
      await expect.poll(() => blockText(t)).toContain(label)
    }
  })

  test('without a config, everyone starts with an empty program', async () => {
    await addModule(teacher!)
    const t = await ready(teacher!)
    expect(await code(t)).toBe('')
    expect(await topBlocks(t)).toBe(0)
  })

  test('an edit in the Python view rebuilds the blocks and reaches the other peer', async ({ browser }) => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    student = await addStudent(browser, classUrl)
    const s = await ready(student)

    const edited = 'from calliopemini import *\n\ndisplay.show(Image.HEART)\nsleep(500)\n'
    await typePython(t, edited)
    // the blocks are rebuilt from the text: the loop is gone, the new calls are there
    await expect.poll(() => blockText(t), { timeout: 5_000 }).toContain('show')
    expect(await blockText(t)).not.toContain('scroll text')
    await expect(status(t)).toHaveText('Sending…')
    await expect(status(t)).toHaveText('Saved', { timeout: SYNC })

    await expect.poll(() => code(s), { timeout: SYNC }).toBe(edited)
    await expect.poll(() => blockText(s)).toContain('show')
    expect(await blockText(s)).not.toContain('scroll text')
  })

  test('an edit in the block view rewrites the Python and reaches the other peer', async ({ browser }) => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    student = await addStudent(browser, classUrl)
    const s = await ready(student)

    await setFirstNumber(s, 250)
    await expect.poll(() => pythonView(s), { timeout: 5_000 }).toContain('sleep(250)')
    await expect.poll(() => code(t), { timeout: SYNC }).toContain('sleep(250)')
    await expect.poll(() => pythonView(t)).toContain('sleep(250)')
  })

  test('a student who joins later sees the current program, and does not reset it', async ({ browser }) => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    const edited = 'from calliopemini import *\n\nprint(42)\n'
    await typePython(t, edited)
    await expect(status(t)).toHaveText('Saved', { timeout: SYNC })

    late = await addStudent(browser, classUrl)
    const l = await ready(late)
    await expect.poll(() => code(l), { timeout: SYNC }).toBe(edited)
    // the teacher's program stays
    await new Promise((r) => setTimeout(r, 3_000))
    expect(await code(t)).toBe(edited)
  })

  test('the run button sends the Python with the execute subject, config.runCommand changes it', async () => {
    await addModule(teacher!, { code: START })
    let t = await ready(teacher!)
    await listen(t)
    await revealModuleTop(t)
    await t.locator('#run').click()
    await expect.poll(() => received(t, 'execute')).toEqual([START])

    await addModule(teacher!, { code: START, runCommand: 'flash' })
    t = await ready(teacher!)
    await listen(t)
    await t.locator('#run').click()
    await expect.poll(() => received(t, 'flash')).toEqual([START])
    expect(await received(t, 'execute')).toEqual([])
  })

  test('the program runs in module-micropython-simulator in the same room', async () => {
    await setModules(teacher!, [
      { url: moduleUrl(MODULE, 'index.html'), config: { synchronize: true, code: 'from calliopemini import *\nprint("hello", 6 * 7)\n' } },
      { url: moduleUrl(SIMULATOR, 'index.html'), config: { board: 'calliope-mini-3' } },
    ])
    const t = await ready(teacher!)
    const sim = await moduleFrame(teacher!, SIMULATOR, 60_000)
    await expect(sim.locator('#status')).not.toHaveText('loading', { timeout: 45_000 })

    await t.locator('#run').click()
    await expect(sim.locator('#stdout')).toContainText('hello 42', { timeout: SYNC })
  })

  test('every Calliope block of the toolbox runs on the simulated Calliope mini 3', async ({ browserName }) => {
    // In WebKit, a simulator that starts below the visible part of the page
    // never finishes display.scroll, with any module above it (also seen with
    // module-markdown-it); a simulator issue, not this module's
    test.skip(browserName === 'webkit', 'the simulator does not finish display.scroll when it starts off-screen in WebKit')
    await setModules(teacher!, [
      { url: moduleUrl(MODULE, 'index.html'), config: { synchronize: true } },
      { url: moduleUrl(SIMULATOR, 'index.html'), config: { board: 'calliope-mini-3' } },
    ])
    const t = await ready(teacher!)
    const sim = await moduleFrame(teacher!, SIMULATOR, 60_000)
    await expect(sim.locator('#status')).not.toHaveText('loading', { timeout: 45_000 })

    // the Calliope blocks, without blocks that have an empty slot or never end
    const snippets = (await calliopeSnippets(t)).filter((b) => !b.includes('___') && !b.startsWith('while True'))
    expect(snippets.length).toBeGreaterThan(25)

    // each block's Python as the generator writes it when the block is
    // dragged in (with the imports it adds), imports first, then the blocks
    // in toolbox order, each followed by a line that names it, so a failure
    // shows which block stopped the program
    const codes = await generated(t, snippets)
    const imports: string[] = []
    const body: string[] = []
    snippets.forEach((snippet, i) => {
      for (const line of codes[i].split('\n')) {
        if (!line.trim()) continue
        if (/^(from \S+ )?import /.test(line)) {
          if (!imports.includes(line)) imports.push(line)
        } else body.push(line)
      }
      body.push('print("done:", ' + JSON.stringify(snippet) + ')')
    })
    const program = [...imports, ...body, 'print("toolbox", "ok")', ''].join('\n')
    await t.evaluate((program) => (window as any).BlocklyMicroPython.editor.setCode(program), program)
    await expect.poll(() => code(t)).toContain('print("toolbox", "ok")')

    await t.locator('#run').click()
    await expect(sim.locator('#stdout')).toContainText('toolbox ok', { timeout: 30_000 })
    await expect(sim.locator('#stdout')).not.toContainText('Error')
    expect(program).toContain('import music')
    expect(program).toContain('import neopixel')
  })

  test('every Calliope block on its own writes the imports it needs, once', async () => {
    await addModule(teacher!)
    const t = await ready(teacher!)
    // without the blocks on the rgb variable (rgb.show(), rgb[0] = ...), which need no import
    const snippets = (await calliopeSnippets(t)).filter(
      (b) => !b.includes('___') && !b.startsWith('while True') && !b.startsWith('rgb')
    )
    const codes = await generated(t, snippets)
    snippets.forEach((snippet, i) => {
      const lines = codes[i].split('\n')
      const count = (line: string) => lines.filter((l) => l === line).length
      // the music blocks only need music; every other Calliope block needs calliopemini
      const needed = snippet.startsWith('music.') ? 'import music' : 'from calliopemini import *'
      expect(count(needed), `${snippet} writes "${needed}" once:\n${codes[i]}`).toBe(1)
      if (snippet.includes('neopixel.')) expect(count('import neopixel'), snippet).toBe(1)
    })
    // and in a program: no import twice, none that the program already has
    const dragged = await generated(t, ['from calliopemini import *\nsleep(1000)\nprint(temperature())\ndisplay.show(Image.HEART)'])
    expect(dragged[0].split('\n').filter((l) => l === 'from calliopemini import *')).toHaveLength(1)
  })

  test('a block-only program with plain Calliope calls runs on the simulator', async ({ browserName }) => {
    test.skip(browserName === 'webkit', 'the simulator does not finish display.scroll when it starts off-screen in WebKit')
    await setModules(teacher!, [
      { url: moduleUrl(MODULE, 'index.html'), config: { synchronize: true } },
      { url: moduleUrl(SIMULATOR, 'index.html'), config: { board: 'calliope-mini-3' } },
    ])
    const t = await ready(teacher!)
    const sim = await moduleFrame(teacher!, SIMULATOR, 60_000)
    await expect(sim.locator('#status')).not.toHaveText('loading', { timeout: 45_000 })

    // no import block: the import comes only from the blocks
    const [program] = await generated(t, ['sleep(10)\nprint("plain", running_time() >= 0, temperature() > -40)'])
    expect(program).toContain('from calliopemini import *')
    await t.evaluate((program) => (window as any).BlocklyMicroPython.editor.setCode(program), program)
    await t.locator('#run').click()
    await expect(sim.locator('#stdout')).toContainText('plain True True', { timeout: SYNC })
    await expect(sim.locator('#stdout')).not.toContainText('Error')
  })

  test('the run button sends text typed just before the click', async () => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    await listen(t)
    const typed = 'from calliopemini import *\n\nprint("just typed")\n'
    // typed and clicked in the same tick, before BlockMirror takes the edit over (0.3 s)
    await t.evaluate((typed) => {
      ;(window as any).BlocklyMicroPython.editor.textEditor.codeMirror.setValue(typed)
      ;(document.getElementById('run') as HTMLButtonElement).click()
    }, typed)
    await expect.poll(() => received(t, 'execute')).toEqual([typed])
  })

  test('emptying config.code starts the room over with an empty program', async () => {
    await addModule(teacher!, { code: START })
    let t = await ready(teacher!)
    await expect.poll(() => code(t)).toBe(START)
    await addModule(teacher!)
    t = await ready(teacher!)
    await expect.poll(() => code(t)).toBe('')
  })

  test('without synchronize, each peer builds their own program, kept across a reload', async ({ browser }) => {
    await addModule(teacher!, { code: START, synchronize: false })
    const t = await ready(teacher!)
    student = await addStudent(browser, classUrl)
    const s = await ready(student)
    await expect(status(t)).toHaveText('Local only')

    const own = 'from calliopemini import *\n\nprint("mine")\n'
    await typePython(s, own)
    await new Promise((r) => setTimeout(r, 3_000))
    // the teacher keeps the start program
    expect(await code(t)).toBe(START)

    await student.page.reload()
    const s2 = await ready(student)
    await expect.poll(() => code(s2)).toBe(own)
  })

  test('Reset brings the room back to the start program; students get no Reset button', async ({ browser }) => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    student = await addStudent(browser, classUrl)
    const s = await ready(student)
    await expect(s.locator('#reset')).toBeHidden()

    await typePython(s, 'print(1)\n')
    await expect.poll(() => code(t), { timeout: SYNC }).toBe('print(1)\n')

    await revealModuleTop(t)
    await t.locator('#reset').click()
    await expect.poll(() => code(t)).toBe(START)
    await expect.poll(() => code(s), { timeout: SYNC }).toBe(START)
  })

  test('config.mode picks the view, the view buttons switch it', async () => {
    await addModule(teacher!, { code: START, mode: 'block' })
    const t = await ready(teacher!)
    const mode = () => t.evaluate(() => (window as any).BlocklyMicroPython.editor.getMode())
    await expect.poll(mode).toBe('block')
    await expect(t.locator('.CodeMirror')).toBeHidden()
    await expect(t.locator('button[data-mode="block"]')).toHaveAttribute('aria-pressed', 'true')

    await revealModuleTop(t)
    await t.locator('button[data-mode="text"]').click()
    await expect.poll(mode).toBe('text')
    await expect(t.locator('.CodeMirror')).toBeVisible()
    await expect(t.locator('.blocklyToolboxDiv')).toBeHidden()
  })

  test('an unknown mode is reported', async () => {
    await addModule(teacher!, { mode: 'cards' })
    const t = await ready(teacher!)
    await expect(t.locator('#errors')).toContainText('Unknown mode "cards"')
    await expect(status(t)).toHaveText('Error')
  })

  test("the module follows the classroom's light or dark theme", async () => {
    await addModule(teacher!, { code: START })
    const t = await ready(teacher!)
    const workspace = () =>
      t.evaluate(() =>
        (window as any).BlocklyMicroPython.editor.blockEditor.workspace.getTheme().getComponentStyle('workspaceBackgroundColour')
      )
    const codeBackground = () => t.locator('.CodeMirror').evaluate((e) => getComputedStyle(e).backgroundColor)

    for (const theme of ['dark', 'light'] as const) {
      await setClassroomTheme(teacher!, theme)
      await expect.poll(() => moduleTheme(t)).toBe(theme)
      await expect.poll(() => moduleBackground(t)).toBe(THEME_BACKGROUND[theme])
      await expect.poll(workspace).toBe(theme === 'dark' ? '#20252d' : '#ffffff')
      expect(await codeBackground()).not.toBe('')
    }
    expect(await code(t)).toBe(START)
  })
})
