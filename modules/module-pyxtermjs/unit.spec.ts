import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODULES_DIR } from '../../lib/modules'

/**
 * module-pyxtermjs's code handling without a browser: src/execute.js (reading
 * an upload, writing a project's files, filling in the script) and
 * src/workflows.js (the built-in workflows), imported from the local checkout.
 * Each case here would cost a class, a station and a student (~8 s) end to end.
 */

const SRC = join(MODULES_DIR, 'module-pyxtermjs', 'src')
// The files are ES modules, but the module's package.json does not say so (Parcel
// does not need it), so Node would read them as CommonJS. Both import nothing, so
// they load as they are from a data: URL.
const load = (file: string) =>
  import('data:text/javascript,' + encodeURIComponent(readFileSync(join(SRC, file), 'utf8')))

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
/** The shell runs `echo <base64> | base64 --decode > name`; decode what it would write. */
const written = (commands: string) =>
  Object.fromEntries(
    [...commands.matchAll(/echo (\S+) \| base64 --decode > '([^']+)'/g)].map(([, data, name]) => [
      name,
      Buffer.from(data, 'base64').toString('utf8'),
    ])
  )

test.describe('module-pyxtermjs units', () => {
  // no browser involved: once is enough
  test.skip(({ browserName }) => browserName !== 'chromium', 'browser-independent')

  test('parseUpload: code as is, or the main file of a project', async () => {
    const { parseUpload } = await load('execute.js')

    expect(parseUpload('print(1)', 'main.py')).toEqual({ code: 'print(1)', files: {} })
    // JSON that is not a project is still code
    expect(parseUpload('{"a": 1}', 'main.py')).toEqual({ code: '{"a": 1}', files: {} })
    expect(parseUpload('[1, 2]', 'main.py')).toEqual({ code: '[1, 2]', files: {} })

    const project = { 'util.h': 'int x;', 'Sketch.ino': 'void setup() {}', 'other.ino': '//' }
    // by name, as JSON text and as an object
    expect(parseUpload(JSON.stringify({ file: project }), 'Sketch.ino')).toEqual({
      code: 'void setup() {}',
      files: { 'util.h': 'int x;', 'other.ino': '//' },
    })
    expect(parseUpload({ file: project }, 'Sketch.ino').code).toBe('void setup() {}')
    // by extension: the first .ino
    expect(parseUpload({ file: project }, 'Main.ino').code).toBe('void setup() {}')
    // else the first file
    expect(parseUpload({ file: project }, 'main.py').code).toBe('int x;')
    expect(parseUpload({ file: project }, '').code).toBe('int x;')

    // an object without files is nothing to run
    expect(parseUpload({ file: {} }, 'main.py')).toBeNull()
    expect(parseUpload({ code: 'x' }, 'main.py')).toBeNull()
    expect(parseUpload(null, 'main.py')).toBeNull()
  })

  test('fileCommands: writes plain names, skips anything the shell would parse', async () => {
    const { fileCommands } = await load('execute.js')

    expect(fileCommands({})).toBe('true')
    const files = {
      'util.py': 'x = "ü"\n',
      'a-b_c.2.h': "it's",
      '../up.txt': 'x',
      '/etc/passwd': 'x',
      '.hidden': 'x',
      'a.txt; rm -rf ~': 'x',
      '$(id)': 'x',
      'sub/dir.txt': 'x',
    }
    const commands = fileCommands(files)
    expect(written(commands)).toEqual({ 'util.py': 'x = "ü"\n', 'a-b_c.2.h': "it's" })
    expect(commands.split(' && ')).toHaveLength(2)
  })

  test('fillScript: placeholders, $FILES or files first, and $CODE as UTF-8 base64', async () => {
    const { fillScript } = await load('execute.js')
    const fields = { board: 'arduino:avr:uno', port: '/dev/ttyACM0', baud: 9600, filename: 'Sketch.ino' }

    // every occurrence, and $FILE does not eat $FILES
    const script = 'cp $FILE $FILE.bak\n(cd dir && $FILES)\nflash -b $BOARD -p $PORT -r $BAUD\necho $CODE'
    const out = fillScript(script, fields, 'grüß', { 'a.h': 'A' })
    expect(out).toBe(
      'cp Sketch.ino Sketch.ino.bak\n' +
        `(cd dir && echo ${b64('A')} | base64 --decode > 'a.h')\n` +
        'flash -b arduino:avr:uno -p /dev/ttyACM0 -r 9600\n' +
        `echo ${b64('grüß')}\n`
    )

    // without $FILES the files are written before the script
    expect(fillScript('run $FILE', fields, 'x', { 'a.h': 'A' })).toBe(
      `echo ${b64('A')} | base64 --decode > 'a.h'\nrun Sketch.ino\n`
    )
    // and without files nothing is added; $FILES becomes a no-op
    expect(fillScript('run $FILE', fields, 'x')).toBe('run Sketch.ino\n')
    expect(fillScript('(cd d && $FILES)', fields, 'x')).toBe('(cd d && true)\n')
    // empty fields
    expect(fillScript('[$BOARD][$PORT]', {}, 'x')).toBe('[][]\n')
  })

  test('every built-in workflow resolves and fills in completely', async () => {
    const { fillScript } = await load('execute.js')
    const { WORKFLOWS, DEFAULT_SCRIPT, resolveField, resolveScript } = await load('workflows.js')

    // an explicit script and explicit fields win over the workflow
    expect(resolveScript({ workflow: 'avr-gcc', script: 'mine' })).toBe('mine')
    expect(resolveScript({})).toBe(DEFAULT_SCRIPT)
    expect(resolveScript({ workflow: 'no-such-workflow' })).toBe(DEFAULT_SCRIPT)
    expect(resolveField({ workflow: 'arduino-avr', port: '/dev/ttyUSB3' }, 'port')).toBe('/dev/ttyUSB3')
    expect(resolveField({ workflow: 'arduino-avr', port: '' }, 'port')).toBe('/dev/ttyACM0')
    expect(resolveField({}, 'port')).toBe('')

    const names = Object.keys(WORKFLOWS)
    expect(names).toEqual([
      'arduino-avr',
      'arduino-esp32',
      'arduino-nano-esp32',
      'arduino-stm32',
      'avr-gcc',
      'micropython',
      'native',
    ])
    for (const workflow of names) {
      const config = { workflow }
      const fields = Object.fromEntries(
        ['board', 'port', 'baud', 'filename'].map((name) => [name, resolveField(config, name)])
      )
      expect(fields.filename, workflow).toBeTruthy()
      expect(WORKFLOWS[workflow].script, workflow).toContain('$CODE')
      if (WORKFLOWS[workflow].board) expect(WORKFLOWS[workflow].boards, workflow).toContain(WORKFLOWS[workflow].board)

      const out = fillScript(resolveScript(config), fields, 'code', { 'extra.h': 'x' })
      expect(out, workflow).not.toMatch(/\$(CODE|FILES?|BOARD|PORT|BAUD)\b/)
      expect(out, workflow).toContain(b64('code'))
      expect(written(out), workflow).toEqual({ 'extra.h': 'x' })
    }
  })
})
