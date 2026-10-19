import { Browser, BrowserContext, Frame, Locator, expect, test } from '@playwright/test'
import {
  ModuleEntry,
  Session,
  closeSessions,
  closeSideMenu,
  createClass,
  enterRoom,
  joinClass,
  openStation,
  reloadStation,
  setModules,
  stationRoom,
} from '../../lib/edrys'
import { moduleFrame, moduleUrl, revealModuleTop, serveModules } from '../../lib/modules'

/**
 * module-survey in a real edrys-Lite: a station and a student in the station's
 * room. Whoever takes the SurveyJS survey sends `surveyCompleted`; only the
 * station stores it (in its own IndexedDB) and can list results and chart them.
 *
 * Nothing is shared state: results live only in the station's browser.
 */

const MODULE = 'module-survey'
const ENTRY = 'index.html'
// time for a message to travel between peers
const SYNC = 15_000

const SURVEY = {
  title: 'Lab Feedback',
  pages: [
    {
      name: 'page1',
      elements: [
        { type: 'text', name: 'name', title: 'Your name' },
        { type: 'rating', name: 'experience', title: 'Rate your experience', rateMax: 5 },
        { type: 'radiogroup', name: 'pace', title: 'Pace', choices: ['slow', 'ok', 'fast'] },
        { type: 'text', inputType: 'number', name: 'age', title: 'Age' },
        { type: 'checkbox', name: 'topics', title: 'Topics you liked', choices: ['loops', 'arrays', 'io'] },
      ],
    },
  ],
}

/** A second, different survey (two in one class, or the first one edited). */
const EXIT_TICKET = {
  title: 'Exit Ticket',
  pages: [
    {
      name: 'page1',
      elements: [{ type: 'radiogroup', name: 'clear', title: 'Was today clear?', choices: ['yes', 'no'] }],
    },
  ],
}

/** The survey as the settings form stores a code-area: a JSON string. */
const surveyConfig = (survey: object = SURVEY) => ({ survey: JSON.stringify(survey) })

const prepare = async (context: BrowserContext) => {
  await serveModules(context)
}

// ---------------------------------------------------------------------------
// Module-specific helpers

/**
 * The module's iframe, once Edrys is ready. With a valid config onReady
 * renders the survey into a hidden container, so wait for `Edrys.ready`.
 */
async function ready(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  await expect
    .poll(() => frame.evaluate(() => (window as any).Edrys?.ready === true).catch(() => false), { timeout: 30_000 })
    .toBe(true)
  await closeSideMenu(s)
  return frame
}

const startButton = (frame: Frame) => frame.locator('#startSurveyBtn')
const resultsButton = (frame: Frame) => frame.locator('#loadResultsBtn')

interface Answers {
  name?: string
  experience?: number
  pace?: string
}

/** Click a control in the module's top row (header, back buttons), clear of edrys-Lite's app bar. */
async function clickTop(frame: Frame, target: Locator) {
  await revealModuleTop(frame)
  await target.click()
}

const startMessage = (frame: Frame) => frame.locator('#startMessage')
const retryButton = (frame: Frame) => frame.locator('#retryBtn')

/**
 * Start the survey, fill it in and complete it, as a person would. The module
 * returns to the start screen once the station confirms (or did not, in time).
 */
async function takeSurvey(frame: Frame, answers: Answers) {
  await clickTop(frame, startButton(frame))
  const survey = frame.locator('#surveyContainer')
  await expect(survey.getByText('Lab Feedback')).toBeVisible()
  if (answers.name !== undefined) await survey.getByRole('textbox').fill(answers.name)
  if (answers.experience !== undefined)
    await survey.locator('.sd-rating__item').filter({ hasText: new RegExp(`^${answers.experience}$`) }).click()
  if (answers.pace !== undefined) await survey.getByText(answers.pace, { exact: true }).click()
  await survey.getByRole('button', { name: 'Complete' }).click()
}

/** The confirmation after a submit, as the user sees it (the ack timeout is 5 s). */
async function expectSubmitted(frame: Frame) {
  await expect(startButton(frame)).toHaveText('Submitted ✓', { timeout: SYNC })
  await expect(startButton(frame)).toBeDisabled()
}

