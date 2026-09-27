/**
 * Typed description of the Angular ⇄ C# bridge (docs/DESKTOP-CONTRACT.md §2–§4).
 * Adding a native capability = add a row here + a handler in the host. Nothing else.
 */
import {
  AppInfo,
  CatClickThroughRequest,
  CatCommand,
  CatDragEnded,
  CatLayoutMode,
  CatLayoutResult,
  CatScreenInfo,
  CatSettings,
  CatWalkEnded,
  CatWalkRequest,
  CatWalkResult,
  DataInfo,
  ExportResult,
  FocusCompleted,
  FocusSettings,
  FocusStartRequest,
  FocusState,
  FocusStats,
  HotkeyName,
  Hotkeys,
  ImportResult,
  MonitorInfo,
  Note,
  NoteCreate,
  NoteUpdate,
  NotificationRequest,
  QuickAction,
  Rect,
  SettingChanged,
  TaskCreate,
  TaskItem,
  TaskUpdate,
  ThemePreference,
  WindowState,
} from '../models';

// ---- Envelopes ----------------------------------------------------------------------------

export interface BridgeRequest {
  kind: 'request';
  id: string;
  command: string;
  payload?: unknown;
}

export type BridgeErrorCode =
  | 'validation'
  | 'not_found'
  | 'unsupported'
  | 'denied'
  | 'internal'
  | 'timeout'
  | 'transport';

export interface BridgeErrorInfo {
  code: BridgeErrorCode;
  message: string;
}

export interface BridgeResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorInfo;
}

export interface BridgeEventMessage {
  kind: 'event';
  name: string;
  data: unknown;
}

export type BridgeMessage = BridgeResponse | BridgeEventMessage;

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

// ---- Commands -----------------------------------------------------------------------------

export type Empty = Record<string, never>;

export interface CommandMap {
  // app.*
  'app.getInfo': { payload: void; result: AppInfo };
  'app.openExternal': { payload: { url: string }; result: Empty };
  'app.showNotification': { payload: NotificationRequest; result: Empty };
  'app.openDataFolder': { payload: void; result: Empty };
  'app.exit': { payload: void; result: Empty };

  // window.* (the window that sends the request)
  'window.minimize': { payload: void; result: Empty };
  'window.maximize': { payload: void; result: Empty };
  'window.restore': { payload: void; result: Empty };
  'window.close': { payload: void; result: Empty };
  'window.focus': { payload: void; result: Empty };
  'window.getState': { payload: void; result: WindowState };
  'window.setAlwaysOnTop': { payload: { enabled: boolean }; result: Empty };

  // cat.* (desktop Cat Companion)
  'cat.show': { payload: void; result: { visible: boolean } };
  'cat.hide': { payload: void; result: { visible: boolean } };
  'cat.toggle': { payload: void; result: { visible: boolean } };
  'cat.isVisible': { payload: void; result: { visible: boolean } };
  'cat.getPosition': { payload: void; result: WindowState };
  'cat.moveTo': { payload: { x: number; y: number; monitor?: string }; result: WindowState };
  'cat.moveBy': { payload: { dx: number; dy: number }; result: WindowState };
  'cat.walk': { payload: CatWalkRequest; result: CatWalkResult };
  'cat.stop': { payload: void; result: Empty };
  'cat.getScreenInfo': { payload: void; result: CatScreenInfo };
  'cat.getMonitors': { payload: void; result: MonitorInfo[] };
  'cat.savePosition': { payload: void; result: WindowState };
  'cat.dragStart': { payload: { followUntilClick?: boolean } | void; result: Empty };
  'cat.dragEnd': { payload: void; result: { moved: boolean } };
  'cat.setLayout': { payload: { mode: CatLayoutMode }; result: CatLayoutResult };
  'cat.setHitRegion': { payload: { rects: Rect[] }; result: Empty };
  'cat.setClickThrough': { payload: CatClickThroughRequest; result: Empty };
  'cat.setAlwaysOnTop': { payload: { enabled: boolean }; result: Empty };
  'cat.getSettings': { payload: void; result: CatSettings };
  'cat.saveSettings': { payload: CatSettings; result: CatSettings };
  'cat.sendCommand': { payload: CatCommand; result: Empty };

