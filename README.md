# Edrys module tests

End-to-end tests for Edrys modules. Every test runs the module inside a real edrys-Lite, with real peers
(teacher, station, students) in separate browsers, the same way a class uses it:

- the **teacher** creates a class, adds the module and opens the `/station` window;
- a **student** opens the `/classroom` link and enters the station room.

Modules are served from your local checkout, so the tests cover changes before they are published. Hardware the
modules talk to (serial ports, …) is faked inside the module's iframe, so no device is needed.

## Setup

You need Node 24 and an edrys-Lite checkout.

1. Start the edrys-Lite dev server on `http://localhost:6999`:

   ```bash
   cd edrys-Lite
   npm run watch
   ```

2. Install the test dependencies and the browser:

   ```bash
   cd edrys-module-tests
   npm install
   npx playwright install chromium
   ```

The tests expect the modules next to this folder (`Edrys_Modules/module-serial`, …). Set `EDRYS_MODULES` if they
live somewhere else.

## Running

```bash
npm test                                         # all modules
npx playwright test modules/module-serial        # one module
npx playwright test -g "late"                    # tests whose name matches
npm run test:headed                              # watch the browsers
npm run report                                   # HTML report of the last run
```

Tests run one at a time: the peers of parallel tests would share the signaling server.

| Variable        | Default                 | Meaning                                    |
| --------------- | ----------------------- | ------------------------------------------ |
| `E2E_BASE_URL`  | `http://localhost:6999` | the edrys-Lite to test against             |
| `EDRYS_MODULES` | the parent folder       | where the module checkouts are             |

A failed test keeps screenshots of every open page and a trace in `test-results/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

## Layout

```
lib/
  edrys.ts         drives edrys-Lite: create a class, open the station, join, enter a room, set modules
  modules.ts       serves local modules, finds a module's iframe
  fake-serial.ts   a fake Web Serial device for module iframes
modules/
  <module-name>/   the tests of one module
```

## How it works

- **Serving modules.** Requests to `http://e2e-module.test/<module-name>/…` are answered from
  `$EDRYS_MODULES/<module-name>/…`, so the module runs cross-origin from the app, as in production. The module's
  published `edrys.js` is swapped for the one of the edrys-Lite under test, so module and host use the same API
  version.
- **Adding a module.** `setModules()` saves the class configuration through the same call the Settings dialog
  uses, with any `config` / `studentConfig` / `teacherConfig` / `stationConfig`.
- **The station.** It opens as a second page in the teacher's browser, because a station has to share the
  teacher's identity. The "Station Mode Active" popup is clicked away, as a user would.
- **Fake hardware.** `installFakeSerial()` replaces `navigator.serial` in module iframes with one fake device.
  Tests drive it from outside:

  ```ts
  await serial(frame).emit('hello\n')    // the device prints
  await serial(frame).written()          // what the module wrote to it
  await serial(frame).fail()             // recoverable read error (e.g. wrong baud)
  await serial(frame).unplug()           // device lost
  await serial(frame).cancelNextRequest() // the user cancels the port picker
  ```

`lib/edrys.ts` reaches into the app's Vue tree in a few places (finding the `Peer`, saving the class). It was
adapted from edrys-Lite's own e2e helpers (`tests/e2e-tests/`); if edrys-Lite changes how the app is mounted or
how Settings saves a class, update it there.

## Adding tests for a module

1. Create `modules/<module-name>/<name>.spec.ts`.
2. In `beforeEach`, set up the class the way the module is used. A station module looks like this:

   ```ts
   const prepare = async (context) => {
     await serveModules(context)
     await installFakeSerial(context) // only if the module needs it
   }

   const { teacher, classUrl } = await createClass(browser, prepare)
   await setModules(teacher, [{ url: moduleUrl('module-x'), stationConfig: { … } }])
   const station = await openStation(teacher, classUrl)
   const student = await joinClass(browser, classUrl, prepare)
   await enterRoom(student, await stationRoom(station))
   ```

   For a module shown in the lobby, skip the station and the room.
3. Get the module's iframe with `moduleFrame(session, 'module-x')`, and wait for something the module renders
   after `Edrys.onReady` before you interact with it. Modules with `<meta name="fetch" content="true">` or a YAML
   entry point run from a `data:` URL; pass text from their HTML as the 4th argument
   (`moduleFrame(session, 'module-x', 30_000, 'some unique string')`) to find them.
   The class's side menu (rooms and users) is a drawer that overlays the left part of the modules; call
   `closeSideMenu(session)` before clicking there or taking screenshots.
4. Close the browsers in `afterEach` with `closeSessions(teacher, student)`. The station shares the teacher's
   browser.

`modules/module-serial/serial.spec.ts` is a complete example.

What to test, per module:

- what each role sees before anything happens (empty and waiting states);
- the main flow across peers: an action on one peer shows up on the others;
- a peer that joins late sees the current state;
- the module's configuration is applied;
- the errors users hit (cancelled dialogs, broken connections) are shown, and the module recovers.

Assert on what users see: text, badges, terminal content. Use `expect.poll` or `expect(locator)` for anything
that crosses peers, never fixed sleeps.

If the test needs to read state that the page does not show as text (e.g. a canvas-rendered terminal), the module
may expose it on `window`, with a comment saying the tests rely on it. module-serial exposes `window.term` for
this.
