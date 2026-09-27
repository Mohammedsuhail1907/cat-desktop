export type ThemePreference = 'system' | 'light' | 'dark';

/** Well-known keys in the generic settings store (contract §3 settings.*). */
export const SETTING_KEYS = {
  theme: 'app.theme',
  closeToTray: 'app.closeToTray',
  startWithWindows: 'app.startWithWindows',
  hotkeys: 'hotkeys',
  focus: 'focus.settings',
  cat: 'cat.settings',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS] | (string & {});

export interface AppSettings {
  theme: ThemePreference;
  closeToTray: boolean;
  startWithWindows: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  closeToTray: false,
  startWithWindows: false,
};

export interface Hotkeys {
  toggleCat: string | null;
  startFocus: string | null;
  quickNote: string | null;
}

export const DEFAULT_HOTKEYS: Hotkeys = {
  toggleCat: 'Ctrl+Shift+P',
  startFocus: 'Ctrl+Shift+F',
  quickNote: 'Ctrl+Shift+N',
};

export type HotkeyName = keyof Hotkeys;

export interface SettingChanged {
  key: string;
  value: unknown;
}
