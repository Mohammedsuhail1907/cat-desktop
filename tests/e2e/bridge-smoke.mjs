#!/usr/bin/env node
/**
 * CatDesktop end-to-end smoke test for the real desktop host (CatDesktop.exe + WebView2 + SQLite).
 *
 * Launches a Debug build with an isolated data folder and the Chrome DevTools Protocol enabled, drives both
 * WebView2 pages (main shell + Cat Companion) over CDP, talks to the host exactly like Angular does (contract envelopes
 * through window.chrome.webview.postMessage) and checks the behaviour promised by docs/DESKTOP-CONTRACT.md.
 *
 * Plain Node 22 ESM, no npm dependencies (global fetch + WebSocket). Windows only.
 *
 *   node tests/e2e/bridge-smoke.mjs [--exe <CatDesktop.exe>] [--port 9333] [--keep-data] [--long]
 *
 * Exit code = number of failed checks. See tests/e2e/README.md.
 *
 * Ground rules (the suite runs next to a real user session):
 *   - never injects OS mouse/keyboard input; UI checks use DOM events through CDP only;
 *   - never triggers an http(s) navigation or app.openExternal with a real URL (that would open the user's browser);
 *   - kills only the process it spawned (by PID) and deletes only the temp data folder it created.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DEFAULT_EXE = path.join(REPO, 'Desktop', 'CatDesktop.Host', 'bin', 'Debug', 'net9.0-windows', 'CatDesktop.exe');
const APP_ORIGIN = 'https://app.catdesktop.local';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Contract section 3 "Default actions (seeded by migration)". */
const DEFAULT_ACTIONS = [
  { id: 'home', actionType: ['navigate'], route: '/dashboard' },
  { id: 'quick-note', actionType: ['quick-note'], route: null },
  { id: 'tasks', actionType: ['tasks'], route: null },
  { id: 'focus', actionType: ['focus'], route: null },
  { id: 'reminders', actionType: ['reminders'], route: null },
  { id: 'pin', actionType: ['pin'], route: null },
  { id: 'search', actionType: ['search', 'navigate'], route: '/notes' },
  { id: 'settings', actionType: ['navigate'], route: '/settings' },
];

/** Host log WARN/ERROR lines this suite provokes on purpose (or that a second CatDesktop instance causes). */
const EXPECTED_HOST_WARNINGS = [
  { pattern: /Could not register all global hotkeys at once/, why: 'a saved shortcut is taken by another application' },
  { pattern: /RegisterHotKey failed for \w+ '[^']+' \(win32 error 1409\)/, why: 'hotkey conflict' },
  { pattern: /Hotkey '[^']+' \(\w+\) not registered/, why: 'hotkey conflict' },
  { pattern: /Could not restore shortcut \w+ '[^']+' \(win32 error 1409\)/, why: 'a shortcut taken by another application while hotkeys were suspended' },
  { pattern: /Bridge: unknown command 'e2e\.unknownCommand'/, why: 'deliberate unknown-command check' },
  { pattern: /dropped non-string web message/, why: 'deliberate non-string message check' },
  { pattern: /Bridge: unparseable message/, why: 'deliberate malformed-JSON check' },
];

/** Page diagnostics this suite provokes on purpose (matched only inside the given section). */
const EXPECTED_PAGE_DIAGNOSTICS = [
  { section: /^11\./, pattern: /Not allowed to load local resource: file:/i, why: 'security check navigates to file://' },
  { section: /^11\./, pattern: /^net::ERR_ABORTED \(canceled\)/, why: 'the host cancels the about:blank navigation' },
  {
    section: /^12b\./,
    // Depending on timing Chromium reports the cancelled document request as aborted, or as denied by the virtual host
    // (it serves no directory index) when the request had already started; either way the navigation is cancelled.
    pattern: /^net::ERR_(ABORTED \(canceled\)|ACCESS_DENIED) https:\/\/app\.catdesktop\.local\/$/,
    why: 'the host cancels a reload of the bare origin and loads /index.html#/… instead',
  },
];

/** Exact field sets of the contract models (docs/DESKTOP-CONTRACT.md §3, §5). */
const SHAPES = {
  AppInfo: ['version', 'windowKind', 'devMode', 'dataDirectory', 'databasePath', 'platform', 'startedAt'],
  Note: ['id', 'title', 'content', 'color', 'pinned', 'createdAt', 'updatedAt'],
  TaskItem: ['id', 'title', 'notes', 'completed', 'priority', 'dueAt', 'completedAt', 'sortOrder', 'createdAt', 'updatedAt'],
  WindowState: ['windowId', 'monitor', 'x', 'y', 'width', 'height', 'isMaximized', 'isMinimized', 'isVisible', 'alwaysOnTop'],
  CatSettings: ['enabled', 'startWithApp', 'autoWalk', 'alwaysOnTop', 'interaction', 'clickThroughWhenIdle', 'randomIdle', 'randomActions', 'sound', 'walkingSpeed', 'scale', 'theme', 'opacity'],
  CatScreenInfo: ['monitor', 'monitors', 'window', 'box', 'room'],
  MonitorInfo: ['id', 'primary', 'bounds', 'workArea', 'scale'],
  CatWalkResult: ['dx', 'dy', 'durationMs', 'accelMs', 'facing'],
  CatLayoutResult: ['mode', 'anchor', 'width', 'height', 'box'],
  CatDragEnded: ['x', 'y', 'monitor', 'moved', 'distance'],
  QuickAction: ['id', 'name', 'icon', 'enabled', 'order', 'route', 'actionType', 'payload'],
  FocusSettings: ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'sessionsBeforeLongBreak', 'autoStartBreaks', 'autoStartFocus', 'notify', 'sound'],
  FocusState: ['phase', 'status', 'remainingSeconds', 'totalSeconds', 'completedFocusSessions', 'startedAt', 'endsAt'],
  FocusStats: ['todayFocusSessions', 'todayFocusMinutes', 'totalFocusSessions', 'totalFocusMinutes'],
  Hotkeys: ['toggleCat', 'startFocus', 'quickNote'],
  DataInfo: ['databasePath', 'sizeBytes', 'noteCount', 'taskCount', 'schemaVersion'],
};
/** Contract fields that are optional ("route?", "payload?"): may be absent. */
const OPTIONAL_FIELDS = { QuickAction: ['route', 'payload'] };

/** Contract §5 defaults. */
const DEFAULT_CAT_SETTINGS = {
  enabled: true, startWithApp: true, autoWalk: true, alwaysOnTop: true, interaction: true, clickThroughWhenIdle: false,
  randomIdle: true, randomActions: true, sound: false, walkingSpeed: 1, scale: 1, theme: 'classic', opacity: 1,
};
/** Contract §7 cat box for a scale (CSS px): round(160 × scale) × round(120 × scale), at least 16 × 12. */
const catBox = (scale) => ({ width: Math.max(16, Math.round(160 * scale)), height: Math.max(12, Math.round(120 * scale)) });
/** Contract §7 extra area of the menu / panel layouts. */
const CAT_LAYOUTS = { menu: { minWidth: 240, extraHeight: 360 }, panel: { minWidth: 340, extraHeight: 456 } };

/** A gesture nobody uses, held by a helper process to simulate "shortcut taken by another application". */
const CONFLICT_GESTURE = 'Ctrl+Alt+Shift+F10';
const FREE_GESTURE = 'Ctrl+Alt+Shift+F11';
const SECOND_FREE_GESTURE = 'Ctrl+Alt+Shift+F9';
/** Virtual-key codes of the three gestures above (all use Ctrl+Alt+Shift). */
const VK = { [CONFLICT_GESTURE]: 0x79, [FREE_GESTURE]: 0x7a, [SECOND_FREE_GESTURE]: 0x78 };

// =====================================================================================================
// Options
// =====================================================================================================

function parseArgs(argv) {
  const opts = { exe: DEFAULT_EXE, port: 9333, keepData: false, long: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--exe': opts.exe = path.resolve(value()); break;
      case '--port': opts.port = Number(value()); break;
      case '--keep-data': opts.keepData = true; break;
      case '--long': opts.long = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`Unknown argument '${argv[i]}' (try --help)`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 1024 || opts.port >= 65536) throw new Error('--port must be an integer 1025-65535');
  return opts;
}

const USAGE = `Usage: node tests/e2e/bridge-smoke.mjs [options]
  --exe <path>   CatDesktop.exe to test (Debug build). Default: ${path.relative(REPO, DEFAULT_EXE)}
  --port <n>     Chrome DevTools Protocol port on 127.0.0.1 (default 9333)
  --keep-data    keep the temp data folder (database, logs) after the run
  --long         also run a real 1-minute focus phase and wait for focus.completed,
                 and wait for the 60 s automatic resume of suspended hotkeys`;

// =====================================================================================================
// Reporting
// =====================================================================================================

const results = [];
let currentSection = 'setup';
let currentRun = 'run1';

function log(line = '') { process.stdout.write(line + '\n'); }
function info(line) { log(`      · ${line}`); }

function section(title) {
  currentSection = title;
  log(`\n=== ${title}`);
}

function fmt(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    const s = JSON.stringify(value);
    return s.length > 700 ? s.slice(0, 700) + '…' : s;
  } catch {
    return String(value);
  }
}

function check(name, ok, detail) {
  const passed = !!ok;
  results.push({ section: currentSection, name, passed, detail: passed ? undefined : detail });
  log(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && detail !== undefined ? `\n        ↳ ${fmt(detail)}` : ''}`);
  return passed;
}

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
  }
  return value;
}

const deepEqual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const checkEqual = (name, actual, expected) => check(name, deepEqual(actual, expected), { actual, expected });

/** The object carries exactly the contract fields of `model` (no leaked host-only properties, nothing missing). */
function checkShape(model, value, label = model) {
  const keys = Object.keys(value ?? {});
  const expected = SHAPES[model];
  const optional = OPTIONAL_FIELDS[model] ?? [];
  const extra = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !keys.includes(k) && !optional.includes(k));
  return check(`${label} has exactly the contract fields of ${model}`, extra.length === 0 && missing.length === 0, { extra, missing });
}

/** .NET Math.Round(double) semantics (banker's rounding), used by the host for CSS → physical px. */
function roundHalfEven(v) {
  const floor = Math.floor(v);
  const diff = v - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(v);
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p) => {
    let full = path.resolve(p);
    try { full = fs.realpathSync.native(full); } catch { /* may not exist */ }
    return full.replace(/[\\/]+$/, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

async function until(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

// =====================================================================================================
// Chrome DevTools Protocol client (one WebSocket per page target)
// =====================================================================================================

class Cdp {
  static async connect(wsUrl, label) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout (${label})`)), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP connect failed (${label}): ${e.message ?? e.type}`)); }, { once: true });
    });
    return new Cdp(ws, label);
  }

  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP socket closed (${label})`));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${p.method} failed (${this.label}): ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const handler of this.handlers.get(msg.method) ?? []) {
        try { handler(msg.params ?? {}); } catch (err) { log(`WARN  CDP handler for ${msg.method} threw: ${err}`); }
      }
    }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(new Error(`CDP socket closed (${this.label})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms (${this.label})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { timeoutMs = 20_000, userGesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, timeoutMs + 2_000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`[${this.label}] evaluate failed: ${d.exception?.description ?? d.text}\n  expression: ${expression.slice(0, 300)}`);
    }
    return r.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * Installed into every page. Mirrors DesktopBridgeService: posts contract envelopes as JSON strings and resolves on the
 * response with the same id; records every host event with a timestamp.
 */
const PAGE_HELPER = String.raw`(() => {
  if (window.__e2e) return 'present';
  const wv = window.chrome && window.chrome.webview;
  if (!wv) throw new Error('window.chrome.webview is missing');
  const pending = new Map();
  const events = [];
  wv.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'response') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
    } else if (m.kind === 'event') {
      events.push({ name: m.name, data: m.data, t: Date.now() });
    }
  });
  const track = (id, timeoutMs, send) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ kind: 'response', id, ok: false, error: { code: 'e2e_timeout', message: 'no response within ' + timeoutMs + ' ms' } });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    send();
  });
  window.__e2e = {
    events,
    invoke(command, payload, timeoutMs = 15000) {
      const envelope = { kind: 'request', id: crypto.randomUUID(), command };
      if (payload !== undefined) envelope.payload = payload;
      return track(envelope.id, timeoutMs, () => wv.postMessage(JSON.stringify(envelope)));
    },
    /** Any envelope (e.g. an unknown kind), still posted as a JSON string. */
    postEnvelope(envelope, timeoutMs = 3000) {
      const e = { id: crypto.randomUUID(), ...envelope };
      return track(e.id, timeoutMs, () => wv.postMessage(JSON.stringify(e)));
    },
    /** A valid request posted as an object instead of a JSON string (not part of the contract). */
    postObject(command, timeoutMs = 1500) {
      const e = { kind: 'request', id: crypto.randomUUID(), command };
      return track(e.id, timeoutMs, () => wv.postMessage(e));
    },
    /** A truncated JSON string that still carries a recognisable id. */
    postMalformed(command, timeoutMs = 1500) {
      const id = crypto.randomUUID();
      return track(id, timeoutMs, () => wv.postMessage('{"kind":"request","id":"' + id + '","command":"' + command + '"'));
    },
    since(index, name) { return events.slice(index).filter((e) => !name || e.name === name); },
    waitFor(name, index, timeoutMs, predicate) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          for (let i = index; i < events.length; i++) {
            const e = events[i];
            if (e.name === name && (!predicate || predicate(e.data))) return resolve(e);
          }
          if (Date.now() >= deadline) return resolve(null);
          setTimeout(tick, 20);
        };
        tick();
      });
    },
  };
  return 'installed';
})()`;

class BridgeFailure extends Error {
  constructor(command, response) {
    super(`${command} failed: ${fmt(response.error ?? response)}`);
    this.response = response;
  }
}

class Page {
  constructor(cdp, kind, targetId) {
    this.cdp = cdp;
    this.kind = kind;
    this.targetId = targetId;
  }

  eval(expression, options) { return this.cdp.eval(expression, options); }

  /** Full response envelope ({ ok, result } or { ok: false, error }). */
  invoke(command, payload, timeoutMs = 15_000) {
    const args = `${JSON.stringify(command)}, ${payload === undefined ? 'undefined' : JSON.stringify(payload)}, ${timeoutMs}`;
    return this.eval(
      `window.__e2e ? window.__e2e.invoke(${args}) : Promise.reject(new Error('e2e helper missing - did the page reload?'))`,
      { timeoutMs: timeoutMs + 2_000 },
    );
  }

  /** Result of a command that must succeed. */
  async ok(command, payload) {
    const r = await this.invoke(command, payload);
    if (!r || !r.ok) throw new BridgeFailure(command, r ?? {});
    return r.result;
  }

  mark() { return this.eval('window.__e2e.events.length'); }

  events(since, name) { return this.eval(`window.__e2e.since(${since}, ${JSON.stringify(name ?? null)})`); }

  /** First event `name` recorded since `since` (optionally matching a JS predicate source), or null. */
  waitEvent(name, since, timeoutMs = 3_000, predicateSource = 'null') {
    return this.eval(`window.__e2e.waitFor(${JSON.stringify(name)}, ${since}, ${timeoutMs}, ${predicateSource})`, { timeoutMs: timeoutMs + 2_000 });
  }

  /** Polls a page expression until it is truthy; returns the last value. */
  waitUntil(expression, timeoutMs = 5_000, intervalMs = 100) {
    return until(() => this.eval(expression).catch(() => false), timeoutMs, intervalMs);
  }
}

// =====================================================================================================
// Diagnostics (console errors, exceptions, failed requests)
// =====================================================================================================

const diagnostics = [];

function attachDiagnostics(cdp, kind) {
  const push = (type, text) => diagnostics.push({ page: kind, run: currentRun, section: currentSection, type, text });
  const urls = new Map();
  const argText = (a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type);
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? []).map(argText).join(' ');
    if (p.type === 'error' || p.type === 'assert') push('console.error', text);
    else if (p.type === 'warning') push('console.warn', text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {};
    push('exception', d.exception?.description ?? d.text ?? 'unknown exception');
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry ?? {};
    const text = `${e.source}: ${e.text}${e.url ? ` (${e.url})` : ''}`;
    if (e.level === 'error') push('log.error', text);
    else if (e.level === 'warning') push('log.warn', text);
  });
  cdp.on('Network.requestWillBeSent', (p) => urls.set(p.requestId, p.request?.url));
  cdp.on('Network.loadingFailed', (p) => {
    push('network.failed', `${p.errorText}${p.canceled ? ' (canceled)' : ''}${p.blockedReason ? ` blocked:${p.blockedReason}` : ''} ${urls.get(p.requestId) ?? ''}`);
  });
  cdp.on('Network.responseReceived', (p) => {
    if (p.response?.status >= 400) push('network.http', `${p.response.status} ${p.response.url}`);
  });
}

function isExpectedDiagnostic(d) {
  return EXPECTED_PAGE_DIAGNOSTICS.find((e) => e.section.test(d.section) && e.pattern.test(d.text));
}

// =====================================================================================================
// Process / OS helpers (read-only queries; no input injection)
// =====================================================================================================

function runPowerShell(script, timeoutMs = 60_000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Monitor layout in physical pixels (per-monitor DPI aware), like the host sees it. */
function queryScreens() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CatDesktopE2EDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
[void][CatDesktopE2EDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    name = $_.DeviceName; primary = $_.Primary
    bounds = [pscustomobject]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
    work = [pscustomobject]@{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height }
  } })
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
[pscustomobject]@{ screens = $screens; virtual = [pscustomobject]@{ x = $v.X; y = $v.Y; width = $v.Width; height = $v.Height } } | ConvertTo-Json -Depth 5 -Compress
`;
  const parsed = JSON.parse(runPowerShell(script));
  parsed.screens = Array.isArray(parsed.screens) ? parsed.screens : [parsed.screens];
  return parsed;
}

