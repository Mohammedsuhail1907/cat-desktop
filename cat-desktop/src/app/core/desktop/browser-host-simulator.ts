import { BridgeMessage, BridgeRequest } from './bridge-protocol';
import { BrowserCatSimulation, SimulatorError as SimError } from './browser-cat-simulation';
import { HostTransport } from './host-transport';
import {
  CatSettings,
  DEFAULT_CAT_SETTINGS,
  DEFAULT_FOCUS_SETTINGS,
  DEFAULT_HOTKEYS,
  FocusPhase,
  FocusSettings,
  FocusState,
  Hotkeys,
  Note,
  QuickAction,
  QuickActionType,
  SETTING_KEYS,
  TaskItem,
  WindowState,
  normaliseCatSettings,
} from '../models';

/**
 * Stand-in for the C# host when the app runs in a plain browser (`ng serve`).
 * Implements the same command surface on top of localStorage so every feature can be developed
 * and demoed without the desktop host. Window and cat commands are simulated in-page (the cat window is
 * the CatOverlay element, see BrowserCatSimulation).
 *
 * Keep it honest: identical semantics, identical events, identical error codes.
 */
export class BrowserHostSimulator implements HostTransport {
  readonly name = 'browser-simulator';

  private handler: ((message: BridgeMessage) => void) | null = null;
  private readonly storageKey = 'catdesktop.simulator.v1';
  private state = this.load();
  private focusInterval: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly cat = new BrowserCatSimulation({
    store: this.state,
    event: (name, data) => this.event(name, data),
    persist: () => this.persist(),
  });

  send(json: string): void {
    let request: BridgeRequest;
    try {
      request = JSON.parse(json) as BridgeRequest;
    } catch {
      return;
    }
    // Simulate the asynchronous hop through the host.
    queueMicrotask(() => {
      try {
        const result = this.execute(request.command, request.payload);
        this.emit({ kind: 'response', id: request.id, ok: true, result: result ?? {} });
      } catch (err) {
        const [code, message] = err instanceof SimError ? [err.code, err.message] : ['internal', String(err)];
        this.emit({ kind: 'response', id: request.id, ok: false, error: { code: code as never, message } });
      }
    });
  }

  onMessage(handler: (message: BridgeMessage) => void): void {
    this.handler = handler;
  }

  // ---- command execution ------------------------------------------------------------------

