import { Browser, BrowserContext, Frame, expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ModuleEntry, Session, closeSessions, closeSideMenu, createClass, joinClass, setModules } from '../../lib/edrys'
import { FakeHexi, HexiResponse, installFakeHexi } from '../../lib/fake-hexi'
import { moduleFrame, moduleUrl, serveModules } from '../../lib/modules'

/**
 * module-avr8js in a real edrys-Lite: a teacher and a student in the lobby
 * (the module is shown everywhere). An editor module sends Arduino code with
 * the `execute` subject; every peer in the room compiles it with
 * hexi.wokwi.com (faked here, with recorded responses in fixtures/) and runs
 * its own simulation of the circuit from config.modules.
 */

const MODULE = 'module-avr8js'
// the published URL is docs/index.html, built from src/ (npm run build)
const ENTRY = 'docs/index.html'
// time for a message to travel between peers and the simulation to react
const SYNC = 15_000

// The sketches the fixtures were recorded from; the fake server matches on the marker comment.
const SKETCHES = {
  hello: `// e2e:hello
void setup() {
  Serial.begin(9600);
  Serial.println("hello from the simulator");
  pinMode(13, OUTPUT);
  digitalWrite(13, HIGH);
}
void loop() {
  if (Serial.available()) Serial.write(Serial.read());
}`,
  button: `// e2e:button
void setup() {
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
}
void loop() {
  // INPUT_PULLUP: a pressed button connects the pin to GND
  digitalWrite(13, digitalRead(2) == LOW);
}`,
  analog: `// e2e:analog
void setup() {
  Serial.begin(9600);
}
void loop() {
  Serial.print("A0=");
  Serial.println(analogRead(A0));
  delay(200);
}`,
  ticks: `// e2e:ticks
int n = 0;
void setup() {
  Serial.begin(9600);
}
void loop() {
  Serial.print("tick ");
  Serial.println(++n);
  delay(50);
}`,
  chart: `// e2e:chart
void setup() {
  analogWrite(5, 64);
}
void loop() {}`,
  flood: `// e2e:flood
unsigned long n = 0;
void setup() {
  Serial.begin(115200);
}
void loop() {
  Serial.print("line ");
  Serial.println(++n);
}`,
  lines: `// e2e:lines
String line = "";
void setup() {
  Serial.begin(9600);
  pinMode(13, OUTPUT);
}
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\\n') {
      if (line == "on") digitalWrite(13, HIGH);
      if (line == "off") digitalWrite(13, LOW);
      Serial.print("> ");
      Serial.println(line);
      line = "";
    } else {
      line += c;
    }
  }
}`,
  error: `// e2e:error
void setup() { undefinedFunction(); }
void loop() {}`,
  xss: `// e2e:xss
void setup() { <img src=x onerror="window.__e2eXss=1"> }
void loop() {}`,
}
type Sketch = keyof typeof SKETCHES

const fixture = (name: Sketch): HexiResponse => JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'))

const LED13 = "<wokwi-led color='red' pin='13' label='13'></wokwi-led>"
const CIRCUIT = `${LED13}\n<span id='simulation-time'></span>`
// every peer in the room runs what any peer uploads
const SYNCED = { config: { modules: CIRCUIT, synchronize: true } }

// one fake compile server per browser, so a test can make it fail for one peer
const servers = new Map<BrowserContext, FakeHexi>()

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
  const hexi = await installFakeHexi(context)
  for (const name of Object.keys(SKETCHES) as Sketch[]) hexi.respond(`// e2e:${name}`, fixture(name))
  servers.set(context, hexi)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once Edrys.onReady has run and the simulator bundle is
 * loaded. The circuit is only rendered after onReady, so this waits for
 * Edrys.ready and window.AVR8js.
 */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await frame.waitForFunction(() => (window as any).Edrys?.ready === true && !!(window as any).AVR8js, null, {
    timeout: 30_000,
  })
  return frame
}

const stdout = (frame: Frame) => frame.locator('#stdout')
const badge = (frame: Frame) => frame.locator('#status')
const WAITING = 'Waiting for code from an editor module (subject execute)…'

const occurrences = async (frame: Frame, text: string) => ((await stdout(frame).textContent()) || '').split(text).length - 1

/** Send a sketch as an editor module does (promiscuous listeners get it, the sender too). */
async function run(frame: Frame, sketch: string, subject = 'execute') {
  await frame.evaluate(([subject, sketch]) => (window as any).Edrys.sendMessage(subject, sketch), [subject, sketch])
}