/** PIDs of other CatDesktop.exe processes (e.g. the user's own copy). */
function otherCatDesktopPids(ownPid) {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq CatDesktop.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out
      .split(/\r?\n/)
      .filter((l) => l.startsWith('"CatDesktop.exe"'))
      .map((l) => Number(l.split('","')[1]))
      .filter((pid) => Number.isInteger(pid) && pid !== ownPid);
  } catch {
    return [];
  }
}

/** WebView2 processes that belong to the test data folder (they outlive the host for a moment after exit). */
function webViewPidsFor(dataDir) {
  const needle = dataDir.replace(/'/g, "''");
  try {
    const out = runPowerShell(
      `@(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${needle}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }) -join ','`,
    );
    return out ? out.split(',').map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function waitForWebViewShutdown(dataDir, timeoutMs = 20_000) {
  const remaining = await until(async () => webViewPidsFor(dataDir).length === 0, timeoutMs, 750);
  return !!remaining;
}

/**
 * Starts a helper process that registers `gesture` (default CONFLICT_GESTURE) as a global hotkey (RegisterHotKey on its
 * own thread) and keeps it until killed. Resolves to { child, held, error }. Only the obscure Ctrl+Alt+Shift+F9/F10/F11
 * gestures are ever taken; no input is ever sent.
 */
function startHotkeyHolder(gesture = CONFLICT_GESTURE) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CatDesktopE2EHotkey { [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk); }'
# Ctrl(2) + Alt(1) + Shift(4) + MOD_NOREPEAT(0x4000); VK_F9..F11 = 0x78..0x7A
if ([CatDesktopE2EHotkey]::RegisterHotKey([IntPtr]::Zero, 0xBEEF, 0x4007, ${VK[gesture]})) {
  [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()
  Start-Sleep -Seconds 900
} else {
  [Console]::Out.WriteLine('FAILED ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); [Console]::Out.Flush()
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return new Promise((resolve) => {
    let out = '';
    const done = (result) => { clearTimeout(timer); resolve({ child, ...result }); };
    const timer = setTimeout(() => done({ held: false, error: 'timeout' }), 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('HELD')) done({ held: true, error: null });
      const failed = /FAILED (\d+)/.exec(out);
      if (failed) done({ held: false, error: Number(failed[1]) });
    });
    child.on('exit', () => done({ held: false, error: out.trim() || 'exited' }));
  });
}

/**
 * Asks Windows whether another process can register `gesture` right now: registers it and releases it at once.
 * Returns 'free' or 'taken <win32 error>' (1409 = already registered, e.g. by the host).
 */
function probeHotkey(gesture) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CatDesktopE2EProbe { [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk); [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id); }'
if ([CatDesktopE2EProbe]::RegisterHotKey([IntPtr]::Zero, 0xBEF0, 0x4007, ${VK[gesture]})) {
  [void][CatDesktopE2EProbe]::UnregisterHotKey([IntPtr]::Zero, 0xBEF0)
  'free'
} else {
  'taken ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
`;
  try {
    return runPowerShell(script, 30_000);
  } catch (err) {
    return `probe failed: ${err.message.split('\n')[0]}`;
  }
}

function stopHotkeyHolder(ctx) {
  if (ctx.holder?.child && ctx.holder.child.exitCode === null) killTree(ctx.holder.child.pid);
  ctx.holder = null;
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* already gone */ }
}

function readHostLog(dataDir) {
  const dir = path.join(dataDir, 'Logs');
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((f) => /^host-\d{8}\.log$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('');
}

/** Host log text written since the last "CatDesktop … starting." line (the current process). */
function currentRunLog(dataDir) {
  const text = readHostLog(dataDir);
  const idx = text.lastIndexOf(' starting. devMode=');
  return idx < 0 ? text : text.slice(text.lastIndexOf('\n', idx) + 1);
}

// =====================================================================================================
// Launch & attach
// =====================================================================================================

function launch(opts, dataDir) {
  const env = { ...process.env, CATDESKTOP_DATA_DIR: dataDir, CATDESKTOP_CDP_PORT: String(opts.port) };
  for (const key of Object.keys(env)) {
    if (/^CATDESKTOP_(DEV_URL|VERBOSE)$/i.test(key)) delete env[key];
  }
  const child = spawn(opts.exe, ['--verbose'], { env, stdio: 'ignore', windowsHide: false });
  const proc = { child, pid: child.pid, exited: false, code: null, error: null };
  proc.exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      proc.exited = true;
      proc.code = code;
      proc.signal = signal;
      resolve(code);
    });
    child.on('error', (err) => {
      proc.error = err;
      proc.exited = true;
      resolve(null);
    });
  });
  return proc;
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  return res.json();
}

const appPages = (targets) => targets.filter((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(APP_ORIGIN + '/'));

async function discoverTargets(port, proc, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    if (proc.exited) throw new Error(`CatDesktop exited during start-up (code ${proc.code}${proc.error ? `, ${proc.error.message}` : ''})`);
    try {
      last = await listTargets(port);
      const pages = appPages(last);
      const cat = pages.find((t) => t.url.includes('#/cat'));
      const main = pages.find((t) => t !== cat && t.url.includes('#/'));
      if (main && cat) return { main, cat };
    } catch { /* DevTools endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error(
    `CDP targets not found within ${timeoutMs / 1000}s on port ${port}; last list: ${fmt(last.map((t) => `${t.type} ${t.url}`))}. ` +
      'Is this a Debug build (CATDESKTOP_CDP_PORT is compiled into Debug builds only)?',
  );
}

/** Page expression: the document is loaded, hosted and the Angular UI of that window has rendered. */
function bootedExpression(kind) {
  const appReady = kind === 'main'
    ? `!!document.querySelector('app-shell nav')`
    : `document.body.classList.contains('cat-window') && !!document.querySelector('app-cat-sprite')`;
  return `document.readyState === 'complete' && !!(window.chrome && window.chrome.webview) && (${appReady})`;
}

async function attachPage(target, kind) {
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl, kind);
  attachDiagnostics(cdp, kind);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  const page = new Page(cdp, kind, target.id);
  const ready = await page.waitUntil(bootedExpression(kind), 45_000, 200);
  if (!ready) throw new Error(`${kind} page did not finish bootstrapping (Angular shell not rendered)`);
  await page.eval(PAGE_HELPER);
  return page;
}

/**
 * After a reload: waits until a NEW document (one without the e2e helper) has booted the Angular UI, then installs the
 * helper there. Resolves true when that happened within the timeout.
 */
async function reattachAfterReload(page, timeoutMs = 20_000) {
  const booted = await page.waitUntil(`!window.__e2e && ${bootedExpression(page.kind)}`, timeoutMs, 100);
  if (!booted) return false;
  await page.eval(PAGE_HELPER);
  return true;
}

/** After an unexpected navigation: load the app again (an app-origin URL, allowed by the host) and re-install the helper. */
async function recoverPage(page) {
  info(`recovering the ${page.kind} page`);
  await page.cdp.send('Page.navigate', { url: `${APP_ORIGIN}/index.html#/${page.kind === 'main' ? 'dashboard' : 'cat'}` }).catch(() => {});
  await page.waitUntil(`document.readyState === 'complete' && !!(window.chrome && window.chrome.webview) && !!document.querySelector('app-root *')`, 15_000, 200);
  await page.eval(PAGE_HELPER).catch(() => {});
}

async function startApp(ctx) {
  ctx.proc = launch(ctx.opts, ctx.dataDir);
  info(`spawned ${path.basename(ctx.opts.exe)} pid ${ctx.proc.pid} (${currentRun})`);
  const targets = await discoverTargets(ctx.opts.port, ctx.proc);
  ctx.main = await attachPage(targets.main, 'main');
  ctx.cat = await attachPage(targets.cat, 'cat');
}

function detachPages(ctx) {
  ctx.main?.cdp.close();
  ctx.cat?.cdp.close();
  ctx.main = null;
  ctx.cat = null;
}

/** app.exit from the main window; resolves with the exit code or 'timeout'. */
async function exitApp(ctx, label) {
  const r = await ctx.main.invoke('app.exit', undefined, 5_000).catch((err) => ({ ok: false, error: { code: 'cdp', message: String(err) } }));
  check(`${label}: app.exit responds ok`, r?.ok === true, r);
  const code = await Promise.race([ctx.proc.exitPromise, sleep(10_000).then(() => 'timeout')]);
  check(`${label}: process exits within 10 s`, code !== 'timeout', { pid: ctx.proc.pid });
  check(`${label}: exit code 0`, code === 0, { code, signal: ctx.proc.signal });
  detachPages(ctx);
  return code;
}

// =====================================================================================================
// Assertion helpers
// =====================================================================================================

async function expectError(page, command, payload, code, label) {
  const r = await page.invoke(command, payload);
  return check(label ?? `${command} → ${code}`, r && r.ok === false && r.error?.code === code, r?.ok ? { unexpectedResult: r.result } : r?.error ?? r);
}

async function expectEventIn(page, name, since, label, predicateSource = 'null', timeoutMs = 3_000) {
  const e = await page.waitEvent(name, since, timeoutMs, predicateSource);
  check(label, !!e, `no '${name}' event in the ${page.kind} window within ${timeoutMs} ms`);
  return e;
}

async function expectNoEventIn(page, name, since, label, settleMs = 600) {
  await sleep(settleMs);
  const events = await page.events(since, name);
  return check(label, events.length === 0, events);
}

function isNoteOrder(list) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a.pinned !== b.pinned) {
      if (!a.pinned) return false;
    } else if (a.updatedAt < b.updatedAt) {
      return false;
    }
  }
  return true;
}

const insideArea = (s, a) => s.x >= a.x && s.y >= a.y && s.x + s.width <= a.x + a.width && s.y + s.height <= a.y + a.height;
const overlap = (s, a) => ({
  w: Math.min(s.x + s.width, a.x + a.width) - Math.max(s.x, a.x),
  h: Math.min(s.y + s.height, a.y + a.height) - Math.max(s.y, a.y),
});

// =====================================================================================================
// Sections
// =====================================================================================================

async function testAppInfo(ctx) {
  const { main, cat } = ctx;
  const mainInfo = await main.ok('app.getInfo');
  const catInfo = await cat.ok('app.getInfo');
  check('main window: app.getInfo windowKind = main', mainInfo.windowKind === 'main', mainInfo);
  check('cat window: app.getInfo windowKind = cat', catInfo.windowKind === 'cat', catInfo);
  check('dataDirectory = the temp data folder', samePath(mainInfo.dataDirectory, ctx.dataDir), { dataDirectory: mainInfo.dataDirectory, expected: ctx.dataDir });
  check('databasePath = <data>\\Database\\application.db', samePath(mainInfo.databasePath, path.join(ctx.dataDir, 'Database', 'application.db')), mainInfo.databasePath);
  check("platform = 'windows' in both windows", mainInfo.platform === 'windows' && catInfo.platform === 'windows', { main: mainInfo.platform, cat: catInfo.platform });
  check('devMode = false (production UI from wwwroot)', mainInfo.devMode === false, mainInfo.devMode);
  check('version is a non-empty string', typeof mainInfo.version === 'string' && mainInfo.version.length > 0, mainInfo.version);
  check('startedAt is ISO-8601 UTC with milliseconds', ISO_UTC.test(mainInfo.startedAt), mainInfo.startedAt);
  check('both windows describe the same process', mainInfo.startedAt === catInfo.startedAt && mainInfo.dataDirectory === catInfo.dataDirectory, { mainInfo, catInfo });
  checkShape('AppInfo', mainInfo, 'app.getInfo');

  const env = (page) => page.eval(`(() => { const e = window.__catdesktop; return e ? { ...e, frozen: Object.isFrozen(e) } : null; })()`);
  const mainEnv = await env(main);
  const catEnv = await env(cat);
  check('window.__catdesktop injected in main (hosted, windowKind main, frozen)', mainEnv?.hosted === true && mainEnv.windowKind === 'main' && mainEnv.frozen && mainEnv.devMode === false, mainEnv);
  check('window.__catdesktop injected in the cat window (hosted, windowKind cat, frozen)', catEnv?.hosted === true && catEnv.windowKind === 'cat' && catEnv.frozen, catEnv);
  check('pages are served from the virtual host origin', (await main.eval('location.origin')) === APP_ORIGIN && (await cat.eval('location.origin')) === APP_ORIGIN);

  await expectError(main, 'e2e.unknownCommand', undefined, 'unsupported', 'unknown command → unsupported');
  const kind = await main.eval(`window.__e2e.postEnvelope({ kind: 'e2e-bogus', command: 'app.getInfo' })`);
  check("unknown envelope kind → unsupported", kind?.ok === false && kind.error?.code === 'unsupported', kind);

  const validationCases = [
    ['notes.get', {}, 'notes.get without id'],
    ['notes.get', undefined, 'notes.get without payload'],
    ['notes.get', { id: 42 }, 'notes.get with a numeric id'],
    ['notes.update', { title: 'x' }, 'notes.update without id'],
    ['notes.create', { title: 42 }, 'notes.create with a numeric title'],
    ['notes.create', { title: 'x', pinned: 'yes' }, "notes.create with pinned 'yes'"],
    ['tasks.create', { title: '' }, 'tasks.create with an empty title'],
    ['tasks.create', { title: '   ' }, 'tasks.create with a blank title'],
    ['tasks.create', {}, 'tasks.create without title'],
    ['tasks.create', { title: 'x', priority: 7 }, 'tasks.create with priority 7'],
    ['tasks.create', { title: 'x', dueAt: 'next tuesday' }, 'tasks.create with an unparseable dueAt'],
    ['settings.set', { key: 'bad key!', value: 1 }, 'settings.set with an invalid key'],
    ['settings.set', { key: 'e2e.novalue' }, 'settings.set without value'],
    ['settings.get', { key: '' }, 'settings.get with an empty key'],
    ['cat.setLayout', { mode: 'huge' }, "cat.setLayout 'huge'"],
    ['cat.moveTo', { x: 'left', y: 0 }, 'cat.moveTo with a non-numeric x'],
    ['cat.walk', { dx: 50 }, 'cat.walk without speed'],
    ['cat.saveSettings', 'large', 'cat.saveSettings with a string payload'],
    ['navigation.navigate', { route: 'https://x' }, "navigation.navigate 'https://x'"],
    ['navigation.navigate', { route: '//evil.example/notes' }, 'navigation.navigate with a protocol-relative route'],
    ['focus.start', { minutes: 0 }, 'focus.start with minutes 0'],
    ['focus.start', { phase: 'nap' }, "focus.start with phase 'nap'"],
    ['focus.saveSettings', { focusMinutes: 'abc' }, 'focus.saveSettings with a non-numeric duration'],
    ['actions.save', { actions: 'all' }, 'actions.save with a non-array'],
    ['hotkeys.set', undefined, 'hotkeys.set without payload'],
    ['app.showNotification', {}, 'app.showNotification without title'],
    ['app.showNotification', { title: 'x'.repeat(201) }, 'app.showNotification with a 201-char title'],
    ['window.setAlwaysOnTop', {}, 'window.setAlwaysOnTop without enabled'],
  ];
  for (const [command, payload, label] of validationCases) {
    await expectError(main, command, payload, 'validation', `${label} → validation`);
  }
  await expectError(main, 'app.openExternal', { url: 'file:///C:/Windows/win.ini' }, 'denied', 'app.openExternal file:// → denied (nothing opened)');
  await expectError(main, 'app.openExternal', { url: 'javascript:alert(1)' }, 'denied', 'app.openExternal javascript: → denied');
  await expectError(cat, 'window.minimize', undefined, 'unsupported', 'window.minimize from the cat window → unsupported');
  await expectError(cat, 'window.maximize', undefined, 'unsupported', 'window.maximize from the cat window → unsupported');

  const notes = await main.ok('notes.list', {});
  const tasks = await main.ok('tasks.list', { includeCompleted: true });
  const leftover = await main.ok('settings.get', { key: 'e2e.novalue' });
  check('rejected requests had no side effects (no notes/tasks/settings created)', notes.length === 0 && tasks.length === 0 && leftover.value === null, { notes, tasks, leftover });
  const mainState = await main.ok('window.getState');
  check('window.getState from main → windowId main, visible', mainState.windowId === 'main' && mainState.isVisible === true && mainState.width > 0, mainState);
  checkShape('WindowState', mainState, 'window.getState');
}