  // navigation.*
  'navigation.navigate': { payload: { route: string }; result: Empty };

  // settings.*
  'settings.getAll': { payload: void; result: Record<string, unknown> };
  'settings.get': { payload: { key: string }; result: { key: string; value: unknown } };
  'settings.set': { payload: { key: string; value: unknown }; result: { key: string; value: unknown } };
  'settings.remove': { payload: { key: string }; result: Empty };

  // notes.*
  'notes.list': { payload: { search?: string } | void; result: Note[] };
  'notes.get': { payload: { id: string }; result: Note };
  'notes.create': { payload: NoteCreate; result: Note };
  'notes.update': { payload: NoteUpdate; result: Note };
  'notes.delete': { payload: { id: string }; result: Empty };

  // tasks.*
  'tasks.list': { payload: { includeCompleted?: boolean } | void; result: TaskItem[] };
  'tasks.create': { payload: TaskCreate; result: TaskItem };
  'tasks.update': { payload: TaskUpdate; result: TaskItem };
  'tasks.toggle': { payload: { id: string }; result: TaskItem };
  'tasks.delete': { payload: { id: string }; result: Empty };
  'tasks.clearCompleted': { payload: void; result: { deleted: number } };

  // actions.*
  'actions.list': { payload: void; result: QuickAction[] };
  'actions.save': { payload: { actions: QuickAction[] }; result: QuickAction[] };
  'actions.reset': { payload: void; result: QuickAction[] };

  // focus.*
  'focus.getState': { payload: void; result: FocusState };
  'focus.start': { payload: FocusStartRequest | void; result: FocusState };
  'focus.pause': { payload: void; result: FocusState };
  'focus.resume': { payload: void; result: FocusState };
  'focus.stop': { payload: void; result: FocusState };
  'focus.reset': { payload: void; result: FocusState };
  'focus.skip': { payload: void; result: FocusState };
  'focus.getSettings': { payload: void; result: FocusSettings };
  'focus.saveSettings': { payload: FocusSettings; result: FocusSettings };
  'focus.getStats': { payload: void; result: FocusStats };

  // hotkeys.*
  'hotkeys.get': { payload: void; result: Hotkeys };
  'hotkeys.set': { payload: Hotkeys; result: Hotkeys };
  /** Temporarily release (true) / re-register (false) the global shortcuts, e.g. while the Settings recorder listens. */
  'hotkeys.suspend': { payload: { suspended: boolean }; result: Empty };

  // data.*
  'data.getInfo': { payload: void; result: DataInfo };
  'data.export': { payload: void; result: ExportResult };
  'data.import': { payload: void; result: ImportResult };
}

export type CommandName = keyof CommandMap;
export type CommandPayload<C extends CommandName> = CommandMap[C]['payload'];
export type CommandResult<C extends CommandName> = CommandMap[C]['result'];

/** Commands whose payload is optional/void may be invoked without a second argument. */
export type CommandArgs<C extends CommandName> = void extends CommandPayload<C>
  ? [payload?: Exclude<CommandPayload<C>, void>]
  : [payload: CommandPayload<C>];

// ---- Events -------------------------------------------------------------------------------

export interface EventMap {
  'cat.visibilityChanged': { visible: boolean };
  'cat.positionChanged': WindowState;
  'cat.walkEnded': CatWalkEnded;
  'cat.dragStateChanged': { dragging: boolean };
  'cat.dragEnded': CatDragEnded;
  'cat.layoutChanged': CatLayoutResult;
  'cat.interactiveChanged': { interactive: boolean };
  'cat.screenChanged': CatScreenInfo;
  'cat.settingsChanged': CatSettings;
  'cat.command': CatCommand;
  'navigation.navigate': { route: string };
  'settings.changed': SettingChanged;
  'notes.changed': Empty;
  'tasks.changed': Empty;
  'actions.changed': Empty;
  'focus.tick': FocusState;
  'focus.completed': FocusCompleted;
  'hotkey.pressed': { name: HotkeyName };
  'window.stateChanged': WindowState;
  'app.themeChanged': { theme: ThemePreference };
}

export type EventName = keyof EventMap;
export type EventData<E extends EventName> = EventMap[E];

export interface BridgeEvent<E extends EventName = EventName> {
  name: E;
  data: EventData<E>;
}
