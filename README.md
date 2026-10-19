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

Tests run one at a time: the peers of parallel tests would share the signaling server.

Without `--project`, every test runs in Chromium, Firefox and WebKit. Where a browser cannot run a test, the test
skips itself with the reason. For example, Playwright's WebKit on Linux sends no frames of a canvas-captured
track over WebRTC, so the module-streaming tests that need a picture from a WebKit station are skipped.

| Variable        | Default                 | Meaning                                    |
| --------------- | ----------------------- | ------------------------------------------ |
| `E2E_BASE_URL`  | `http://localhost:6999` | the edrys-Lite to test against             |
| `EDRYS_MODULES` | the parent folder       | where the module checkouts are             |
| `STREAM_RELAY_DIR` | `../websocket-server` (next to `Edrys_Modules`) | the websocket-server checkout for the real relay tests |
| `PYXTERM_PYTHON` | the checkout's venv, else `python3` | Python for the real pyxtermjs server |

A failed test keeps screenshots of every open page and a trace in `test-results/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

## Layout

```
lib/
  edrys.ts         drives edrys-Lite: create a class, open (and reload) the station, join, enter a room, set modules
  modules.ts       serves local modules, finds a module's iframe, scrolls its top row clear of the app bar
  fake-serial.ts   a fake Web Serial device for module iframes
  fake-hexi.ts     a fake of Wokwi's Arduino compile server (hexi.wokwi.com)
  fake-pyxterm.ts  a fake pyxtermjs terminal server (Socket.IO)
  fake-webrepl.ts  a fake MicroPython board with WebREPL (WebSocket, password, REPL, file put/get)
  pyxterm-server.ts starts the real pyxtermjs server from the local checkout; also exports freePort()
  xterm.ts         reads the text of a module's xterm.js terminal (window.term)
  fake-media.ts    fake cameras and a microphone for module iframes (getUserMedia, enumerateDevices)
  fake-peerjs.ts   a fake PeerJS cloud signaling server (Edrys.sendStream / onStream, method webrtc)
  fake-ws-relay.ts a fake of websocket-server's /stream relay (method websocket)
  local-webrtc.ts  keeps WebRTC between the test browsers on this machine (no STUN/TURN, no mDNS in Chromium)
  stream-servers.ts starts the real PeerJS server (`peer` package) and the real /stream relay
  fake-lights.ts   a fake station-lights server (localhost:3000) for station-lights-module
  lights-server.ts starts the real station-lights server and a fake Elgato light behind it
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
  teacher's identity. The "Station Mode Active" popup is clicked away, as a user would. `reloadStation(station)`
  reloads the station window like F5 and clicks the popup away again (e.g. to check that data kept in the
  station's browser survives a reload).
- **Fake hardware.** `installFakeSerial()` replaces `navigator.serial` in module iframes with one fake device.
  Tests drive it from outside:

  ```ts
  await serial(frame).emit('hello\n')    // the device prints
  await serial(frame).written()          // what the module wrote to it
  await serial(frame).fail()             // recoverable read error (e.g. wrong baud)
  await serial(frame).unplug()           // device lost
  await serial(frame).cancelNextRequest() // the user cancels the port picker
  ```

- **Fake compile server.** `installFakeHexi(context)` answers `https://hexi.wokwi.com/**` (used by module-avr8js
  to compile sketches) from recorded responses, so no network is needed. Record a real response once with curl,
  keep it as a fixture, and register it for a marker comment in the sketch:

  ```ts
  const hexi = await installFakeHexi(context)
  hexi.respond('// e2e:blink', blinkResponse)  // { stdout, stderr, hex } for sketches containing the marker
  hexi.offline()                              // requests fail like a network error
  hexi.delay(1500)                            // answers arrive later (overlapping compiles)
  hexi.requests                               // the sketches the module sent
  hexi.files                                  // the extra files sent with each sketch (libraries.txt, ...)
  ```

- **Fake terminal server.** `installFakePyxterm(context, { up })` replaces the Socket.IO client that
  module-pyxtermjs loads from cdnjs with a fake `io` whose sockets talk to an in-page pyxtermjs server. No Python
  server is needed. Drive it in the frame that holds the socket (the station):

  ```ts
  await pty(frame).output('hello\r\n')  // the shell prints
  await pty(frame).inputs()             // every pty-input the server got, in order
  await pty(frame).resizes()            // every resize the server got
  await pty(frame).stop()               // server goes away; pty(frame).start() brings it back
  await pty(frame).connects()           // sockets the module opened (e.g. after a reload)
  ```

- **Fake MicroPython board.** `new FakeWebRepl()` is a board with WebREPL enabled; `board.install(context)`
  answers WebSockets to `ws://webrepl.test…` with it through Playwright's `routeWebSocket`, so neither a board nor
  `proxy.py` is needed. Use `board.url` as the module's `websocket` station config. The board lives in the test
  process and asks for `board.password` first, like a real one; drive it directly:

  ```ts
  board.print('hello\r\n')         // the board prints on every open connection
  board.lines                      // REPL lines it received after login, in order
  board.files                      // its file system (Map name -> Buffer); put/get transfers use it
  board.executed                   // every exec(open('<file>').read()): file and content at that moment
  board.putAckDelay = 3000         // a put is stored and confirmed later (slow board, large file)
  board.disconnect()               // the board drops every connection
  board.down = true                // the board is off: new connections are closed right away
  board.interrupts                 // Ctrl-C received (it also drops the line being typed)
  board.replies.set('1+1', '2')    // what the board prints for a REPL line, before the next prompt
  board.open, board.connections    // connections open now / opened so far
  ```

- **Fake cameras.** `installFakeMedia(context, { cameras: ['red', 'blue'] })` gives module iframes cameras that
  show one solid colour each (labels "Fake camera 1", "Fake camera 2", …) and a microphone (an oscillator). It
  replaces `getUserMedia` and `enumerateDevices`, and provides `navigator.mediaDevices` itself, because the
  test module origin is not a secure context. `{ blocked: 'NotAllowedError' }` makes every call fail. Drive it
  per frame, and tell which camera a `<video>` shows by its colour:

  ```ts
  await media(frame).calls()                   // constraints of every getUserMedia call
  await media(frame).liveTracks('video')       // tracks handed out and not stopped yet
  await media(frame).denyNext('NotReadableError') // the next call fails (camera in use)
  await media(frame).unplug()                  // the camera is lost: live video tracks end
  nearestColor(await videoColor(frame))        // 'red', 'blue', … or null (no picture)
  ```

  Chromium does not render an off-screen cross-origin iframe, so a fake camera in it sends black frames. Scroll
  the frame into view before reading its colour (module-streaming's `expectCamera` does this), but only when it
  is fully off-screen. A visible frame scrolled to the top slides under edrys-Lite's fixed app bar, and clicks
  on the module's top row then hit the app bar.
- **Fake stream servers.** For `Edrys.sendStream` / `Edrys.onStream`:
  - `FakePeerServer` answers the PeerJS cloud (`0.peerjs.com`) for the `webrtc` method. Media still flows
    between the browsers over real WebRTC. Create one per test and call `install(context)` in every context:

    ```ts
    peerjs.ids()                   // peers connected right now (stream_<hash> is a station's stream)
    peerjs.dropMediaAnswers = true // media calls never connect, as when ICE fails
    peerjs.close()                 // in afterEach
    ```

  - `FakeStreamRelay` stands in for websocket-server's `/stream` relay for the `websocket` method. Set the
    module's `websocketUrl` to `relay.url`. `relay.rooms()` reports per room whether a source is registered,
    how many viewers there are, and how many chunks were relayed.
- **Local WebRTC.** `installLocalWebRTC(context)` removes the STUN/TURN servers in module iframes, and
  `test.use({ launchOptions: localWebRTCLaunchOptions })` turns off Chromium's mDNS host candidates. Without them,
  some media connections between the test browsers never got past ICE checking.
- **Real stream servers.** `modules/module-streaming/real-server.spec.ts` checks the module against the real
  servers, to catch protocol drift in the fakes:

  ```ts
  const peer = await startPeerServer()   // in this process, free port; stationConfig.peerServerConfig = peer.config
  const relay = await startStreamRelay() // websocket-server checkout; stationConfig.websocketUrl = relay.url
  ```

  The relay is `$STREAM_RELAY_DIR`, else `websocket-server` next to the `Edrys_Modules` folder. Its tests skip
  themselves when the checkout or its `node_modules` is missing.
- **The real terminal server.** Most servers are faked; `startPyxtermServer()` runs the actual
  pyxtermjs server from `$EDRYS_MODULES/module-pyxtermjs` on a free port, with a plain `bash --norc` behind it. It
  is for the few tests that check the server itself and the real Socket.IO client against it
  (`modules/module-pyxtermjs/real-server.spec.ts`). Python is `$PYXTERM_PYTHON`, else the checkout's
  `venv/bin/python`, else `python3`. The spec skips itself when that Python lacks the server's requirements
  (`pip install -r requirements.txt` in the module).

  ```ts
  const server = await startPyxtermServer()
  server.url      // http://127.0.0.1:<port>/pty, the module's `server` config
  server.log()    // what the server printed (attach it on failure)
  await server.stop()
  ```

- **Fake light server.** station-lights-module posts to a helper server on the station's machine
  (`http://localhost:3000`). `new FakeLightServer()` answers it in the browser; `lights.install(context)` in every
  context that should reach it. Each request remembers the page (tab) whose frame sent it, because the station
  shares the teacher's context:

  ```ts
  lights.lights(station.page)      // bodies of POST /api/light from the station
  lights.heartbeats(station.page)  // bodies of POST /api/heartbeat
  lights.from(student.page)        // every request a page's module frames made
  lights.down = true               // requests fail like a refused connection
  lights.status = 500              // the server answers with an error
  ```

- **The real light server.** `modules/station-lights-module/real-server.spec.ts` runs the module's own
  `station-lights-server` (its heartbeat timeouts are not in the fake). `startFakeElgato()` listens on
  127.0.0.1:9123 (use `127.0.0.1` as `lightIp`; `elgato.on`, `elgato.puts`), `startLightsServer()` starts
  `server.js` (allowing CORS from the test module origin) and `server.route(context)` forwards the module's requests
  to it through Playwright; `server.requests` lists the forwarded paths. Both ports are fixed in `server.js`; the
  spec skips itself when they are taken or the server's `node_modules` is missing.
- **Reading xterm terminals.** xterm.js does not keep its text in the DOM in a readable order. Modules expose
  their terminal as `window.term` (module-pyxtermjs, module-serial), and `terminalText(frame)` and
  `terminalSize(frame)` read its buffer.

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
   edrys-Lite's app bar is fixed: once a click further down a frame has scrolled the page, the frame's top row
   (header controls, back buttons) can sit under the bar, and a click there lands on the bar's home link. Call
   `revealModuleTop(frame)` before clicking a module's top row; it also helps with the lower of two modules.
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
