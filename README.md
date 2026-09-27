# CatDesktop

CatDesktop is a Windows desktop application for notes, tasks and focused work, with the **Cat Companion** - an animated
cat that lives on your desktop: it walks around the screen, sits, naps, can be picked up and dropped anywhere, and
keeps quick notes, tasks and the focus timer one double-click away. The UI is an Angular 20
application rendered by Microsoft Edge WebView2 inside a .NET 9 WinForms host; all data lives in a local SQLite
database. There is no server, no account and no network access: everything works offline on the PC it is installed on.

The complete technical contract between the Angular UI, the C# host and the database is
[docs/DESKTOP-CONTRACT.md](docs/DESKTOP-CONTRACT.md). Build and release details are in
[docs/BUILD-AND-RELEASE.md](docs/BUILD-AND-RELEASE.md).

## Development

Everything runs from the repository root (the folder with this README). Requirements: Windows 10 1809+ or 11 (64-bit),
Node.js 20.19+ (22 LTS recommended), the .NET 9 SDK and the WebView2 Runtime (see [Prerequisites](#prerequisites)).

### Install dependencies

```powershell
npm install
```

Installs the root tooling (`concurrently`), then the Angular app's dependencies in `cat-desktop/` (from its own
`package-lock.json`) and restores the .NET host's NuGet packages. Nothing has to be installed globally.

### Start the complete application

```powershell
npm run dev
```

Starts the Angular dev server and, as soon as it answers on `http://127.0.0.1:4280` (CatDesktop's own port, so another Angular project on 4200 is never
picked up by mistake), the .NET desktop host with WebView2
pointed at it (`--dev-url`). Output is prefixed `[Angular]` and `[Desktop]`. Angular changes reload live in the main
window and in the cat; C# changes need a restart. Closing the app (or `Ctrl+C`) stops both processes, and if either one
stops the other is stopped too, so nothing is left running. If an installed CatDesktop is already running, the dev host
uses its own data folder (`.dev-data/`) so both can run side by side.

### Other commands

| Command | What it does |
|---|---|
| `npm run dev:angular` | Angular dev server only (`ng serve` in `cat-desktop/`); open `http://127.0.0.1:4280` in a browser to work on the UI with the simulated host |
| `npm run dev:desktop` | Desktop host only, pointed at a dev server you started yourself |
| `npm start` | Production-like run: Angular production build, then the host in Release loading the packaged UI |
| `npm run build` | Angular production build + Release build of the host (the build copies the UI into `wwwroot/`) |
| `npm run build:angular` / `npm run build:desktop` | The two halves on their own |
| `npm run build:installer` | The full release pipeline (`build.ps1`): publish + Windows installer in `Installer/output/` |
| `npm test` | Angular unit tests (headless Chrome) |
| `npm run test:e2e` | End-to-end suite against a real Debug build of the host (add `-- --long` for the slow checks) |
| `npm run clean` | Removes build outputs (`-- --all` also removes node_modules, downloaded installer tools and `.dev-data/`) |
| `npm run install:all` | Clean reinstall of the Angular dependencies (`npm ci`) + .NET restore |

The root `package.json` only orchestrates: the Angular project keeps its own `package.json` and lockfile (the installer
build uses them), so there are no npm workspaces and no duplicated configuration.

## Architecture

```
Windows Desktop Application (CatDesktop.exe)
|
+-- C# / .NET 9 WinForms host            Desktop/CatDesktop.Host
|   +-- MainWindow     framed window, WebView2 -> Angular shell (#/dashboard, #/notes, ...)
|   +-- CatWindow      frameless, transparent, always-on-top WebView2 -> #/cat (DirectComposition visual hosting)
|   +-- Bridge         JSON request/response + events over WebView2 web messages
|   +-- Services       focus timer, global hotkeys, tray icon, notifications, startup, backup
|   +-- Database       SQLite via Microsoft.Data.Sqlite, repositories, embedded migrations
|
+-- Angular 20 app (zoneless, standalone)  cat-desktop/
|   +-- core/desktop   DesktopBridgeService - the ONLY code that touches window.chrome.webview
|   +-- core/services  signal-based feature services (settings, notes, tasks, focus, cat)
|   +-- features/      dashboard, notes, tasks, focus, settings
|   +-- cat-companion/ the desktop cat rendered inside CatWindow (behaviour, animation, menus)
|
+-- Local data  %LOCALAPPDATA%\CatDesktop\
    +-- Database\application.db          SQLite, per PC, never shared
    +-- WebView2\                        WebView2 user-data folder (cache, cookies)
    +-- Logs\host-YYYYMMDD.log           host log, one file per day
```

How the pieces talk to each other:

* **Production**: the Angular build is copied to `wwwroot/` next to `CatDesktop.exe` and served through the WebView2
  virtual host `https://app.catdesktop.local/` (folder mapping with cross-origin access denied).
* **Development**: the host is started with `--dev-url http://127.0.0.1:4280` and loads the Angular dev server
  instead, with live reload and DevTools.
* **Bridge**: Angular sends `{ kind: "request", id, command, payload }` as a JSON string with
  `window.chrome.webview.postMessage`; the host answers with a `response` envelope carrying the same `id`, and pushes
  unsolicited `event` envelopes (focus ticks, settings changes, hotkeys, ...). Every command and event is listed in the
  contract. Payloads are validated in C# before any side effect.
* **Routing**: Angular uses hash routing, so the packaged app works from a static folder
  (`.../index.html#/notes`). The main window loads `#/`, the cat window `#/cat`; both come from one bundle.
* **Focus timer runs in the host**, so the main window, the cat and the tray icon always agree.
* **Browser fallback**: when `window.__catdesktop` is absent (plain `ng serve` in a browser) the Angular app switches to
  `BrowserHostSimulator`, a localStorage-backed implementation of the same command surface, so every screen can be
  developed without the host.

## Folder structure

```
package.json                       Root scripts: npm install / npm run dev / build / test (see "Development")
scripts/                           Helpers behind those scripts (install, dev host launcher, e2e, clean)
build.ps1                          Builds Angular + host + installer (see "Build the installer")
dev.ps1                            PowerShell alternative to npm run dev
CatDesktop.sln                     Solution with the host project (open in Visual Studio / Rider)
cat-desktop/                       Angular 20 application (npm project)
  src/app/core/desktop/            Bridge protocol, transport, DesktopBridgeService, browser simulator
  src/app/core/models/             Shared TypeScript models (mirror the C# records)
  src/app/core/services/           Feature services built on signals
  src/app/features/                Dashboard, notes, tasks, focus, settings pages
  src/app/cat-companion/           Cat window UI: behaviour state machine, animation, menus, panels
  public/assets/cat/               Cat skin manifest and folders for replacement sprite sheets
Desktop/CatDesktop.Host/           .NET 9 WinForms host (assembly name CatDesktop, exe CatDesktop.exe)
  App/                             Composition root, paths, config, logger, single instance
  Bridge/                          Envelopes, router, events, payload validation, command handlers
  WebView/                         WebView2 hosting, security settings, URL helpers
  MainWindow/, Cat/                The two windows (Cat/: CatWindow, CatWindowService, walking, dragging, click-through)
  Services/                        Focus timer, hotkeys, tray, notifications, startup, backup
  Database/                        SQLite access and repositories
  Assets/app.ico                   Application icon (also used by the installer)
Database/Migrations/               SQL migration scripts, embedded into the host as "Migrations.<file>"
Installer/
  CatDesktop.iss                   Inno Setup script
  tools/, redist/, output/         Downloaded compiler, WebView2 bootstrapper, built setup (all git-ignored)
tests/e2e/                         End-to-end suite that drives the real host over CDP (see "End-to-end tests")
docs/DESKTOP-CONTRACT.md           The contract: architecture, envelopes, commands, events, models, schema
docs/BUILD-AND-RELEASE.md          Build pipeline details and the release checklist
```

## Prerequisites

For **developers** (building and running from source):

| Tool | Version | Notes |
|---|---|---|
| Windows | 10 version 1809 (build 17763) or later, or Windows 11, 64-bit | Same minimum as the WebView2 Runtime |
| Node.js + npm | Node 20.19+ (22 LTS recommended), npm 10 | Builds and serves the Angular app, runs the root scripts |
| .NET SDK | 9.0 | Builds and publishes the host; `dotnet --version` should print 9.x |
| WebView2 Runtime | any Evergreen version | Pre-installed on Windows 11 and on updated Windows 10; otherwise install it from Microsoft |
| PowerShell | Windows PowerShell 5.1 (built in) or PowerShell 7 | Runs `build.ps1` (also behind `npm run build:installer`) and `dev.ps1` |

Inno Setup does **not** need to be installed: `build.ps1` downloads the Inno Setup 6.7.3 compiler once from NuGet
(`Tools.InnoSetup`) into `Installer/tools/`. Inno Setup 6 is free software whose licence allows commercial use
(`Installer/tools/innosetup/license.txt`), so no licence has to be bought to ship CatDesktop. Visual Studio is optional.

**End users need none of this.** The installer produced by `build.ps1` is self-contained (it carries the .NET runtime)
and installs the WebView2 Runtime when it is missing. The only requirement is 64-bit Windows 10 1809+ / Windows 11.

## Run in development

`npm run dev` (see [Development](#development)) is the fast path. Alternatives:

```powershell
.\dev.ps1                 # PowerShell: starts "npm start" in a new window, waits for http://127.0.0.1:4280, runs the host
.\dev.ps1 -NoServe        # you already have ng serve running

# or by hand, in two terminals
npm run dev:angular       # terminal 1 – http://127.0.0.1:4280
npm run dev:desktop       # terminal 2 – dotnet run --project Desktop/CatDesktop.Host -- --dev-url http://127.0.0.1:4280
```

Useful switches and behaviours:

* `--dev-url <url>` (or environment variable `CATDESKTOP_DEV_URL`, or `--dev` for the default URL) selects the dev
  server. Debug builds fall back to `http://127.0.0.1:4280` automatically when no `wwwroot/index.html` is present.
* Dev mode enables DevTools (F12) and the context menu inside the WebView. `--devtools` enables them for a production
  build too. `--hidden` starts minimised to the tray (used by the "start when I sign in" Run entry).
* `--verbose` (or environment variable `CATDESKTOP_VERBOSE=1`) writes every bridge command, response and event to the
  host log at TRACE level. Dev mode always logs this way.
* `CATDESKTOP_DATA_DIR=<folder>` runs the app on a separate data folder (database, WebView2 profile, logs) with its
  own single-instance guard, so a test or second profile runs beside your normal copy:

  ```powershell
  $env:CATDESKTOP_DATA_DIR = "$env:TEMP\catdesktop-scratch"
  dotnet run --project Desktop/CatDesktop.Host -- --verbose
  Remove-Item Env:CATDESKTOP_DATA_DIR    # back to %LOCALAPPDATA%\CatDesktop for this terminal
  ```

  The full list of switches and variables is in the contract ("Command line and environment").
* Angular changes reload live in both windows. Host (C#) changes need a restart of `dotnet run`.
* `Desktop/CatDesktop.Host/Properties/launchSettings.json` contains matching launch profiles for Visual Studio.
* To work on the UI without the host at all, open `http://127.0.0.1:4280` in a browser: the app runs on the
  `BrowserHostSimulator` (data in localStorage). A simulated cat walks over the page; `http://127.0.0.1:4280/#/cat` shows the cat window UI on its own.

## End-to-end tests

`tests/e2e/bridge-smoke.mjs` drives the real host (both WebView2 windows, SQLite, the production UI) over the Chrome
DevTools Protocol and checks the contract: validation, notes, tasks, settings, actions, focus timer, the Cat Companion (walking, layouts, hit region, click-through),
navigation, security, the UI and a restart with persisted state. It is plain Node 22 with no npm dependencies. It needs a
**Debug** build (the DevTools Protocol hook is compiled into Debug only) with `wwwroot/index.html` next to the exe:

```powershell
cd cat-desktop; npx ng build; cd ..
dotnet build Desktop/CatDesktop.Host/CatDesktop.Host.csproj -c Debug -o $env:TEMP\catdesktop-e2e-build
node tests/e2e/bridge-smoke.mjs --exe $env:TEMP\catdesktop-e2e-build\CatDesktop.exe
```

The suite starts its own instance with `--verbose`, `CATDESKTOP_DATA_DIR=<temp folder>` and `CATDESKTOP_CDP_PORT`, so it
runs beside a CatDesktop you already have open and never touches your data. It uses no OS mouse or keyboard input. The
exit code is the number of failed checks (`0` = green). Options (`--port`, `--keep-data`, `--long`) and the ground rules
are in [tests/e2e/README.md](tests/e2e/README.md).

## Build the installer

```powershell
.\build.ps1
```

This produces `Installer/output/CatDesktop-Setup-<version>.exe` (the version comes from `<Version>` in
`Desktop/CatDesktop.Host/CatDesktop.Host.csproj`, currently 1.0.0). The pipeline is:

1. **Prerequisites** - node, npm and dotnet are located and their versions printed.
2. **Angular** - `npm ci` when `cat-desktop/node_modules` is missing, then `npm run build` (production configuration)
   into `cat-desktop/dist/cat-desktop/browser`.
3. **Publish** - `dotnet publish` of the host for `win-x64`, self-contained, into
   `Desktop/CatDesktop.Host/bin/publish/win-x64`. The csproj copies the Angular output into `wwwroot/` during publish,
   so step 2 must run first. The script verifies that `CatDesktop.exe` and `wwwroot/index.html` exist.
4. **Tools** - downloads and caches the Inno Setup 6.7.3 compiler (`Installer/tools/innosetup/ISCC.exe`, free
   for commercial use) and the WebView2 Evergreen bootstrapper (`Installer/redist/MicrosoftEdgeWebview2Setup.exe`). An
   Inno Setup 6/7 already installed on the PC (on `PATH` or in `Program Files (x86)\Inno Setup 6`) is used when the
   cache is empty.
5. **Installer** - `ISCC.exe` compiles `Installer/CatDesktop.iss`; the resulting setup path and size are printed.

Flags:

| Flag | Effect |
|---|---|
| `-Version 1.2.0` | Override the product version (stamped into the exe, the installer name and the Apps list) |
| `-Runtime win-arm64` | Publish a native Arm64 build; the setup is named `...-arm64.exe` and only installs on Arm64 Windows |
| `-Configuration Debug` | Publish the Debug configuration (default Release) |
| `-SelfContained:$false` | Framework-dependent build (about 10x smaller); the target PC then needs the .NET 9 Desktop Runtime, which the installer checks for |
| `-SkipAngular` | Reuse the existing `cat-desktop/dist` output |
| `-SkipPublish` | Reuse the existing publish folder |
| `-SkipInstaller` | Stop after publishing (for example to zip the publish folder yourself) |
| `-FetchToolsOnly` | Only download the compiler and the bootstrapper (do this once while online) |

`.\build.ps1 -SkipAngular -SkipPublish` is the quick way to iterate on the installer script alone. The script exits
non-zero on any failure and is Windows PowerShell 5.1 compatible. If the WebView2 bootstrapper cannot be downloaded the
build continues with a warning; the installer then shows a download hint instead of installing WebView2 silently.

## Install and first run

1. Copy `CatDesktop-Setup-<version>.exe` to the target PC and double-click it. The setup is not code-signed, so
   Windows SmartScreen may show "Windows protected your PC": choose *More info* -> *Run anyway*.
2. Choose **Install for me only** (default, no administrator rights, installs to
   `%LOCALAPPDATA%\Programs\CatDesktop`) or **Install for all users** (UAC prompt, installs to `Program Files`).
3. Optional tasks: desktop shortcut (on by default) and *Start CatDesktop when I sign in* (off by default; adds a
   per-user Run entry that launches the app hidden in the tray). The sign-in task is offered only on the first
   per-user install; after that, and in all-users installs, use *Settings -> Start with Windows* in the app, which owns
   the Run entry from its first start on.
4. If the WebView2 Runtime is missing, the setup installs it silently (internet connection required for that step).
   Windows 11 and updated Windows 10 already have it.
5. Finish with *Launch CatDesktop*. The main window opens on the dashboard and the cat appears at the bottom-right of
   the primary monitor; a tray icon gives quick access to the app, the cat (show/hide, pause walking), the focus timer
   and *Exit*.
6. **Upgrades**: run a newer setup over the existing installation; settings and data are kept, including the
   *Start with Windows* choice. The setup refuses to run while CatDesktop is open (exit it from the tray first).
   **Uninstall** through *Settings -> Apps* or the *Uninstall CatDesktop* shortcut. It removes the sign-in Run entry
   when it points at this installation and, for a per-user install, asks whether to delete your local data as well
   (default *No*). Silent uninstalls (`/VERYSILENT`) never ask and keep the data; an all-users uninstall keeps every
   user's data and says where it is.

## Where data is stored

Everything lives under `%LOCALAPPDATA%\CatDesktop` (for example `C:\Users\<you>\AppData\Local\CatDesktop`):

| Path | Content |
|---|---|
| `Database\application.db` | SQLite database: notes, tasks, settings (including the cat's theme and size), the cat's quick actions, window and cat positions, focus sessions (WAL mode, so `-wal`/`-shm` side files may exist while the app runs) |
| `Logs\host-YYYYMMDD.log` | Host log, one file per day, kept for 14 days |
| `WebView2\` | WebView2 user-data folder (cache, local storage of the UI) |
| `Backups\` | Suggested location for JSON exports made from *Settings -> Data* |

Data is **per PC and per Windows user** and is never synchronised or uploaded. To move to another PC use
*Settings -> Data -> Export* (JSON backup of all tables, including the focus history) and *Import* there; nothing is
written to the installation folder, so an uninstall keeps the data unless you confirm its deletion. When the
environment variable `CATDESKTOP_DATA_DIR` is set, all of the above lives in that folder instead (used by the tests).

## The Cat Companion

The cat lives in its own frameless, transparent, always-on-top window (`#/cat`), independent of the main window's
pages. The C# host (`CatWindowService`) moves and sizes that window; the Angular side decides what the cat does and
draws it.

**How it works**

* **Alive, not scripted** - a behaviour state machine (idle, walking, running, sitting, sleeping, yawning, stretching,
  jumping, looking around, dragged, interacting) picks the next state at random with weights and random durations:
  walks of 5-12 s, pauses, looking around, sitting, the odd nap (usually with a yawn first; waking is yawn, then
  stretch). All timings are in `cat-desktop/src/app/cat-companion/services/cat-behavior.config.ts`.
* **Smooth walking** - the host glides the window with eased acceleration and deceleration; the walk cycle (with a
  small bounce) is synced to the movement so the feet do not slide, and the cat turns around (mirrored, no duplicate
  art) near the edges. It always stays completely inside the usable work area of its monitor, never under the taskbar.
* **Idle life** - breathing, irregular blinks, ear twitches, small head movements and tail sway run on independent
  timers, so the cat never moves in lockstep. Hovering makes it attentive: ears up, eyes on the cursor.
* **Interaction** - a click gets a varied reaction (look at the cursor and blink, a small jump, a happy wiggle, a head
  tilt with a slow blink, a meow if sounds are on), never the same one twice in a row. Grab it and it looks surprised,
  hangs from the scruff while you carry it, lands with a little squash when you let go, sits, then carries on.
  **Double-click** opens the companion panel (configurable quick actions, quick note, tasks, focus timer, reminders);
  **right-click** opens the menu: Pause/Resume Walking, Move Cat, Change Theme, Change Size, Always on Top, Cat
  Settings, Hide Cat.
* **Out of the way** - only the cat's own shape takes the mouse; the rest of its window is click-through. *Click-through
  when idle* lets clicks pass through the cat itself until the cursor rests on it, and *Cat interaction* off makes it
  ignore the mouse completely.
* **Position** - the monitor and position are saved after every walk, drag and resize and restored at the next start; a
  disconnected monitor falls back to the primary one.

**Customising the cat** (*Settings -> Cat Companion*; everything applies instantly and is stored locally in
`cat.settings`)

* **Theme** - ten coats: Classic (brown tabby), Black, White, Orange, Gray, Brown, Cream (colour-point), Pink, Blue and
  Purple, shown as cards that render the real cat.
* **Size** - a slider from 10 % to 200 % (default 100 %). The desktop cat resizes at once, keeping its feet where they
  were and staying inside the screen.
* **Live preview** - the same cat component as on the desktop, with chips to preview every animation.
* **Behaviour** - enable, auto walk, random behaviour (with an *Advanced* split into random idle and random actions),
  always on top, start with the application, cat interaction, click-through when idle, sounds (off by default),
  walking speed and opacity.

**Adding a theme or new art**

* A theme is one entry in `cat-desktop/src/app/cat-companion/components/cat-sprite/cat-themes.ts` (`CAT_THEMES`): coat,
  belly, optional stripes and colour points, eye, accent and outline colours. The vector cat derives all of its shading
  from these colours with CSS variables, so a new entry is immediately available in Settings, the preview and on the
  desktop - no filters, no image files needed.
* The artwork is an animated SVG with CSS (GPU-friendly transforms, no per-frame Angular work). Any animation can be
  replaced by a sprite sheet without code changes, for every theme or for one theme only (`themeSkins` in
  `cat-desktop/public/assets/cat/cat.manifest.json`, sheets in `assets/cat/themes/<id>/`); the format is described in
  `cat-desktop/public/assets/cat/README.md`. `tests/visual/cat-preview/` renders contact sheets of every animation and
  theme for review.

**Also in the app**

* **Global hotkeys** (work while other apps have focus): `Ctrl+Shift+P` shows/hides the cat, `Ctrl+Shift+F`
  starts/pauses the focus timer, `Ctrl+Shift+N` opens a quick note. All three are rebindable.
* **Focus timer** - Pomodoro-style 25 / 5 / 15 minutes with a long break every 4 sessions, auto-start options,
  notification and sound. It runs in the host, so the main window, the cat and the tray always show the same state.
* **Upgrading** - the first start after an upgrade converts older settings: the Pet Book's settings and position, and
  the first cat release's small / medium / large size (70 % / 100 % / 140 %). Quick actions are kept.

## Adding a native capability

Every capability follows the same five steps; no other plumbing is needed.

1. **Contract** - add a row to the command table in `docs/DESKTOP-CONTRACT.md` (section 3) with payload and result
   types, plus any new event in section 4. Names are `area.verb`, JSON is camelCase.
2. **Protocol** - add the command to `CommandMap` (and events to `EventMap`) in
   `cat-desktop/src/app/core/desktop/bridge-protocol.ts`. Add the same behaviour to
   `browser-host-simulator.ts` so `ng serve` in a browser keeps working.
3. **Host handler** - create or extend a `*Commands` class in `Desktop/CatDesktop.Host/Bridge/Handlers/` with a
   `Register(BridgeRouter router)` method:

   ```csharp
   router.Register("clipboard.copy", (ctx, payload) =>
   {
       var text = Payload.RequireString(payload, "text", maxLength: 10_000); // validate BEFORE side effects
       Clipboard.SetText(text);
       return new { };
   });
   ```

   Throw `BridgeException.Validation(...)`, `.NotFound(...)` or `.Denied(...)` for expected failures; anything else
   becomes a generic `internal` error and is logged. Register the class in the `DesktopApplication` constructor
   next to the other handlers. Use `BridgeEvents.Broadcast`/`Send` for events.
4. **Service** - expose it from a core service using signals, for example
   `copy(text: string) { return this.bridge.invoke('clipboard.copy', { text }); }` in
   `cat-desktop/src/app/core/services/`. Components never call the bridge directly.
5. **UI** - use the service from a feature component or the cat window.

## Security notes

* WebView2 is hardened: no host objects (`AreHostObjectsAllowed=false`), DevTools and context menus only in dev
  mode, no status bar, zoom or browser accelerator keys in production, no autofill or password saving.
* The host only accepts web messages whose source is the app origin (`https://app.catdesktop.local` or the dev URL)
  and only the commands listed in the contract exist. Unknown commands return `unsupported`; every payload is validated
  before anything happens.
* Navigation away from the app origin is cancelled; http(s) links open in the default browser instead. New-window
  requests are handled the same way.
* The UI is served from a read-only folder mapping; nothing is ever written to the installation directory.
* File access is user-mediated only (Save/Open dialogs for export and import). There is no network code in the app.
* The installer runs without administrator rights by default, installs per user, and touches only its own folder,
  its shortcuts and (optionally) one per-user Run entry. It is not code-signed; see the SmartScreen note above.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The user interface files are missing (wwwroot/index.html)" at startup | The host was built or published without the Angular output. Run `.\build.ps1` (without `-SkipAngular`), or start with `--dev-url` for development. `build.ps1` fails early with this check so a broken installer is never produced. |
| Page "Angular dev server not reachable" in dev mode | `npm start` is not running or uses another port. Start it (or `.\dev.ps1`), then press F5 in the app or restart `dotnet run`. Check that `--dev-url` matches the port `ng serve` printed. |
| A hotkey cannot be saved ("denied") | Another application already registered that key combination. Choose a different one; the previous bindings stay active. |
| Nothing happens when a hotkey is pressed | The app must be running (tray icon visible). Some elevated apps swallow global hotkeys while they have focus. |
| App does not start / WebView2 error | The WebView2 Runtime is missing or broken. Install it from Microsoft (search "WebView2 Runtime") or re-run the setup, which installs it when missing. |
| Setup says CatDesktop is running | Exit the app through the tray icon (*Exit*) and run the setup again. |
| A second CatDesktop does not open | Only one instance runs per user session; the running one is brought to the front. |
| The cat ended up on a disconnected monitor or cannot be found | Its position is clamped into a work area on start and after every display change (a missing monitor falls back to the primary one). Use *Settings -> Cat -> Bring cat to this screen*, or toggle it with `Ctrl+Shift+P`. |
| Clicks do not reach what is under the cat | Only the cat itself takes the mouse. Drag it away, or enable *Click-through when idle* (clicks pass through until the cursor rests on the cat) or turn *Cat interaction* off. |
| Logs | `%LOCALAPPDATA%\CatDesktop\Logs\host-YYYYMMDD.log` (dev mode, `--verbose` and `CATDESKTOP_VERBOSE=1` log at TRACE level). Fatal startup errors also show a message box pointing to this folder. |
| Both windows went blank and the app came back by itself | The WebView2 browser process crashed; the host restarts itself once (log line "restarting CatDesktop"). If it crashes again within a minute it shows an error and exits instead. Repair the WebView2 Runtime if this repeats. |
| Build: `npm ci` fails | `package-lock.json` and `package.json` are out of sync, or the Node version is too old. Use Node 22 LTS and run `npm install` once inside `cat-desktop` to refresh the lock file. |
| Build: Inno Setup download blocked | Run `.\build.ps1 -FetchToolsOnly` on a PC with internet access and copy `Installer/tools/` and `Installer/redist/` over, or install Inno Setup 6 in `Program Files (x86)` - the script finds it there. |