async function testNotes(ctx) {
  const { main, cat } = ctx;
  let catMark = await cat.mark();
  const a = await main.ok('notes.create', { title: 'E2E Alpha', content: 'first body', color: '#ffd166' });
  check('create returns a UUID id', UUID.test(a.id), a);
  check('create stores title/content/color; pinned defaults to false', a.title === 'E2E Alpha' && a.content === 'first body' && a.color === '#ffd166' && a.pinned === false, a);
  check('createdAt/updatedAt are ISO UTC and equal on create', ISO_UTC.test(a.createdAt) && a.createdAt === a.updatedAt, a);
  checkShape('Note', a, 'notes.create result');
  await expectEventIn(cat, 'notes.changed', catMark, 'notes.changed (main → create) arrives in the cat window');

  await sleep(5);
  const b = await main.ok('notes.create', { title: 'E2E Beta pinned', content: 'contains the needle word', pinned: true });
  check('create with pinned: true', b.pinned === true, b);
  const mainMark = await main.mark();
  const c = await cat.ok('notes.create', {});
  check('create with an empty payload → blank note (title "", content "", color null)', c.title === '' && c.content === '' && c.color === null && c.pinned === false, c);
  await expectEventIn(main, 'notes.changed', mainMark, 'notes.changed (cat → create) arrives in the main window');

  checkEqual('get returns the stored note', await main.ok('notes.get', { id: a.id }), a);

  await sleep(15);
  catMark = await cat.mark();
  const upd = await main.ok('notes.update', { id: a.id, content: 'second body' });
  check('partial update changes only content', upd.title === a.title && upd.color === a.color && upd.pinned === a.pinned && upd.content === 'second body', upd);
  check('update keeps createdAt and advances updatedAt', upd.createdAt === a.createdAt && upd.updatedAt > a.updatedAt && ISO_UTC.test(upd.updatedAt), { before: a, after: upd });
  await expectEventIn(cat, 'notes.changed', catMark, 'notes.changed (update) arrives in the cat window');
  checkEqual('get after update returns the updated note', await main.ok('notes.get', { id: a.id }), upd);
  const noColor = await main.ok('notes.update', { id: a.id, color: null });
  check('update with color: null clears the colour', noColor.color === null && noColor.content === 'second body', noColor);
  const blankColor = await main.ok('notes.update', { id: a.id, color: '#06d6a0' }).then(() => main.ok('notes.update', { id: a.id, color: '   ' }));
  check('update with a blank colour stores null', blankColor.color === null, blankColor);
  const recoloured = await main.ok('notes.update', { id: a.id, color: '#06d6a0', title: 'E2E Alpha' });
  await expectError(main, 'notes.update', { id: a.id, pinned: 'yes' }, 'validation', "update with pinned 'yes' → validation");
  checkEqual('rejected update left the note unchanged', await main.ok('notes.get', { id: a.id }), recoloured);

  const list = await main.ok('notes.list', {});
  check('list returns the 3 notes', list.length === 3, list.map((n) => n.title));
  check('list: pinned note first', list[0]?.id === b.id, list.map((n) => n.title));
  check('list: pinned first, then updatedAt descending', isNoteOrder(list), list.map((n) => [n.title, n.pinned, n.updatedAt]));
  const noPayload = await main.ok('notes.list');
  check('list without payload works', Array.isArray(noPayload) && noPayload.length === 3, noPayload);

  const search = async (term) => (await main.ok('notes.list', { search: term })).map((n) => n.id);
  checkEqual("search 'needle' (content) → only Beta", await search('needle'), [b.id]);
  checkEqual("search 'alpha' is case-insensitive → only Alpha", await search('alpha'), [a.id]);
  checkEqual("search 'SECOND BODY' → only Alpha", await search('SECOND BODY'), [a.id]);
  checkEqual("search '%' is literal (LIKE wildcards escaped) → nothing", await search('%'), []);
  checkEqual("search '_' is literal → nothing", await search('_'), []);
  check("search '' → everything", (await search('')).length === 3);

  const missing = randomUUID();
  await expectError(main, 'notes.get', { id: missing }, 'not_found', 'get missing id → not_found');
  await expectError(main, 'notes.update', { id: missing, title: 'x' }, 'not_found', 'update missing id → not_found');
  await expectError(main, 'notes.delete', { id: missing }, 'not_found', 'delete missing id → not_found');

  await expectError(main, 'notes.list', { search: 'x'.repeat(201) }, 'validation', 'search longer than 200 chars → validation');
  await expectError(main, 'notes.create', { content: 'x'.repeat(200_001) }, 'validation', 'content longer than 200 000 chars → validation');
  const text = 'Ünïcødé ✨ 😺 مرحبا 你好\nline two\ttab "quotes" \\ backslash';
  const big = 'lorem ipsum '.repeat(15_000);
  const uni = await cat.ok('notes.create', { title: 'E2E ünïcødé 😺', content: text + big });
  const uniBack = await main.ok('notes.get', { id: uni.id });
  check('unicode / control characters / 180 KB content round-trip exactly', uniBack.title === 'E2E ünïcødé 😺' && uniBack.content === text + big, { titleOk: uniBack.title === 'E2E ünïcødé 😺', length: uniBack.content.length });
  await main.ok('notes.delete', { id: uni.id });

  // Burst: 40 creates from each window at once, then 80 parallel deletes.
  const countBefore = (await main.ok('notes.list', {})).length;
  const burstExpr = (who) => `Promise.all(Array.from({ length: 40 }, (_, i) => window.__e2e.invoke('notes.create', { title: 'E2E burst ${who} ' + i })))`;
  const [fromMain, fromCat] = await Promise.all([main.eval(burstExpr('main'), { timeoutMs: 60_000 }), cat.eval(burstExpr('cat'), { timeoutMs: 60_000 })]);
  const created = [...fromMain, ...fromCat];
  const ids = new Set(created.filter((r) => r.ok).map((r) => r.result.id));
  check('80 concurrent creates from both windows all succeed with unique ids', created.every((r) => r.ok) && ids.size === 80, created.filter((r) => !r.ok).slice(0, 3));
  check('list count grew by exactly 80', (await main.ok('notes.list', {})).length === countBefore + 80);
  const deleted = await main.eval(`Promise.all(${JSON.stringify([...ids])}.map((id) => window.__e2e.invoke('notes.delete', { id })))`, { timeoutMs: 60_000 });
  check('80 concurrent deletes all succeed', deleted.every((r) => r.ok), deleted.filter((r) => !r.ok).slice(0, 3));
  check('list count back to where it was', (await main.ok('notes.list', {})).length === countBefore);

  catMark = await cat.mark();
  const del = await main.ok('notes.delete', { id: c.id });
  checkEqual('delete returns {}', del, {});
  await expectEventIn(cat, 'notes.changed', catMark, 'notes.changed (delete) arrives in the cat window');
  await expectError(main, 'notes.get', { id: c.id }, 'not_found', 'get after delete → not_found');
  check('list after delete has 2 notes', (await main.ok('notes.list', {})).length === 2);
}

async function testTasks(ctx) {
  const { main, cat } = ctx;
  let catMark = await cat.mark();
  const t1 = await main.ok('tasks.create', { title: 'E2E Task one', priority: 1, dueAt: '2026-10-01T09:30:00+02:00' });
  check('create: UUID id, completed false, completedAt null, notes null', UUID.test(t1.id) && t1.completed === false && t1.completedAt === null && t1.notes === null && t1.priority === 1, t1);
  check('dueAt with +02:00 offset normalised to UTC ISO', t1.dueAt === '2026-10-01T07:30:00.000Z', t1.dueAt);
  check('createdAt/updatedAt ISO UTC', ISO_UTC.test(t1.createdAt) && ISO_UTC.test(t1.updatedAt), t1);
  checkShape('TaskItem', t1, 'tasks.create result');
  await expectEventIn(cat, 'tasks.changed', catMark, 'tasks.changed (create) arrives in the cat window');

  const t2 = await main.ok('tasks.create', { title: '  E2E Task two  ', notes: 'remember the milk' });
  check('title is trimmed', t2.title === 'E2E Task two', t2.title);
  check('sortOrder increases for new tasks', t2.sortOrder > t1.sortOrder, [t1.sortOrder, t2.sortOrder]);
  const t3 = await main.ok('tasks.create', { title: 'E2E Task three', dueAt: '2026-12-24' });
  const localMidnight = new Date(2026, 11, 24).toISOString();
  check('date-only dueAt → local midnight as UTC ISO', t3.dueAt === localMidnight, { got: t3.dueAt, expected: localMidnight });
  const t4 = await cat.ok('tasks.create', { title: 'E2E Task four', dueAt: '2026-11-05T10:15:00Z' });
  check("dueAt '…Z' keeps its instant, gains milliseconds", t4.dueAt === '2026-11-05T10:15:00.000Z', t4.dueAt);
  check('priority defaults to 0', t4.priority === 0, t4.priority);

  const ids = (list) => list.map((t) => t.id);
  checkEqual('list (open only) ordered by sortOrder', ids(await main.ok('tasks.list', {})), [t1.id, t2.id, t3.id, t4.id]);

  const mainMark = await main.mark();
  catMark = await cat.mark();
  const t2done = await main.ok('tasks.toggle', { id: t2.id });
  check('toggle → completed with completedAt stamp', t2done.completed === true && ISO_UTC.test(t2done.completedAt ?? ''), t2done);
  await expectEventIn(main, 'tasks.changed', mainMark, 'tasks.changed (toggle) arrives in the main window');
  await expectEventIn(cat, 'tasks.changed', catMark, 'tasks.changed (toggle) arrives in the cat window');
  await sleep(15);
  const t1done = await main.ok('tasks.toggle', { id: t1.id });
  checkEqual('list default excludes completed tasks', ids(await main.ok('tasks.list', {})), [t3.id, t4.id]);
  checkEqual('list includeCompleted: open by sortOrder, then completed by completedAt desc', ids(await main.ok('tasks.list', { includeCompleted: true })), [t3.id, t4.id, t1.id, t2.id]);
  check('completedAt of the later toggle is later', t1done.completedAt > t2done.completedAt, [t1done.completedAt, t2done.completedAt]);

  const t2open = await main.ok('tasks.toggle', { id: t2.id });
  check('toggle again → open, completedAt cleared', t2open.completed === false && t2open.completedAt === null, t2open);

  const t3c = await main.ok('tasks.update', { id: t3.id, completed: true });
  check('update completed: true stamps completedAt', t3c.completed === true && ISO_UTC.test(t3c.completedAt ?? ''), t3c);
  await sleep(15);
  const t3c2 = await main.ok('tasks.update', { id: t3.id, completed: true, title: 'E2E Task three (done)' });
  check('completing an already completed task keeps its completedAt', t3c2.completedAt === t3c.completedAt && t3c2.title === 'E2E Task three (done)', { first: t3c.completedAt, second: t3c2.completedAt });

  const t2p = await main.ok('tasks.update', { id: t2.id, priority: 2 });
  check('partial update (priority) keeps title/notes/dueAt/sortOrder', t2p.priority === 2 && t2p.title === t2.title && t2p.notes === t2.notes && t2p.dueAt === t2.dueAt && t2p.sortOrder === t2.sortOrder, t2p);
  const t2due = await main.ok('tasks.update', { id: t2.id, dueAt: '2026-10-10T17:45:00.5+05:30' });
  check('update dueAt normalises to UTC ISO', t2due.dueAt === '2026-10-10T12:15:00.500Z', t2due.dueAt);
  const t2nodue = await main.ok('tasks.update', { id: t2.id, dueAt: null });
  check('update dueAt: null clears it', t2nodue.dueAt === null && t2nodue.priority === 2, t2nodue);
  await expectError(main, 'tasks.update', { id: t2.id, title: '' }, 'validation', 'update with an empty title → validation');
  await expectError(main, 'tasks.update', { id: t2.id, priority: -1 }, 'validation', 'update with priority -1 → validation');

  await main.ok('tasks.update', { id: t4.id, sortOrder: -5 });
  checkEqual('sortOrder update reorders open tasks', ids(await main.ok('tasks.list', {})), [t4.id, t2.id]);
  // Contract: sortOrder is an integer from -1,000,000 to 1,000,000; anything else is 'validation'.
  await expectError(main, 'tasks.update', { id: t2.id, sortOrder: 1_000_001 }, 'validation', 'update with sortOrder 1,000,001 → validation');
  await expectError(main, 'tasks.update', { id: t2.id, sortOrder: -1_000_001 }, 'validation', 'update with sortOrder -1,000,001 → validation');
  await expectError(main, 'tasks.update', { id: t2.id, sortOrder: 2 ** 31 }, 'validation', 'update with sortOrder 2^31 (int overflow) → validation');
  await expectError(main, 'tasks.update', { id: t2.id, sortOrder: '3' }, 'validation', "update with sortOrder '3' (string) → validation");
  check('rejected sortOrder updates changed nothing', (await main.ok('tasks.list', {})).find((t) => t.id === t2.id)?.sortOrder === t2.sortOrder);
  const atMin = await main.ok('tasks.update', { id: t4.id, sortOrder: -1_000_000 });
  check('sortOrder -1,000,000 (lower bound) is accepted', atMin.sortOrder === -1_000_000, atMin.sortOrder);
  checkEqual('… and keeps the task on top', ids(await main.ok('tasks.list', {})), [t4.id, t2.id]);

  const clearMark = await cat.mark();
  const cleared = await main.ok('tasks.clearCompleted');
  checkEqual('clearCompleted → { deleted: 2 }', cleared, { deleted: 2 });
  await expectEventIn(cat, 'tasks.changed', clearMark, 'tasks.changed (clearCompleted) arrives in the cat window');
  checkEqual('clearCompleted removed exactly the completed tasks', ids(await main.ok('tasks.list', { includeCompleted: true })), [t4.id, t2.id]);
  checkEqual('clearCompleted again → { deleted: 0 }', await main.ok('tasks.clearCompleted'), { deleted: 0 });

  const missing = randomUUID();
  await expectError(main, 'tasks.toggle', { id: missing }, 'not_found', 'toggle missing id → not_found');
  await expectError(main, 'tasks.update', { id: missing, title: 'x' }, 'not_found', 'update missing id → not_found');
  await expectError(main, 'tasks.delete', { id: missing }, 'not_found', 'delete missing id → not_found');
  checkEqual('delete returns {}', await main.ok('tasks.delete', { id: t4.id }), {});
  await expectError(main, 'tasks.toggle', { id: t4.id }, 'not_found', 'toggle after delete → not_found');

  // Upper bound: accepted, and a task created after it is appended at the (clamped) maximum instead of overflowing.
  const atMax = await main.ok('tasks.update', { id: t2.id, sortOrder: 1_000_000 });
  check('sortOrder 1,000,000 (upper bound) is accepted', atMax.sortOrder === 1_000_000, atMax.sortOrder);

  // Leave one open and one completed task for the persistence check.
  const t5 = await main.ok('tasks.create', { title: 'E2E Task five (completed)', priority: 1 });
  check('tasks.create after a task at 1,000,000 appends at the clamped maximum (1,000,000)', t5.sortOrder === 1_000_000, t5.sortOrder);
  await main.ok('tasks.toggle', { id: t5.id });
  const final = await main.ok('tasks.list', { includeCompleted: true });
  checkEqual('final task list: open "two", completed "five"', final.map((t) => [t.title, t.completed]), [['E2E Task two', false], ['E2E Task five (completed)', true]]);
}

async function testSettings(ctx) {
  const { main, cat } = ctx;
  let mm = await main.mark();
  let pm = await cat.mark();
  checkEqual("set 'e2e.string' → { key, value }", await main.ok('settings.set', { key: 'e2e.string', value: 'hello' }), { key: 'e2e.string', value: 'hello' });
  const pred = (key, value) => `(d) => d && d.key === ${JSON.stringify(key)} && JSON.stringify(d.value) === ${JSON.stringify(JSON.stringify(value))}`;
  await expectEventIn(main, 'settings.changed', mm, 'settings.changed arrives in the main window', pred('e2e.string', 'hello'));
  await expectEventIn(cat, 'settings.changed', pm, 'settings.changed arrives in the cat window', pred('e2e.string', 'hello'));

  const obj = { a: 1, b: [true, null, 'x'], nested: { text: 'ünï😺' } };
  pm = await cat.mark();
  await cat.ok('settings.set', { key: 'e2e.object', value: obj });
  const objEvent = await cat.waitEvent('settings.changed', pm, 3_000, `(d) => d && d.key === 'e2e.object'`);
  checkEqual('settings.changed carries an object value unchanged', objEvent?.data?.value, obj);
  checkEqual('get returns the object value', await main.ok('settings.get', { key: 'e2e.object' }), { key: 'e2e.object', value: obj });
  await main.ok('settings.set', { key: 'e2e.number', value: 42.5 });
  await main.ok('settings.set', { key: 'e2e.bool', value: false });
  await main.ok('settings.set', { key: 'e2e.null', value: null });
  checkEqual('get number', await main.ok('settings.get', { key: 'e2e.number' }), { key: 'e2e.number', value: 42.5 });
  checkEqual('get false', await main.ok('settings.get', { key: 'e2e.bool' }), { key: 'e2e.bool', value: false });
  checkEqual('get null value', await main.ok('settings.get', { key: 'e2e.null' }), { key: 'e2e.null', value: null });
  checkEqual('get missing key → value null', await main.ok('settings.get', { key: 'e2e.missing' }), { key: 'e2e.missing', value: null });

  const all = await main.ok('settings.getAll');
  check('getAll contains every stored key/value', all['e2e.string'] === 'hello' && deepEqual(all['e2e.object'], obj) && all['e2e.number'] === 42.5 && all['e2e.bool'] === false && 'e2e.null' in all, all);

  mm = await main.mark();
  pm = await cat.mark();
  checkEqual('remove → {}', await main.ok('settings.remove', { key: 'e2e.string' }), {});
  await expectEventIn(main, 'settings.changed', mm, 'remove broadcasts settings.changed { value: null } (main)', pred('e2e.string', null));
  await expectEventIn(cat, 'settings.changed', pm, 'remove broadcasts settings.changed { value: null } (cat)', pred('e2e.string', null));
  checkEqual('get after remove → null', await main.ok('settings.get', { key: 'e2e.string' }), { key: 'e2e.string', value: null });
  check('getAll after remove no longer has the key', !('e2e.string' in (await main.ok('settings.getAll'))));

  for (const theme of ['dark', 'light', 'dark']) {
    mm = await main.mark();
    pm = await cat.mark();
    await main.ok('settings.set', { key: 'app.theme', value: theme });
    const tp = `(d) => d && d.theme === ${JSON.stringify(theme)}`;
    await expectEventIn(main, 'app.themeChanged', mm, `app.theme '${theme}' → app.themeChanged in the main window`, tp);
    await expectEventIn(cat, 'app.themeChanged', pm, `app.theme '${theme}' → app.themeChanged in the cat window`, tp);
    await expectEventIn(cat, 'settings.changed', pm, `app.theme '${theme}' → settings.changed too`, pred('app.theme', theme));
    const applied = await main.waitUntil(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, 3_000);
    check(`main UI applies data-theme="${theme}"`, applied, await main.eval('document.documentElement.dataset.theme'));
  }
}

