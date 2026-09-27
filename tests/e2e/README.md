# CatDesktop end-to-end tests

`bridge-smoke.mjs` drives the **real desktop host**: `CatDesktop.exe` with both WebView2 windows, the SQLite
database and the production Angular UI. It checks the behaviour promised by
[`docs/DESKTOP-CONTRACT.md`](../../docs/DESKTOP-CONTRACT.md). The script is plain Node 22 ESM with no npm
dependencies (it uses the global `fetch` and `WebSocket`) and runs on Windows only.

## Quick start

```powershell
# 1. Build a Debug host that contains the production UI (wwwroot next to the exe).
cd cat-desktop; npx ng build; cd ..
dotnet build Desktop/CatDesktop.Host/CatDesktop.Host.csproj -c Debug

# 2. Run the suite (about 1.5 minutes).
node tests/e2e/bridge-smoke.mjs
```

If `bin/Debug` is locked because you are running the app from it, build into another folder and point the suite at it:

```powershell
dotnet build Desktop/CatDesktop.Host/CatDesktop.Host.csproj -c Debug -o $env:TEMP\catdesktop-e2e-build
node tests/e2e/bridge-smoke.mjs --exe $env:TEMP\catdesktop-e2e-build\CatDesktop.exe
```

| option | default | meaning |
|---|---|---|
| `--exe <path>` | `Desktop/CatDesktop.Host/bin/Debug/net9.0-windows/CatDesktop.exe` | the host to test. It must be a **Debug** build with `wwwroot/index.html` next to it. |
| `--port <n>` | `9333` | Chrome DevTools Protocol port, bound to 127.0.0.1 |
| `--keep-data` | off | keep the temp data folder (database, logs, WebView2 profile) for inspection |
| `--long` | off | also run a real 1-minute focus phase and wait for `focus.completed`, and wait for the automatic resume of suspended hotkeys (adds about 2 minutes 10 s) |

The script prints `PASS`/`FAIL` for each check and a summary at the end. The **exit code is the number of failed
checks**, so `0` means green.

## How it works

1. It creates a fresh temp data folder and starts the exe with `--verbose` and two environment variables.
   `CATDESKTOP_DATA_DIR=<temp>` isolates the database, logs and WebView2 profile, and gives the instance its own
   single-instance mutex, so it runs beside a copy you may already have open. `CATDESKTOP_CDP_PORT=<port>` turns on the
   DevTools Protocol, which is compiled into Debug builds only.
2. It polls `http://127.0.0.1:<port>/json/list` until the main page (`#/…`) and the cat page (`#/cat`) exist.
   It then opens one CDP WebSocket per page and enables `Runtime`, `Log` and `Network`, recording console errors,
   uncaught exceptions and failed requests.
3. It installs a small helper in each page. `__e2e.invoke(command, payload)` posts the contract envelope through
   `window.chrome.webview.postMessage(JSON.stringify(…))` and resolves on the matching response. `__e2e.events` records
   every host event, which lets the suite check which window an event reached.
4. It runs the sections below, then calls `app.exit`, restarts on the same data folder, compares the restored state and
   exits again.

