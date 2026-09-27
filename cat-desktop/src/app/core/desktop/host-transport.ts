import { BridgeMessage } from './bridge-protocol';

/**
 * Abstraction over "how bytes reach the host". Exactly two implementations exist:
 *  - WebView2Transport      → window.chrome.webview (real desktop host)
 *  - BrowserHostSimulator   → in-page simulation for `ng serve` in a normal browser
 */
export interface HostTransport {
  readonly name: string;
  send(json: string): void;
  onMessage(handler: (message: BridgeMessage) => void): void;
}

interface WebView2Api {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebView2Api };
  }
}

export function getWebView2(): WebView2Api | undefined {
  return typeof window !== 'undefined' ? window.chrome?.webview : undefined;
}

/** The only place in the whole Angular app that touches window.chrome.webview. */
export class WebView2Transport implements HostTransport {
  readonly name = 'webview2';
  private readonly api: WebView2Api;

  constructor(api: WebView2Api) {
    this.api = api;
  }

  send(json: string): void {
    this.api.postMessage(json);
  }

  onMessage(handler: (message: BridgeMessage) => void): void {
    this.api.addEventListener('message', (event) => {
      const data = event.data;
      if (data && typeof data === 'object' && 'kind' in data) {
        handler(data as BridgeMessage);
      }
    });
  }
}