async function testActions(ctx) {
  const { main, cat } = ctx;
  const fresh = await main.ok('actions.list');
  check('actions.list returns 8 defaults', fresh.length === 8, fresh.map((a) => a.id));
  checkEqual('default ids in contract order', fresh.map((a) => a.id), DEFAULT_ACTIONS.map((a) => a.id));
  checkEqual('default order values 0..7', fresh.map((a) => a.order), [0, 1, 2, 3, 4, 5, 6, 7]);
  const mismatches = DEFAULT_ACTIONS.filter((exp, i) => {
    const a = fresh[i];
    return !a || !exp.actionType.includes(a.actionType) || (a.route ?? null) !== exp.route || a.enabled !== true || !a.name || !a.icon;
  });
  check('default actionType/route/enabled/name/icon per contract', mismatches.length === 0, { mismatches: mismatches.map((m) => m.id), fresh });
  checkShape('QuickAction', fresh[0], 'actions.list item');

  const reset0 = await main.ok('actions.reset');
  checkEqual('actions.reset on a fresh database = the migration seed', reset0, fresh);

  const mm = await main.mark();
  const pm = await cat.mark();
  const reordered = [...fresh].reverse().map((a) => ({ ...a, order: 99, enabled: a.id !== 'pin' }));
  const saved = await main.ok('actions.save', { actions: reordered });
  checkEqual('save: order re-assigned from array position', saved.map((a) => [a.id, a.order]), reordered.map((a, i) => [a.id, i]));
  check("save: 'pin' disabled, others enabled", saved.every((a) => a.enabled === (a.id !== 'pin')), saved.map((a) => [a.id, a.enabled]));
  checkEqual('list round-trips the saved set', await main.ok('actions.list'), saved);
  await expectEventIn(main, 'actions.changed', mm, 'actions.changed arrives in the main window');
  await expectEventIn(cat, 'actions.changed', pm, 'actions.changed arrives in the cat window');

  const invalidSets = [
    [[...fresh, { ...fresh[0] }], 'duplicate ids'],
    [[], 'an empty set'],
    [[{ ...fresh[0], actionType: 'teleport' }], "unknown actionType 'teleport'"],
    [[{ ...fresh[0], id: 'has space' }], 'an id with a space'],
    [[{ ...fresh[0], route: 'notes' }], "a route without leading '/'"],
    [[{ ...fresh[0], name: '   ' }], 'a blank name'],
    [[{ ...fresh[0], id: null }], 'id null'],
    [[{ ...fresh[0], actionType: null }], 'actionType null'],
  ];
  for (const [actions, label] of invalidSets) {
    await expectError(main, 'actions.save', { actions }, 'validation', `save with ${label} → validation`);
  }
  checkEqual('rejected saves left the set unchanged', await main.ok('actions.list'), saved);

  const custom = { id: 'e2e-custom', name: 'E2E Custom', icon: 'star', enabled: true, order: 8, actionType: 'custom', route: null, payload: { route: '/tasks', n: 1, tags: ['a'] } };
  const withCustom = await main.ok('actions.save', { actions: [...fresh, custom] });
  checkEqual('custom action payload round-trips', withCustom.find((a) => a.id === 'e2e-custom')?.payload, custom.payload);

  const pm2 = await cat.mark();
  const reset = await main.ok('actions.reset');
  checkEqual('reset restores the defaults', reset, fresh);
  await expectEventIn(cat, 'actions.changed', pm2, 'actions.changed (reset) arrives in the cat window');

  // Arrangement kept for the persistence check and the cat panel UI check: settings first, reminders off, plus the custom action.
  const arrangement = [fresh[7], ...fresh.slice(0, 7)].map((a) => ({ ...a, enabled: a.id !== 'reminders' }));
  ctx.state.actions = await main.ok('actions.save', { actions: [...arrangement, custom] });
  check('final arrangement saved (9 actions, settings first)', ctx.state.actions.length === 9 && ctx.state.actions[0].id === 'settings', ctx.state.actions.map((a) => a.id));
}

async function testFocus(ctx) {
  const { main, cat } = ctx;
  const defaults = await main.ok('focus.getSettings');
  checkEqual('focus defaults 25/5/15/4', [defaults.focusMinutes, defaults.shortBreakMinutes, defaults.longBreakMinutes, defaults.sessionsBeforeLongBreak], [25, 5, 15, 4]);
  const idle = await main.ok('focus.getState');
  check('initial state: idle focus 25:00, no sessions', idle.status === 'idle' && idle.phase === 'focus' && idle.remainingSeconds === 1500 && idle.totalSeconds === 1500 && idle.completedFocusSessions === 0 && idle.startedAt === null && idle.endsAt === null, idle);
  checkShape('FocusSettings', defaults, 'focus.getSettings');
  checkShape('FocusState', idle, 'focus.getState');
  checkShape('FocusStats', await main.ok('focus.getStats'), 'focus.getStats');

  const settings = { focusMinutes: 30, shortBreakMinutes: 6, longBreakMinutes: 20, sessionsBeforeLongBreak: 3, autoStartBreaks: false, autoStartFocus: false, notify: false, sound: false };
  let pm = await cat.mark();
  checkEqual('saveSettings returns the saved settings', await main.ok('focus.saveSettings', settings), settings);
  checkEqual('getSettings round-trips', await main.ok('focus.getSettings'), settings);
  const idle30 = await main.ok('focus.getState');
  check('idle state follows the new focus duration (30 min)', idle30.totalSeconds === 1800 && idle30.remainingSeconds === 1800, idle30);
  await expectEventIn(cat, 'focus.tick', pm, 'saveSettings broadcasts focus.tick with the new duration', `(d) => d.totalSeconds === 1800`);

  const mm = await main.mark();
  pm = await cat.mark();
  const t0 = Date.now();
  const started = await main.ok('focus.start', {});
  check('start → running focus 30:00 with startedAt/endsAt', started.status === 'running' && started.phase === 'focus' && started.totalSeconds === 1800 && started.remainingSeconds === 1800 && ISO_UTC.test(started.startedAt ?? '') && ISO_UTC.test(started.endsAt ?? ''), started);
  const endsIn = (Date.parse(started.endsAt) - t0) / 1000;
  check('endsAt ≈ now + 30 min', Math.abs(endsIn - 1800) < 5, endsIn);
  await sleep(3_600);
  for (const page of [main, cat]) {
    const ticks = await page.events(page === main ? mm : pm, 'focus.tick');
    const running = ticks.filter((t) => t.data.status === 'running');
    const gaps = running.slice(1).map((t, i) => t.t - running[i].t).slice(1); // skip the immediate state-change tick
    const decreasing = running.every((t, i) => i === 0 || t.data.remainingSeconds <= running[i - 1].data.remainingSeconds);
    check(`focus.tick about every second in the ${page.kind} window (≥ 3 in 3.6 s)`, running.length >= 3 && gaps.every((g) => g > 500 && g < 1_600), { count: running.length, gapsMs: gaps });
    check(`remainingSeconds counts down in the ${page.kind} window`, decreasing && running.at(-1)?.data.remainingSeconds < 1800, running.map((t) => t.data.remainingSeconds));
  }

  const paused = await main.ok('focus.pause');
  check('pause → paused, endsAt null', paused.status === 'paused' && paused.endsAt === null && paused.remainingSeconds < 1800 && paused.remainingSeconds > 1790, paused);
  const pauseMarkMain = await main.mark();
  const pauseMarkCat = await cat.mark();
  await sleep(2_200);
  const stillPaused = await cat.ok('focus.getState');
  check('pause freezes remainingSeconds', stillPaused.status === 'paused' && stillPaused.remainingSeconds === paused.remainingSeconds, { paused: paused.remainingSeconds, later: stillPaused.remainingSeconds });
  check('no focus.tick while paused (both windows)', (await main.events(pauseMarkMain, 'focus.tick')).length === 0 && (await cat.events(pauseMarkCat, 'focus.tick')).length === 0);

  const resumed = await main.ok('focus.resume');
  check('resume → running from the paused remaining time', resumed.status === 'running' && Math.abs(resumed.remainingSeconds - paused.remainingSeconds) <= 1 && ISO_UTC.test(resumed.endsAt ?? ''), resumed);
  await main.ok('focus.saveSettings', { ...settings, focusMinutes: 45 });
  const whileRunning = await main.ok('focus.getState');
  check('saveSettings while running does not change the running phase', whileRunning.status === 'running' && whileRunning.totalSeconds === 1800, whileRunning);
  await main.ok('focus.saveSettings', settings);

  const skipMark = await main.mark();
  const skipped = await main.ok('focus.skip');
  check("skip → phase shortBreak, status completed (6 min lined up)", skipped.phase === 'shortBreak' && skipped.status === 'completed' && skipped.totalSeconds === 360 && skipped.remainingSeconds === 360 && skipped.startedAt === null, skipped);
  check('skip does not count a focus session', skipped.completedFocusSessions === 0, skipped);
  await expectNoEventIn(main, 'focus.completed', skipMark, 'skip does not emit focus.completed');

  const longBreak = await main.ok('focus.start', { phase: 'longBreak', minutes: 2 });
  check('start { phase: longBreak, minutes: 2 } → running 2:00 long break', longBreak.status === 'running' && longBreak.phase === 'longBreak' && longBreak.totalSeconds === 120, longBreak);
  const stopped = await main.ok('focus.stop');
  check('stop → idle focus phase with the configured duration', stopped.status === 'idle' && stopped.phase === 'focus' && stopped.totalSeconds === 1800 && stopped.endsAt === null, stopped);
  const resumeIdle = await main.ok('focus.resume');
  check('resume while idle is a no-op', resumeIdle.status === 'idle', resumeIdle);
  const reset = await main.ok('focus.reset');
  check('reset → idle, completedFocusSessions 0', reset.status === 'idle' && reset.completedFocusSessions === 0, reset);
  checkEqual('getStats: nothing completed yet', await main.ok('focus.getStats'), { todayFocusSessions: 0, todayFocusMinutes: 0, totalFocusSessions: 0, totalFocusMinutes: 0 });

  if (!ctx.opts.long) {
    info('focus.completed not exercised (run with --long for a real 1-minute phase)');
    return;
  }
  const lm = await main.mark();
  const lp = await cat.mark();
  const oneMinute = await main.ok('focus.start', { minutes: 1 });
  check('start { minutes: 1 } → 60 s focus', oneMinute.totalSeconds === 60 && oneMinute.status === 'running', oneMinute);
  info('waiting up to 75 s for focus.completed …');
  const done = await main.waitEvent('focus.completed', lm, 75_000);
  checkEqual('focus.completed { phase: focus, next: shortBreak } in the main window', done?.data, { phase: 'focus', next: 'shortBreak' });
  checkEqual('focus.completed arrives in the cat window too', (await cat.waitEvent('focus.completed', lp, 3_000))?.data, { phase: 'focus', next: 'shortBreak' });
  const after = await main.ok('focus.getState');
  check('after completion: shortBreak lined up, 1 session counted', after.status === 'completed' && after.phase === 'shortBreak' && after.completedFocusSessions === 1 && after.totalSeconds === 360, after);
  checkEqual('getStats counts the completed minute', await main.ok('focus.getStats'), { todayFocusSessions: 1, todayFocusMinutes: 1, totalFocusSessions: 1, totalFocusMinutes: 1 });
  await main.ok('focus.stop');
}

/**
 * Asks Windows which top-level window is under each point (WindowFromPoint → root), compared with the cat window of the
 * test instance (found by process id + exact bounds). No input is sent. Also returns the cat window's extended style.
 */
