# CatDesktop — Desktop Architecture & Bridge Contract

This document is the single source of truth for how the Angular UI, the C# desktop host and the
local SQLite database talk to each other. Every implementer (C# or Angular) must follow it exactly.

```
Windows Desktop Application (CatDesktop.exe)
│
├── C# / .NET 9 WinForms host          Desktop/CatDesktop.Host
│   ├── MainWindow  (framed, WebView2 → Angular shell, hash routes #/dashboard …)
│   ├── CatWindow   (frameless, transparent, always-on-top WebView2 → #/cat, moved by CatWindowService;
│   │                visual hosting: CoreWebView2CompositionController + DirectComposition, see §7)
│   ├── Bridge (JSON request/response + events over WebView2 web messages)
│   ├── Services (focus timer, hotkeys, tray, notifications, startup, backup)
│   └── Database (SQLite via Microsoft.Data.Sqlite, repositories, embedded migrations)
│
├── Angular 20 app (zoneless, standalone) cat-desktop/
│   ├── core/desktop  DesktopBridgeService (ONLY place that touches window.chrome.webview)
│   ├── core/services signal-based feature services (settings, notes, tasks, focus, cat window/settings)
│   ├── features/     dashboard, notes, tasks, focus, settings
│   └── cat-companion/ the desktop cat rendered inside CatWindow (behaviour, animation, menus)
│
└── Local data  %LOCALAPPDATA%\CatDesktop\   (or the folder named by CATDESKTOP_DATA_DIR, see below)
    ├── Database\application.db      (SQLite, per-PC, never shared)
    ├── WebView2\                    (WebView2 user data folder)
    ├── Backups\                     (suggested folder for data.export)
    └── Logs\host-YYYYMMDD.log
```

* No server, no IIS, no network. Everything works offline.
* Production: Angular build is copied to `wwwroot/` next to `CatDesktop.exe` and served through the
  WebView2 virtual host `https://app.catdesktop.local/` (`SetVirtualHostNameToFolderMapping`, access `Deny`).
* Development: host started with `--dev-url http://127.0.0.1:4280` (or env `CATDESKTOP_DEV_URL`) loads the
  Angular dev server instead; DevTools only enabled in that mode or with `--devtools`.
* Angular router uses **hash location** (`withHashLocation()`), so a route is `…/index.html#/notes`.
  Main window loads `#/` (shell), the cat window loads `#/cat`.

### Command line and environment

| switch / variable | effect |
|---|---|
| `--dev-url <url>` | load the UI from an Angular dev server (http/https only); implies DevTools and verbose logging |
| `--dev` | same as `--dev-url http://127.0.0.1:4280` (CatDesktop's dev-server address, set in `cat-desktop/angular.json`) |
| `CATDESKTOP_DEV_URL=<url>` | used when neither switch is given. Debug builds also fall back to `http://127.0.0.1:4280` when `wwwroot/index.html` is missing |
| `--devtools` | DevTools and the context menu in a production build |
| `--verbose` or `CATDESKTOP_VERBOSE=1` | TRACE-level host log: every bridge command, response and event (always on in dev mode) |
| `--hidden` / `--minimized` | start in the tray without showing the main window (used by the "start with Windows" Run value) |
| `--restart` | added by the host itself when it relaunches after a WebView2 browser-process crash (see §2); not meant to be typed |
| `CATDESKTOP_DATA_DIR=<folder>` | isolated data folder: database, WebView2 profile, logs and backups live there instead of `%LOCALAPPDATA%\CatDesktop`. The instance also gets its own single-instance mutex/event names (suffixed with a hash of the folder), so it runs beside the normal app. Like dev mode, it skips the start-up reconciliation of the "start with Windows" Run value (see `app.startWithWindows`). Used by `tests/e2e` |
| `CATDESKTOP_CDP_PORT=<1025-65535>` | **Debug builds only**: opens the Chrome DevTools Protocol on `127.0.0.1:<port>` for the end-to-end tests. Compiled out of Release builds |

The default data folder uses the fixed mutex name `Local\CatDesktop.SingleInstance.v1`; the installer's `AppMutex`
depends on it, so it must not change.

## 1. Transport

Angular → C#: `window.chrome.webview.postMessage(jsonString)` (always a JSON *string*).
C# → Angular: `CoreWebView2.PostWebMessageAsJson(json)`; Angular receives `event.data` already parsed.

Injected before any document script (host `AddScriptToExecuteOnDocumentCreatedAsync`):

```js
window.__catdesktop = { hosted: true, windowKind: 'main' | 'cat', version: '1.0.0', devMode: false };
```

When `window.__catdesktop` is absent the Angular app is running in a plain browser (`ng serve`) and
`DesktopBridgeService` must fall back to `BrowserHostSimulator` (localStorage-backed, same command API).

## 2. Envelopes

```jsonc
// Angular → C#
{ "kind": "request", "id": "<uuid>", "command": "notes.create", "payload": { … } }

// C# → Angular (one per request, same id)
{ "kind": "response", "id": "<uuid>", "ok": true,  "result": { … } }
{ "kind": "response", "id": "<uuid>", "ok": false, "error": { "code": "validation" | "not_found" | "unsupported" | "denied" | "internal", "message": "…" } }

// C# → Angular (unsolicited, broadcast to every open window unless stated otherwise)
{ "kind": "event", "name": "focus.tick", "data": { … } }
```

Rules
* `id` is a UUID string generated by Angular. Unknown `kind`/`command` → `error.code = "unsupported"`.
* Payload validation happens in C# **before** any side effect. Missing/invalid → `"validation"`.
* Host must verify `e.Source` starts with the app origin (`https://app.catdesktop.local` or the dev URL) and ignore
  anything else. Host objects (`AddHostObjectToScript`) are **never** used.
* All timestamps are ISO-8601 UTC strings (`2026-09-26T10:15:00.000Z`). IDs are UUID strings (`Guid.NewGuid().ToString()`).
* JSON is camelCase on both sides.

Event delivery
* The host **queues events for a window until its current document has sent its first message** (any request).
  That message flushes the queue in order, ahead of the response to it. A new document (navigation, reload, or a
  reload after a render-process crash) starts queuing again; a hash-route change inside the same document does not.
  Queuing starts as soon as such a navigation starts, so an event sent while a page reloads reaches the new document
  instead of dying with the outgoing one; a navigation that ends without replacing the document (cancelled or failed
  before it loaded anything) hands the queue to the current document. The queue keeps at most 500 events per window;
  older ones are dropped.
* A reload of the bare virtual-host root (`https://app.catdesktop.local/#/…`, which is how the hash location shows the
  production page) is redirected by the host to `/index.html#/…`, because the virtual host serves no directory index.
* Consequence for Angular: the bridge's message listener and every **core service that needs events must subscribe in
  its constructor** (core services are created by the app initializer, before the first request goes out). A
  subscription made later, for example in a routed component's `ngOnInit`, misses the events flushed at the first request.
* `cat.command` is the exception that a component consumes: `CatWindowService` subscribes in its constructor and
  **buffers** commands until the cat UI subscribes to `commands$`, then hands them over and delivers live. This keeps a
  command that opened the cat window (for example the quick-note hotkey) from being lost while `#/cat` loads.

Browser-process crash
* A crashed or unresponsive **render** process is reloaded in place (events queue until the reloaded page speaks).
* When the WebView2 **browser** process exits, both windows are unusable. The host logs it, relaunches
  `CatDesktop.exe` with its original arguments plus `--restart`, and exits. The new process waits up to 15 s for the
  old one to release the single-instance mutex instead of handing over to it (it gives up and exits 1 after that). If
  the browser process of a restarted instance dies again within 60 s, the host shows an error and exits instead of
  restarting in a loop.

## 3. Commands (Angular → C#)

Payload/Result types are given in TypeScript; C# uses equivalent records with camelCase JSON.

### app.*
| command | payload | result |
|---|---|---|
| `app.getInfo` | – | `AppInfo { version; windowKind: 'main'\|'cat'; devMode; dataDirectory; databasePath; platform:'windows'; startedAt }` |
| `app.openExternal` | `{ url }` (http/https only, else `denied`) | `{}` |
| `app.showNotification` | `{ title; body; silent?: boolean }` | `{}` |
| `app.openDataFolder` | – | `{}` |
| `app.exit` | – | `{}` (exits whole application) |

### window.* (acts on the window that sent the request)
| command | payload | result |
|---|---|---|
| `window.minimize` / `window.maximize` / `window.restore` / `window.close` / `window.focus` | – | `{}` (from the cat window: `window.close` only hides it, `window.minimize`/`maximize` are `unsupported`, and `window.focus` activates it and gives the WebView keyboard focus – the cat UI calls it when its menu or panel opens) |
| `window.getState` | – | `WindowState { windowId; monitor; x; y; width; height; isMaximized; isMinimized; isVisible; alwaysOnTop }` (physical px) |
| `window.setAlwaysOnTop` | `{ enabled }` | `{}` |

### cat.* (the desktop Cat Companion – C# `CatWindowService` + `CatWindow`)

Units: `x`, `y`, `bounds` and `workArea` are **physical** screen pixels (like `WindowState`). `dx`, `dy`, `speed`, `room`,
layout sizes and hit rectangles are **DIPs / CSS px**; the host multiplies them by the cat window's DPI scale. The
"cat box" is the rectangle the cat is drawn in (§7); the cat stands on its bottom edge.

```ts
interface Rect { x: number; y: number; width: number; height: number }
interface MonitorInfo { id: string /* device name, e.g. \\.\DISPLAY1 */; primary: boolean; bounds: Rect; workArea: Rect; scale: number }
interface CatScreenInfo {
  monitor: MonitorInfo;        // monitor holding the centre of the cat box
  monitors: MonitorInfo[];
  window: WindowState;         // windowId 'cat'
  box: Rect;                   // cat box inside the window, CSS px
  room: { left: number; right: number; up: number; down: number };  // DIPs the cat box can move before it touches the work-area edge
}
type CatFacing = 'left' | 'right';
interface CatWalkResult { dx: number; dy: number; durationMs: number; accelMs: number; facing: CatFacing }
type CatLayoutMode = 'cat' | 'menu' | 'panel';
interface CatLayoutResult { mode: CatLayoutMode; anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; width: number; height: number; box: Rect }
```

| command | payload | result |
|---|---|---|
| `cat.show` / `cat.hide` / `cat.toggle` | – | `{ visible }`. Show creates the window on first use (CreateCatWindow) and restores the saved position. It returns `visible: false` while `CatSettings.enabled` is false |
| `cat.isVisible` | – | `{ visible }` |
| `cat.getPosition` | – | `WindowState` (windowId `cat`) |
| `cat.moveTo` | `{ x; y; monitor?: string }` physical px of the window's top-left (SetCatPosition) | `WindowState`. Immediate. Clamped so the cat box is fully inside the work area of the named monitor, else of the monitor containing the point, else of the primary monitor. Persisted |
| `cat.moveBy` | `{ dx; dy }` DIPs (MoveCat) | `WindowState`. Immediate, clamped like `moveTo` on the current monitor, persisted |
| `cat.walk` | `{ dx: number; dy?: number; speed: number }` DIPs, `speed` 10–600 DIP/s, `dx`/`dy` within ±10000 | `CatWalkResult`. Smooth walk: accelerate over `accelMs` (at most 400 ms and at most 30 % of the walk), cruise, then decelerate symmetrically. The target is clamped so the cat box stays inside the current monitor's work area; the result reports the distance actually walked (0 when blocked, then `cat.walkEnded` reason `blocked` follows at once). A walk in progress is replaced (it ends with reason `replaced`). `denied` while dragging or when the layout is not `cat` |
| `cat.stop` | – | `{}`. Decelerates to a stop within about 200 ms (`cat.walkEnded` reason `stopped`); no-op when not walking |
| `cat.getScreenInfo` | – | `CatScreenInfo` (GetScreenInformation) |
| `cat.getMonitors` | – | `MonitorInfo[]` (GetMonitorInformation) |
| `cat.savePosition` | – | `WindowState` (SaveCatPosition). The host also saves after every walk, move, drag and layout change |
| `cat.dragStart` | `{ followUntilClick?: boolean }` or nothing | `{}`. The host stops any walk (`walkEnded` reason `dragged`) and moves the window with the **native cursor** at about 60 Hz, keeping the grab offset, until the left mouse button is released or `cat.dragEnd` is called. With `followUntilClick` (the context menu's "Move Cat") the button does not need to be held: the host first centres the cat box under the cursor (the cat is "picked up"), then it follows the cursor until the next left click (or Esc, which puts it back where it was, or 30 s). `cat.dragEnded` is sent after every drag, whichever way it ended. The cat box is kept fully inside the work area of the monitor under the cursor, so the cat can be carried to any monitor. `denied` when the layout is not `cat` |
| `cat.dragEnd` | – | `{ moved: boolean }`. Ends a drag now (normally the host ends it itself on button release) |
| `cat.setLayout` | `{ mode: CatLayoutMode }` | `CatLayoutResult`. Resizes the window for the context menu or the companion panel. The cat box keeps its screen position when possible; the extra area opens toward the side of the screen with more room (anchor = the window corner that holds the cat box), and the whole window is clamped into the work area. Stops a walk first (reason `layout`) |
| `cat.setHitRegion` | `{ rects: Rect[] }` 0–16 rectangles, CSS px in window coordinates | `{}`. Only these rectangles receive the mouse (window region); clicks elsewhere reach the windows below. An empty list means the whole window. Reset to the whole window on every layout change |
| `cat.setClickThrough` | `{ enabled: boolean; hoverToInteract?: boolean }` | `{}`. Runtime override of the settings-driven mode (§5). `enabled` makes the window ignore the mouse (layered + transparent window style). With `hoverToInteract` (default true) the host watches the cursor: after it rests on the hit region for 350 ms the cat becomes interactive, and 800 ms after the cursor leaves the window it is click-through again (`cat.interactiveChanged`) |
| `cat.setAlwaysOnTop` | `{ enabled }` | `{}` (runtime only; the persisted value is `CatSettings.alwaysOnTop`) |
| `cat.getSettings` | – | `CatSettings` |
| `cat.saveSettings` | `CatSettings` (full object) | `CatSettings`, normalised and stored under `cat.settings`. The host applies `enabled` (hide when false, show when switched on), `alwaysOnTop`, `scale` (box and window resized at once: the cat's bottom-centre point stays where it was, then the box is clamped into the work area; emits `cat.layoutChanged` and `cat.positionChanged`) and `interaction` / `clickThroughWhenIdle` (§5), then broadcasts `cat.settingsChanged`. `scale` outside 0.1–2 is clamped; a `theme` that does not match the pattern becomes `classic` |
| `cat.sendCommand` | `{ action: string (1–64 chars); payload?: unknown }` | `{}`. Shows the cat (when enabled) and forwards `cat.command` to the cat window. Known actions: `open-menu`, `open-panel` (optional payload `{ tab: 'home' | 'quick-note' | 'tasks' | 'focus' | 'reminders' }`), `quick-note`, `tasks`, `focus`, `reminders`, `pause-walking`, `start-walking`, `toggle-walking`, `meow`. For `quick-note` the host also gives the cat window keyboard focus |

Further rules (host behaviour where the table is silent)
* `cat.walk` and `cat.dragStart` are `denied` while the cat is hidden. A walk whose clamped length is 0 because the cat
  already touches the edge returns `dx = dy = 0` and ends with reason `blocked`; a requested length of 0 ends with `arrived`.
* `cat.moveTo` / `cat.moveBy` or a display change during a walk end it with reason `stopped`; a size change ends it with
  `layout`. A `replaced` walk and a drag that did not move save nothing and emit no `cat.positionChanged`.
* In the `menu` / `panel` layouts `moveTo` / `moveBy` clamp the whole window into the work area.
* Hit rectangles are grown outward to whole physical pixels; rectangles entirely outside the window are dropped (none
  left = whole window). Layout and size changes reset the region to the whole window.
* `cat.interactiveChanged` is sent only on hover-watcher transitions. A runtime `cat.setClickThrough` override lasts until
  `interaction` or `clickThroughWhenIdle` change.
* Esc cancels any drag (the cat goes back to where the drag started). A second `cat.dragStart` during a drag is ignored.
* `scale` or `theme` of the wrong JSON type (a number for `theme`, a non-numeric string for `scale`) is `validation`; a
  `theme` string that fails the pattern becomes `classic`. A scale change ends a drag and a walk (reason `layout`); in the
  `menu` / `panel` layouts it keeps the anchor corner and resizes the whole window. Consecutive scale changes reuse the
  same unrounded bottom-centre point, so a slider drag never makes the cat drift.

### navigation.*
| command | payload | result |
|---|---|---|
| `navigation.navigate` | `{ route: string }` | `{}` brings the main window to front and sends it event `navigation.navigate { route }` |

### settings.* (generic key → JSON store; keys are namespaced strings)
| command | payload | result |
|---|---|---|
| `settings.getAll` | – | `Record<string, unknown>` |
| `settings.get` | `{ key }` | `{ key; value: unknown \| null }` |
| `settings.set` | `{ key; value }` | `{ key; value }` (broadcast `settings.changed`) |
| `settings.remove` | `{ key }` | `{}` |

Well-known keys: `app.theme` (`'system'|'light'|'dark'`), `app.closeToTray` (bool), `app.startWithWindows` (bool),
`app.mainWindowState` (managed by host), `hotkeys` (`Hotkeys`), `focus.settings` (`FocusSettings`), `cat.settings` (`CatSettings`).
`petbook.settings` is legacy: at start-up the host converts it once into `cat.settings` (see §5) and removes it.

`app.startWithWindows` owns the per-user Run value `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CatDesktop`
(`"<exe>" --hidden`): setting it writes or removes that value. At every start the host reconciles the two once: when
the key is missing it is seeded from the Run value (for example one written by the installer's "start when I sign in"
task), otherwise the stored value is applied to the registry, which also rewrites a stale exe path and removes a value
re-added from outside. Skipped in dev mode and with `CATDESKTOP_DATA_DIR`.

### notes.*
```ts
interface Note { id; title; content; color: string | null; pinned: boolean; createdAt; updatedAt }
```
| command | payload | result |
|---|---|---|
| `notes.list` | `{ search?: string }` | `Note[]` (pinned first, then updatedAt desc) |
| `notes.get` | `{ id }` | `Note` |
| `notes.create` | `{ title?; content?; color?; pinned? }` | `Note` |
| `notes.update` | `{ id; title?; content?; color?; pinned? }` | `Note` |
| `notes.delete` | `{ id }` | `{}` |
All mutations broadcast `notes.changed`.

### tasks.*
```ts
interface TaskItem { id; title; notes: string | null; completed: boolean; priority: 0|1|2; dueAt: string | null; completedAt: string | null; sortOrder: number; createdAt; updatedAt }
```
| command | payload | result |
|---|---|---|
| `tasks.list` | `{ includeCompleted?: boolean }` | `TaskItem[]` (open first by sortOrder, then completed by completedAt desc) |
| `tasks.create` | `{ title; notes?; priority?; dueAt? }` | `TaskItem` |
| `tasks.update` | `{ id; title?; notes?; priority?; dueAt?; completed?; sortOrder? }` | `TaskItem` |
| `tasks.toggle` | `{ id }` | `TaskItem` |
| `tasks.delete` | `{ id }` | `{}` |
| `tasks.clearCompleted` | – | `{ deleted: number }` |
All mutations broadcast `tasks.changed`.
`sortOrder` is an integer from -1,000,000 to 1,000,000 (negative values move a task above the others); anything else is
`validation`. `tasks.create` appends after the largest existing `sortOrder`, clamped to that range. A backup import
clamps out-of-range values instead of dropping the task.

### actions.* (quick actions shown in the cat's companion panel)
```ts
interface QuickAction { id; name; icon; enabled: boolean; order: number; route?: string; actionType: 'navigate'|'quick-note'|'tasks'|'focus'|'reminders'|'pin'|'search'|'settings'|'custom'; payload?: Record<string, unknown> }
// 'pin' toggles CatSettings.alwaysOnTop. The Pet Book types 'toggle-compact' and 'return-home' no longer exist (migration 002 deletes such rows).
```
| command | payload | result |
|---|---|---|
| `actions.list` | – | `QuickAction[]` (ordered) |
| `actions.save` | `{ actions: QuickAction[] }` (full replace) | `QuickAction[]` |
| `actions.reset` | – | `QuickAction[]` (default set) |
Mutations broadcast `actions.changed`.

Default actions (seeded by migration): home(navigate `/dashboard`), quick-note, tasks, focus, reminders, pin, search(navigate `/notes`), settings(navigate `/settings`).

### focus.* (the timer RUNS IN THE HOST so main window, cat window and tray always agree)
```ts
interface FocusSettings { focusMinutes: number; shortBreakMinutes: number; longBreakMinutes: number; sessionsBeforeLongBreak: number; autoStartBreaks: boolean; autoStartFocus: boolean; notify: boolean; sound: boolean }
type FocusPhase = 'focus' | 'shortBreak' | 'longBreak';
type FocusStatus = 'idle' | 'running' | 'paused' | 'completed';
interface FocusState { phase: FocusPhase; status: FocusStatus; remainingSeconds: number; totalSeconds: number; completedFocusSessions: number; startedAt: string | null; endsAt: string | null }
```
| command | payload | result |
|---|---|---|
| `focus.getState` | – | `FocusState` |
| `focus.start` | `{ phase?: FocusPhase; minutes?: number }` (phase defaults to the phase that is up next; minutes 1–180, else `validation`) | `FocusState` |
| `focus.pause` / `focus.resume` / `focus.stop` / `focus.reset` / `focus.skip` | – | `FocusState` |
| `focus.getSettings` | – | `FocusSettings` |
| `focus.saveSettings` | `FocusSettings` | `FocusSettings` |
| `focus.getStats` | – | `{ todayFocusSessions; todayFocusMinutes; totalFocusSessions; totalFocusMinutes }` |
Host emits `focus.tick` every second while running and on every state change, `focus.completed { phase }` when a phase ends
(and shows a notification + optional sound per settings). Completed sessions are logged in `focus_sessions`.
Defaults: 25 / 5 / 15, 4 sessions before long break.
Ranges: `focusMinutes` 1–180, `shortBreakMinutes` 1–60, `longBreakMinutes` 1–120, `sessionsBeforeLongBreak` 1–12.
`focus.saveSettings` clamps numbers outside these ranges and returns the values it stored; UIs should use the same
limits so that nothing is changed silently.

### hotkeys.*
```ts
interface Hotkeys { toggleCat: string | null; startFocus: string | null; quickNote: string | null }  // e.g. "Ctrl+Shift+P"
// A stored value that still uses the legacy name togglePetBook is read as toggleCat.
```
| command | payload | result |
|---|---|---|
| `hotkeys.get` | – | `Hotkeys` |
| `hotkeys.set` | `Hotkeys` | `Hotkeys` (re-registers; a key that cannot be registered returns `error.code="denied"` and leaves previous bindings) |
| `hotkeys.suspend` | `{ suspended: boolean }` (missing/not a boolean → `validation`) | `{}` `true` unregisters all global hotkeys, so the Settings shortcut recorder can capture a gesture that is currently bound (otherwise Windows delivers it to the host as `hotkey.pressed`). `false` registers the current bindings again. The host resumes by itself 60 s after the **last** `true`, in case the UI never sends `false` |
Default: `toggleCat = "Ctrl+Shift+P"`, `startFocus = "Ctrl+Shift+F"`, `quickNote = "Ctrl+Shift+N"`.
The recorder calls `hotkeys.suspend { suspended: true }` when recording starts and `{ suspended: false }` whenever it
ends (gesture captured, Esc, cancel, save, page left).
While suspended, `hotkeys.get` still returns the configured bindings, and `hotkeys.set` still validates atomically (it
registers the new set once, so `denied` applies as usual) and then releases the shortcuts again until the suspension
ends. Resuming is best effort: a shortcut that another application registered in the meantime is logged and dropped
from `hotkeys.get`. The `hotkeys` setting written through `settings.set` or `data.import` is applied immediately, best
effort (like at start-up: a shortcut that cannot be registered is logged and skipped).

### data.*
| command | payload | result |
|---|---|---|
| `data.getInfo` | – | `{ databasePath; sizeBytes; noteCount; taskCount; schemaVersion }` |
| `data.export` | – | `{ cancelled: boolean; path?: string }` (SaveFileDialog, writes JSON backup of all tables) |
| `data.import` | – | `{ cancelled: boolean; notes: number; tasks: number }` (OpenFileDialog, merges by id) then broadcasts `notes.changed`, `tasks.changed`, `settings.changed`, `actions.changed` |

Backup file (UTF-8 JSON, written to a temporary file and then moved over the target, so a failed export never
destroys an existing backup):

```ts
interface BackupFile {
  format: 'catdesktop-backup';
  version: 1;                        // still 1: focusSessions was added without a format change
  exportedAt: string; appVersion: string;
  notes: Note[]; tasks: TaskItem[]; settings: Record<string, unknown>; actions: QuickAction[];
  focusSessions?: { id; phase: FocusPhase; startedAt; endedAt: string | null; plannedSeconds: number; completed: boolean }[];
}
```
Import runs in one transaction. Notes and tasks are merged by id (same id overwritten, others kept), a valid `actions`
array replaces the quick actions, settings are written key by key (at most 500 keys), and focus sessions are only
added (an id that already exists is kept). Invalid entries are skipped. Files written before `focusSessions` existed
have no such array and still import.

## 4. Events (C# → Angular)

Events for a window whose document has not sent its first message yet are queued (§2, "Event delivery").

| name | data | to |
|---|---|---|
| `cat.visibilityChanged` | `{ visible }` | all |
| `cat.positionChanged` | `WindowState` | all (after a walk, move, drag, layout change or display change; never per frame) |
| `cat.walkEnded` | `{ reason: 'arrived' \| 'stopped' \| 'replaced' \| 'dragged' \| 'hidden' \| 'layout' \| 'blocked'; x; y }` | cat window |
| `cat.dragStateChanged` | `{ dragging: boolean }` | cat window |
| `cat.dragEnded` | `{ x; y; monitor: string; moved: boolean; distance: number /* DIPs */ }` | cat window |
| `cat.layoutChanged` | `CatLayoutResult` | cat window |
| `cat.interactiveChanged` | `{ interactive: boolean }` | cat window (click-through mode only) |
| `cat.screenChanged` | `CatScreenInfo` | cat window (monitors, work area or DPI changed; the host has already moved the cat back on screen if needed) |
| `cat.settingsChanged` | `CatSettings` | all |
| `cat.command` | `{ action; payload? }` | cat window (buffered by `CatWindowService` until the cat UI consumes it, see §2) |
| `navigation.navigate` | `{ route }` | main window |
| `settings.changed` | `{ key; value }` | all |
| `notes.changed` / `tasks.changed` / `actions.changed` | `{}` | all |
| `focus.tick` | `FocusState` | all |
| `focus.completed` | `{ phase: FocusPhase; next: FocusPhase }` | all |
| `hotkey.pressed` | `{ name: 'toggleCat' \| 'startFocus' \| 'quickNote' }` | all (never while `hotkeys.suspend` is in effect) |
| `window.stateChanged` | `WindowState` | the window concerned |
| `app.themeChanged` | `{ theme }` | all (host mirrors `settings.changed` for key `app.theme`) |

## 5. Cat settings model

```ts
interface CatSettings {
  enabled: boolean;              // CatEnabled. false → the cat window is hidden and never shown. Default true
  startWithApp: boolean;         // show the cat when the application starts. Default true
  autoWalk: boolean;             // AutoWalk. false → the cat stays where it is (it still idles, sits and sleeps). Default true
  alwaysOnTop: boolean;          // Default true
  interaction: boolean;          // "Cat Interaction". false → the cat ignores the mouse completely (always click-through). Default true
  clickThroughWhenIdle: boolean; // ClickThrough. true → clicks pass through the cat until the cursor rests on it. Default false
  randomIdle: boolean;           // RandomBehavior, part 1: sit, look around and sleep between walks. Default true
  randomActions: boolean;        // RandomBehavior, part 2: stretch, jump, short runs, happy wiggles. Default true
  sound: boolean;                // SoundEnabled: an occasional meow or purr. Default FALSE
  walkingSpeed: number;          // WalkingSpeed multiplier 0.5–2 of the base walk (about 55 DIP/s). Default 1
  scale: number;                 // CatSize: 0.1–2 (10 %–200 %) of the reference cat box, 2 decimals. Default 1
  theme: string;                 // CatTheme id, ^[a-z0-9][a-z0-9-]{0,31}$ (catalogue: cat-sprite/cat-themes.ts). Default 'classic'
  opacity: number;               // 0.3–1, applied by CSS in the cat window. Default 1
}
```
The position (PositionX, PositionY, MonitorId) is stored in the `window_states` row `cat`.

A stored `cat.settings` written before scale and themes existed has `size` instead of `scale`: it is read as small 0.7,
medium 1, large 1.4, and `theme` defaults to `classic`. `size` is dropped on the next save. The host stores `theme` as
given (after the pattern check) and never interprets it: a theme id the UI does not know is drawn as `classic`, so themes
can be added or removed without a host change.

The host applies `interaction` and `clickThroughWhenIdle` itself. `interaction=false` means click-through without
hover-to-interact. `clickThroughWhenIdle=true` means click-through with hover-to-interact. Otherwise the cat is
interactive, but only inside its hit region. `cat.setClickThrough` overrides this at runtime; for example the UI turns
click-through off while a menu is open and hands control back with the settings-driven value afterwards.

Legacy conversion runs once at start-up, when `cat.settings` is missing and `petbook.settings` exists. `enabled`,
`alwaysOnTop`, `startWithApp` and `opacity` carry over and the Pet Book `size` becomes `scale` (small 0.7, medium 1,
large 1.4); everything else takes the defaults above, so sound stays off. The `window_states` row `petbook` becomes the cat's starting position (monitor and x/y) and is deleted.

## 6. Database schema (Database/Migrations/001_initial.sql …)

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);           -- value = JSON
CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', color TEXT NULL,
                    pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NULL, completed INTEGER NOT NULL DEFAULT 0,
                    priority INTEGER NOT NULL DEFAULT 0, due_at TEXT NULL, completed_at TEXT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- created as pet_book_actions by 001; 002_cat_companion.sql renames it to quick_actions, deletes rows of removed types
-- and renames the untouched default 'pin' action to "Always on Top" (as actions.reset does)
CREATE TABLE quick_actions (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0, route TEXT NULL, action_type TEXT NOT NULL, payload TEXT NULL);
CREATE TABLE window_states (window_id TEXT PRIMARY KEY, monitor TEXT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL,
                    height INTEGER NOT NULL, is_maximized INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, phase TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NULL,
                    planned_seconds INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
```
SQLite is opened with `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Migrations are embedded resources and
applied in version order inside a transaction on startup.

## 7. Cat window geometry

* Cat box (CSS px, 4:3): `round(160 × scale)` × `round(120 × scale)`, at least 16 × 12 (so 100 % = 160 × 120,
  200 % = 320 × 240). The cat's feet touch the bottom edge of the box
  (a soft ground shadow is drawn inside the box), so the box bottom is the cat's floor line.
* Layout `cat`: window = cat box. `menu`: width max(box width, 240), height box height + 360 (context menu above or
  below the cat). `panel`: width max(box width, 340), height box height + 456 (companion panel). The cat box sits in the
  anchor corner; the menu or panel spans the full window width on the other side.
* The host converts CSS px to physical px with the window's current DPI (`Form.DeviceDpi / 96`).
* Walking and dragging keep the cat box **fully** inside the work area of one monitor (the taskbar is excluded). Walks
  never cross monitors; dragging can carry the cat to any monitor.
* Restore: look up the monitor device name of the `window_states` row `cat`; if it is missing use the primary monitor,
  then clamp into that monitor's work area. Without a saved position the cat starts at the bottom-right of the primary
  work area, 48 px from the right edge, standing on the taskbar line.
* Display changes (monitor unplugged, resolution, DPI or taskbar change) move the cat back into a valid work area and
  emit `cat.screenChanged`.
* Hosting: the cat window uses WebView2 **visual hosting** (`CoreWebView2CompositionController` rendered into a
  DirectComposition visual on a `WS_EX_NOREDIRECTIONBITMAP` window), not the windowed WinForms control. That gives true
  per-pixel transparency, and it is the only mode that keeps rendering when the window is made click-through with
  `WS_EX_LAYERED | WS_EX_TRANSPARENT` (a windowed WebView2 in a layered window draws nothing – verified on Windows 11).
  In this mode the host forwards mouse input to WebView2 itself (`SendMouseInput`); keyboard input works once the
  controller has focus. The window region (`cat.setHitRegion`) clips both drawing and hit testing.

## 8. Security posture
* `AreHostObjectsAllowed=false`, `AreDevToolsEnabled` only in dev, `AreDefaultContextMenusEnabled` only in dev,
  `IsStatusBarEnabled=false`, `AreBrowserAcceleratorKeysEnabled=false` in production, `IsZoomControlEnabled=false`.
* `NavigationStarting`: allow only the app origin; anything else is cancelled and opened in the default browser when http(s).
* `NewWindowRequested`: handled → open externally for http(s), otherwise ignored.
* Only the commands above exist. File access is user-mediated dialogs only.