/**
 * Click Stop in the module header. Typing in the input row scrolls the edrys
 * page down, which puts the header under edrys' fixed app bar, and the click
 * would land on the bar.
 */
async function clickStop(s: Session, frame: Frame) {
  await s.page.evaluate(() => {
    for (const e of [document.scrollingElement, ...Array.from(document.querySelectorAll('*'))]) if (e?.scrollTop) e.scrollTop = 0
  })
  await frame.locator('#stop').click()
}

/** Whether the LED on `pin` is lit. */
const led = (frame: Frame, pin: number) =>
  frame.locator(`wokwi-led[pin="${pin}"]`).evaluate((e: any) => e.value === true)

async function setup(teacher: Session, entry: Omit<ModuleEntry, 'url'> = { config: { modules: CIRCUIT } }) {
  await setModules(teacher, [{ url: moduleUrl(MODULE, ENTRY), ...entry }])
}

/** A student who opens the class link and stays in the lobby. */
function addStudent(browser: Browser, classUrl: string) {
  return joinClass(browser, classUrl, prepare)
}

// ---------------------------------------------------------------------------

test.describe('module-avr8js', () => {
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
    if (teacher) servers.delete(teacher.context)
    if (student) servers.delete(student.context)
    teacher = student = undefined
  })

  test('before any code arrives, everyone sees the circuit and an idle terminal', async ({ browser }) => {
    await setup(teacher!)
    student = await addStudent(browser, classUrl)

    for (const frame of [await ready(teacher!), await ready(student)]) {
      await expect(stdout(frame)).toHaveText(WAITING)
      await expect(badge(frame)).toHaveText('idle')
      await expect(frame.locator('#modules wokwi-led')).toBeVisible()
      expect(await led(frame, 13)).toBe(false)
      // nothing to talk to or stop yet
      for (const id of ['#send', '#stdin', '#stop']) await expect(frame.locator(id)).toBeDisabled()
    }
  })

  test('with synchronize, code sent with execute runs on every peer in the room', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await run(stu, SKETCHES.hello)
    for (const frame of [stu, t]) {
      await expect(stdout(frame)).toContainText('hello from the simulator', { timeout: SYNC })
      await expect.poll(() => led(frame, 13), { timeout: SYNC }).toBe(true)
      await expect(frame.locator('#simulation-time')).toContainText('Simulation time: ')
      await expect(badge(frame)).toHaveText('running')
      for (const id of ['#send', '#stdin', '#stop']) await expect(frame.locator(id)).toBeEnabled()
    }
    // the compiler's summary replaces the waiting hint
    await expect(stdout(t)).toContainText('Sketch uses')
    await expect(stdout(t)).not.toContainText('Waiting for code')
  })

  test('by default, an upload runs only for the peer who sent it', async ({ browser }) => {
    await setup(teacher!)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await run(stu, SKETCHES.hello)
    await expect(stdout(stu)).toContainText('hello from the simulator', { timeout: SYNC })
    await expect.poll(() => led(stu, 13), { timeout: SYNC }).toBe(true)

    // the teacher's own upload runs for the teacher; the student's was never compiled there
    await run(t, SKETCHES.error)
    await expect(stdout(t)).toContainText("'undefinedFunction' was not declared", { timeout: SYNC })
    expect(servers.get(teacher!.context)!.requests).toEqual([SKETCHES.error])
    expect(await led(t, 13)).toBe(false)
    // and the student's simulation keeps running
    await expect(stdout(stu)).not.toContainText('undefinedFunction')
    expect(servers.get(student!.context)!.requests).toEqual([SKETCHES.hello])
    // nothing is kept in the room for later joiners
    expect(await stu.evaluate(() => (window as any).Edrys.getState('avr8js:execute', 'Value'))).toBeFalsy()
  })

  test('terminal input reaches the program as lines, and stop ends the simulation', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, SKETCHES.lines)
    await expect(stdout(t)).toContainText('Sketch uses', { timeout: SYNC })
    await closeSideMenu(teacher!)

    // Enter sends the line with \n, as the Arduino Serial Monitor does: the
    // sketch acts on a command only once its line has ended
    await t.locator('#stdin').fill('on')
    await t.locator('#stdin').press('Enter')
    await expect(stdout(t)).toContainText('> on', { timeout: SYNC })
    await expect.poll(() => led(t, 13), { timeout: SYNC }).toBe(true)
    await expect(t.locator('#stdin')).toHaveValue('')

    // the Send button sends as well
    await t.locator('#stdin').fill('off')
    await t.locator('#send').click()
    await expect(stdout(t)).toContainText('> off', { timeout: SYNC })
    await expect.poll(() => led(t, 13), { timeout: SYNC }).toBe(false)

    // typed markup is echoed as text, by the module and by the sketch
    await t.locator('#stdin').fill('<b>bold?</b>')
    await t.locator('#stdin').press('Enter')
    await expect.poll(() => occurrences(t, '<b>bold?</b>'), { timeout: SYNC }).toBe(2)
    await expect(t.locator('#stdout b')).toHaveCount(0)

    await clickStop(teacher!, t)
    await expect(stdout(t)).toContainText('execution stopped')
    await expect(badge(t)).toHaveText('stopped')
    for (const id of ['#send', '#stdin', '#stop']) await expect(t.locator(id)).toBeDisabled()
  })

  test('a pushbutton pulls an INPUT_PULLUP pin to LOW while pressed', async () => {
    await setup(teacher!, {
      config: { modules: `<wokwi-pushbutton pin='2'></wokwi-pushbutton>\n${LED13}` },
    })
    const t = await ready(teacher!)
    await closeSideMenu(teacher!)
    await run(t, SKETCHES.button)
    await expect(stdout(t)).toContainText('Sketch uses', { timeout: SYNC })
    expect(await led(t, 13)).toBe(false)

    await t.locator('wokwi-pushbutton').hover()
    await teacher!.page.mouse.down()
    await expect.poll(() => led(t, 13), { timeout: SYNC }).toBe(true)
    await teacher!.page.mouse.up()
    await expect.poll(() => led(t, 13), { timeout: SYNC }).toBe(false)
  })

  test('config.execute changes the subject the module listens to', async () => {
    await setup(teacher!, { config: { modules: CIRCUIT, execute: 'flash' } })
    const t = await ready(teacher!)
    // the waiting hint names the subject an editor has to send
    await expect(stdout(t)).toHaveText('Waiting for code from an editor module (subject flash)…')

    await run(t, SKETCHES.error, 'execute')
    await run(t, SKETCHES.hello, 'flash')
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })
    // only the sketch sent with the configured subject was compiled
    expect(servers.get(teacher!.context)!.requests).toEqual([SKETCHES.hello])
  })

  // hexi installs some libraries only when libraries.txt lists them
  test('a sketch that includes Adafruit_SSD1306.h requests the library', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    const hexi = servers.get(teacher!.context)!

    await run(t, SKETCHES.hello)
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })
    await run(t, `#include <Adafruit_SSD1306.h>\n${SKETCHES.hello}`)
    await expect.poll(() => hexi.files.length, { timeout: SYNC }).toBe(2)

    expect(hexi.files).toEqual([[], [{ name: 'libraries.txt', content: 'Adafruit SSD1306' }]])
  })

  test('without a circuit, the module says where to configure one', async () => {
    await setup(teacher!, { config: {} })
    const t = await ready(teacher!)
    await expect(t.locator('#modules')).toHaveText('No circuit configured: add Wokwi parts in the module settings (modules).')
    await expect(stdout(t)).toHaveText(WAITING)
  })

  test('a compile error is shown on every peer and nothing runs', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await run(stu, SKETCHES.error)
    for (const frame of [stu, t]) {
      await expect(stdout(frame)).toContainText("'undefinedFunction' was not declared in this scope", { timeout: SYNC })
      await expect(badge(frame)).toHaveText('error')
      for (const id of ['#send', '#stdin', '#stop']) await expect(frame.locator(id)).toBeDisabled()
    }
  })

  test("a potentiometer on pin 'A0' sets the value analogRead(A0) returns", async () => {
    await setup(teacher!, {
      config: { modules: `<wokwi-potentiometer pin='A0' value='512'></wokwi-potentiometer>\n${CIRCUIT}` },
    })
    const t = await ready(teacher!)
    await run(t, SKETCHES.analog)
    // 512 of 1023 is half of 5 V
    await expect(stdout(t)).toContainText(/A0=51[0-3]/, { timeout: SYNC })
  })

  test('sensor sliders change the values the sketch reads, controls="none" hides them', async () => {
    await setup(teacher!, {
      config: {
        modules: `<wokwi-ntc-temperature-sensor pin='A0' temperature='25'></wokwi-ntc-temperature-sensor>
<wokwi-photoresistor-sensor pin='A1' controls='none'></wokwi-photoresistor-sensor>
${CIRCUIT}`,
      },
    })
    const t = await ready(teacher!)
    // the side menu would take the clicks on the slider and Stop
    await closeSideMenu(teacher!)
    await run(t, SKETCHES.analog)
    const slider = t.getByLabel('Temperature A0')
    await expect(slider).toBeVisible({ timeout: SYNC })
    await expect(t.locator('#sensors .slider')).toHaveCount(1)
    // 25 °C: the 10 kΩ NTC against the 10 kΩ pull-up gives half of 5 V
    await expect(stdout(t)).toContainText(/A0=51[0-3]/, { timeout: SYNC })

    // hotter: the NTC's resistance and so the voltage drop (80 °C ≈ 115)
    await slider.fill('80')
    await expect(stdout(t)).toContainText(/A0=11[0-9]/, { timeout: SYNC })

    // the sliders belong to the run
    await clickStop(teacher!, t)
    await expect(t.locator('#sensors .slider')).toHaveCount(0)
  })

  // gcc quotes the offending source line, so a sketch's markup reaches every peer's terminal
  test('markup in a compile error is shown as text, not run, on the other peers', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    const stu = await ready(student)

    await run(stu, SKETCHES.xss)
    await expect(stdout(t)).toContainText('expected primary-expression', { timeout: SYNC })
    await expect(t.locator('#stdout img')).toHaveCount(0)
    await expect(stdout(t)).toContainText('<img src=x onerror="window.__e2eXss=1">')
    expect(await t.evaluate(() => (window as any).__e2eXss)).toBeUndefined()
  })

  test('an unreachable compile server is reported, and the same sketch runs once it is back', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    const hexi = servers.get(teacher!.context)!
    hexi.offline()

    await run(t, SKETCHES.hello)
    await expect(stdout(t).locator('.error')).toContainText('compile server (hexi.wokwi.com) failed', { timeout: SYNC })
    await expect(badge(t)).toHaveText('error')
    for (const id of ['#send', '#stdin', '#stop']) await expect(t.locator(id)).toBeDisabled()

    // the failure is not cached: the same sketch is compiled again
    hexi.offline(false)
    await run(t, SKETCHES.hello)
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })
    expect(hexi.requests).toEqual([SKETCHES.hello, SKETCHES.hello])
  })

  test('a second upload while the first one compiles replaces it', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    // both requests are in flight at the same time
    servers.get(teacher!.context)!.delay(1_500)

    await run(t, SKETCHES.ticks)
    await run(t, SKETCHES.ticks + '\n// second upload')
    await expect(stdout(t)).toContainText('tick 8', { timeout: SYNC })
    // one simulation prints every tick once; two running side by side print each twice
    // (Serial.println ends lines with \r\n)
    expect(((await stdout(t).textContent()) || '').match(/^tick 6\r?$/gm)).toHaveLength(1)
  })

  test('with synchronize, a student who joins later sees the program that is running', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    const t = await ready(teacher!)
    await run(t, SKETCHES.hello)
    await expect.poll(() => led(t, 13), { timeout: SYNC }).toBe(true)

    student = await addStudent(browser, classUrl)
    const stu = await ready(student)
    await expect.poll(() => led(stu, 13), { timeout: SYNC }).toBe(true)
    await expect(stdout(stu)).toContainText('hello from the simulator')
  })

  test('with synchronize, a reloaded module picks the running program up again', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    await ready(student)
    await run(t, SKETCHES.hello)
    await expect.poll(async () => led(await ready(student!), 13), { timeout: SYNC }).toBe(true)

    await (await moduleFrame(student, MODULE))
      .evaluate(() => {
        ;(window as any).__e2eOld = true
        location.reload()
      })
      .catch(() => {})
    // the reloaded frame (it can be replaced) runs the program again
    await expect
      .poll(
        async () =>
          (await moduleFrame(student!, MODULE))
            .evaluate(() => {
              const w = window as any
              return !w.__e2eOld && (document.querySelector('wokwi-led[pin="13"]') as any)?.value === true
            })
            .catch(() => false),
        { timeout: 30_000 }
      )
      .toBe(true)
  })

  test('with synchronize, Stop stops the room, and a reload does not start the program again', async ({ browser }) => {
    await setup(teacher!, SYNCED)
    student = await addStudent(browser, classUrl)
    const t = await ready(teacher!)
    let stu = await ready(student)
    await run(t, SKETCHES.hello)
    for (const frame of [t, stu]) await expect.poll(() => led(frame, 13), { timeout: SYNC }).toBe(true)

    await closeSideMenu(student)
    await clickStop(student, stu)
    for (const frame of [stu, t]) {
      await expect(stdout(frame)).toContainText('execution stopped', { timeout: SYNC })
      await expect(badge(frame)).toHaveText('stopped')
      await expect(frame.locator('#stop')).toBeDisabled()
    }
    await expect
      .poll(() => t.evaluate(() => (window as any).Edrys.getState('avr8js:execute', 'Value')), { timeout: SYNC })
      .toBeFalsy()

    // reload the student's module: it comes back idle
    await stu.evaluate(() => location.reload()).catch(() => {})
    await expect
      .poll(async () => (await moduleFrame(student!, MODULE)).evaluate(() => (window as any).Edrys?.ready === true).catch(() => false), {
        timeout: 30_000,
      })
      .toBe(true)
    stu = await ready(student)
    await expect(stdout(stu)).toHaveText(WAITING)
    await expect(badge(stu)).toHaveText('idle')
    expect(await led(stu, 13)).toBe(false)
  })

  test('a sketch that prints forever keeps only the newest terminal output', async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    await run(t, SKETCHES.flood)

    const text = async () => (await stdout(t).textContent()) || ''
    // the newest complete line (output can stop mid-line)
    const lastLine = async () => Number([...(await text()).matchAll(/line (\d+)\r?\n/g)].pop()?.[1] || 0)
    // ~10 characters per line: by line 15000 far more than the 100 000 kept was printed
    await expect.poll(lastLine, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(15_000)

    const kept = await text()
    expect(kept.length).toBeLessThanOrEqual(100_000)
    // the oldest output (the compiler summary) is gone, the newest is still there
    expect(kept).not.toContain('Sketch uses')
    expect(await lastLine()).toBeGreaterThan(15_000)
  })

  test("a module-editor multi-file project is compiled with its files", async () => {
    await setup(teacher!)
    const t = await ready(teacher!)
    const hexi = servers.get(teacher!.context)!

    // module-editor's multi-file mode sends JSON {"file": {name: content}}
    await run(t, JSON.stringify({ file: { 'sketch.ino': SKETCHES.hello, 'util.h': 'int twice(int x);\n' } }))
    await expect(stdout(t)).toContainText('hello from the simulator', { timeout: SYNC })
    expect(hexi.requests).toEqual([SKETCHES.hello])
    expect(hexi.files).toEqual([[{ name: 'util.h', content: 'int twice(int x);\n' }]])

    // a project without an .ino is reported, nothing is sent
    await run(t, JSON.stringify({ file: { 'util.h': '' } }))
    await expect(stdout(t).locator('.error')).toContainText('the project has no .ino file', { timeout: SYNC })
    await expect(badge(t)).toHaveText('error')
    expect(hexi.requests).toHaveLength(1)
  })

  test('an avr-chart records Timer0 and draws it', async () => {
    await setup(teacher!, {
      config: { modules: "<avr-chart signals='TCNT0, OCR0B, OC0B' window='4ms' mode='scope' trigger='TOV0'></avr-chart>" },
    })
    const t = await ready(teacher!)
    await run(t, SKETCHES.chart)
    await expect(stdout(t)).toContainText('Sketch uses', { timeout: SYNC })

    const chart = t.locator('avr-chart')
    // analogWrite(5, 64): Timer0 counts 0-255, OCR0B is 64
    await expect
      .poll(
        () =>
          chart.evaluate((e: any) => {
            const data = (name: string) => e.traces.find((t: any) => t.name === name).data.map((p: number[]) => p[1])
            const count = data('TCNT0')
            return [Math.min(...count), Math.max(...count), data('OCR0B').at(-1), data('OC0B (D5)').includes(1)]
          }),
        { timeout: SYNC }
      )
      .toEqual([0, 255, 64, true])
    // the canvas is drawn after the first trigger
    await expect
      .poll(() => chart.evaluate((e: any) => e.shadowRoot.querySelector('canvas').height), { timeout: SYNC })
      .toBeGreaterThan(100)
    await expect(chart.locator('.legend')).toHaveText(/TCNT0\s*OCR0B/)
  })
})
