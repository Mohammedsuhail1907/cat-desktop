import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CatCommand, CatSettings, QuickAction } from '../core/models';
import { CatSettingsService } from '../core/services/cat-settings.service';
import { CatWindowService } from '../core/services/cat-window.service';
import { NavigationService } from '../core/services/navigation.service';
import { QuickActionsService } from '../core/services/quick-actions.service';
import { CatCompanionPanel, tabForAction } from './components/cat-companion-panel/cat-companion-panel';
import { CatContextMenu, CatMenuCommand } from './components/cat-context-menu/cat-context-menu';
import { CatSprite } from './components/cat-sprite/cat-sprite';
import { CatAnimationService } from './services/cat-animation.service';
import { CatBehaviorService } from './services/cat-behavior.service';
import { CatInteractionService, CompanionTab } from './services/cat-interaction.service';
import { CatSoundService } from './services/cat-sound.service';

/** Provided by CatOverlay: the cat UI runs inside the main page (plain browser) instead of its own window. */
export const CAT_OVERLAY = new InjectionToken<boolean>('CAT_OVERLAY');

const PANEL_TABS: ReadonlySet<string> = new Set<CompanionTab>(['home', 'quick-note', 'tasks', 'focus', 'reminders']);

/**
 * Root of the cat UI: the host's transparent cat window (#/cat), or CatOverlay in a plain browser.
 * Lays out the cat box in the anchor corner and the context menu / companion panel on the other side
 * (CatLayoutResult), wires the behaviour services and executes menu items, quick actions and cat.command.
 *
 * No per-frame work: the host moves the window, CSS inside CatSprite animates the cat, and the services only
 * change signals when the behaviour changes.
 */
@Component({
  selector: 'app-cat-companion-window',
  imports: [CatSprite, CatContextMenu, CatCompanionPanel],
  providers: [CatAnimationService, CatSoundService, CatBehaviorService, CatInteractionService],
  templateUrl: './cat-companion-window.html',
  styleUrl: './cat-companion-window.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
    '[style.--cat-opacity]': 'settings().opacity',
    '[style.--cat-box-width]': 'boxWidth()',
    '[style.--cat-box-height]': 'boxHeight()',
    '(document:contextmenu)': 'onDocumentContextMenu($event)',
  },
})
export class CatCompanionWindow {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly catWindow = inject(CatWindowService);
  private readonly catSettings = inject(CatSettingsService);
  private readonly navigation = inject(NavigationService);
  protected readonly quickActions = inject(QuickActionsService);
  protected readonly animation = inject(CatAnimationService);
  protected readonly behavior = inject(CatBehaviorService);
  protected readonly interaction = inject(CatInteractionService);

  /** False inside the browser overlay: the page around it must keep its background and its context menu. */
  private readonly standalone = !inject(CAT_OVERLAY, { optional: true });
  private readonly catBox = viewChild.required<ElementRef<HTMLElement>>('catBox');
  private readonly surfaceCard = viewChild('surfaceCard', { read: ElementRef });

  protected readonly settings = this.catSettings.settings;
  protected readonly mode = this.interaction.mode;
  /**
   * In the plain cat layout the window IS the cat box, so the box simply fills it (a scale change the host applies
   * shows at once, before cat.settingsChanged arrives). With the menu/panel open the host's layout gives the box.
   */
  private readonly layoutBox = computed(() => {
    const layout = this.catWindow.layout();
    return layout && layout.mode !== 'cat' ? layout.box : null;
  });
  protected readonly boxWidth = computed(() => {
    const box = this.layoutBox();
    return box ? `${box.width}px` : '100%';
  });
  protected readonly boxHeight = computed(() => {
    const box = this.layoutBox();
    return box ? `${box.height}px` : '100%';
  });
  protected readonly anchor = computed(() => this.catWindow.layout()?.anchor ?? 'bottom-right');
  protected readonly hostClass = computed(
    () => `mode-${this.mode()} anchor-${this.anchor()}` + (this.settings().interaction ? '' : ' is-inert') + (this.standalone ? ' is-standalone' : ''),
  );
  protected readonly menuStatus = computed(() => (this.settings().autoWalk ? 'Wandering around' : 'Walking paused'));
  protected readonly catLabel = computed(
    () => `Cat, ${this.behavior.stateLabel().toLowerCase()}. Enter opens the companion panel, Shift+F10 the menu.`,
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (this.standalone) {
      this.document.body.classList.add('cat-window');
      destroyRef.onDestroy(() => this.document.body.classList.remove('cat-window'));
    }

    // Replays commands that arrived while #/cat was loading (e.g. the quick-note hotkey that opened the window).
    this.catWindow.commands$.pipe(takeUntilDestroyed()).subscribe((command) => this.handleCommand(command));
    // Start in the plain cat layout (the host may still hold a menu layout from before a reload), unless a
    // replayed command already asked for a menu or panel.
    if (this.interaction.requestedMode() === 'cat') void this.interaction.requestLayout('cat');

    effect(() => {
      const card = this.surfaceCard()?.nativeElement as HTMLElement | undefined;
      untracked(() => this.animation.surface.set(card ?? null));
    });

    afterNextRender(() => {
      const catBox = this.catBox().nativeElement;
      this.animation.attach(this.host.nativeElement, catBox);
      this.interaction.attach(catBox);
      this.behavior.start();
    });
  }

