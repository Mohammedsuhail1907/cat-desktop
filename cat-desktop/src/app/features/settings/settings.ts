import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { DesktopBridgeService } from '../../core/desktop/desktop-bridge.service';
import { HotkeyName, Hotkeys, QuickAction, QuickActionType, ThemePreference } from '../../core/models';
import { DataService } from '../../core/services/data.service';
import { HotkeysService } from '../../core/services/hotkeys.service';
import { QuickActionsService } from '../../core/services/quick-actions.service';
import { SettingsService } from '../../core/services/settings.service';
import { ConfirmDialog } from '../../shared/components/confirm-dialog/confirm-dialog';
import { ICON_NAMES, Icon } from '../../shared/components/icon/icon';
import { Toggle } from '../../shared/components/toggle/toggle';
import { CatCompanionCard } from './cat-companion/cat-companion-card';

interface Section {
  id: string;
  label: string;
  icon: string;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

interface HotkeyRow {
  name: HotkeyName;
  label: string;
  description: string;
}

const SECTIONS: readonly Section[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'behaviour', label: 'Behaviour', icon: 'window' },
  { id: 'cat', label: 'Cat Companion', icon: 'cat' },
  { id: 'actions', label: 'Quick actions', icon: 'sparkles' },
  { id: 'hotkeys', label: 'Keyboard shortcuts', icon: 'keyboard' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'about', label: 'About', icon: 'info' },
];

const ACTION_TYPES: readonly Choice<QuickActionType>[] = [
  { value: 'navigate', label: 'Navigate to route' },
  { value: 'quick-note', label: 'Quick note' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'focus', label: 'Focus timer' },
  { value: 'reminders', label: 'Reminders' },
  { value: 'pin', label: 'Always on top' },
  { value: 'search', label: 'Search notes' },
  { value: 'settings', label: 'Settings' },
  { value: 'custom', label: 'Custom' },
];

const ROUTE_TYPES: ReadonlySet<QuickActionType> = new Set(['navigate', 'custom']);
const TOAST_MS = 4500;

/** Mirrors the host's quick-action rules so a save is never refused for a reason the form did not show. */
const MAX_ACTIONS = 24;
const MAX_NAME_LENGTH = 60;
const MAX_ROUTE_LENGTH = 200;
const ACTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** Targets inside a section that /settings#<id> can scroll to (besides the sections themselves). */
const SUB_TARGETS: Readonly<Record<string, string>> = { 'cat-size': 'cat', 'cat-theme': 'cat' };
const TARGET_FLASH_MS = 1600;

@Component({
  selector: 'app-settings',
  imports: [Icon, Toggle, ConfirmDialog, CatCompanionCard],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  host: { '(document:keydown)': 'onDocumentKeydown($event)', '(window:blur)': 'stopRecording()' },
})
export class Settings {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirm = viewChild.required(ConfirmDialog);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private actionsTouched = false;
  /** True once the user changed a shortcut; host-side changes (another window, an import) then no longer overwrite it. */
  private hotkeysTouched = false;
  private rendered = false;
  /** Section picked in the nav (or by a link); the scroll-spy keeps it highlighted until the user scrolls or clicks. */
  private pickedSection: string | null = null;

  protected readonly bridge = inject(DesktopBridgeService);
  protected readonly settings = inject(SettingsService);
  protected readonly quickActions = inject(QuickActionsService);
  protected readonly hotkeys = inject(HotkeysService);
  protected readonly data = inject(DataService);