  private execute(command: string, payload: unknown): unknown {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'app.getInfo':
        return {
          version: 'dev (browser)',
          windowKind: 'main',
          devMode: true,
          dataDirectory: 'localStorage',
          databasePath: 'localStorage:' + this.storageKey,
          platform: 'browser',
          startedAt: this.startedAt,
        };
      case 'app.openExternal':
        window.open(String(p['url']), '_blank', 'noopener');
        return {};
      case 'app.showNotification':
        this.notify(String(p['title'] ?? ''), String(p['body'] ?? ''));
        return {};
      case 'app.openDataFolder':
      case 'app.exit':
      case 'window.minimize':
      case 'window.maximize':
      case 'window.restore':
      case 'window.close':
      case 'window.focus':
      case 'window.setAlwaysOnTop':
        return {};
      case 'window.getState':
        return this.windowState();

      case 'navigation.navigate':
        this.event('navigation.navigate', { route: String(p['route'] ?? '/') });
        return {};

      case 'settings.getAll':
        return { ...this.state.settings };
      case 'settings.get':
        return { key: String(p['key']), value: this.state.settings[String(p['key'])] ?? null };
      case 'settings.set': {
        const key = requireString(p, 'key');
        this.state.settings[key] = p['value'];
        this.persist();
        this.event('settings.changed', { key, value: p['value'] });
        if (key === SETTING_KEYS.cat) this.cat.applyStoredSettings(p['value']);
        if (key === SETTING_KEYS.theme) this.event('app.themeChanged', { theme: p['value'] });
        return { key, value: p['value'] };
      }
      case 'settings.remove': {
        delete this.state.settings[requireString(p, 'key')];
        this.persist();
        return {};
      }

      case 'notes.list': {
        const search = typeof p['search'] === 'string' ? p['search'].toLowerCase() : '';
        return this.state.notes
          .filter((n) => !search || n.title.toLowerCase().includes(search) || n.content.toLowerCase().includes(search))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
      }
      case 'notes.get':
        return this.findNote(requireString(p, 'id'));
      case 'notes.create': {
        const now = nowIso();
        const note: Note = {
          id: uuid(),
          title: String(p['title'] ?? ''),
          content: String(p['content'] ?? ''),
          color: (p['color'] as string | null) ?? null,
          pinned: p['pinned'] === true,
          createdAt: now,
          updatedAt: now,
        };
        this.state.notes.push(note);
        this.persist();
        this.event('notes.changed', {});
        return note;
      }
      case 'notes.update': {
        const note = this.findNote(requireString(p, 'id'));
        const updated: Note = {
          ...note,
          title: 'title' in p ? String(p['title'] ?? '') : note.title,
          content: 'content' in p ? String(p['content'] ?? '') : note.content,
          color: 'color' in p ? ((p['color'] as string | null) ?? null) : note.color,
          pinned: 'pinned' in p ? p['pinned'] === true : note.pinned,
          updatedAt: nowIso(),
        };
        this.state.notes = this.state.notes.map((n) => (n.id === updated.id ? updated : n));
        this.persist();
        this.event('notes.changed', {});
        return updated;
      }
      case 'notes.delete': {
        const id = requireString(p, 'id');
        this.state.notes = this.state.notes.filter((n) => n.id !== id);
        this.persist();
        this.event('notes.changed', {});
        return {};
      }

      case 'tasks.list': {
        const includeCompleted = p['includeCompleted'] === true;
        const open = this.state.tasks.filter((t) => !t.completed).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
        const done = includeCompleted
          ? this.state.tasks.filter((t) => t.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
          : [];
        return [...open, ...done];
      }
      case 'tasks.create': {
        const now = nowIso();
        const task: TaskItem = {
          id: uuid(),
          title: requireString(p, 'title'),
          notes: (p['notes'] as string | null) ?? null,
          completed: false,
          priority: (Number(p['priority'] ?? 0) as 0 | 1 | 2) ?? 0,
          dueAt: (p['dueAt'] as string | null) ?? null,
          completedAt: null,
          sortOrder: this.state.tasks.length,
          createdAt: now,
          updatedAt: now,
        };
        this.state.tasks.push(task);
        this.persist();
        this.event('tasks.changed', {});
        return task;
      }
      case 'tasks.update': {
        const task = this.findTask(requireString(p, 'id'));
        const completed = 'completed' in p ? p['completed'] === true : task.completed;
        const updated: TaskItem = {
          ...task,
          title: 'title' in p ? requireString(p, 'title') : task.title,
          notes: 'notes' in p ? ((p['notes'] as string | null) ?? null) : task.notes,
          priority: 'priority' in p ? (Number(p['priority']) as 0 | 1 | 2) : task.priority,
          dueAt: 'dueAt' in p ? ((p['dueAt'] as string | null) ?? null) : task.dueAt,
          sortOrder: 'sortOrder' in p ? Number(p['sortOrder']) : task.sortOrder,
          completed,
          completedAt: completed ? (task.completedAt ?? nowIso()) : null,
          updatedAt: nowIso(),
        };
        this.state.tasks = this.state.tasks.map((t) => (t.id === updated.id ? updated : t));
        this.persist();
        this.event('tasks.changed', {});
        return updated;
      }
      case 'tasks.toggle': {
        const task = this.findTask(requireString(p, 'id'));
        return this.execute('tasks.update', { id: task.id, completed: !task.completed });
      }
      case 'tasks.delete': {
        const id = requireString(p, 'id');
        this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
        this.persist();
        this.event('tasks.changed', {});
        return {};
      }
      case 'tasks.clearCompleted': {
        const before = this.state.tasks.length;
        this.state.tasks = this.state.tasks.filter((t) => !t.completed);
        this.persist();
        this.event('tasks.changed', {});
        return { deleted: before - this.state.tasks.length };
      }

      case 'actions.list':
        return [...this.state.actions].sort((a, b) => a.order - b.order);
      case 'actions.save': {
        const actions = p['actions'];
        if (!Array.isArray(actions) || !actions.every(isQuickAction)) {
          throw new SimError('validation', `'actions' must be an array of quick actions (types: ${QUICK_ACTION_TYPES.join(', ')}).`);
        }
        this.state.actions = actions.map((a, i) => ({ ...a, order: i }));
        this.persist();
        this.event('actions.changed', {});
        return this.state.actions;
      }
      case 'actions.reset':
        this.state.actions = defaultActions();
        this.persist();
        this.event('actions.changed', {});
        return this.state.actions;

      case 'focus.getState':
        return this.focusSnapshot();
      case 'focus.start': {
        const phase = p['phase'] ?? undefined;
        if (phase !== undefined && !FOCUS_PHASES.includes(phase as FocusPhase)) {
          throw new SimError('validation', "'phase' must be 'focus', 'shortBreak' or 'longBreak'.");
        }
        const minutes = p['minutes'] ?? undefined;
        if (minutes !== undefined && (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 180)) {
          throw new SimError('validation', "'minutes' must be between 1 and 180.");
        }
        return this.focusStart(phase as FocusPhase | undefined, minutes as number | undefined);
      }
      case 'focus.pause':
        if (this.state.focus.status === 'running') {
          this.state.focus = { ...this.state.focus, status: 'paused', endsAt: null };
          this.stopFocusTicker();
          this.focusTick();
        }
        return this.focusSnapshot();
      case 'focus.resume':
        if (this.state.focus.status === 'paused') {
          this.state.focus = { ...this.state.focus, status: 'running', endsAt: new Date(Date.now() + this.state.focus.remainingSeconds * 1000).toISOString() };
          this.startFocusTicker();
          this.focusTick();
        }
        return this.focusSnapshot();
      case 'focus.stop':
      case 'focus.reset': {
        this.stopFocusTicker();
        const total = this.state.focusSettings.focusMinutes * 60;
        this.state.focus = {
          phase: 'focus',
          status: 'idle',
          remainingSeconds: total,
          totalSeconds: total,
          completedFocusSessions: command === 'focus.reset' ? 0 : this.state.focus.completedFocusSessions,
          startedAt: null,
          endsAt: null,
        };
        this.persist();
        this.focusTick();
        return this.focusSnapshot();
      }
      case 'focus.skip':
        this.completePhase(false);
        return this.focusSnapshot();
      case 'focus.getSettings':
        return this.state.focusSettings;
      case 'focus.saveSettings': {
        // Clamp exactly like the host (FocusSettings.Normalised) and broadcast the stored value.
        const s = { ...DEFAULT_FOCUS_SETTINGS, ...(payload as FocusSettings) };
        this.state.focusSettings = {
          ...s,
          focusMinutes: clampInt(s.focusMinutes, 1, 180, DEFAULT_FOCUS_SETTINGS.focusMinutes),
          shortBreakMinutes: clampInt(s.shortBreakMinutes, 1, 60, DEFAULT_FOCUS_SETTINGS.shortBreakMinutes),
          longBreakMinutes: clampInt(s.longBreakMinutes, 1, 120, DEFAULT_FOCUS_SETTINGS.longBreakMinutes),
          sessionsBeforeLongBreak: clampInt(s.sessionsBeforeLongBreak, 1, 12, DEFAULT_FOCUS_SETTINGS.sessionsBeforeLongBreak),
        };
        this.state.settings[SETTING_KEYS.focus] = this.state.focusSettings;
        this.persist();
        this.event('settings.changed', { key: SETTING_KEYS.focus, value: this.state.focusSettings });
        if (this.state.focus.status === 'idle' || this.state.focus.status === 'completed') {
          const total = this.phaseMinutes(this.state.focus.phase) * 60;
          this.state.focus = { ...this.state.focus, remainingSeconds: total, totalSeconds: total };
          this.focusTick();
        }
        return this.state.focusSettings;
      }
      case 'focus.getStats': {
        const today = new Date().toDateString();
        const sessions = this.state.focusSessions.filter((s) => s.completed);
        const todaySessions = sessions.filter((s) => new Date(s.startedAt).toDateString() === today);
        return {
          todayFocusSessions: todaySessions.length,
          todayFocusMinutes: Math.round(todaySessions.reduce((m, s) => m + s.plannedSeconds / 60, 0)),
          totalFocusSessions: sessions.length,
          totalFocusMinutes: Math.round(sessions.reduce((m, s) => m + s.plannedSeconds / 60, 0)),
        };
      }

      case 'hotkeys.get':
        return this.state.hotkeys;
      case 'hotkeys.set':
        this.state.hotkeys = { ...DEFAULT_HOTKEYS, ...(payload as Hotkeys) };
        this.state.settings[SETTING_KEYS.hotkeys] = this.state.hotkeys;
        this.persist();
        this.event('settings.changed', { key: SETTING_KEYS.hotkeys, value: this.state.hotkeys });
        return this.state.hotkeys;
      case 'hotkeys.suspend':
        // No global shortcuts exist in a browser; only the payload is checked.
        if (typeof p['suspended'] !== 'boolean') throw new SimError('validation', "'suspended' must be a boolean.");
        return {};

      case 'data.getInfo':
        return {
          databasePath: 'localStorage:' + this.storageKey,
          sizeBytes: (localStorage.getItem(this.storageKey) ?? '').length,
          noteCount: this.state.notes.length,
          taskCount: this.state.tasks.length,
          schemaVersion: 1,
        };
      case 'data.export': {
        const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `catdesktop-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { cancelled: false, path: a.download };
      }
      case 'data.import':
        return { cancelled: true, notes: 0, tasks: 0 };

      default:
        if (command.startsWith('cat.')) return this.cat.execute(command, payload);
        throw new SimError('unsupported', `Unknown command '${command}'.`);
    }
  }

  // ---- focus timer simulation -------------------------------------------------------------

  /** Like the host: without a phase, start the one that is up next (the current phase of the state). */
  private focusStart(phase: FocusPhase | undefined, minutes: number | undefined): FocusState {
    const targetPhase = phase ?? this.state.focus.phase;
    const total = Math.round((minutes ?? this.phaseMinutes(targetPhase)) * 60);
    const now = new Date();
    this.state.focus = {
      phase: targetPhase,
      status: 'running',
      remainingSeconds: total,
      totalSeconds: total,
      completedFocusSessions: this.state.focus.completedFocusSessions,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + total * 1000).toISOString(),
    };
    this.startFocusTicker();
    this.focusTick();
    return this.focusSnapshot();
  }

  private startFocusTicker(): void {
    this.stopFocusTicker();
    this.focusInterval = setInterval(() => {
      if (this.state.focus.status !== 'running') return;
      const remaining = Math.max(0, Math.round((new Date(this.state.focus.endsAt ?? 0).getTime() - Date.now()) / 1000));
      this.state.focus = { ...this.state.focus, remainingSeconds: remaining };
      if (remaining <= 0) this.completePhase(true);
      else this.focusTick();
    }, 1000);
  }

  private stopFocusTicker(): void {
    if (this.focusInterval) clearInterval(this.focusInterval);
    this.focusInterval = null;
  }

  private completePhase(completed: boolean): void {
    this.stopFocusTicker();
    const f = this.state.focus;
    const s = this.state.focusSettings;
    let sessions = f.completedFocusSessions;
    if (f.phase === 'focus' && completed) {
      sessions += 1;
      this.state.focusSessions.push({ id: uuid(), phase: 'focus', startedAt: f.startedAt ?? nowIso(), endedAt: nowIso(), plannedSeconds: f.totalSeconds, completed: true });
    }
    // Only a completed focus phase can earn the long break (a skipped one never does).
    const next: FocusPhase = f.phase === 'focus' ? (completed && sessions % s.sessionsBeforeLongBreak === 0 ? 'longBreak' : 'shortBreak') : 'focus';
    const nextTotal = this.phaseMinutes(next) * 60;
    this.state.focus = {
      phase: next,
      status: 'completed',
      remainingSeconds: nextTotal,
      totalSeconds: nextTotal,
      completedFocusSessions: sessions,
      startedAt: null,
      endsAt: null,
    };
    this.persist();
    if (completed) {
      this.event('focus.completed', { phase: f.phase, next });
      if (s.notify) this.notify(f.phase === 'focus' ? 'Focus session complete' : 'Break over', f.phase === 'focus' ? 'Time for a break.' : 'Back to focus.');
    }
    this.focusTick();
    const autoStart = (f.phase === 'focus' && s.autoStartBreaks) || (f.phase !== 'focus' && s.autoStartFocus);
    if (completed && autoStart) this.focusStart(next, undefined);
  }

  private phaseMinutes(phase: FocusPhase): number {
    const s = this.state.focusSettings;
    return phase === 'focus' ? s.focusMinutes : phase === 'shortBreak' ? s.shortBreakMinutes : s.longBreakMinutes;
  }

  private focusSnapshot(): FocusState {
    return { ...this.state.focus };
  }

  private focusTick(): void {
    this.event('focus.tick', this.focusSnapshot());
  }

  // ---- helpers ----------------------------------------------------------------------------

  /** The main window (the browser tab): the whole viewport. */
  private windowState(): WindowState {
    return {
      windowId: 'main',
      monitor: 'BROWSER',
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      isMaximized: false,
      isMinimized: false,
      isVisible: true,
      alwaysOnTop: false,
    };
  }


  private findNote(id: string): Note {
    const note = this.state.notes.find((n) => n.id === id);
    if (!note) throw new SimError('not_found', `Note ${id} not found.`);
    return note;
  }

  private findTask(id: string): TaskItem {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new SimError('not_found', `Task ${id} not found.`);
    return task;
  }

  private notify(title: string, body: string): void {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    } else {
      console.info(`[notification] ${title}: ${body}`);
    }
  }

  private event(name: string, data: unknown): void {
    this.emit({ kind: 'event', name, data });
  }

  private emit(message: BridgeMessage): void {
    this.handler?.(message);
  }

  private load(): SimulatorState {
    const total = DEFAULT_FOCUS_SETTINGS.focusMinutes * 60;
    const focus: FocusState = { phase: 'focus', status: 'idle', remainingSeconds: total, totalSeconds: total, completedFocusSessions: 0, startedAt: null, endsAt: null };
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SimulatorState> & { petBookSettings?: Partial<CatSettings> & { size?: unknown } };
        const focusSettings = { ...DEFAULT_FOCUS_SETTINGS, ...(parsed.focusSettings ?? {}) };
        const settings = { ...(parsed.settings ?? {}) };
        const catSettings = parsed.catSettings ? normaliseCatSettings(parsed.catSettings) : legacyCatSettings(parsed.petBookSettings);
        settings[SETTING_KEYS.cat] = catSettings;
        delete settings['petbook.settings'];
        // Like migration 002: the Pet Book action types no longer exist.
        const actions = (parsed.actions ?? []).filter(isQuickAction);
        const focusTotal = focusSettings.focusMinutes * 60;
        return {
          settings,
          notes: parsed.notes ?? [],
          tasks: parsed.tasks ?? [],
          actions: actions.length ? actions : defaultActions(),
          focusSettings,
          focus: { ...focus, remainingSeconds: focusTotal, totalSeconds: focusTotal },
          focusSessions: parsed.focusSessions ?? [],
          hotkeys: normaliseHotkeys(parsed.hotkeys),
          catSettings,
          catPosition: isPoint(parsed.catPosition) ? parsed.catPosition : null,
        };
      }
    } catch {
      /* fall through to defaults */
    }
    const catSettings = { ...DEFAULT_CAT_SETTINGS };
    return {
      settings: { [SETTING_KEYS.cat]: catSettings },
      notes: [],
      tasks: [],
      actions: defaultActions(),
      focusSettings: { ...DEFAULT_FOCUS_SETTINGS },
      focus,
      focusSessions: [],
      hotkeys: { ...DEFAULT_HOTKEYS },
      catSettings,
      catPosition: null,
    };
  }


  private persist(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      /* quota or private mode – ignore */
    }
  }
}

interface SimulatorState {
  settings: Record<string, unknown>;
  notes: Note[];
  tasks: TaskItem[];
  actions: QuickAction[];
  focusSettings: FocusSettings;
  focus: FocusState;
  focusSessions: { id: string; phase: FocusPhase; startedAt: string; endedAt: string | null; plannedSeconds: number; completed: boolean }[];
  hotkeys: Hotkeys;
  catSettings: CatSettings;
  /** Top-left of the cat box in viewport px (the window_states row `cat` of the host). */
  catPosition: { x: number; y: number } | null;
}

const QUICK_ACTION_TYPES: readonly QuickActionType[] = ['navigate', 'quick-note', 'tasks', 'focus', 'reminders', 'pin', 'search', 'settings', 'custom'];

function isQuickAction(value: unknown): value is QuickAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<QuickAction>;
  return typeof a.id === 'string' && typeof a.name === 'string' && QUICK_ACTION_TYPES.includes(a.actionType as QuickActionType);
}

/**
 * Like the host's one-time conversion of `petbook.settings` (contract §5): enabled, alwaysOnTop, startWithApp and
 * opacity carry over and the Pet Book `size` becomes `scale` (normaliseCatSettings reads the legacy size).
 */
function legacyCatSettings(legacy: (Partial<CatSettings> & { size?: unknown }) | undefined): CatSettings {
  if (!legacy || typeof legacy !== 'object') return { ...DEFAULT_CAT_SETTINGS };
  const { enabled, alwaysOnTop, startWithApp, opacity, size } = legacy;
  return normaliseCatSettings({ enabled, alwaysOnTop, startWithApp, opacity, size } as Partial<CatSettings>);
}

/** A stored value that still uses the legacy name togglePetBook is read as toggleCat. */
function normaliseHotkeys(stored: (Partial<Hotkeys> & { togglePetBook?: string | null }) | undefined): Hotkeys {
  const { togglePetBook, ...rest } = stored ?? {};
  const hotkeys = { ...DEFAULT_HOTKEYS, ...rest };
  if (stored && !('toggleCat' in stored) && togglePetBook !== undefined) hotkeys.toggleCat = togglePetBook;
  return hotkeys;
}

function isPoint(value: unknown): value is { x: number; y: number } {
  const p = value as { x?: unknown; y?: unknown } | null;
  return !!p && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y);
}

const FOCUS_PHASES: readonly FocusPhase[] = ['focus', 'shortBreak', 'longBreak'];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v.trim()) throw new SimError('validation', `'${key}' is required.`);
  return v;
}

function nowIso(): string {
  return new Date().toISOString();
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}


/** Mirrors the rows seeded by Database/Migrations/001_initial.sql (renamed to quick_actions by 002). */
export function defaultActions(): QuickAction[] {
  return [
    { id: 'home', name: 'Home', icon: 'home', enabled: true, order: 0, route: '/dashboard', actionType: 'navigate' },
    { id: 'quick-note', name: 'Quick Note', icon: 'note', enabled: true, order: 1, actionType: 'quick-note' },
    { id: 'tasks', name: 'Tasks', icon: 'tasks', enabled: true, order: 2, actionType: 'tasks' },
    { id: 'focus', name: 'Focus Timer', icon: 'timer', enabled: true, order: 3, actionType: 'focus' },
    { id: 'reminders', name: 'Reminders', icon: 'bell', enabled: true, order: 4, actionType: 'reminders' },
    { id: 'pin', name: 'Pin', icon: 'pin', enabled: true, order: 5, actionType: 'pin' },
    { id: 'search', name: 'Search', icon: 'search', enabled: true, order: 6, route: '/notes', actionType: 'search' },
    { id: 'settings', name: 'Settings', icon: 'settings', enabled: true, order: 7, route: '/settings', actionType: 'navigate' },
  ];
}