/**
 * Make the module in this frame drop the messages it sends under `subject`, as
 * when the peer is offline (edrys-Lite drops them silently then). `on = false`
 * restores sending.
 */
const dropOutgoing = (frame: Frame, subject: string, on = true) =>
  frame.evaluate(
    ([subject, on]) => {
      const w = window as any
      if (!w.__e2eSend) {
        w.__e2eSend = w.Edrys.sendMessage
        w.__e2eDrop = new Set()
        w.Edrys.sendMessage = (s: string, b: unknown, u?: string) => (w.__e2eDrop.has(s) ? undefined : w.__e2eSend(s, b, u))
      }
      if (on) w.__e2eDrop.add(subject)
      else w.__e2eDrop.delete(subject)
    },
    [subject, on] as const
  )

/** Reload only the module's iframe (as the module would be after the page was closed and opened again). */
async function reloadModule(s: Session): Promise<Frame> {
  const frame = await moduleFrame(s, MODULE)
  const navigated = s.page.waitForEvent('framenavigated', (f) => f === frame)
  await frame.evaluate(() => setTimeout(() => location.reload()))
  await navigated
  return ready(s)
}

/** Send a raw `surveyCompleted` from this frame, as a (modified) peer could. */
const sendCompleted = (frame: Frame, body: unknown) =>
  frame.evaluate((body) => (window as any).Edrys.sendMessage('surveyCompleted', body), body)

/** Station: open the results list. */
async function openResults(frame: Frame) {
  await clickTop(frame, resultsButton(frame))
  await expect(frame.locator('#resultsContainer')).toBeVisible()
}

/** Station: wait until `n` results are stored (they arrive by message); reads the total, the list is paged. */
async function expectResults(frame: Frame, n: number) {
  await expect
    .poll(
      async () => {
        await clickTop(frame, frame.locator('#resultsContainer .back-btn'))
        await openResults(frame)
        const info = frame.locator('.pagination-info')
        if ((await info.count()) === 0) return 0
        return Number((await info.textContent())?.match(/of (\d+) results/)?.[1])
      },
      { timeout: SYNC }
    )
    .toBe(n)
}

/** Station: from the results list, open the field selection and generate charts for every field. */
async function generateCharts(frame: Frame) {
  await clickTop(frame, frame.getByRole('button', { name: /Generate Charts$/ }))
  await expect(frame.getByText('Select Fields for Chart Generation')).toBeVisible()
  await frame.getByRole('button', { name: 'Generate Charts for Selected Fields' }).click()
  await expect(frame.getByText('Survey Results Charts')).toBeVisible()
}

/** Data of the Chart.js chart drawn for a question. */
const chartData = (frame: Frame, question: string) =>
  frame.evaluate((question) => {
    const canvas = document.getElementById(`chart-${question}`)
    const chart = canvas && (window as any).Chart.getChart(canvas)
    return chart
      ? {
          type: chart.config.type as string,
          labels: chart.data.labels as string[],
          data: chart.data.datasets[0].data as number[],
          colors: chart.data.datasets[0].backgroundColor,
          height: chart.height as number,
        }
      : null
  }, question)

/** A pie chart's slices as { label: count }, independent of their order. */
const pie = (chart: { labels: string[]; data: number[] } | null) =>
  chart && Object.fromEntries(chart.labels.map((label, i) => [label, chart.data[i]]))

/**
 * With several survey modules in a class: the frame of the one whose survey has
 * `title`, once Edrys is ready in it.
 */
async function surveyFrame(s: Session, title: string): Promise<Frame> {
  let found: Frame | undefined
  await expect
    .poll(
      async () => {
        for (const frame of s.page.frames().filter((f) => f.url().startsWith(moduleUrl(MODULE)))) {
          const ok = await frame
            .evaluate(
              (title) => (window as any).Edrys?.ready === true && JSON.stringify((window as any).Edrys.module.stationConfig).includes(title),
              title
            )
            .catch(() => false)
          if (ok) found = frame
        }
        return !!found
      },
      { timeout: 30_000, message: `survey "${title}" in ${s.page.url()}` }
    )
    .toBe(true)
  await closeSideMenu(s)
  return found!
}

