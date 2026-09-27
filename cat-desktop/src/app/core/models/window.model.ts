export type WindowKind = 'main' | 'cat';

/** Physical-pixel window geometry reported by the host (contract §3 window.getState). */
export interface WindowState {
  windowId: string;
  monitor: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isMinimized: boolean;
  isVisible: boolean;
  alwaysOnTop: boolean;
}