| # | section | highlights |
|---|---|---|
| 1 | app & validation | `app.getInfo` per window, `window.__catdesktop`, `unsupported` for unknown commands and kinds, about 30 `validation`/`denied` cases with no side effects |
| 9 | hotkeys (runs second) | defaults registered (or reported unavailable when another CatDesktop owns them), `denied` for a taken shortcut with atomic rollback, invalid gestures, set/clear; `hotkeys.suspend`: validation, a probe process can register the gestures while suspended and cannot after the resume, `hotkeys.get` unchanged, a suspended `hotkeys.set` stays atomic and released, a gesture taken meanwhile is dropped on resume (with `--long`: the automatic resume after 60 s) |
| 2 | notes | CRUD, partial update, colours, search (case-insensitive, literal `%`/`_`), ordering, `not_found`, size limits, unicode/180 KB round-trip, 80 concurrent creates and deletes from both windows, `notes.changed` in the other window |
| 3 | tasks | CRUD, `dueAt` normalised to UTC ISO (offsets, date-only), toggle and `completedAt`, list ordering, `sortOrder` bounds (±1,000,000 accepted, ±1,000,001 → `validation`, create after the maximum is clamped), `clearCompleted`, `tasks.changed` |
| 4 | settings | set/get/getAll/remove for every JSON type, `settings.changed`, `app.theme` → `app.themeChanged`, and the UI's `data-theme` follows |
| 5 | actions | the 8 defaults per contract, reset = migration seed, save (reorder, disable, custom payload), validation (including `id: null` / `actionType: null`), `actions.changed` |
| 6 | focus | defaults, saveSettings, start/pause/resume/skip/stop/reset, `focus.tick` about once a second in both windows, stats (with `--long`: `focus.completed`) |
| 7 | cat | defaults (sound off) and shapes; screen/monitor info and room; visibility and events; moveTo/moveBy with DPI scaling and full clamping into a work area; smooth walks (distance, duration, acceleration, cruise speed, facing, blocked/clamped at edges, replaced, stopped, validation); menu/panel layouts from all four quadrants (anchor, size, cat box kept in place, inside the work area, walk/drag denied); hit region and click-through checked with Windows hit testing (no input); settings (scale 10–200 % resizes at once keeping the bottom-centre point, 16×12 minimum, rapid changes, 2 decimals; theme round-trip and live repaint of the desktop cat; opacity; normalisation; legacy size presets; enable/disable); commands to the cat window only; drag bookkeeping |
| 8 | navigation & window | cat → `navigation.navigate` → main `location.hash`; `window.stateChanged` to the concerned window only |
| 10 | data | `data.getInfo` counts, schema version and file |
| 11 | security | no usable host objects, `window.open` creates nothing, `file://` and `about:blank` navigations blocked, junk messages ignored, the init script's `<html>` classes and drag & drop guard |
| 12 | UI (DOM only) | every route renders; bridge-created records appear; a note and a task created by filling inputs and dispatching DOM events; the cat page is transparent and the sprite fills the cat box; the context menu (open-menu) shows Pause/Resume Walking, Move Cat, Change Theme, Change Size, Always on Top, Cat Settings and Hide Cat and closes on Esc; the companion panel (open-panel) lists the enabled quick actions and its Settings action navigates the main window |
| 12b | page reloads | `Page.reload` of the cat page, then at once `cat.sendCommand { action: 'tasks' }` from the main window: the NEW cat document opens the Tasks panel; `Page.reload` of the main page, then at once `navigation.navigate '/focus'` from the cat: the new main document lands on `#/focus` (events queue from the moment a navigation starts) |
| 13 | lifecycle & persistence | a second launch hands over and exits 0; `app.exit` exits 0 within 10 s; after a restart, notes, tasks, settings, actions, cat settings and position, focus settings and stats, and main window bounds are restored; a saved shortcut that is taken costs only that shortcut; a legacy `petbook.settings` value is converted into `cat.settings` on the next start |
| 14 | diagnostics | no console errors, exceptions or failed requests in either page, and no WARN/ERROR lines in the host log except the expected ones |

## Ground rules (it runs next to a real user session)

* **No OS input.** The suite never uses `SendInput`, `SetCursorPos` or `SendKeys`. UI checks set input values and dispatch
  DOM events through CDP. The cat's drag follow loop reads the real cursor, so only its bookkeeping is tested (dragStart, then dragEnd at once).
* **No browser pop-ups.** No http(s) URL is ever navigated to or passed to `app.openExternal`. The external-link checks
  use `file:` and `javascript:` URLs, which the host refuses before opening anything.
* **Only its own processes and files.** It kills only the PIDs it spawned (the test instance tree and the hotkey-holder
  helper) and deletes only its own temp folder.
* **Your autostart entry stays as it is.** An instance with `CATDESKTOP_DATA_DIR` skips the start-up reconciliation of
  the per-user Run value, and the suite never sets `app.startWithWindows` (doing so would point your real
  "start with Windows" entry at the test exe).
* **Windows appear.** The test instance's main window and cat show up for about 2 minutes. The test cat's
  autonomous walking is switched off and it is moved to the top-left of the primary work area, away from a cat that may sit in the bottom-right corner.
* **Global shortcuts.** If your own CatDesktop is not running, the test instance registers the default
  `Ctrl+Shift+P/F/N` at start-up, like the product does. The hotkeys section therefore runs second and releases them
  within a few seconds. To simulate "shortcut taken by another application" deterministically, a helper PowerShell
  process holds only `Ctrl+Alt+Shift+F10` (via `RegisterHotKey`) until the restart check has finished. The
  `hotkeys.suspend` checks briefly register `Ctrl+Alt+Shift+F9`/`F11` from short-lived probe processes (register and
  release at once) and let one more helper hold `Ctrl+Alt+Shift+F11` for a moment.

## Expected warnings

The diagnostics section fails on any page error and any host-log `WARN`/`ERROR` line that is not in one of two lists at
the top of the script. `EXPECTED_HOST_WARNINGS` covers the hotkey conflicts and the deliberate unknown-command,
non-string and malformed-JSON messages. `EXPECTED_PAGE_DIAGNOSTICS` covers the Chromium error for the `file://`
navigation and the aborted request of the blocked `about:blank` navigation (scoped to the security section), and the
cancelled document request of a reload of the bare origin, which the host replaces by `/index.html#/…` (scoped to the
reload section).
Only add an entry for something the suite provokes on purpose.

## Troubleshooting

* **`Port 9333 is already serving DevTools`**: another test run (or app) uses the port. Pass `--port 9444`.
* **`CDP targets not found`**: the exe is probably a Release build (CDP is Debug-only), or `wwwroot` is missing.
* **A section fails with an unexpected error**: rerun with `--keep-data` and read `<data>/Logs/host-YYYYMMDD.log`. It
  contains every bridge command and event, because the suite starts the host with `--verbose`.
