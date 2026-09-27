import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { DEFAULT_HOTKEYS, HotkeyName, Hotkeys, SETTING_KEYS } from '../models';

/** `KeyboardEvent.code` → key name of the host gesture grammar (HotkeyManager.TryParseKey / WinForms `Keys`). */
const NAMED_KEY_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: 'OemMinus',
  Equal: 'Oemplus',
  Comma: 'Oemcomma',
  Period: 'OemPeriod',
  Slash: 'OemQuestion',
  Semicolon: 'OemSemicolon',
  Quote: 'OemQuotes',
  BracketLeft: 'OemOpenBrackets',
  BracketRight: 'OemCloseBrackets',
  Backslash: 'OemPipe',
  IntlBackslash: 'OemBackslash',
  Backquote: 'Oemtilde',
  NumpadAdd: 'Add',
  NumpadSubtract: 'Subtract',
  NumpadMultiply: 'Multiply',
  NumpadDivide: 'Divide',
  NumpadDecimal: 'Decimal',
};

/** Global (desktop-level) keyboard shortcuts registered by the host. */
@Injectable({ providedIn: 'root' })
export class HotkeysService {
  private readonly bridge = inject(DesktopBridgeService);

  readonly hotkeys = signal<Hotkeys>(DEFAULT_HOTKEYS);
  readonly error = signal<string | null>(null);
  readonly pressed$: Observable<{ name: HotkeyName }> = this.bridge.on('hotkey.pressed');

  constructor() {
    // Another window (or a backup import) changed the bindings: re-read what the host actually registered.
    this.bridge.on('settings.changed').subscribe(({ key }) => {
      if (key === SETTING_KEYS.hotkeys) this.load().catch((err) => console.warn('[hotkeys] reload failed', err));
    });
  }

  async load(): Promise<void> {
    this.hotkeys.set({ ...DEFAULT_HOTKEYS, ...(await this.bridge.invoke('hotkeys.get')) });
  }

  /** Save all bindings. Returns false (and sets `error`) when the host refused a gesture. */
  async save(hotkeys: Hotkeys): Promise<boolean> {
    try {
      this.hotkeys.set(await this.bridge.invoke('hotkeys.set', hotkeys));
      this.error.set(null);
      return true;
    } catch (err) {
      this.error.set((err as Error).message);
      return false;
    }
  }

  /**
   * Release (true) or re-register (false) the global shortcuts, so a recorder can capture a gesture that is
   * currently bound. Best effort: a host without the command simply keeps its shortcuts.
   */
  async suspend(suspended: boolean): Promise<void> {
    try {
      await this.bridge.invoke('hotkeys.suspend', { suspended });
    } catch (err) {
      console.warn('[hotkeys] suspend failed', err);
    }
  }

  /**
   * Turn a KeyboardEvent into the "Ctrl+Shift+P" gesture format the host accepts (HotkeyManager.TryParse), or null
   * while it is incomplete or uses a key the host cannot register. Like the host, F1–F24 need no modifier; every
   * other key does.
   */
  static gestureFromEvent(event: KeyboardEvent): string | null {
    if (['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'].includes(event.key)) return null;
    const key = keyName(event);
    if (!key) return null;
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Win');
    if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return null;
    parts.push(key);
    return parts.join('+');
  }
}

/**
 * The host key name for an event. A Latin letter is taken from `event.key`, because RegisterHotKey uses virtual keys,
 * which follow the keyboard layout (AZERTY, QWERTZ, Dvorak…). Everything else comes from `event.code`, which Shift,
 * AltGr and non-Latin layouts do not change ("Shift+1" stays "1", not "!").
 */
function keyName(event: KeyboardEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  const code = event.code;
  // With NumLock off the number pad sends End, ArrowDown, Delete… and so does its virtual key, so register that.
  if (/^Numpad(\d|Decimal)$/.test(code) && NAMED_KEY_CODES[event.key]) return NAMED_KEY_CODES[event.key];
  let match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1];
  match = /^Digit(\d)$/.exec(code);
  if (match) return match[1];
  match = /^Numpad(\d)$/.exec(code);
  if (match) return `NumPad${match[1]}`;
  match = /^F(\d{1,2})$/.exec(code);
  if (match) {
    const n = Number(match[1]);
    return n >= 1 && n <= 24 ? `F${n}` : null;
  }
  return NAMED_KEY_CODES[code] ?? null;
}
