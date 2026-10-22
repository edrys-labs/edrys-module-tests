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

2. Install the test dependencies and the browsers:

   ```bash
   cd edrys-module-tests
   npm install
   npx playwright install chromium        # add firefox webkit for the other projects
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
npx playwright test --project=firefox            # one browser (chromium, firefox, webkit)
npm run typecheck                                # type-check lib/ and modules/ (Playwright itself does not)
```

Tests run one at a time: the peers of parallel tests would share the signaling server. Without `--project`,
every test runs in Chromium, Firefox and WebKit; where a browser cannot run a test, the test skips itself with
the reason.

| Variable           | Default                                         | Meaning                                                 |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `E2E_BASE_URL`     | `http://localhost:6999`                         | the edrys-Lite to test against                          |
| `EDRYS_MODULES`    | the parent folder                               | where the module checkouts are                          |
| `STREAM_RELAY_DIR` | `../websocket-server` (next to `Edrys_Modules`) | the websocket-server checkout for the real relay tests  |
| `PYXTERM_PYTHON`   | the checkout's venv, else `python3`             | Python for the real pyxtermjs server                    |
| `LIASCRIPT_BUILD`  | unset (the hosted player)                       | a local LiaScript build (`dist` folder) for module-liascript |

A failed test keeps screenshots of every open page and a trace in `test-results/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

## Layout

```
lib/
  edrys.ts         drives edrys-Lite: create a class, open (and reload) the station, join, enter a room, set modules
  modules.ts       serves local modules, finds a module's iframe
  fake-*.ts        fakes of the hardware and servers modules talk to (serial, cameras, compile server, …)
  *-server(s).ts   start the real servers, for the few tests that check them
  local-webrtc.ts  keeps WebRTC between the test browsers on this machine
  xterm.ts         reads the text of a module's xterm.js terminal
modules/
  <module-name>/   the tests of one module
  edrys-api/       tests of the module API (edrys.js) itself, with fixture modules defined in the spec
```

Each file in `lib/` starts with a comment that shows how to use it.

## How it works

- **Serving modules.** Requests to `http://e2e-module.test/<module-name>/…` are answered from
  `$EDRYS_MODULES/<module-name>/…`, so the module runs cross-origin from the app, as in production. The module's
  published `edrys.js` is swapped for the one of the edrys-Lite under test, so module and host use the same API
  version.
- **The station** opens as a second page in the teacher's browser, because a station has to share the teacher's
  identity.
- **Fakes first.** Devices and servers are faked, so tests need no hardware or network and can trigger failures
  (unplugged device, server down). A few `real-server.spec.ts` files run the same module against the real server
  to catch drift in the fakes; they skip themselves when that server's checkout or dependencies are missing.
- **edrys-Lite internals.** `lib/edrys.ts` reaches into the app's Vue tree in a few places (finding the `Peer`,
  saving the class). It was adapted from edrys-Lite's own e2e helpers (`tests/e2e-tests/`); if edrys-Lite changes
  how the app is mounted or how Settings saves a class, update it there.

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
   after `Edrys.onReady` before you interact with it. Before clicking, call `closeSideMenu(session)` if the
   target is on the left, and `revealModuleTop(frame)` if it is in the module's top row: the side menu and the
   app bar overlay the module.
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
