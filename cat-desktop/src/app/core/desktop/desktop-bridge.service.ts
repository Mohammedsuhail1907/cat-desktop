import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Observable, Subject, filter, map } from 'rxjs';
import { AppInfo, CatDesktopEnvironment, WindowKind } from '../models';
import {
  BridgeError,
  BridgeEvent,
  BridgeMessage,
  BridgeRequest,
  CommandArgs,
  CommandName,
  CommandResult,
  EventData,
  EventName,
} from './bridge-protocol';
import { BrowserHostSimulator } from './browser-host-simulator';
import { HostTransport, WebView2Transport, getWebView2 } from './host-transport';

declare global {
  interface Window {
    __catdesktop?: CatDesktopEnvironment;
  }
}

interface PendingCall {
  command: string;
  resolve: (value: unknown) => void;
  reject: (reason: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Dialog-driven commands wait for the user; don't time them out. */
const NO_TIMEOUT_COMMANDS = new Set<string>(['data.export', 'data.import']);

/**
 * The single gateway between Angular and the C# desktop host.
 *
 *   await bridge.invoke('notes.create', { title: 'Hi' });
 *   bridge.on('focus.tick').subscribe(state => …);
 *
 * Components/services never touch `window.chrome.webview` directly (contract §18).
 * When not hosted (plain browser during `ng serve`) a localStorage-backed simulator is used.
 */
@Injectable({ providedIn: 'root' })
export class DesktopBridgeService {
  private readonly zone = inject(NgZone);
  private readonly transport: HostTransport;
  private readonly pending = new Map<string, PendingCall>();
  private readonly events = new Subject<BridgeEvent>();

  /** True when running inside the CatDesktop host (WebView2). */
  readonly isHosted: boolean;
  /** Which host window renders this document. */
  readonly windowKind: WindowKind;
  /** Host build info; null until `loadInfo()` succeeded. */
  readonly info = signal<AppInfo | null>(null);
  /** Every host event as an observable stream. */
  readonly events$: Observable<BridgeEvent> = this.events.asObservable();

  constructor() {
    const env = typeof window !== 'undefined' ? window.__catdesktop : undefined;
    const webview = getWebView2();
    this.isHosted = !!env?.hosted && !!webview;
    this.windowKind = env?.windowKind ?? 'main';
    this.transport = this.isHosted && webview ? new WebView2Transport(webview) : new BrowserHostSimulator();
    this.transport.onMessage((message) => this.zone.run(() => this.handleMessage(message)));
  }

  /** True inside the host's transparent cat window (#/cat). */
  get isCatWindow(): boolean {
    return this.windowKind === 'cat';
  }

  get transportName(): string {
    return this.transport.name;
  }

  /** Send a command to the host and await its typed result. Rejects with {@link BridgeError}. */
  invoke<C extends CommandName>(command: C, ...args: CommandArgs<C>): Promise<CommandResult<C>> {
    const payload = args[0];
    const id = newId();
    const request: BridgeRequest = { kind: 'request', id, command, payload };

    return new Promise<CommandResult<C>>((resolve, reject) => {
      const timeoutMs = NO_TIMEOUT_COMMANDS.has(command) ? 0 : DEFAULT_TIMEOUT_MS;
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new BridgeError('timeout', `Host did not answer '${command}' within ${timeoutMs / 1000}s.`, command));
          }, timeoutMs)
        : (0 as unknown as ReturnType<typeof setTimeout>);

      this.pending.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.transport.send(JSON.stringify(request));
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new BridgeError('transport', `Could not send '${command}': ${String(err)}`, command));
      }
    });
  }

  /** Typed stream of one host event. */
  on<E extends EventName>(name: E): Observable<EventData<E>> {
    return this.events$.pipe(
      filter((e): e is BridgeEvent<E> => e.name === name),
      map((e) => e.data),
    );
  }

  /** Fetch and cache app info (version, data folder…). Safe to call repeatedly. */
  async loadInfo(): Promise<AppInfo> {
    const info = await this.invoke('app.getInfo');
    this.info.set(info);
    return info;
  }

  private handleMessage(message: BridgeMessage): void {
    if (message.kind === 'response') {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (call.timer) clearTimeout(call.timer);
      if (message.ok) {
        call.resolve(message.result);
      } else {
        const error = message.error ?? { code: 'internal' as const, message: 'Unknown host error' };
        call.reject(new BridgeError(error.code, error.message, call.command));
      }
      return;
    }

    if (message.kind === 'event' && typeof message.name === 'string') {
      this.events.next({ name: message.name as EventName, data: message.data as never });
    }
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