  protected readonly sections = SECTIONS;
  protected readonly actionTypes = ACTION_TYPES;
  protected readonly maxActions = MAX_ACTIONS;
  protected readonly iconNames = ICON_NAMES;
  protected readonly themes: readonly Choice<ThemePreference>[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  protected readonly hotkeyRows: readonly HotkeyRow[] = [
    { name: 'toggleCat', label: 'Show / hide cat', description: 'Show or hide the desktop cat.' },
    { name: 'startFocus', label: 'Start focus', description: 'Start or pause the focus timer.' },
    { name: 'quickNote', label: 'Quick note', description: 'Open the notes page with a fresh note.' },
  ];

  protected readonly activeSection = signal(SECTIONS[0].id);
  protected readonly toast = signal<{ text: string; error: boolean } | null>(null);
  protected readonly busy = signal(false);
  protected readonly actionsDraft = signal<QuickAction[]>([]);
  protected readonly hotkeysDraft = signal<Hotkeys>(this.hotkeys.hotkeys());
  protected readonly recording = signal<HotkeyName | null>(null);
  protected readonly dataError = signal<string | null>(null);

  protected readonly actionsDirty = computed(() => JSON.stringify(this.actionsDraft()) !== JSON.stringify(this.quickActions.actions()));
  protected readonly actionErrors = computed(() => {
    const errors: string[] = [];
    const draft = this.actionsDraft();
    if (draft.length === 0) errors.push('Keep at least one quick action.');
    if (draft.length > MAX_ACTIONS) errors.push(`At most ${MAX_ACTIONS} quick actions are allowed.`);
    const seen = new Set<string>();
    draft.forEach((a, i) => {
      const row = `Row ${i + 1}`;
      const id = a.id.trim();
      if (!id) errors.push(`${row}: an id is required.`);
      else if (!ACTION_ID_PATTERN.test(id)) errors.push(`${row}: the id may only use letters, digits, "-" and "_" (up to 64).`);
      else if (seen.has(id)) errors.push(`${row}: the id "${id}" is used more than once.`);
      seen.add(id);
      const name = a.name.trim();
      if (!name) errors.push(`${row}: a name is required.`);
      else if (name.length > MAX_NAME_LENGTH) errors.push(`${row}: the name must be at most ${MAX_NAME_LENGTH} characters.`);
      if (ROUTE_TYPES.has(a.actionType)) {
        const route = (a.route ?? '').trim();
        if (!route) errors.push(`${row}: a route is required for ${a.actionType} actions.`);
        else if (!this.isValidRoute(route)) errors.push(`${row}: the route must start with "/" and be at most ${MAX_ROUTE_LENGTH} characters.`);
      }
    });
    return errors;
  });
  protected readonly actionsValid = computed(() => this.actionErrors().length === 0);

  protected readonly hotkeysDirty = computed(() => {
    const a = this.hotkeysDraft();
    const b = this.hotkeys.hotkeys();
    return a.toggleCat !== b.toggleCat || a.startFocus !== b.startFocus || a.quickNote !== b.quickNote;
  });

  constructor() {
    // Mirror server-side actions/hotkeys into the drafts until the user starts editing them.
    effect(() => {
      const actions = this.quickActions.actions();
      untracked(() => {
        if (!this.actionsTouched) this.actionsDraft.set(actions.map((a) => ({ ...a })));
      });
    });
    effect(() => {
      const hotkeys = this.hotkeys.hotkeys();
      untracked(() => {
        if (!this.hotkeysTouched) this.hotkeysDraft.set({ ...hotkeys });
      });
    });

    void this.refreshData();

    // /settings#cat, #cat-size, #cat-theme (e.g. from the cat's menu) also scroll when the page is already open,
    // even to the fragment it is already on (NavigationService navigates with onSameUrlNavigation 'reload').
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((e) => {
        const fragment = this.router.parseUrl(e.urlAfterRedirects).fragment;
        if (this.rendered && fragment) this.scrollToTarget(fragment);
      });

    afterNextRender(() => {
      this.rendered = true;
      this.observeSections();
      const fragment = this.route.snapshot.fragment;
      if (fragment) this.scrollToTarget(fragment);
    });

    this.destroyRef.onDestroy(() => {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.stopRecording(); // never leave the global shortcuts suspended
    });
  }

  // ---- navigation ---------------------------------------------------------------------------

  protected scrollTo(id: string, smooth = true): void {
    this.activeSection.set(id);
    this.pickedSection = id;
    this.host.nativeElement
      .querySelector<HTMLElement>(`[data-section="${id}"]`)
      ?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  /** A section id, or an element inside a section (cat-size, cat-theme): scroll to it and flash it briefly. */
  private scrollToTarget(id: string): void {
    if (SECTIONS.some((s) => s.id === id)) {
      this.scrollTo(id, false);
      return;
    }
    const section = SUB_TARGETS[id];
    const el = section ? this.host.nativeElement.querySelector<HTMLElement>(`#${id}`) : null;
    if (!section || !el) return;
    this.activeSection.set(section);
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.remove('flash-target');
    void el.offsetWidth; // restart the highlight animation
    el.classList.add('flash-target');
    setTimeout(() => el.classList.remove('flash-target'), TARGET_FLASH_MS);
    el.querySelector<HTMLElement>('input, [role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
  }

  private observeSections(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    // The last sections can never scroll up into the spy's band, so while a picked section scrolls into view the
    // sections it passes would take the highlight. The user's own input hands it back to the spy.
    const release = () => (this.pickedSection = null);
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    inputs.forEach((type) => document.addEventListener(type, release, { capture: true, passive: true }));
    this.destroyRef.onDestroy(() => inputs.forEach((type) => document.removeEventListener(type, release, { capture: true })));

    const observer = new IntersectionObserver(
      (entries) => {
        if (this.pickedSection) return;
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute('data-section');
        if (id) this.activeSection.set(id);
      },
      { rootMargin: '-15% 0px -65% 0px', threshold: 0 },
    );
    this.host.nativeElement.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => observer.observe(el));
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  // ---- appearance & behaviour ---------------------------------------------------------------

  protected setTheme(theme: ThemePreference): void {
    void this.run(() => this.settings.setTheme(theme));
  }

  protected setCloseToTray(enabled: boolean): void {
    void this.run(() => this.settings.setCloseToTray(enabled));
  }

  protected setStartWithWindows(enabled: boolean): void {
    void this.run(() => this.settings.setStartWithWindows(enabled));
  }

  // ---- quick actions ------------------------------------------------------------------------

  protected isRouteType(type: QuickActionType): boolean {
    return ROUTE_TYPES.has(type);
  }

  protected isValidId(id: string): boolean {
    return ACTION_ID_PATTERN.test(id.trim());
  }

  protected isValidName(name: string): boolean {
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;
  }

  protected isValidRoute(route: string | undefined): boolean {
    const trimmed = (route ?? '').trim();
    return trimmed.startsWith('/') && trimmed.length <= MAX_ROUTE_LENGTH;
  }

  protected patchAction(index: number, patch: Partial<QuickAction>): void {
    this.actionsTouched = true;
    this.actionsDraft.update((list) => list.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  protected setActionType(index: number, value: string): void {
    const option = ACTION_TYPES.find((o) => o.value === value);
    if (!option) return;
    const patch: Partial<QuickAction> = { actionType: option.value };
    if (!ROUTE_TYPES.has(option.value)) patch.route = undefined;
    this.patchAction(index, patch);
  }

  protected moveAction(index: number, delta: -1 | 1): void {
    const target = index + delta;
    const list = this.actionsDraft();
    if (target < 0 || target >= list.length) return;
    this.actionsTouched = true;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    this.actionsDraft.set(next.map((a, i) => ({ ...a, order: i })));
  }

  protected removeAction(index: number): void {
    this.actionsTouched = true;
    this.actionsDraft.update((list) => list.filter((_, i) => i !== index).map((a, i) => ({ ...a, order: i })));
  }

  protected addAction(): void {
    this.actionsTouched = true;
    this.actionsDraft.update((list) => [
      ...list,
      {
        id: uniqueId('custom', new Set(list.map((a) => a.id))),
        name: 'New action',
        icon: 'sparkles',
        enabled: true,
        order: list.length,
        route: '/dashboard',
        actionType: 'custom',
      },
    ]);
  }

  protected revertActions(): void {
    this.actionsTouched = false;
    this.actionsDraft.set(this.quickActions.actions().map((a) => ({ ...a })));
  }

  protected async resetActions(): Promise<void> {
    const ok = await this.confirm().open('All quick actions will be replaced with the default set.', {
      title: 'Reset quick actions?',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.quickActions.reset();
      this.actionsTouched = false;
      this.actionsDraft.set(this.quickActions.actions().map((a) => ({ ...a })));
      this.showToast('Quick actions reset to defaults.');
    });
  }

  protected async saveActions(): Promise<void> {
    if (!this.actionsValid() || !this.actionsDirty()) return;
    const cleaned = this.actionsDraft().map((a) => ({
      ...a,
      id: a.id.trim(),
      name: a.name.trim(),
      route: ROUTE_TYPES.has(a.actionType) ? (a.route ?? '').trim() : undefined,
    }));
    await this.run(async () => {
      await this.quickActions.save(cleaned);
      this.actionsTouched = false;
      this.actionsDraft.set(this.quickActions.actions().map((a) => ({ ...a })));
      this.showToast('Quick actions saved.');
    });
  }

  // ---- hotkeys ------------------------------------------------------------------------------

  protected startRecording(name: HotkeyName): void {
    this.setRecording(this.recording() === name ? null : name);
  }

  /** Ends recording (Esc, Cancel, a captured gesture, save/revert, leaving the window or the page). */
  protected stopRecording(): void {
    this.setRecording(null);
  }

  /**
   * While the recorder listens the host releases its global shortcuts; otherwise a gesture that is currently
   * bound would fire its action instead of reaching the page, and bindings could never be swapped.
   */
  private setRecording(name: HotkeyName | null): void {
    const wasRecording = this.recording() !== null;
    this.recording.set(name);
    if (wasRecording !== (name !== null)) void this.hotkeys.suspend(name !== null);
  }

  protected clearHotkey(name: HotkeyName): void {
    this.stopRecording();
    this.hotkeysTouched = true;
    this.hotkeysDraft.update((h) => ({ ...h, [name]: null }));
  }

  protected revertHotkeys(): void {
    this.stopRecording();
    this.hotkeysTouched = false;
    this.hotkeysDraft.set({ ...this.hotkeys.hotkeys() });
    this.hotkeys.error.set(null);
  }

  protected async saveHotkeys(): Promise<void> {
    if (!this.hotkeysDirty()) return;
    this.stopRecording();
    this.busy.set(true);
    try {
      const ok = await this.hotkeys.save(this.hotkeysDraft());
      if (ok) {
        this.hotkeysTouched = false;
        this.hotkeysDraft.set({ ...this.hotkeys.hotkeys() });
        this.showToast('Shortcuts saved.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    const name = this.recording();
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.stopRecording();
      return;
    }
    const gesture = HotkeysService.gestureFromEvent(event);
    if (!gesture) return;
    this.hotkeysTouched = true;
    this.hotkeysDraft.update((h) => ({ ...h, [name]: gesture }));
    this.stopRecording();
  }

  // ---- data ---------------------------------------------------------------------------------

  protected async refreshData(): Promise<void> {
    try {
      await this.data.refresh();
      this.dataError.set(null);
    } catch (err) {
      this.dataError.set((err as Error).message ?? String(err));
    }
  }

  protected async exportData(): Promise<void> {
    await this.run(async () => {
      const result = await this.data.exportBackup();
      this.showToast(result.cancelled ? 'Export cancelled.' : `Backup saved to ${result.path ?? 'the chosen file'}.`);
    });
  }

  protected async importData(): Promise<void> {
    await this.run(async () => {
      const result = await this.data.importBackup();
      this.showToast(
        result.cancelled ? 'Import cancelled.' : `Imported ${result.notes} ${plural(result.notes, 'note')} and ${result.tasks} ${plural(result.tasks, 'task')}.`,
      );
    });
  }

  protected openDataFolder(): void {
    void this.run(() => this.data.openDataFolder());
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  protected formatDate(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // ---- helpers ------------------------------------------------------------------------------

  protected dismissToast(): void {
    this.toast.set(null);
  }

  protected showToast(text: string, error = false): void {
    this.toast.set({ text, error });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), TOAST_MS);
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
    } catch (err) {
      this.showToast((err as Error).message ?? String(err), true);
    } finally {
      this.busy.set(false);
    }
  }
}

function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