/** A class with the survey module (given stationConfig), its station, and a student in the station's room. */
async function classWith(browser: Browser, stationConfig?: object | string) {
  return classWithModules(browser, [{ url: moduleUrl(MODULE, ENTRY), stationConfig }])
}

/** A class with these modules, its station, and a student in the station's room. */
async function classWithModules(browser: Browser, modules: ModuleEntry[]) {
  const { teacher, classUrl } = await createClass(browser, prepare)
  await setModules(teacher, modules)
  const station = await openStation(teacher, classUrl)
  const student = await joinClass(browser, classUrl, prepare)
  await enterRoom(student, await stationRoom(station))
  return { teacher, station, student }
}

// ---------------------------------------------------------------------------

test.describe('module-survey', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined

  test.beforeEach(async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser, surveyConfig()))
  })

  test.afterEach(async () => {
    // the station window shares the teacher's browser
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('both roles get the start screen; only the station can load results', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)

    for (const frame of [st, stu]) {
      // the intro card: the survey's title and size
      await expect(frame.locator('#surveyTitle')).toHaveText('Lab Feedback')
      await expect(frame.locator('#surveySize')).toHaveText('5 questions')
      await expect(startButton(frame)).toBeEnabled()
      await expect(startButton(frame)).toHaveText('Start Survey')
    }
    await expect(resultsButton(st)).toBeVisible()
    await expect(resultsButton(stu)).toBeHidden()

    // A station without results says so.
    await openResults(st)
    await expect(st.getByText('No results for this survey yet.')).toBeVisible()
  })

  test("a student's answers are stored at the station and listed there", async () => {
    const st = await ready(station!)
    const stu = await ready(student!)

    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    // back on the start screen once the station confirmed
    await expectSubmitted(stu)
    await expect(stu.locator('#startScreen')).toBeVisible()

    await openResults(st)
    await expectResults(st, 1)
    const data = JSON.parse((await st.locator('.result-item pre').textContent()) ?? '')
    expect(data).toEqual({ name: 'Ada', experience: 4, pace: 'ok' })
    await expect(st.locator('.pagination-info')).toHaveText(/Showing 1-1 of 1 results/)

    const name = await stu.evaluate(() => (window as any).Edrys.liveUser.displayName)
    await expect(st.locator('.result-item')).toContainText(`From: ${name} (student)`)

    await expectSubmitted(await reloadModule(student!))
  })

  test('answers given at the station itself are stored too, and survive a reload', async () => {
    let st = await ready(station!)
    await takeSurvey(st, { name: 'Station user', experience: 2, pace: 'slow' })
    await expectSubmitted(st)
    await openResults(st)
    await expectResults(st, 1)

    await reloadStation(station!)
    st = await ready(station!)
    await expectSubmitted(st)
    await openResults(st)
    await expect(st.locator('.result-item')).toHaveCount(1)
    await expect(st.locator('.result-item pre')).toContainText('Station user')
    await expect(st.locator('.result-item')).toContainText(`From: ${await stationRoom(station!)} (station)`)
  })

  test('an answer that does not reach the station is reported, and Retry sends it', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await dropOutgoing(stu, 'surveyCompleted')

    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    await expect(stu.getByText('Sending your answer to the station…')).toBeVisible()
    await expect(startMessage(stu)).toHaveText('The station did not receive your answer.', { timeout: SYNC })
    await expect(startButton(stu)).toBeDisabled()
    await openResults(st)
    await expectResults(st, 0)

    await dropOutgoing(stu, 'surveyCompleted', false)
    await clickTop(stu, retryButton(stu))
    await expectSubmitted(stu)
    await expect(retryButton(stu)).toBeHidden()
    await expect(startMessage(stu)).toBeHidden()
    await expectResults(st, 1)
  })

  test('an answer whose confirmation got lost is stored once when it is sent again', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await dropOutgoing(st, 'surveyStored')

    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    await expect(startMessage(stu)).toHaveText('The station did not receive your answer.', { timeout: SYNC })
    await openResults(st)
    await expectResults(st, 1)

    await dropOutgoing(st, 'surveyStored', false)
    await clickTop(stu, retryButton(stu))
    await expectSubmitted(stu)
    await expectResults(st, 1)
  })

  test('an unconfirmed answer is sent again when the module loads again', async () => {
    const st = await ready(station!)
    let stu = await ready(student!)
    await dropOutgoing(stu, 'surveyCompleted')
    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    await expect(stu.getByText('Sending your answer to the station…')).toBeVisible()

    // the reload also ends the dropping: the module resends on its own
    stu = await reloadModule(student!)
    await expectSubmitted(stu)
    await openResults(st)
    await expectResults(st, 1)
  })

  test('the station charts each field from the answers', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await sendCompleted(stu, { data: { experience: 2, pace: 'slow' } })
    await sendCompleted(stu, { data: { experience: 5, pace: 'ok' } })
    await sendCompleted(stu, { data: { experience: 5, pace: 'ok' } })

    await openResults(st)
    await expectResults(st, 3)
    await expect(st.locator('.pagination-info')).toHaveText(/of 3 results/)
    await generateCharts(st)
    await expect(st.getByText('Generated from 3 responses • 2 fields selected')).toBeVisible()

    // charts are titled with the questions' titles
    await expect(st.locator('#chartsContainer h3')).toHaveText(['Rate your experience', 'Pace'], { useInnerText: true })
    // single choice: a pie chart with one slice per answer (results are newest first)
    await expect.poll(async () => pie(await chartData(st, 'pace'))).toEqual({ ok: 2, slow: 1 })
    expect((await chartData(st, 'pace'))!.type).toBe('pie')
    // rating: a bar per value of the scale, unused values included
    await expect
      .poll(async () => (await chartData(st, 'experience'))?.labels)
      .toEqual(['1', '2', '3', '4', '5'])
    expect((await chartData(st, 'experience'))!.data).toEqual([0, 1, 0, 0, 2])
    // the chart actually takes space on the page
    expect((await chartData(st, 'experience'))!.height).toBeGreaterThan(100)
  })

  test('free text is not charted, choices with several answers get a bar each, every slice has its own colour', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await sendCompleted(stu, { data: { name: 'Ada', topics: ['loops', 'io'], age: 21 } })
    await sendCompleted(stu, { data: { name: 'Bob', topics: ['loops'], age: 34 } })
    // `colour` is not in the survey (e.g. from an older version): charted by its values
    const colours = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'black', 'white', 'grey', 'brown']
    for (const colour of colours) await sendCompleted(stu, { data: { colour } })
    await openResults(st)
    await expectResults(st, 12)

    await clickTop(st, st.getByRole('button', { name: /Generate Charts$/ }))
    await expect(st.getByRole('checkbox', { name: 'Topics you liked' })).toBeVisible()
    await expect(st.getByRole('checkbox', { name: 'Age' })).toBeVisible()
    await expect(st.getByRole('checkbox', { name: 'Colour' })).toBeVisible()
    // one slice per person would say nothing
    await expect(st.getByRole('checkbox', { name: 'Your name' })).toHaveCount(0)
    await st.getByRole('button', { name: 'Generate Charts for Selected Fields' }).click()
    await expect(st.getByText('3 fields selected')).toBeVisible()

    await expect.poll(async () => (await chartData(st, 'topics'))?.type).toBe('bar')
    expect((await chartData(st, 'topics'))!.labels).toEqual(['loops', 'io'])
    expect((await chartData(st, 'topics'))!.data).toEqual([2, 1])
    // numbers: a histogram that counts every answer once
    expect((await chartData(st, 'age'))!.data.reduce((a, b) => a + b, 0)).toBe(2)

    const colourChart = (await chartData(st, 'colour'))!
    expect(colourChart.labels).toHaveLength(10)
    expect(new Set(colourChart.colors as string[]).size).toBe(10)
  })

  test('only the selected fields are charted', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await sendCompleted(stu, { data: { experience: 3, pace: 'fast' } })
    await openResults(st)
    await expectResults(st, 1)

    await clickTop(st, st.getByRole('button', { name: /Generate Charts$/ }))
    await clickTop(st, st.getByRole('button', { name: 'Select None' }))
    await st.getByRole('button', { name: 'Generate Charts for Selected Fields' }).click()
    // nothing selected: the module says so and stays on the selection
    await expect(st.getByRole('alert')).toHaveText('Select at least one field to generate charts.')
    await expect(st.getByText('Select Fields for Chart Generation')).toBeVisible()

    await st.getByRole('checkbox', { name: 'Pace' }).check()
    await st.getByRole('button', { name: 'Generate Charts for Selected Fields' }).click()
    await expect(st.getByText('1 fields selected')).toBeVisible()
    await expect.poll(async () => pie(await chartData(st, 'pace'))).toEqual({ fast: 1 })
    expect(await chartData(st, 'experience')).toBeNull()
  })

  test('answers with HTML are shown as text at the station, not run', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    const payload = '<img src=x onerror=window.__e2eXss=1>'

    await takeSurvey(stu, { name: payload, experience: 3, pace: 'ok' })
    await openResults(st)
    await expectResults(st, 1)

    await expect(st.locator('.result-item pre')).toContainText(payload)

    // answer keys are peer-controlled too: they become field labels and chart headings
    await sendCompleted(stu, { data: { [payload]: 'yes' } })
    await expectResults(st, 2)
    await generateCharts(st)
    // (the heading title-cases the key, so match its start)
    await expect(st.locator('#chartsContainer h3', { hasText: '<img src=x onerror=' })).toBeVisible()
    await expect(st.locator('img')).toHaveCount(0)
    expect(await st.evaluate(() => (window as any).__e2eXss)).toBeUndefined()
  })

  test('a histogram counts the answers when everyone gave the same number', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await sendCompleted(stu, { data: { age: 20 } })
    await sendCompleted(stu, { data: { age: 20 } })
    await openResults(st)
    await expectResults(st, 2)
    await generateCharts(st)

    await expect.poll(async () => (await chartData(st, 'age'))?.labels, { timeout: 5_000 }).toEqual(['20'])
    expect((await chartData(st, 'age'))!.data).toEqual([2])
  })

  test('a malformed message is ignored and the station still charts the valid answers', async () => {
    const st = await ready(station!)
    const stu = await ready(student!)
    await sendCompleted(stu, { note: 'no data field' })
    await sendCompleted(stu, null)
    await sendCompleted(stu, { data: ['not', 'answers'] })
    await sendCompleted(stu, { data: { pace: 'ok' } })
    await openResults(st)
    // messages arrive in order, so once the valid one is stored the others were dropped
    await expectResults(st, 1)

    await clickTop(st, st.getByRole('button', { name: /Generate Charts$/ }))
    await expect(st.getByText('Select Fields for Chart Generation')).toBeVisible({ timeout: 5_000 })
  })
})