function hitTestCat(pid, rect, points) {
  const calls = points.map((p) => `[CatDesktopE2EHit]::Hits($cat, ${Math.round(p.x)}, ${Math.round(p.y)})`).join(', ');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CatDesktopE2EHit {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  public static IntPtr Find(uint pid, int x, int y, int w, int h) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hw, l) => {
      uint p; GetWindowThreadProcessId(hw, out p); RECT r;
      if (p == pid && IsWindowVisible(hw) && GetWindowRect(hw, out r) && r.L == x && r.T == y && r.R - r.L == w && r.B - r.T == h) { found = hw; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Hits(IntPtr cat, int x, int y) { return GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2) == cat; }
}
'@
[void][CatDesktopE2EHit]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$cat = [CatDesktopE2EHit]::Find(${pid}, ${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})
$hits = @(${calls})
[pscustomobject]@{ found = ($cat -ne [IntPtr]::Zero); exStyle = [CatDesktopE2EHit]::GetWindowLong($cat, -20); hits = $hits } | ConvertTo-Json -Compress
`;
  const parsed = JSON.parse(runPowerShell(script));
  parsed.hits = Array.isArray(parsed.hits) ? parsed.hits : [parsed.hits];
  return parsed;
}

const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x80000;
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/** Cat box + layout sizes for a scale, in CSS px (contract §7). */
function catGeometry(scale, mode = 'cat') {
  const box = catBox(scale);
  if (mode === 'cat') return { width: box.width, height: box.height, box };
  const l = CAT_LAYOUTS[mode];
  return { width: Math.max(box.width, l.minWidth), height: box.height + l.extraHeight, box };
}

async function waitWalkEnd(ctx, since, timeoutMs, reason) {
  const pred = reason ? `(d) => d && d.reason === ${JSON.stringify(reason)}` : 'null';
  return ctx.cat.waitEvent('cat.walkEnded', since, timeoutMs, pred);
}

async function testCat(ctx) {
  const { main, cat, work, primary } = ctx;
  const px = (css) => roundHalfEven(css * ctx.dpr);
  const pos = () => main.ok('cat.getPosition');
  info(`devicePixelRatio ${ctx.dpr}; primary work area ${fmt(work)}`);

  // ---- defaults & shapes (the start-up settings were captured before the suite froze the behaviour)
  checkEqual('default cat settings (contract §5; sound off)', ctx.state.catDefaults, DEFAULT_CAT_SETTINGS);
  checkShape('CatSettings', ctx.state.catDefaults, 'cat.getSettings');
  const frozen = await main.ok('cat.getSettings');
  check('suite froze the autonomous behaviour (autoWalk, randomIdle, randomActions off)', frozen.autoWalk === false && frozen.randomIdle === false && frozen.randomActions === false, frozen);
  checkEqual('isVisible → true (startWithApp)', await main.ok('cat.isVisible'), { visible: true });
  const p0 = await pos();
  checkShape('WindowState', p0, 'cat.getPosition');
  check("getPosition → windowId 'cat', medium box 160x120 CSS, visible, on top", p0.windowId === 'cat' && p0.width === px(160) && p0.height === px(120) && p0.isVisible === true && p0.alwaysOnTop === true, { p0, expected: [px(160), px(120)] });
  check('getPosition reports the monitor device name', p0.monitor === primary.name, p0.monitor);
  check('the cat box is fully inside the primary work area', insideArea(p0, work), { p0, work });

  // ---- screen / monitor information
  const si = await main.ok('cat.getScreenInfo');
  checkShape('CatScreenInfo', si, 'cat.getScreenInfo');
  checkShape('MonitorInfo', si.monitor, 'CatScreenInfo.monitor');
  check('screen info: current monitor = primary, work area and bounds match Windows', si.monitor.id === primary.name && si.monitor.primary === true && deepEqual(si.monitor.workArea, work) && deepEqual(si.monitor.bounds, primary.bounds), si.monitor);
  check('screen info: scale matches devicePixelRatio', near(si.monitor.scale, ctx.dpr, 0.01), { scale: si.monitor.scale, dpr: ctx.dpr });
  checkEqual('screen info: box = whole window in the cat layout', si.box, { x: 0, y: 0, width: 160, height: 120 });
  const expectRoom = {
    left: (p0.x - work.x) / ctx.dpr,
    right: (work.x + work.width - (p0.x + p0.width)) / ctx.dpr,
    up: (p0.y - work.y) / ctx.dpr,
    down: (work.y + work.height - (p0.y + p0.height)) / ctx.dpr,
  };
  check('screen info: room = DIPs to the work-area edges', ['left', 'right', 'up', 'down'].every((k) => near(si.room[k], expectRoom[k], 1.5)), { room: si.room, expected: expectRoom });
  const monitors = await main.ok('cat.getMonitors');
  check('getMonitors lists every monitor, exactly one primary', Array.isArray(monitors) && monitors.length === ctx.screens.length && monitors.filter((m) => m.primary).length === 1, monitors);
  check('getMonitors: the primary entry matches Windows', monitors.some((m) => m.primary && m.id === primary.name && deepEqual(m.workArea, work)), monitors);

  // ---- visibility
  const visPred = (v) => `(d) => d && d.visible === ${v}`;
  let mm = await main.mark();
  checkEqual('hide → { visible: false }', await main.ok('cat.hide'), { visible: false });
  await expectEventIn(main, 'cat.visibilityChanged', mm, 'hide broadcasts cat.visibilityChanged { visible: false }', visPred(false));
  checkEqual('isVisible → false', await main.ok('cat.isVisible'), { visible: false });
  check('getPosition.isVisible false while hidden', (await pos()).isVisible === false);
  mm = await main.mark();
  checkEqual('show → { visible: true }', await main.ok('cat.show'), { visible: true });
  await expectEventIn(main, 'cat.visibilityChanged', mm, 'show broadcasts cat.visibilityChanged { visible: true }', visPred(true));
  const shownAt = await pos();
  check('show restores the previous position', shownAt.x === p0.x && shownAt.y === p0.y, { before: p0, after: shownAt });
  checkEqual('toggle (visible) → { visible: false }', await main.ok('cat.toggle'), { visible: false });
  checkEqual('toggle (hidden) → { visible: true }', await main.ok('cat.toggle'), { visible: true });
  mm = await main.mark();
  checkEqual('window.close from the cat window → {}', await cat.ok('window.close'), {});
  await expectEventIn(main, 'cat.visibilityChanged', mm, 'window.close only hides the cat (visibilityChanged false)', visPred(false));
  check('cat window still alive after window.close', (await cat.invoke('app.getInfo')).ok === true);
  await main.ok('cat.show');

  // ---- immediate moves (moveTo / moveBy) and clamping
  const inside = { x: work.x + 200, y: work.y + 150 };
  mm = await main.mark();
  let cm = await cat.mark();
  const moved = await main.ok('cat.moveTo', inside);
  check('moveTo inside the work area lands exactly there', moved.x === inside.x && moved.y === inside.y && moved.windowId === 'cat', { moved, inside });
  const posPred = `(d) => d && d.x === ${inside.x} && d.y === ${inside.y}`;
  await expectEventIn(main, 'cat.positionChanged', mm, 'moveTo broadcasts cat.positionChanged (main)', posPred);
  await expectEventIn(cat, 'cat.positionChanged', cm, 'moveTo broadcasts cat.positionChanged (cat)', posPred);
  const by = await main.ok('cat.moveBy', { dx: 16, dy: -12 });
  check('moveBy { dx: 16, dy: -12 } DIPs moves by the DPI-scaled amount', near(by.x, inside.x + 16 * ctx.dpr) && near(by.y, inside.y - 12 * ctx.dpr), { by, expected: { x: inside.x + 16 * ctx.dpr, y: inside.y - 12 * ctx.dpr } });
  await expectError(main, 'cat.moveBy', { dx: 30000, dy: 0 }, 'validation', 'moveBy beyond ±10000 DIPs → validation');
  await expectError(main, 'cat.moveTo', { x: 10 }, 'validation', 'moveTo without y → validation');
  await expectError(main, 'cat.moveTo', { x: 200000, y: 0 }, 'validation', 'moveTo beyond ±100000 px → validation');
  check('rejected moves left the cat where it was', (await pos()).x === by.x);
  for (const far of [{ x: -20000, y: -20000 }, { x: 20000, y: 20000 }, { x: -20000, y: 20000 }, { x: work.x + work.width - 5, y: work.y + 100 }]) {
    const st = await main.ok('cat.moveTo', far);
    check(`moveTo ${fmt(far)} is clamped: the whole cat box stays inside a work area`, ctx.screens.some((s) => insideArea(st, s.work)), st);
  }
  const named = await main.ok('cat.moveTo', { x: work.x + 300, y: work.y + 200, monitor: primary.name });
  check('moveTo with the primary monitor name', named.x === work.x + 300 && named.y === work.y + 200 && named.monitor === primary.name, named);

  // ---- walking
  const walkStart = { x: work.x + Math.round(work.width * 0.3), y: work.y + Math.round(work.height * 0.5) };
  await main.ok('cat.moveTo', walkStart);
  const w0 = await pos();
  cm = await cat.mark();
  mm = await main.mark();
  const t0 = Date.now();
  const walk = await main.ok('cat.walk', { dx: 240, speed: 300 });
  checkShape('CatWalkResult', walk, 'cat.walk result');
  check("walk right: facing 'right', dx 240, dy 0", walk.facing === 'right' && near(walk.dx, 240) && near(walk.dy, 0), walk);
  check('walk: accelMs ≤ 400 and ≤ 30 % of the walk', walk.accelMs > 0 && walk.accelMs <= 400 && walk.accelMs <= 0.3 * walk.durationMs + 1, walk);
  check('walk: durationMs = distance / speed + accelMs (trapezoid with smooth ramps)', near(walk.durationMs, (240 / 300) * 1000 + walk.accelMs, 80), { walk, expected: (240 / 300) * 1000 + walk.accelMs });
  const samples = [];
  while (Date.now() - t0 < walk.durationMs + 1500) {
    const s = await pos();
    samples.push({ t: Date.now() - t0, x: s.x, y: s.y });
    if ((await cat.events(cm, 'cat.walkEnded')).length > 0) break;
    await sleep(40);
  }
  const ended = await waitWalkEnd(ctx, cm, 2_000);
  check("walkEnded { reason: 'arrived' } arrives in the cat window", ended?.data?.reason === 'arrived', ended?.data);
  await expectNoEventIn(main, 'cat.walkEnded', mm, 'walkEnded is not sent to the main window', 100);
  const w1 = await pos();
  check('after the walk the cat stands 240 DIPs further right, same height', near(w1.x, w0.x + 240 * ctx.dpr, 1.5) && w1.y === w0.y, { start: w0, end: w1, expectedX: w0.x + 240 * ctx.dpr });
  check('the walk ended within durationMs (+ slack)', Date.now() - t0 < walk.durationMs + 1500, { elapsed: Date.now() - t0, durationMs: walk.durationMs });
  const xs = samples.map((s) => s.x);
  check('the window really moved over time (≥ 5 distinct intermediate positions, monotonic)', new Set(xs.filter((x) => x > w0.x && x < w1.x)).size >= 5 && xs.every((x, i) => i === 0 || x >= xs[i - 1]), samples);
  const cruise = samples.filter((s) => s.t > walk.accelMs + 60 && s.t < walk.durationMs - walk.accelMs - 60);
  if (cruise.length >= 2) {
    const a = cruise[0], b = cruise[cruise.length - 1];
    const v = (b.x - a.x) / ((b.t - a.t) / 1000) / ctx.dpr;
    check('cruise speed ≈ 300 DIP/s (±30 %)', v > 210 && v < 390, { measured: Math.round(v) });
  }
  const early = samples.filter((s) => s.t > 0 && s.t <= Math.min(120, walk.accelMs));
  if (early.length > 0 && cruise.length >= 2) {
    const firstMove = (early[early.length - 1].x - w0.x) / ctx.dpr;
    check('the walk accelerates smoothly (moves less than full speed during the first ramp)', firstMove < (300 * early[early.length - 1].t) / 1000, { firstMoveDips: firstMove, t: early[early.length - 1].t });
  }
  await expectEventIn(main, 'cat.positionChanged', mm, 'cat.positionChanged after the walk (main)', `(d) => d && d.x === ${w1.x}`);

  cm = await cat.mark();
  const left = await main.ok('cat.walk', { dx: -120, speed: 240 });
  check("walk left: facing 'left', dx -120", left.facing === 'left' && near(left.dx, -120), left);
  check("… and arrives", (await waitWalkEnd(ctx, cm, left.durationMs + 2_000))?.data?.reason === 'arrived');

  const diag = await main.ok('cat.walk', { dx: 160, dy: 40, speed: 250 });
  check('diagonal walk keeps dy', near(diag.dx, 160) && near(diag.dy, 40), diag);
  await waitWalkEnd(ctx, cm, diag.durationMs + 2_000, 'arrived');

  // Blocked at the left edge, clamped close to it.
  await main.ok('cat.moveTo', { x: work.x, y: walkStart.y });
  cm = await cat.mark();
  const blocked = await main.ok('cat.walk', { dx: -100, speed: 200 });
  check('walking into the left work-area edge → dx 0', near(blocked.dx, 0), blocked);
  check("… and walkEnded { reason: 'blocked' }", !!(await waitWalkEnd(ctx, cm, 1_500, 'blocked')));
  const edge = await main.ok('cat.moveTo', { x: work.x + px(50), y: walkStart.y });
  cm = await cat.mark();
  const clamped = await main.ok('cat.walk', { dx: -500, speed: 400 });
  check('a walk past the edge is shortened to the room left (≈ -50 DIPs)', near(clamped.dx, (work.x - edge.x) / ctx.dpr, 1.5), { clamped, expected: (work.x - edge.x) / ctx.dpr });
  await waitWalkEnd(ctx, cm, clamped.durationMs + 2_000, 'arrived');
  check('… ending exactly at the work-area edge', (await pos()).x === work.x, await pos());

  // Replace a walk in progress; stop a walk.
  await main.ok('cat.moveTo', walkStart);
  cm = await cat.mark();
  await main.ok('cat.walk', { dx: 400, speed: 100 });
  await sleep(500);
  const second = await main.ok('cat.walk', { dx: -60, speed: 200 });
  check("replacing a walk: the first ends with reason 'replaced'", !!(await waitWalkEnd(ctx, cm, 1_000, 'replaced')));
  check('… the second walk runs to its end', !!(await waitWalkEnd(ctx, cm, second.durationMs + 2_000, 'arrived')));
  cm = await cat.mark();
  await main.ok('cat.walk', { dx: 500, speed: 120 });
  await sleep(600);
  const stopAt = Date.now();
  checkEqual('cat.stop → {}', await main.ok('cat.stop'), {});
  const stopped = await waitWalkEnd(ctx, cm, 1_500, 'stopped');
  check("stop: walkEnded { reason: 'stopped' } within ~200 ms (+ slack)", !!stopped && Date.now() - stopAt < 1_000, { elapsed: Date.now() - stopAt });
  const rest1 = await pos();
  await sleep(300);
  const rest2 = await pos();
  check('… and the cat stays put afterwards', rest1.x === rest2.x && rest1.y === rest2.y, [rest1, rest2]);
  checkEqual('cat.stop when not walking → {}', await main.ok('cat.stop'), {});
  for (const [payload, label] of [
    [{ dx: 100, speed: 5 }, 'speed 5'],
    [{ dx: 100, speed: 1000 }, 'speed 1000'],
    [{ dx: 20000, speed: 100 }, 'dx 20000'],
    [{ dx: 100 }, 'without speed'],
    [{ speed: 100 }, 'without dx'],
  ]) {
    await expectError(main, 'cat.walk', payload, 'validation', `cat.walk ${label} → validation`);
  }

  // ---- layouts: menu / panel open toward free space, the cat box keeps its screen position
  const quadrants = [
    { name: 'top-left', at: { x: work.x + 200, y: work.y + 150 } },
    { name: 'top-right', at: { x: work.x + work.width - px(160) - 220, y: work.y + 150 } },
    { name: 'bottom-left', at: { x: work.x + 200, y: work.y + work.height - px(120) - 150 } },
    { name: 'bottom-right', at: { x: work.x + work.width - px(160) - 420, y: work.y + work.height - px(120) - 220 } },
  ];
  for (const q of quadrants) {
    const before = await main.ok('cat.moveTo', q.at);
    for (const mode of ['menu', 'panel']) {
      const g = catGeometry(1, mode);
      mm = await main.mark();
      cm = await cat.mark();
      const res = await cat.ok('cat.setLayout', { mode });
      const st = await pos();
      info(`${mode} from the ${q.name} quadrant → anchor ${res.anchor}, window ${st.width}x${st.height} at ${st.x},${st.y}, box ${fmt(res.box)}`);
      if (q.name === 'top-left' && mode === 'menu') checkShape('CatLayoutResult', res, 'cat.setLayout result');
      check(`[${q.name}/${mode}] result size ${g.width}x${g.height} CSS`, res.mode === mode && res.width === g.width && res.height === g.height && res.box.width === 160 && res.box.height === 120, res);
      check(`[${q.name}/${mode}] opens toward free space (anchor ${q.name})`, res.anchor === q.name, res.anchor);
      check(`[${q.name}/${mode}] window is ${g.width}x${g.height} CSS in physical px`, near(st.width, px(g.width)) && near(st.height, px(g.height)), { st, expected: [px(g.width), px(g.height)] });
      check(`[${q.name}/${mode}] window stays inside the work area`, insideArea(st, work), { st, work });
      check(`[${q.name}/${mode}] the cat box keeps its screen position`, near(st.x + px(res.box.x), before.x, 1.5) && near(st.y + px(res.box.y), before.y, 1.5), { before, window: st, box: res.box });
      await expectEventIn(cat, 'cat.layoutChanged', cm, `[${q.name}/${mode}] cat.layoutChanged arrives in the cat window`, `(d) => d && d.mode === ${JSON.stringify(mode)}`);
      await expectNoEventIn(main, 'cat.layoutChanged', mm, `[${q.name}/${mode}] cat.layoutChanged is not sent to the main window`, 100);
      if (q.name === 'top-left' && mode === 'menu') {
        await expectError(main, 'cat.walk', { dx: 50, speed: 100 }, 'denied', 'walk while the menu layout is open → denied');
        await expectError(main, 'cat.dragStart', undefined, 'denied', 'dragStart while the menu layout is open → denied');
      }
      const back = await cat.ok('cat.setLayout', { mode: 'cat' });
      const st2 = await pos();
      check(`[${q.name}/${mode}] back to the cat layout → the original bounds`, back.mode === 'cat' && st2.x === before.x && st2.y === before.y && st2.width === px(160) && st2.height === px(120), { before, after: st2, back });
    }
  }

  // ---- hit region & click-through (Windows hit testing, no input)
  const park = await main.ok('cat.moveTo', { x: work.x + 200, y: work.y + 150 });
  const centre = { x: park.x + park.width / 2, y: park.y + park.height / 2 };
  const inRect = { x: park.x + px(30), y: park.y + px(30) };
  let hit = hitTestCat(ctx.proc.pid, park, [centre]);
  check('hit test: the cat window is found and receives the mouse at its centre', hit.found && hit.hits[0] === true, hit);
  checkEqual('setHitRegion one small rect → {}', await cat.ok('cat.setHitRegion', { rects: [{ x: 10, y: 10, width: 40, height: 40 }] }), {});
  hit = hitTestCat(ctx.proc.pid, park, [inRect, centre]);
  check('hit region: a point inside the rect hits the cat, the box centre outside it passes through', hit.hits[0] === true && hit.hits[1] === false, hit);
  checkEqual('setHitRegion [] (whole window) → {}', await cat.ok('cat.setHitRegion', { rects: [] }), {});
  hit = hitTestCat(ctx.proc.pid, park, [centre]);
  check('empty hit region → the whole window receives the mouse again', hit.hits[0] === true, hit);
  const tooMany = Array.from({ length: 17 }, (_, i) => ({ x: i, y: 0, width: 1, height: 1 }));
  await expectError(cat, 'cat.setHitRegion', { rects: tooMany }, 'validation', 'setHitRegion with 17 rects → validation');
  await expectError(cat, 'cat.setHitRegion', {}, 'validation', 'setHitRegion without rects → validation');
  await cat.ok('cat.setHitRegion', { rects: [{ x: 0, y: 0, width: 50, height: 50 }] });
  await cat.ok('cat.setLayout', { mode: 'menu' });
  const menuWin = await pos();
  await cat.ok('cat.setLayout', { mode: 'cat' });
  hit = hitTestCat(ctx.proc.pid, await pos(), [centre]);
  check('a layout change resets the hit region to the whole window', hit.hits[0] === true, { hit, menuWin });

  checkEqual('setClickThrough { enabled: true, hoverToInteract: false } → {}', await cat.ok('cat.setClickThrough', { enabled: true, hoverToInteract: false }), {});
  hit = hitTestCat(ctx.proc.pid, park, [centre]);
  check('click-through: the centre passes through to the window below', hit.hits[0] === false, hit);
  check('click-through: layered + transparent window style', (hit.exStyle & WS_EX_LAYERED) !== 0 && (hit.exStyle & WS_EX_TRANSPARENT) !== 0, { exStyle: hit.exStyle.toString(16) });
  checkEqual('setClickThrough { enabled: false } → {}', await cat.ok('cat.setClickThrough', { enabled: false }), {});
  hit = hitTestCat(ctx.proc.pid, park, [centre]);
  check('interactive again: the centre hits the cat, no transparent style', hit.hits[0] === true && (hit.exStyle & WS_EX_TRANSPARENT) === 0, { hits: hit.hits, exStyle: hit.exStyle.toString(16) });
  await expectError(cat, 'cat.setClickThrough', { enabled: 'yes' }, 'validation', 'setClickThrough enabled "yes" → validation');

  // ---- settings
  mm = await main.mark();
  cm = await cat.mark();
  const beforeSize = await pos();
  const fur0 = await cat.eval(`(() => { const el = document.querySelector('app-cat-sprite'); return el ? getComputedStyle(el).getPropertyValue('--cat-fur').trim() : ''; })()`);
  const wanted = { ...frozen, scale: 1.4, theme: 'black', opacity: 0.5, walkingSpeed: 1.5 };
  const saved = await main.ok('cat.saveSettings', wanted);
  checkEqual('saveSettings returns the normalised settings', saved, wanted);
  const setPred = `(d) => d && d.opacity === 0.5 && d.scale === 1.4 && d.theme === 'black'`;
  await expectEventIn(main, 'cat.settingsChanged', mm, 'cat.settingsChanged arrives in the main window', setPred);
  await expectEventIn(cat, 'cat.settingsChanged', cm, 'cat.settingsChanged arrives in the cat window', setPred);
  checkEqual('getSettings round-trips', await main.ok('cat.getSettings'), wanted);
  const fur1 = await cat.waitUntil(`(() => { const v = (() => { const el = document.querySelector('app-cat-sprite'); return el ? getComputedStyle(el).getPropertyValue('--cat-fur').trim() : ''; })(); return v && v !== ${JSON.stringify(fur0)} ? v : false; })()`, 3_000);
  check("theme 'black' repaints the desktop cat live (--cat-fur changes, no reload)", !!fur0 && !!fur1 && !!(await cat.eval('!!window.__e2e')), { before: fur0, after: fur1 });
  const grown = await until(async () => { const s = await pos(); return near(s.width, px(224)) && near(s.height, px(168)) ? s : null; }, 3_000);
  check('the window follows scale 1.4 immediately (224x168 CSS)', !!grown, { expected: [px(224), px(168)], got: await pos() });
  if (grown) {
    check('… keeping the feet on the same line (bottom edge unchanged)', near(grown.y + grown.height, beforeSize.y + beforeSize.height, 1.5), { before: beforeSize, after: grown });
    check('… and the cat centred where it was (bottom-centre point kept)', near(grown.x + grown.width / 2, beforeSize.x + beforeSize.width / 2, 1.5), { before: beforeSize, after: grown });
  }
  const cssOk = await cat.waitUntil(`(() => { const el = document.querySelector('app-cat-sprite'); return !!el && getComputedStyle(el).getPropertyValue('--cat-opacity').trim() === '0.5'; })()`, 3_000);
  check('cat UI applies opacity 0.5 (--cat-opacity)', !!cssOk);
  const norm = await main.ok('cat.saveSettings', { ...wanted, opacity: 0.1, walkingSpeed: 5, scale: 5, theme: 'Not a theme!' });
  check('saveSettings normalises: opacity ≥ 0.3, walkingSpeed ≤ 2, scale ≤ 2, invalid theme id → classic', norm.opacity === 0.3 && norm.walkingSpeed === 2 && norm.scale === 2 && norm.theme === 'classic', norm);
  const tiny = await main.ok('cat.saveSettings', { ...wanted, scale: 0.01 });
  check('scale below 0.1 → 0.1', tiny.scale === 0.1, tiny);
  const tinyWin = await until(async () => { const st = await pos(); return near(st.width, px(16)) && near(st.height, px(12)) ? st : null; }, 3_000);
  check('scale 0.1 → the 16x12 minimum box', !!tinyWin, await pos());
  const odd = await main.ok('cat.saveSettings', { ...wanted, scale: 1.234 });
  check('scale is stored with 2 decimals (1.234 → 1.23)', odd.scale === 1.23, odd);
  for (const s of [0.5, 0.75, 1.25, 1.75, 1.4]) await main.ok('cat.saveSettings', { ...wanted, scale: s });
  check('rapid scale changes end at the last value (1.4, 224x168)', !!(await until(async () => { const st = await pos(); return near(st.width, px(224)) && near(st.height, px(168)) ? st : null; }, 3_000)), await pos());
  // A cat.settings value from the first cat release (size preset, no scale/theme) is read as a scale.
  await main.ok('settings.set', { key: 'cat.settings', value: { ...DEFAULT_CAT_SETTINGS, autoWalk: false, randomIdle: false, randomActions: false, scale: undefined, theme: undefined, size: 'small' } });
  const legacy = await main.ok('cat.getSettings');
  check("legacy cat.settings { size: 'small' } → scale 0.7, theme classic, no size field", legacy.scale === 0.7 && legacy.theme === 'classic' && !('size' in legacy), legacy);
  checkShape('CatSettings', legacy, 'cat.getSettings after a legacy value');
  const slow = await main.ok('cat.saveSettings', { ...wanted, walkingSpeed: 0.1 });
  check("theme 'black' round-trips", (await main.ok('cat.getSettings')).theme === 'black');
  check('walkingSpeed below 0.5 → 0.5', slow.walkingSpeed === 0.5, slow);
  await main.ok('cat.saveSettings', wanted);
  checkShape('CatSettings', (await main.ok('settings.get', { key: 'cat.settings' })).value, "stored 'cat.settings' value");

  mm = await main.mark();
  const disabled = await main.ok('cat.saveSettings', { ...wanted, enabled: false });
  check('saveSettings enabled: false', disabled.enabled === false, disabled);
  await expectEventIn(main, 'cat.visibilityChanged', mm, 'disabling hides the cat (visibilityChanged false)', visPred(false));
  checkEqual('show while disabled → { visible: false }', await main.ok('cat.show'), { visible: false });
  checkEqual('toggle while disabled → { visible: false }', await main.ok('cat.toggle'), { visible: false });
  mm = await main.mark();
  await main.ok('cat.saveSettings', wanted);
  await expectEventIn(main, 'cat.visibilityChanged', mm, 're-enabling shows the cat again', visPred(true));

  await main.ok('cat.setAlwaysOnTop', { enabled: false });
  check('setAlwaysOnTop false (runtime)', (await pos()).alwaysOnTop === false);
  await main.ok('cat.setAlwaysOnTop', { enabled: true });
  check('setAlwaysOnTop true (runtime)', (await pos()).alwaysOnTop === true);

  // ---- commands
  mm = await main.mark();
  cm = await cat.mark();
  checkEqual('sendCommand → {}', await main.ok('cat.sendCommand', { action: 'e2e-noop', payload: { source: 'e2e' } }), {});
  const cmd = await cat.waitEvent('cat.command', cm, 3_000);
  checkEqual('cat.command arrives in the cat window with action + payload', cmd?.data, { action: 'e2e-noop', payload: { source: 'e2e' } });
  await expectNoEventIn(main, 'cat.command', mm, 'cat.command is not sent to the main window');
  await main.ok('cat.hide');
  cm = await cat.mark();
  await main.ok('cat.sendCommand', { action: 'e2e-noop' });
  checkEqual('sendCommand shows a hidden cat first', await main.ok('cat.isVisible'), { visible: true });
  check('command without payload is delivered', (await cat.waitEvent('cat.command', cm, 3_000))?.data?.action === 'e2e-noop');
  await expectError(main, 'cat.sendCommand', { payload: {} }, 'validation', 'sendCommand without action → validation');
  await expectError(main, 'cat.sendCommand', { action: 'x'.repeat(65) }, 'validation', 'sendCommand with a 65-char action → validation');

  // ---- drag bookkeeping (the follow loop itself needs a real mouse button)
  const beforeDrag = await pos();
  cm = await cat.mark();
  checkEqual('dragStart → {}', await cat.ok('cat.dragStart'), {});
  const dragEnd = await cat.ok('cat.dragEnd');
  check('dragEnd right away → { moved: false }', dragEnd && typeof dragEnd.moved === 'boolean', dragEnd);
  const dragged = await cat.waitEvent('cat.dragEnded', cm, 2_000);
  check('cat.dragEnded arrives in the cat window', !!dragged, dragged);
  if (dragged) checkShape('CatDragEnded', dragged.data, 'cat.dragEnded');
  check('cat.dragStateChanged { dragging: true } then { dragging: false }', !!(await cat.waitEvent('cat.dragStateChanged', cm, 1_000, '(d) => d && d.dragging === true')) && !!(await cat.waitEvent('cat.dragStateChanged', cm, 1_000, '(d) => d && d.dragging === false')));
  const afterDrag = await pos();
  info(`drag without a held button: ${fmt(beforeDrag)} → ${fmt(afterDrag)} (moves only if the user moved the mouse meanwhile)`);
  checkEqual('dragEnd when not dragging → { moved: false }', await cat.ok('cat.dragEnd'), { moved: false });
  cm = await cat.mark();
  await cat.ok('cat.dragStart', { followUntilClick: true });
  await cat.ok('cat.dragEnd');
  check('dragStart { followUntilClick } then dragEnd → dragEnded', !!(await cat.waitEvent('cat.dragEnded', cm, 2_000)));
  await expectError(cat, 'cat.dragStart', { followUntilClick: 'yes' }, 'validation', 'dragStart followUntilClick "yes" → validation');

  // ---- misc
  const catWin = await cat.ok('window.getState');
  check("window.getState from the cat window → windowId 'cat'", catWin.windowId === 'cat', catWin);
  const savedPos = await main.ok('cat.savePosition');
  check('savePosition returns the current state', savedPos.windowId === 'cat' && savedPos.x === catWin.x, savedPos);

  ctx.state.catSettings = wanted;
  ctx.state.catPos = { x: work.x + 240, y: work.y + 200 };
  const parked = await main.ok('cat.moveTo', ctx.state.catPos);
  check('cat parked for the persistence check', parked.x === ctx.state.catPos.x && parked.y === ctx.state.catPos.y && near(parked.width, px(224)), parked);
}


async function testNavigation(ctx) {
  const { main, cat } = ctx;
  for (const route of ['/tasks', '/notes', '/focus']) {
    const mm = await main.mark();
    const pm = await cat.mark();
    checkEqual(`navigate '${route}' from the cat window → {}`, await cat.ok('navigation.navigate', { route }), {});
    await expectEventIn(main, 'navigation.navigate', mm, `navigation.navigate { route: '${route}' } arrives in the main window`, `(d) => d && d.route === ${JSON.stringify(route)}`);
    const hash = await main.waitUntil(`location.hash === ${JSON.stringify('#' + route)} && location.hash`, 3_000);
    check(`main window location.hash becomes '#${route}'`, hash === '#' + route, await main.eval('location.hash'));
    await expectNoEventIn(cat, 'navigation.navigate', pm, 'navigation.navigate is not sent to the cat window', 100);
  }
  for (const route of ['notes', '/a b', 'javascript:alert(1)', '/x://y']) {
    await expectError(cat, 'navigation.navigate', { route }, 'validation', `navigate ${JSON.stringify(route)} → validation`);
  }
  const mainState = await main.ok('window.getState');
  check('navigation brought the main window to the front (visible, not minimised)', mainState.isVisible === true && mainState.isMinimized === false, mainState);

  for (const enabled of [true, false]) {
    const mm = await main.mark();
    const pm = await cat.mark();
    checkEqual(`window.setAlwaysOnTop ${enabled} (main) → {}`, await main.ok('window.setAlwaysOnTop', { enabled }), {});
    await expectEventIn(main, 'window.stateChanged', mm, `window.stateChanged { alwaysOnTop: ${enabled} } arrives in the main window`, `(d) => d && d.windowId === 'main' && d.alwaysOnTop === ${enabled}`);
    check(`window.getState reports alwaysOnTop ${enabled}`, (await main.ok('window.getState')).alwaysOnTop === enabled);
    await expectNoEventIn(cat, 'window.stateChanged', pm, 'window.stateChanged of the main window is not sent to the cat window', 100);
  }
}

async function testHotkeys(ctx) {
  const { main, cat } = ctx;
  const none = { toggleCat: null, startFocus: null, quickNote: null };
  const others = otherCatDesktopPids(ctx.proc.pid);
  const current = await main.ok('hotkeys.get');
  checkShape('Hotkeys', current, 'hotkeys.get');
  const hostLog = currentRunLog(ctx.dataDir);
  if (others.length > 0) {
    info(`another CatDesktop.exe is running (pid ${others.join(', ')}) and owns the default shortcuts`);
    checkEqual('default shortcuts are reported unavailable (all null)', current, none);
    check('host log records the conflicting shortcuts', ['Ctrl+Shift+P', 'Ctrl+Shift+F', 'Ctrl+Shift+N'].every((g) => hostLog.includes(`Hotkey '${g}'`)), 'expected "Hotkey \'…\' not registered" warnings for all three defaults');
    await expectError(main, 'hotkeys.set', { toggleCat: 'Ctrl+Shift+P', startFocus: null, quickNote: null }, 'denied', 'set a shortcut owned by another app → denied');
    checkEqual('denied set leaves the previous bindings', await main.ok('hotkeys.get'), current);
  } else {
    info('no other CatDesktop.exe is running: the defaults must be registered by this instance');
    checkEqual('default shortcuts registered', current, { toggleCat: 'Ctrl+Shift+P', startFocus: 'Ctrl+Shift+F', quickNote: 'Ctrl+Shift+N' });
    // They are system-wide: give them back to the user straight away.
    checkEqual('hotkeys.set all null releases them', await main.ok('hotkeys.set', none), none);
  }

  // Deterministic conflict: a helper process holds CONFLICT_GESTURE, like another application would.
  ctx.holder = await startHotkeyHolder();
  const conflict = ctx.holder.held || ctx.holder.error === 1409;
  info(`hotkey holder for ${CONFLICT_GESTURE}: ${ctx.holder.held ? `held by pid ${ctx.holder.child.pid}` : `not held (${ctx.holder.error})`}`);
  if (conflict) {
    const bindingsBefore = await main.ok('hotkeys.get');
    const storedBefore = (await main.ok('settings.get', { key: 'hotkeys' })).value;
    const denied = await main.invoke('hotkeys.set', { toggleCat: FREE_GESTURE, startFocus: CONFLICT_GESTURE, quickNote: null });
    check(`hotkeys.set with ${CONFLICT_GESTURE} (taken) → denied`, denied.ok === false && denied.error?.code === 'denied', denied);
    check('denied message names the shortcut', typeof denied.error?.message === 'string' && denied.error.message.includes(CONFLICT_GESTURE), denied.error);
    checkEqual('denied set is atomic: previous bindings kept (the free gesture was rolled back)', await main.ok('hotkeys.get'), bindingsBefore);
    checkEqual('denied set persisted nothing', (await main.ok('settings.get', { key: 'hotkeys' })).value, storedBefore);
  } else {
    check(`could hold ${CONFLICT_GESTURE} to simulate a conflict`, false, ctx.holder.error);
  }

  const invalid = [
    [{ toggleCat: 'Ctrl+Shift+Banana', startFocus: null, quickNote: null }, 'an unknown key'],
    [{ toggleCat: 'P', startFocus: null, quickNote: null }, 'no modifier'],
    [{ toggleCat: 'Ctrl++P', startFocus: null, quickNote: null }, 'an empty part'],
    [{ toggleCat: 'Ctrl+Alt+Shift+F11', startFocus: 'ctrl+alt+shift+f11', quickNote: null }, 'the same gesture twice'],
    [{ toggleCat: 'Ctrl+Alt+Shift+' + 'F'.repeat(40), startFocus: null, quickNote: null }, 'a gesture longer than 40 chars'],
    [{ toggleCat: 5, startFocus: null, quickNote: null }, 'a numeric gesture'],
  ];
  for (const [payload, label] of invalid) {
    await expectError(main, 'hotkeys.set', payload, 'validation', `hotkeys.set with ${label} → validation`);
  }

  const free = { toggleCat: FREE_GESTURE, startFocus: null, quickNote: null };
  const pm = await cat.mark();
  checkEqual('hotkeys.set with an unused gesture → ok', await main.ok('hotkeys.set', free), free);
  checkEqual('hotkeys.get returns it', await main.ok('hotkeys.get'), free);
  checkEqual("persisted under settings key 'hotkeys'", (await main.ok('settings.get', { key: 'hotkeys' })).value, free);
  await expectEventIn(cat, 'settings.changed', pm, "settings.changed for 'hotkeys' arrives in the cat window", `(d) => d && d.key === 'hotkeys'`);
  checkEqual('hotkeys.set all null → ok', await main.ok('hotkeys.set', none), none);
  checkEqual('hotkeys.get → all null', await main.ok('hotkeys.get'), none);

  await testHotkeySuspend(ctx, conflict);
  checkEqual('hotkeys.set all null after the suspend checks', await main.ok('hotkeys.set', none), none);

  if (conflict) {
    // Saved bindings for the next start: one taken, one free. Checked after the restart in section 13
    // (a taken shortcut must not cost the others). Written through the generic store; applied at start-up.
    ctx.state.startupHotkeys = { toggleCat: CONFLICT_GESTURE, startFocus: SECOND_FREE_GESTURE, quickNote: null };
    await main.ok('settings.set', { key: 'hotkeys', value: ctx.state.startupHotkeys });
  }
}

/**
 * hotkeys.suspend (contract §3): the Settings recorder releases every global shortcut while it records, so Windows lets
 * another process (here: a probe) register the gestures; `false` takes them back. Uses only Ctrl+Alt+Shift+F9/F10/F11.
 */
async function testHotkeySuspend(ctx, conflict) {
  const { main } = ctx;
  const suspendInvalid = [
    [undefined, 'without payload'],
    [{}, "without 'suspended'"],
    [{ suspended: 'yes' }, "with suspended 'yes'"],
    [{ suspended: 1 }, 'with suspended 1'],
  ];
  for (const [payload, label] of suspendInvalid) {
    await expectError(main, 'hotkeys.suspend', payload, 'validation', `hotkeys.suspend ${label} → validation`);
  }

  const held = (gesture) => probeHotkey(gesture).startsWith('taken 1409');
  const free = (gesture) => probeHotkey(gesture) === 'free';
  const bound = { toggleCat: FREE_GESTURE, startFocus: null, quickNote: null };
  checkEqual(`hotkeys.set ${FREE_GESTURE} before suspending`, await main.ok('hotkeys.set', bound), bound);
  check(`the host holds ${FREE_GESTURE} (another process cannot register it)`, held(FREE_GESTURE), probeHotkey(FREE_GESTURE));

  checkEqual('hotkeys.suspend { suspended: true } → {}', await main.ok('hotkeys.suspend', { suspended: true }), {});
  checkEqual('hotkeys.get while suspended still reports the configured bindings', await main.ok('hotkeys.get'), bound);
  check(`while suspended another process can register ${FREE_GESTURE}`, free(FREE_GESTURE), probeHotkey(FREE_GESTURE));
  checkEqual('suspending again (restarts the safety clock) → {}', await main.ok('hotkeys.suspend', { suspended: true }), {});

  // hotkeys.set during a suspension still validates atomically and keeps the new set released until the resume.
  if (conflict) {
    await expectError(main, 'hotkeys.set', { toggleCat: SECOND_FREE_GESTURE, startFocus: CONFLICT_GESTURE, quickNote: null }, 'denied', `hotkeys.set while suspended with ${CONFLICT_GESTURE} (taken) → denied`);
    checkEqual('… atomic: the configured bindings are unchanged', await main.ok('hotkeys.get'), bound);
    check(`… and ${SECOND_FREE_GESTURE} of the rejected set was released again`, free(SECOND_FREE_GESTURE), probeHotkey(SECOND_FREE_GESTURE));
  }
  const bound2 = { toggleCat: SECOND_FREE_GESTURE, startFocus: FREE_GESTURE, quickNote: null };
  checkEqual('hotkeys.set while suspended → ok', await main.ok('hotkeys.set', bound2), bound2);
  checkEqual('hotkeys.get while suspended reports the new bindings', await main.ok('hotkeys.get'), bound2);
  check('the new set stays released while suspended', free(SECOND_FREE_GESTURE) && free(FREE_GESTURE), [probeHotkey(SECOND_FREE_GESTURE), probeHotkey(FREE_GESTURE)]);

  checkEqual('hotkeys.suspend { suspended: false } → {}', await main.ok('hotkeys.suspend', { suspended: false }), {});
  check('after the resume the host holds both gestures again', held(SECOND_FREE_GESTURE) && held(FREE_GESTURE), [probeHotkey(SECOND_FREE_GESTURE), probeHotkey(FREE_GESTURE)]);
  checkEqual('hotkeys.get after the resume', await main.ok('hotkeys.get'), bound2);
  checkEqual('resuming when not suspended is a no-op → {}', await main.ok('hotkeys.suspend', { suspended: false }), {});
  check('… the gestures stay registered', held(SECOND_FREE_GESTURE) && held(FREE_GESTURE));

  // Resuming is best effort: a gesture another application took in the meantime is dropped from hotkeys.get.
  await main.ok('hotkeys.suspend', { suspended: true });
  const thief = await startHotkeyHolder(FREE_GESTURE);
  try {
    if (check(`another process takes ${FREE_GESTURE} while the host is suspended`, thief.held, thief.error)) {
      await main.ok('hotkeys.suspend', { suspended: false });
      checkEqual('the resume drops the taken gesture from hotkeys.get', await main.ok('hotkeys.get'), { ...bound2, startFocus: null });
      check(`… and still registers the others (${SECOND_FREE_GESTURE})`, held(SECOND_FREE_GESTURE), probeHotkey(SECOND_FREE_GESTURE));
      check('host log names the shortcut it could not restore', currentRunLog(ctx.dataDir).includes(`Could not restore shortcut startFocus '${FREE_GESTURE}'`));
    }
  } finally {
    if (thief.child.exitCode === null) killTree(thief.child.pid);
    await until(async () => free(FREE_GESTURE), 5_000, 250); // Windows releases it when the holder's thread is gone
    await main.invoke('hotkeys.suspend', { suspended: false });
  }

  if (ctx.opts.long) {
    await main.ok('hotkeys.set', bound2);
    await main.ok('hotkeys.suspend', { suspended: true });
    check(`suspended again: ${SECOND_FREE_GESTURE} is free`, free(SECOND_FREE_GESTURE));
    info('waiting 63 s for the automatic resume …');
    await sleep(63_000);
    check('the host resumes by itself 60 s after the last suspend', held(SECOND_FREE_GESTURE) && held(FREE_GESTURE), [probeHotkey(SECOND_FREE_GESTURE), probeHotkey(FREE_GESTURE)]);
    checkEqual('hotkeys.get after the automatic resume', await main.ok('hotkeys.get'), bound2);
  } else {
    info('automatic resume after 60 s not exercised (run with --long)');
  }
}

async function testData(ctx) {
  const { main } = ctx;
  const infoRes = await main.ok('data.getInfo');
  const notes = await main.ok('notes.list', {});
  const tasks = await main.ok('tasks.list', { includeCompleted: true });
  check('noteCount matches notes.list', infoRes.noteCount === notes.length, { noteCount: infoRes.noteCount, listed: notes.length });
  check('taskCount matches tasks.list (incl. completed)', infoRes.taskCount === tasks.length, { taskCount: infoRes.taskCount, listed: tasks.length });
  check('schemaVersion = 2 (001 + 002_cat_companion)', infoRes.schemaVersion === 2, infoRes.schemaVersion);
  check('databasePath is inside the temp data folder', samePath(infoRes.databasePath, path.join(ctx.dataDir, 'Database', 'application.db')), infoRes.databasePath);
  check('database file exists on disk', fs.existsSync(infoRes.databasePath), infoRes.databasePath);
  check('sizeBytes > 0', infoRes.sizeBytes > 0, infoRes.sizeBytes);
  checkShape('DataInfo', infoRes, 'data.getInfo');
}

async function testSecurity(ctx) {
  const { main, cat } = ctx;
  const hostObjects = await main.eval(`(async () => {
    const w = window.chrome.webview;
    const present = typeof w.hostObjects !== 'undefined' && w.hostObjects !== null;
    if (!present) return { present };
    try {
      const outcome = await Promise.race([
        Promise.resolve(w.hostObjects.catdesktop).then((v) => ({ resolved: typeof v })),
        new Promise((r) => setTimeout(() => r({ timeout: true }), 1500)),
      ]);
      return { present, outcome };
    } catch (e) {
      return { present, outcome: { rejected: String((e && e.message) || e) } };
    }
  })()`);
  check('no usable host object (AreHostObjectsAllowed=false)', !hostObjects.present || !('resolved' in (hostObjects.outcome ?? {})) || hostObjects.outcome.resolved === 'undefined', hostObjects);
  info(`chrome.webview.hostObjects: ${fmt(hostObjects)}`);

  const tampered = await main.eval(`(() => { try { window.__catdesktop = { hosted: false }; } catch {} try { window.__catdesktop.windowKind = 'cat'; } catch {} return window.__catdesktop && window.__catdesktop.windowKind; })()`);
  check('window.__catdesktop cannot be replaced or modified', tampered === 'main', tampered);

  // The rest of the host's init script: root classes and the file drag & drop guard.
  for (const page of [main, cat]) {
    const r = await page.eval(`(() => {
      const c = document.documentElement.classList;
      const cancelled = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; };
      return { hosted: c.contains('catdesktop-hosted'), kind: c.contains('catdesktop-${page.kind}'), dragover: cancelled('dragover'), drop: cancelled('drop') };
    })()`);
    check(`init script tags <html> with catdesktop-hosted + catdesktop-${page.kind} (${page.kind})`, r.hosted && r.kind, r);
    check(`init script cancels file dragover/drop (no drop-to-navigate) (${page.kind})`, r.dragover && r.drop, r);
  }

  const pagesBefore = appPages(await listTargets(ctx.opts.port)).length;
  const allBefore = (await listTargets(ctx.opts.port)).filter((t) => t.type === 'page').length;
  const opened = await main.eval(`(() => { const w = window.open('about:blank'); return w === null ? 'null' : typeof w; })()`, { userGesture: true });
  await sleep(1_500);
  const allAfter = (await listTargets(ctx.opts.port)).filter((t) => t.type === 'page').length;
  check("window.open('about:blank') creates no new window/target", allAfter === allBefore, { before: allBefore, after: allAfter, windowOpenReturned: opened });
  const newWindowLogged = readHostLog(ctx.dataDir).includes("ignored new-window request for 'about:blank'");
  check('host handled the new-window request (logged and ignored)', newWindowLogged || opened === 'null', { opened, newWindowLogged });

  for (const url of ['file:///C:/Windows/win.ini', 'about:blank']) {
    await main.eval(`location.href = ${JSON.stringify(url)}; true`);
    await sleep(1_500);
    const where = await main.eval(`({ origin: location.origin, href: location.href, helper: !!window.__e2e })`).catch((err) => ({ error: String(err) }));
    if (!check(`navigation to ${url} is blocked (still on the app origin, no reload)`, where.origin === APP_ORIGIN && where.helper === true, where)) {
      await recoverPage(main); // keep the rest of the suite usable
    }
    const targets = appPages(await listTargets(ctx.opts.port));
    check(`CDP still shows both app pages after ${url}`, targets.length === pagesBefore, targets.map((t) => t.url));
  }
  const blockedLogged = readHostLog(ctx.dataDir);
  info(`host log: blocked file:// ${blockedLogged.includes("blocked navigation to 'file:///")}, blocked about:blank ${blockedLogged.includes("blocked navigation to 'about:blank'")}`);

  const objectMsg = await main.eval(`window.__e2e.postObject('app.getInfo')`);
  check('a non-string web message is ignored (no response)', objectMsg?.error?.code === 'e2e_timeout', objectMsg);
  const malformed = await main.eval(`window.__e2e.postMalformed('app.getInfo')`);
  check('a malformed JSON message is ignored (no response)', malformed?.error?.code === 'e2e_timeout', malformed);
  const stillAlive = await main.invoke('app.getInfo');
  check('bridge keeps working after junk messages', stillAlive.ok === true, stillAlive);
  const catAlive = await cat.invoke('app.getInfo');
  check('cat bridge unaffected', catAlive.ok === true, catAlive);
}