  // ---- commands ---------------------------------------------------------------------------

  private handleCommand(command: CatCommand): void {
    switch (command.action) {
      case 'open-menu':
        void this.interaction.openMenu();
        break;
      case 'open-panel': {
        const tab = (command.payload as { tab?: unknown } | undefined)?.tab;
        void this.interaction.openPanel(typeof tab === 'string' && PANEL_TABS.has(tab) ? (tab as CompanionTab) : 'home');
        break;
      }
      case 'quick-note':
      case 'tasks':
      case 'focus':
      case 'reminders':
        void this.interaction.openPanel(command.action as CompanionTab);
        break;
      case 'pause-walking':
        void this.save({ autoWalk: false });
        break;
      case 'start-walking':
        void this.save({ autoWalk: true });
        break;
      case 'toggle-walking':
        void this.save({ autoWalk: !this.settings().autoWalk });
        break;
      case 'meow':
        void this.behavior.meowCommand();
        break;
      default:
        console.warn(`[cat] unknown command '${command.action}' ignored`);
    }
  }

  protected onMenuCommand(command: CatMenuCommand): void {
    switch (command) {
      case 'toggle-walking':
        void this.save({ autoWalk: !this.settings().autoWalk });
        void this.interaction.close();
        break;
      case 'move':
        void this.interaction.moveCat();
        break;
      case 'always-on-top':
        void this.save({ alwaysOnTop: !this.settings().alwaysOnTop });
        void this.interaction.close();
        break;
      case 'theme':
        void this.interaction.close();
        void this.openInMain('/settings#cat-theme');
        break;
      case 'size':
        void this.interaction.close();
        void this.openInMain('/settings#cat-size');
        break;
      case 'settings':
        void this.interaction.close();
        void this.openInMain('/settings#cat');
        break;
      case 'hide':
        void this.hideCat();
        break;
    }
  }

  protected runQuickAction(action: QuickAction): void {
    const tab = tabForAction(action);
    if (tab) {
      this.interaction.panelTab.set(tab);
      return;
    }
    switch (action.actionType) {
      case 'navigate':
        void this.openInMain(action.route ?? routeFromPayload(action) ?? '/dashboard');
        break;
      case 'pin':
        void this.save({ alwaysOnTop: !this.settings().alwaysOnTop });
        break;
      case 'search':
        void this.openInMain('/notes');
        break;
      case 'settings':
        void this.openInMain('/settings');
        break;
      case 'custom': {
        const route = routeFromPayload(action) ?? action.route;
        if (route) void this.openInMain(route);
        break;
      }
    }
  }

  protected async hideCat(): Promise<void> {
    await this.interaction.close();
    try {
      await this.catWindow.hide();
    } catch (err) {
      console.warn('[cat] hide failed', err);
    }
  }

  /** Right-clicks outside the cat never show the browser's menu in the cat window. */
  protected onDocumentContextMenu(event: MouseEvent): void {
    if (this.standalone) event.preventDefault();
  }

  /** Bring the main window to a route; the panel folds away so it does not cover what it just opened. */
  private async openInMain(route: string): Promise<void> {
    try {
      await this.navigation.navigate(route);
    } catch (err) {
      console.warn('[cat] navigate failed', err);
      return;
    }
    if (this.interaction.requestedMode() !== 'cat') void this.interaction.close();
  }

  private async save(patch: Partial<CatSettings>): Promise<void> {
    try {
      await this.catSettings.save(patch);
    } catch (err) {
      console.warn('[cat] saving settings failed', err);
    }
  }
}

function routeFromPayload(action: QuickAction): string | null {
  const route = action.payload?.['route'];
  return typeof route === 'string' && route.startsWith('/') ? route : null;
}