test.describe('module-survey configuration', () => {
  let teacher: Session | undefined
  let station: Session | undefined
  let student: Session | undefined

  test.afterEach(async () => {
    await closeSessions(teacher, student)
    teacher = station = student = undefined
  })

  test('without a survey, the start button says that the configuration is missing', async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser))
    for (const s of [station!, student!]) {
      const frame = await ready(s)
      await expect(startButton(frame)).toHaveText('No Survey Configuration')
      await expect(startButton(frame)).toBeDisabled()
      await expect(startMessage(frame)).toHaveText('Add a SurveyJS JSON as "survey" in the module\'s station settings.')
    }
  })

  test('a survey that is not valid JSON is reported as a configuration error', async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser, { survey: '{ "title": "broken", ' }))
    for (const s of [station!, student!]) {
      const frame = await ready(s)
      await expect(startButton(frame)).toHaveText('Survey Configuration Error')
      await expect(startButton(frame)).toBeDisabled()
      await expect(startMessage(frame)).toContainText('The "survey" station setting is not valid JSON:')
    }
  })

  test('two surveys in one class keep their answers and results apart', async ({ browser, browserName }) => {
    // Playwright's WebKit runs no requestAnimationFrame in the station's lower module frame (it
    // starts below the fold; scrolling it into view or a taller viewport doesn't help), so every
    // click there waits forever for the target to be "stable". The module itself works there.
    test.skip(browserName === 'webkit', 'WebKit runs no animation frames in the lower module iframe')
    ;({ teacher, station, student } = await classWithModules(browser, [
      { url: moduleUrl(MODULE, ENTRY), stationConfig: surveyConfig() },
      { url: moduleUrl(MODULE, ENTRY), stationConfig: surveyConfig(EXIT_TICKET) },
    ]))
    const stuFeedback = await surveyFrame(student!, 'Lab Feedback')
    const stuTicket = await surveyFrame(student!, 'Exit Ticket')

    await clickTop(stuTicket, startButton(stuTicket))
    await stuTicket.getByText('yes', { exact: true }).click()
    await stuTicket.getByRole('button', { name: 'Complete' }).click()
    await expectSubmitted(stuTicket)
    // the other survey can still be answered
    await expect(startButton(stuFeedback)).toHaveText('Start Survey')
    await expect(startButton(stuFeedback)).toBeEnabled()

    const stTicket = await surveyFrame(station!, 'Exit Ticket')
    await openResults(stTicket)
    await expectResults(stTicket, 1)
    await expect(stTicket.locator('.result-item pre')).toContainText('"clear": "yes"')

    const stFeedback = await surveyFrame(station!, 'Lab Feedback')
    await openResults(stFeedback)
    await expect(stFeedback.getByText('No results for this survey yet.')).toBeVisible()
  })

  test('after the survey is edited, its results start empty and everyone can answer again', async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser, surveyConfig()))
    await ready(station!)
    const stu = await ready(student!)
    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    await expectSubmitted(stu)

    // the teacher edits the survey: edrys-Lite reloads the module everywhere
    await setModules(teacher!, [{ url: moduleUrl(MODULE, ENTRY), stationConfig: surveyConfig(EXIT_TICKET) }])
    const stuNew = await surveyFrame(student!, 'Exit Ticket')
    await expect(startButton(stuNew)).toHaveText('Start Survey')
    await expect(startButton(stuNew)).toBeEnabled()

    const st = await surveyFrame(station!, 'Exit Ticket')
    await openResults(st)
    // the earlier answer belongs to the old survey
    await expect(st.getByText('No results for this survey yet.')).toBeVisible()
  })

  test('with allowRetake, a user can take the survey again and every answer is stored', async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser, { ...surveyConfig(), allowRetake: true }))
    const st = await ready(station!)
    const stu = await ready(student!)

    await takeSurvey(stu, { name: 'Ada', experience: 4, pace: 'ok' })
    await expect(startMessage(stu)).toHaveText('Submitted ✓', { timeout: SYNC })
    await expect(startButton(stu)).toHaveText('Start Survey')
    await expect(startButton(stu)).toBeEnabled()

    // a fresh, empty survey
    await clickTop(stu, startButton(stu))
    await expect(stu.locator('#surveyContainer').getByRole('textbox')).toHaveValue('')
    await stu.locator('#surveyContainer').getByRole('textbox').fill('Bob')
    await stu.locator('#surveyContainer').getByRole('button', { name: 'Complete' }).click()
    await expect(startMessage(stu)).toHaveText('Submitted ✓', { timeout: SYNC })

    await openResults(st)
    await expectResults(st, 2)
    await expect(st.locator('.result-item pre').first()).toContainText('Bob')
  })

  test('a survey given as an object (YAML in the config editor) is accepted', async ({ browser }) => {
    ;({ teacher, station, student } = await classWith(browser, { survey: SURVEY }))
    const stu = await ready(student!)
    await expect(startButton(stu)).toHaveText('Start Survey', { timeout: 5_000 })
    await takeSurvey(stu, { name: 'Ada', experience: 5, pace: 'fast' })
  })
})