async function testUi(ctx) {
  const { main, cat } = ctx;
  const go = (route) => main.eval(`location.hash = ${JSON.stringify('#' + route)}; true`);
  const contentText = `(document.querySelector('main.content') || document.body).innerText`;
  const expectations = [
    ['/dashboard', ['Today', 'Pinned notes', 'Focus', 'Cat'], /Good (morning|afternoon|evening)|Still up\?/],
    ['/notes', ['Notes', 'New note', 'E2E Beta pinned', 'E2E Alpha'], null],
    ['/tasks', ['Tasks', 'Add', 'E2E Task two'], null],
    ['/focus', ['Focus', 'Timer settings'], null],
    ['/settings', ['Settings', 'Appearance', 'Cat', 'Quick actions', 'Keyboard shortcuts', 'Data', 'About'], null],
  ];
  for (const [route, texts, pattern] of expectations) {
    await go(route);
    const ok = await main.waitUntil(`(() => { const a = document.querySelector('a.nav-link.is-active'); const t = ${contentText}; return !!a && a.getAttribute('href') === ${JSON.stringify('#' + route)} && ${JSON.stringify(texts)}.every((s) => t.includes(s)) ${pattern ? `&& ${pattern}.test(t)` : ''}; })()`, 5_000);
    check(`#${route} renders (${texts.join(', ')}${pattern ? ', greeting' : ''})`, ok, (await main.eval(contentText)).slice(0, 400));
  }
  await go('/dashboard');
  const pinnedOnDashboard = await main.waitUntil(`${contentText}.includes('E2E Beta pinned')`, 3_000);
  check('dashboard lists the pinned note', pinnedOnDashboard);

  // Bridge-created records appear on the pages.
  await go('/notes');
  await main.waitUntil(`!!document.querySelector('app-notes')`, 3_000);
  await main.ok('notes.create', { title: 'E2E Bridge note (UI)', content: 'from the bridge' });
  check('a note created through the bridge appears on the Notes page', await main.waitUntil(`[...document.querySelectorAll('.note-list .item-title')].some((e) => e.textContent.trim() === 'E2E Bridge note (UI)')`, 3_000));
  await go('/tasks');
  await main.waitUntil(`!!document.querySelector('app-tasks')`, 3_000);
  await cat.ok('tasks.create', { title: 'E2E Bridge task (UI)' });
  check('a task created through the bridge (cat window) appears on the Tasks page', await main.waitUntil(`${contentText}.includes('E2E Bridge task (UI)')`, 3_000));

  // Create a note through the UI (DOM events only, no OS input).
  await go('/notes');
  await main.waitUntil(`!!document.querySelector('app-notes .list-header .btn-primary')`, 3_000);
  await main.eval(`document.querySelector('app-notes .list-header .btn-primary').click(); true`);
  const editor = await main.waitUntil(`!!document.querySelector('#note-title') && !!document.querySelector('#note-content')`, 3_000);
  check('New note opens the editor', editor);
  await main.eval(`(() => {
    const set = (sel, value) => { const el = document.querySelector(sel); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#note-title', 'E2E UI note');
    set('#note-content', 'typed through DOM events');
    return true;
  })()`);
  const uiNote = await until(async () => (await main.ok('notes.list', {})).find((n) => n.title === 'E2E UI note' && n.content === 'typed through DOM events'), 5_000, 200);
  check('the UI-created note (autosaved) lands in notes.list', !!uiNote, (await main.ok('notes.list', {})).map((n) => [n.title, n.content]));
  check('editor reports Saved', await main.waitUntil(`document.querySelector('.save-state')?.textContent.trim() === 'Saved'`, 3_000), await main.eval(`document.querySelector('.save-state')?.textContent.trim()`));
  check('the UI note is listed in the sidebar list', await main.waitUntil(`[...document.querySelectorAll('.note-list .item-title')].some((e) => e.textContent.trim() === 'E2E UI note')`, 3_000));

  // Create a task through the UI.
  await go('/tasks');
  await main.waitUntil(`!!document.querySelector('#task-title')`, 3_000);
  await main.eval(`(() => { const el = document.querySelector('#task-title'); el.value = 'E2E UI task'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await main.waitUntil(`!document.querySelector('form.add-form button[type=submit]').disabled`, 2_000);
  await main.eval(`document.querySelector('form.add-form button[type=submit]').click(); true`);
  const uiTask = await until(async () => (await main.ok('tasks.list', {})).find((t) => t.title === 'E2E UI task'), 4_000, 200);
  check('the UI-created task lands in tasks.list', !!uiTask);

  // Cat page rendering.
  const catUi = await cat.eval(`(() => {
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const sprite = document.querySelector('app-cat-sprite');
    const r = sprite ? sprite.getBoundingClientRect() : null;
    return { bodyClass: document.body.classList.contains('cat-window'), htmlHosted: document.documentElement.classList.contains('catdesktop-cat'),
             bodyBg: bg(document.body), htmlBg: bg(document.documentElement), sprite: !!sprite, drawn: !!(sprite && sprite.querySelector('svg, [style*="background"]')),
             w: r && Math.round(r.width), h: r && Math.round(r.height) };
  })()`);
  check('cat page: body.cat-window and <html class="catdesktop-cat">', catUi.bodyClass && catUi.htmlHosted, catUi);
  const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  check('cat page: transparent computed background (html + body)', transparent(catUi.bodyBg) && transparent(catUi.htmlBg), catUi);
  const box = catBox(ctx.state.catSettings.scale);
  check(`cat page: the cat sprite fills the ${box.width}x${box.height} cat box`, catUi.sprite && catUi.drawn && near(catUi.w, box.width, 2) && near(catUi.h, box.height, 2), catUi);

  const px = (css) => roundHalfEven(css * ctx.dpr);
  const sizeIs = (g) => until(async () => { const st = await main.ok('cat.getPosition'); return near(st.width, px(g.width)) && near(st.height, px(g.height)) ? st : null; }, 4_000);
  const pressEscape = () => cat.eval(`(() => { const t = document.activeElement || document.body; for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
  const catText = () => cat.eval('document.body.innerText');

  // Context menu (the right-click menu) through the open-menu command.
  await main.ok('cat.sendCommand', { action: 'open-menu' });
  check('open-menu: the cat window grows to the menu layout', !!(await sizeIs(catGeometry(ctx.state.catSettings.scale, 'menu'))), await main.ok('cat.getPosition'));
  const menuText = await cat.waitUntil(`(() => { const t = document.body.innerText; return ['Cat Companion', 'Move Cat', 'Change Theme', 'Change Size', 'Always on Top', 'Cat Settings', 'Hide Cat'].every((x) => t.includes(x)) && /Pause Walking|Resume Walking/.test(t) ? t : false; })()`, 3_000);
  check('context menu shows Cat Companion: Pause/Resume Walking, Move Cat, Change Theme, Change Size, Always on Top, Cat Settings, Hide Cat', !!menuText, (await catText()).slice(0, 300));
  await pressEscape();
  check('Esc closes the menu (back to the cat layout)', !!(await sizeIs(catGeometry(ctx.state.catSettings.scale))), await main.ok('cat.getPosition'));

  // Companion panel with the quick actions; clicking Settings navigates the main window.
  const enabledActions = ctx.state.actions.filter((a) => a.enabled);
  await main.ok('cat.sendCommand', { action: 'open-panel' });
  check('open-panel: the cat window grows to the panel layout', !!(await sizeIs(catGeometry(ctx.state.catSettings.scale, 'panel'))), await main.ok('cat.getPosition'));
  const listed = await cat.waitUntil(`(() => { const t = document.body.innerText; return ${JSON.stringify(enabledActions.map((a) => a.name))}.every((n) => t.includes(n)); })()`, 3_000);
  check(`companion panel lists the ${enabledActions.length} enabled quick actions`, !!listed, { expected: enabledActions.map((a) => a.name), text: (await catText()).slice(0, 400) });
  await main.eval(`location.hash = '#/dashboard'; true`);
  const clicked = await cat.eval(`(() => {
    const els = [...document.querySelectorAll('button, [role=button], a')];
    const el = els.find((b) => b.getAttribute('title') === 'Settings' || b.getAttribute('aria-label') === 'Settings' || b.textContent.trim() === 'Settings');
    if (!el) return false; el.click(); return true;
  })()`);
  check("the panel has a 'Settings' quick action", clicked);
  const navigated = await main.waitUntil(`location.hash.startsWith('#/settings')`, 3_000);
  check("clicking the cat's Settings action navigates the main window to #/settings", navigated, await main.eval('location.hash'));
  await pressEscape();
  check('Esc closes the panel (back to the cat layout)', !!(await sizeIs(catGeometry(ctx.state.catSettings.scale))), await main.ok('cat.getPosition'));
}

/**
 * Contract §2 "Event delivery": events for a window are queued until its CURRENT document has sent its first message,
 * and a reload starts queuing again. An event sent while a page reloads must therefore reach the new document instead of
 * dying with the old one. Page.reload also exercises the host's reload of the bare origin (Angular shows the page as
 * https://app.catdesktop.local/#/…, which the host loads as /index.html#/…).
 */
async function testReloads(ctx) {
  const { main, cat } = ctx;
  const px = (css) => roundHalfEven(css * ctx.dpr);
  const catSize = async () => { const st = await main.ok('cat.getPosition'); return [st.width, st.height]; };
  const scale = ctx.state.catSettings.scale;
  const catG = catGeometry(scale);
  const panelG = catGeometry(scale, 'panel');
  const is = (g) => async () => { const [w, h] = await catSize(); return near(w, px(g.width)) && near(h, px(g.height)); };

  // ---- cat page: cat.command sent right after the reload started
  await main.ok('cat.show');
  check('the cat is in the cat layout before the reload', !!(await until(is(catG), 3_000)), await catSize());
  info(`cat page before the reload: ${await cat.eval('location.href')}`);
  await cat.cdp.send('Page.reload', {});
  const sent = await main.invoke('cat.sendCommand', { action: 'tasks', payload: { source: 'e2e-reload' } });
  check('cat.sendCommand right after the cat page started reloading → ok', sent?.ok === true, sent);
  const catBack = await reattachAfterReload(cat);
  check('the cat page reloads and boots again (reload of the production address works)', catBack, await cat.eval('location.href').catch((err) => String(err)));
  info(`cat page after the reload: ${await cat.eval('location.href').catch(() => '?')}`);
  const opened = await until(is(panelG), 5_000);
  check('the command reached the NEW cat document: CatWindowService handed it to the UI, the panel opened', !!opened, await catSize());
  const tasksShown = await cat.waitUntil(`document.body.innerText.includes('E2E Bridge task (UI)') || document.body.innerText.includes('E2E UI task')`, 3_000);
  check('… on the Tasks panel (it lists the open tasks)', !!tasksShown, (await cat.eval('document.body.innerText').catch(String)).slice(0, 300));
  const stayed = await sleep(600).then(is(panelG));
  check('… and the start-up layout did not fold it back', stayed, await catSize());
  await cat.eval(`(() => { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
  check('Esc folds the reloaded cat back', !!(await until(is(catG), 3_000)), await catSize());

  // ---- main page: navigation.navigate sent right after the reload started
  await main.eval(`location.hash = '#/dashboard'; true`);
  await main.waitUntil(`location.hash === '#/dashboard' && !!document.querySelector('app-dashboard')`, 3_000);
  info(`main page before the reload: ${await main.eval('location.href')}`);
  await main.cdp.send('Page.reload', {});
  const nav = await cat.invoke('navigation.navigate', { route: '/focus' });
  check('navigation.navigate right after the main page started reloading → ok', nav?.ok === true, nav);
  const mainBack = await reattachAfterReload(main);
  check('the main page reloads and boots again', mainBack, await main.eval('location.href').catch((err) => String(err)));
  const landed = await main.waitUntil(`location.hash === '#/focus' && !!document.querySelector('app-focus')`, 5_000);
  check('the navigation reached the NEW main document: it lands on #/focus', !!landed, await main.eval('location.hash').catch(String));
  const kept = await sleep(600).then(() => main.eval(`location.hash`));
  check('… and stays there (the reload did not override it)', kept === '#/focus', kept);
  check('the reloaded main page answers requests', (await main.invoke('app.getInfo')).ok === true);
  check('the reloaded cat page answers requests', (await cat.invoke('app.getInfo')).ok === true);
}

async function snapshot(page) {
  return {
    notes: await page.ok('notes.list', {}),
    tasks: await page.ok('tasks.list', { includeCompleted: true }),
    settings: await page.ok('settings.getAll'),
    actions: await page.ok('actions.list'),
    catSettings: await page.ok('cat.getSettings'),
    focusSettings: await page.ok('focus.getSettings'),
    stats: await page.ok('focus.getStats'),
    hotkeys: await page.ok('hotkeys.get'),
  };
}

async function testPersistence(ctx) {
  // Single instance: a second launch with the same data folder hands over to the running copy and exits 0.
  const second = launch(ctx.opts, ctx.dataDir);
  const secondCode = await Promise.race([second.exitPromise, sleep(15_000).then(() => 'timeout')]);
  if (secondCode === 'timeout') killTree(second.pid);
  check('a second launch with the same data folder exits by itself with code 0', secondCode === 0, { secondCode });
  check('… after activating the running copy (host log)', readHostLog(ctx.dataDir).includes('Another instance is running; activated it and exiting.'));
  const firstStillUp = await ctx.main.invoke('app.getInfo');
  check('the first instance keeps running and answering', firstStillUp.ok === true && !ctx.proc.exited, firstStillUp);
  check('the activated main window is visible', (await ctx.main.ok('window.getState')).isVisible === true);

  const parked = await ctx.main.ok('cat.moveTo', ctx.state.catPos);
  check('cat at the parked coordinates before exit', parked.x === ctx.state.catPos.x && parked.y === ctx.state.catPos.y, parked);
  const before = await snapshot(ctx.main);
  const mainBefore = await ctx.main.ok('window.getState');
  info(`snapshot: ${before.notes.length} notes, ${before.tasks.length} tasks, ${Object.keys(before.settings).length} settings, ${before.actions.length} actions`);

  await exitApp(ctx, 'first run');
  check('host log says "CatDesktop exited normally."', readHostLog(ctx.dataDir).includes('CatDesktop exited normally.'));
  const settled = await waitForWebViewShutdown(ctx.dataDir);
  check('WebView2 processes of the test instance shut down', settled, webViewPidsFor(ctx.dataDir));

  currentRun = 'run2';
  await startApp(ctx);
  const after = await snapshot(ctx.main);
  checkEqual('notes restored', after.notes, before.notes);
  checkEqual('tasks restored', after.tasks, before.tasks);
  checkEqual('settings restored', after.settings, before.settings);
  checkEqual('quick actions restored', after.actions, before.actions);
  checkEqual('cat settings restored', after.catSettings, before.catSettings);
  checkEqual('focus settings restored', after.focusSettings, before.focusSettings);
  checkEqual('focus stats restored', after.stats, before.stats);
  const mainAfter = await ctx.main.ok('window.getState');
  checkEqual('main window bounds restored', [mainAfter.x, mainAfter.y, mainAfter.width, mainAfter.height, mainAfter.isMaximized], [mainBefore.x, mainBefore.y, mainBefore.width, mainBefore.height, mainBefore.isMaximized]);
  if (ctx.state.startupHotkeys) {
    checkEqual(`start-up with a taken shortcut: ${CONFLICT_GESTURE} skipped, ${SECOND_FREE_GESTURE} still registered`, after.hotkeys, { toggleCat: null, startFocus: SECOND_FREE_GESTURE, quickNote: null });
    const runLog = currentRunLog(ctx.dataDir);
    check('host log names the unavailable shortcut', runLog.includes(`Hotkey '${CONFLICT_GESTURE}' (toggleCat) not registered`), runLog.split(/\r?\n/).filter((l) => /hotkey/i.test(l)));
    const none = { toggleCat: null, startFocus: null, quickNote: null };
    checkEqual('hotkeys.set all null after the check', await ctx.main.ok('hotkeys.set', none), none);
  } else {
    checkEqual('hotkeys restored', after.hotkeys, before.hotkeys);
  }
  stopHotkeyHolder(ctx);
  const pos = await ctx.main.ok('cat.getPosition');
  check('cat position restored to the moveTo coordinates', pos.x === ctx.state.catPos.x && pos.y === ctx.state.catPos.y, { pos, expected: ctx.state.catPos });
  check('cat restored visible at the saved scale (1.4 = 224x168)', near(pos.width, roundHalfEven(224 * ctx.dpr)) && near(pos.height, roundHalfEven(168 * ctx.dpr)) && pos.isVisible === true, pos);
  const focus = await ctx.main.ok('focus.getState');
  check('focus timer starts idle with the saved duration', focus.status === 'idle' && focus.totalSeconds === before.focusSettings.focusMinutes * 60, focus);
  check('main UI starts with the saved theme', await ctx.main.waitUntil(`document.documentElement.dataset.theme === 'dark'`, 3_000));
  check('cat UI starts with opacity 0.5', await ctx.cat.waitUntil(`(() => { const el = document.querySelector('app-cat-sprite'); return !!el && getComputedStyle(el).getPropertyValue('--cat-opacity').trim() === '0.5'; })()`, 3_000));

  // Legacy Pet Book settings are converted once at start-up (contract §5).
  await ctx.main.ok('settings.remove', { key: 'cat.settings' });
  await ctx.main.ok('settings.set', { key: 'petbook.settings', value: { enabled: true, alwaysOnTop: false, startWithApp: true, opacity: 0.6, animations: true, sound: true, compactMode: true, wheelBehavior: 'cycle-actions', snapBackAfterThrow: false, size: 'small', theme: 'system', home: null } });
  await exitApp(ctx, 'second run');
  await waitForWebViewShutdown(ctx.dataDir);
  currentRun = 'run3';
  await startApp(ctx);
  const converted = await ctx.main.ok('cat.getSettings');
  checkEqual("legacy 'petbook.settings' converted: enabled/alwaysOnTop/startWithApp/opacity kept, size small → scale 0.7, the rest default (sound off)", converted, { ...DEFAULT_CAT_SETTINGS, alwaysOnTop: false, opacity: 0.6, scale: 0.7 });
  checkEqual("… and 'petbook.settings' removed", (await ctx.main.ok('settings.get', { key: 'petbook.settings' })).value, null);
  const small = await ctx.main.ok('cat.getPosition');
  check('… the cat window uses the converted scale (0.7 = 112x84)', near(small.width, roundHalfEven(112 * ctx.dpr)) && near(small.height, roundHalfEven(84 * ctx.dpr)), small);
  await exitApp(ctx, 'third run');
}

function testDiagnostics(ctx) {
  const errors = diagnostics.filter((d) => ['console.error', 'exception', 'log.error', 'network.failed', 'network.http'].includes(d.type));
  const expected = errors.filter(isExpectedDiagnostic);
  const unexpected = errors.filter((d) => !isExpectedDiagnostic(d));
  for (const d of expected) info(`expected page diagnostic (${isExpectedDiagnostic(d).why}): [${d.run}/${d.page}] ${d.type}: ${d.text}`);
  for (const kind of ['main', 'cat']) {
    const mine = unexpected.filter((d) => d.page === kind);
    check(`no console errors / exceptions / failed requests in the ${kind} page`, mine.length === 0, mine.map((d) => `[${d.run} ${d.section}] ${d.type}: ${d.text}`));
  }
  const warnings = diagnostics.filter((d) => ['console.warn', 'log.warn'].includes(d.type));
  for (const w of warnings) info(`page warning: [${w.run}/${w.page} ${w.section}] ${w.type}: ${w.text}`);

  const lines = readHostLog(ctx.dataDir).split(/\r?\n/).filter((l) => /\[(WARN |ERROR)\]/.test(l));
  const unexpectedHost = [];
  for (const line of lines) {
    const known = EXPECTED_HOST_WARNINGS.find((e) => e.pattern.test(line));
    if (known && !line.includes('[ERROR]')) info(`expected host warning (${known.why}): ${line.replace(/^.*?\] \[\s*\d+\] /, '')}`);
    else unexpectedHost.push(line);
  }
  check('host log has no WARN/ERROR lines besides the expected ones', unexpectedHost.length === 0, unexpectedHost);
}

// =====================================================================================================
// Main
// =====================================================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  if (process.platform !== 'win32') throw new Error('CatDesktop end-to-end tests run on Windows only.');
  if (!fs.existsSync(opts.exe)) throw new Error(`CatDesktop.exe not found at ${opts.exe} (build it or pass --exe)`);
  if (!fs.existsSync(path.join(path.dirname(opts.exe), 'wwwroot', 'index.html'))) {
    throw new Error(`No wwwroot/index.html next to ${opts.exe}: build the Angular app first so the host serves the production UI.`);
  }
  const portBusy = await fetch(`http://127.0.0.1:${opts.port}/json/version`, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false);
  if (portBusy) throw new Error(`Port ${opts.port} is already serving DevTools; pick another with --port.`);

  const tmpRoot = fs.realpathSync.native(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'catdesktop-e2e-'));
  const ctx = { opts, dataDir, state: {}, proc: null, main: null, cat: null };
  let fatal = null;

  const onSignal = () => {
    log('\nInterrupted: stopping the test instance…');
    if (ctx.proc && !ctx.proc.exited) killTree(ctx.proc.pid);
    stopHotkeyHolder(ctx);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);

  log(`CatDesktop e2e bridge smoke test\n  exe:  ${opts.exe}\n  data: ${dataDir}\n  CDP:  127.0.0.1:${opts.port}${opts.long ? '\n  mode: --long' : ''}`);
  try {
    section('0. launch & attach');
    let screens = null;
    try {
      screens = queryScreens();
    } catch (err) {
      info(`PowerShell monitor query failed (${err.message.split('\n')[0]}); falling back to the cat page's screen info`);
    }
    await startApp(ctx);
    check('main page (#/…) and cat page (#/cat) attached over CDP', !!ctx.main && !!ctx.cat);
    ctx.dpr = await ctx.cat.eval('window.devicePixelRatio');
    if (!screens) {
      const s = await ctx.cat.eval(`({ x: screen.availLeft, y: screen.availTop, w: screen.availWidth, h: screen.availHeight, W: screen.width, H: screen.height })`);
      const p = (v) => Math.round(v * ctx.dpr);
      const work = { x: p(s.x), y: p(s.y), width: p(s.w), height: p(s.h) };
      screens = { screens: [{ name: (await ctx.main.ok('cat.getPosition')).monitor, primary: true, work, bounds: { x: 0, y: 0, width: p(s.W), height: p(s.H) } }] };
      screens.virtual = screens.screens[0].bounds;
    }
    ctx.primary = screens.screens.find((s) => s.primary) ?? screens.screens[0];
    ctx.work = ctx.primary.work;
    ctx.virtual = screens.virtual;
    ctx.screens = screens.screens;
    // Freeze the autonomous behaviour (walks, idles, random actions) so positions stay deterministic, and park the test
    // cat away from the bottom-right corner, where the user's own cat usually lives.
    ctx.state.catDefaults = await ctx.main.ok('cat.getSettings');
    await ctx.main.ok('cat.saveSettings', { ...ctx.state.catDefaults, autoWalk: false, randomIdle: false, randomActions: false });
    await ctx.main.ok('cat.stop');
    const park = await ctx.main.ok('cat.moveTo', { x: ctx.work.x + 200, y: ctx.work.y + 150 });
    info(`test cat parked at ${park.x},${park.y} (${park.width}x${park.height}); autonomous behaviour frozen`);

    // Hotkeys run second (not ninth): when the user's own CatDesktop is not running, this instance registers the
    // system-wide default shortcuts at start-up, and the section releases them as early as possible.
    const sections = [
      ['1. app.getInfo, unsupported & validation', testAppInfo],
      ['9. hotkeys.* (run early to release the global shortcuts)', testHotkeys],
      ['2. notes.*', testNotes],
      ['3. tasks.*', testTasks],
      ['4. settings.*', testSettings],
      ['5. actions.*', testActions],
      ['6. focus.*', testFocus],
      ['7. cat.* (Cat Companion window)', testCat],
      ['8. navigation.navigate & window state', testNavigation],
      ['10. data.getInfo', testData],
      ['11. security', testSecurity],
      ['12. UI rendering (DOM only)', testUi],
      ['12b. page reloads: events sent meanwhile reach the new document', testReloads],
      ['13. persistence across restart', testPersistence],
    ];
    for (const [title, fn] of sections) {
      section(title);
      if (!ctx.proc || ctx.proc.exited) {
        check('host process is running', false, { exitCode: ctx.proc?.code });
        continue;
      }
      try {
        await fn(ctx);
      } catch (err) {
        check('section finished without an unexpected error', false, err);
      }
    }
    section('14. diagnostics');
    testDiagnostics(ctx);
  } catch (err) {
    fatal = err;
    check('suite ran to completion', false, err);
  } finally {
    process.removeListener('SIGINT', onSignal);
    stopHotkeyHolder(ctx);
    detachPages(ctx);
    if (ctx.proc && !ctx.proc.exited) {
      log(`\nStopping the test instance (pid ${ctx.proc.pid})…`);
      killTree(ctx.proc.pid);
      await Promise.race([ctx.proc.exitPromise, sleep(5_000)]);
    }
    if (opts.keepData) {
      log(`\nData folder kept: ${dataDir}`);
    } else {
      await waitForWebViewShutdown(dataDir, 15_000);
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (err) {
        log(`WARN  could not delete ${dataDir}: ${err.message}`);
      }
    }
  }

  const failed = results.filter((r) => !r.passed);
  log(`\n${'='.repeat(80)}\nSUMMARY: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`);
  for (const f of failed) log(`  FAIL  [${f.section}] ${f.name}`);
  if (fatal) log(`\nFatal: ${fatal.message}`);
  return failed.length;
}

main().then(
  (failures) => { process.exitCode = failures; },
  (err) => {
    log(`ERROR ${err.stack ?? err}`);
    process.exitCode = 1;
  },
);
