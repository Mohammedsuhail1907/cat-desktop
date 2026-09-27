/**
 * Minimal Chrome DevTools Protocol client + headless Chrome launcher for the cat preview tools (Node 22, no packages).
 *
 * CDP runs over --remote-debugging-pipe by default. On the development machine the endpoint protection terminates a
 * headless Chrome that has a remote-debugging *port* open shortly after it captures a screenshot (exit code 1260,
 * nothing in Chrome's log); the same protocol over the pipe (what Playwright uses) is not affected. Pass
 * { usePort: true } to use --remote-debugging-port instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const CHROME = process.env.CHROME ?? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

// ------------------------------------------------------------------------------------------------ CDP
export class Cdp {
  /** @param write (string) => void  */
  constructor(write) {
    this.write = write;
    this.id = 1;
    this.pending = new Map();
    this.sessionId = undefined;
    this.waiters = new Map();
  }
  /** Resolves on the next event with this method name. */
  once(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} not received`)), timeoutMs);
      if (!this.waiters.has(method)) this.waiters.set(method, []);
      this.waiters.get(method).push((p) => { clearTimeout(t); resolve(p); });
    });
  }
  receive(raw) {
    const msg = JSON.parse(raw);
    if (msg.method) {
      const waiters = this.waiters.get(msg.method) ?? [];
      this.waiters.delete(msg.method);
      for (const w of waiters) w(msg.params);
      return;
    }
    const p = msg.id !== undefined && this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
  send(method, params = {}, timeoutMs = 20_000, browserLevel = false) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method });
      const sessionId = browserLevel ? undefined : this.sessionId;
      this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

/** Starts Chrome and returns { cdp (attached to a fresh page), stop() }. */
export async function startChrome({ usePort = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-preview-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, usePort ? `--remote-debugging-port=${port}` : '--remote-debugging-pipe',
    '--no-first-run', '--hide-scrollbars', '--disable-gpu', ...(process.env.CAT_CHROME_FLAGS ? process.env.CAT_CHROME_FLAGS.split(' ') : []), 'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: usePort ? 'ignore' : ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let ws;
  const stop = async () => {
    try { ws?.close(); } catch { /* ignore */ }
    try { proc.stdio[3]?.destroy(); proc.stdio[4]?.destroy(); } catch { /* ignore */ }
    // kill the whole tree (renderer, GPU and crashpad helpers keep the profile folder locked otherwise)
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  };
  let cdp;
  try {
    if (usePort) {
      let version;
      for (let i = 0; i < 300 && !version; i++) {
        await sleep(100);
        try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* not up yet */ }
      }
      if (!version) throw new Error('Chrome did not start');
      ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP connect failed')), { once: true }); });
      cdp = new Cdp((s) => ws.send(s));
      ws.addEventListener('message', (ev) => cdp.receive(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')));
    } else {
      cdp = new Cdp((s) => proc.stdio[3].write(s + '\0'));
      let buf = '';
      proc.stdio[4].on('data', (d) => {
        buf += d.toString('utf8');
        for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) cdp.receive(buf.slice(0, i));
      });
    }
    // use the start-up tab (a second tab would be a background tab whose frames Chrome may stop producing)
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets', {}, 20_000, true);
      target = targetInfos.find((t) => t.type === 'page');
      if (!target) await sleep(100);
    }
    const targetId = target?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' }, 20_000, true)).targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, 20_000, true);
    await cdp.send('Target.activateTarget', { targetId }, 20_000, true);
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  } catch (e) {
    await stop();
    throw e;
  }
  return { cdp, stop };
}

