import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CatSettingsService } from '../core/services/cat-settings.service';
import { CatWindowService } from '../core/services/cat-window.service';
import { NavigationService } from '../core/services/navigation.service';
import { QuickActionsService } from '../core/services/quick-actions.service';
import { CatCompanionWindow } from './cat-companion-window';
import { pickWeighted } from './services/cat-behavior.config';

/** The cat UI against the browser host simulator (same cat.* semantics as the desktop host). */
describe('CatCompanionWindow', () => {
  let fixture: ComponentFixture<CatCompanionWindow> | null = null;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    }).compileComponents();
    await Promise.all([TestBed.inject(CatSettingsService).load(), TestBed.inject(CatWindowService).load(), TestBed.inject(QuickActionsService).load()]);
  });

  afterEach(() => {
    fixture?.destroy();
    fixture = null;
  });

  /** Like the host window: the viewport the cat UI lives in has the size of the current layout. */
  function frameToLayout(): void {
    const container = fixture?.nativeElement.parentElement as HTMLElement | undefined;
    const layout = TestBed.inject(CatWindowService).layout();
    if (!container) return;
    container.style.cssText = `position: fixed; left: 0; top: 0; width: ${layout?.width ?? 160}px; height: ${layout?.height ?? 120}px;`;
  }

  async function until(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      frameToLayout();
      await fixture?.whenStable();
      fixture?.detectChanges();
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return check();
  }

  function el(): HTMLElement {
    return fixture!.nativeElement as HTMLElement;
  }

  it('keeps a cat.command that arrived before the cat UI and opens that panel', async () => {
    await TestBed.inject(CatWindowService).sendCommand('tasks');
    await new Promise((resolve) => setTimeout(resolve, 30)); // the event is delivered before any listener exists
    fixture = TestBed.createComponent(CatCompanionWindow);
    expect(await until(() => !!el().querySelector('app-cat-companion-panel app-tasks-panel'))).toBeTrue();
    expect(el().querySelectorAll('app-cat-companion-panel nav.strip button.chip').length).toBe(8);
    expect(TestBed.inject(CatWindowService).layout()?.mode).toBe('panel');
    expect(document.body.classList.contains('cat-window')).toBeTrue();
  });

  it('opens the context menu on right click, and Escape closes it', async () => {
    fixture = TestBed.createComponent(CatCompanionWindow);
    expect(await until(() => !!el().querySelector('.cat-box app-cat-sprite'))).toBeTrue();
    await until(() => TestBed.inject(CatWindowService).layout()?.mode === 'cat');
    el().querySelector('.cat-box')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    expect(await until(() => !!el().querySelector('app-cat-context-menu'))).toBeTrue();
    const labels = Array.from(el().querySelectorAll('app-cat-context-menu button.item')).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Pause Walking', 'Move Cat', 'Change Theme', 'Change Size', 'Always on Top', 'Cat Settings', 'Hide Cat']);
    expect(el().querySelector('app-cat-context-menu .title')?.textContent?.trim()).toBe('Cat Companion');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await until(() => !el().querySelector('app-cat-context-menu'))).toBeTrue();
    expect(TestBed.inject(CatWindowService).layout()?.mode).toBe('cat');
  });

  it('sends the hit region (cat + menu card) and hands click-through back when the menu closes', async () => {
    const catWindow = TestBed.inject(CatWindowService);
    const hitRegion = spyOn(catWindow, 'setHitRegion').and.callThrough();
    const clickThrough = spyOn(catWindow, 'setClickThrough').and.callThrough();
    fixture = TestBed.createComponent(CatCompanionWindow);
    await until(() => catWindow.layout()?.mode === 'cat');
    expect(await until(() => hitRegion.calls.count() > 0, 1_000)).toBeTrue();
    const catRects = hitRegion.calls.mostRecent().args[0];
    expect(catRects.length).toBe(1);
    expect(catRects[0].x).toBeGreaterThanOrEqual(0);
    expect(catRects[0].x + catRects[0].width).toBeLessThanOrEqual(160);
    expect(catRects[0].y + catRects[0].height).toBeLessThanOrEqual(120);

    await catWindow.sendCommand('open-menu');
    expect(await until(() => hitRegion.calls.mostRecent().args[0].length === 2, 1_500)).toBeTrue();
    const [cat, card] = hitRegion.calls.mostRecent().args[0];
    const box = catWindow.layout()!.box;
    expect(cat.x).toBeGreaterThanOrEqual(box.x);
    expect(cat.y).toBeGreaterThanOrEqual(box.y);
    expect(card.width).toBe(240 - 16); // full menu width minus the 8 px shadow padding
    expect(card.y + card.height).toBeLessThanOrEqual(box.y);
    expect(clickThrough.calls.mostRecent().args[0]).toEqual({ enabled: false });

    await TestBed.inject(CatSettingsService).save({ clickThroughWhenIdle: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await until(() => catWindow.layout()?.mode === 'cat')).toBeTrue();
    expect(await until(() => clickThrough.calls.mostRecent().args[0].hoverToInteract === true)).toBeTrue();
    expect(clickThrough.calls.mostRecent().args[0]).toEqual({ enabled: true, hoverToInteract: true });
  });

  it('Change Theme / Change Size / Cat Settings open the main window on their settings targets', async () => {
    const navigate = spyOn(TestBed.inject(NavigationService), 'navigate').and.resolveTo({});
    const catWindow = TestBed.inject(CatWindowService);
    fixture = TestBed.createComponent(CatCompanionWindow);
    await until(() => catWindow.layout()?.mode === 'cat');
    for (const [command, route] of [
      ['theme', '/settings#cat-theme'],
      ['size', '/settings#cat-size'],
      ['settings', '/settings#cat'],
    ]) {
      await catWindow.sendCommand('open-menu');
      expect(await until(() => !!el().querySelector('app-cat-context-menu'))).toBeTrue();
      el().querySelector<HTMLButtonElement>(`button[data-command="${command}"]`)!.click();
      expect(await until(() => navigate.calls.count() > 0 && navigate.calls.mostRecent().args[0] === route)).toBeTrue();
      expect(await until(() => !el().querySelector('app-cat-context-menu') && catWindow.layout()?.mode === 'cat')).toBeTrue();
    }
  });

  it('draws the cat in the theme from the settings and follows changes live', async () => {
    fixture = TestBed.createComponent(CatCompanionWindow);
    expect(await until(() => !!el().querySelector('.cat-box app-cat-sprite'))).toBeTrue();
    const sprite = fixture.debugElement.query((d) => d.name === 'app-cat-sprite');
    expect(sprite.componentInstance.theme()).toBe('classic');
    await TestBed.inject(CatSettingsService).save({ theme: 'black' });
    expect(await until(() => sprite.componentInstance.theme() === 'black')).toBeTrue();
  });

  it('toggles walking from the menu (settings.autoWalk)', async () => {
    fixture = TestBed.createComponent(CatCompanionWindow);
    await until(() => TestBed.inject(CatWindowService).layout()?.mode === 'cat');
    await TestBed.inject(CatWindowService).sendCommand('open-menu');
    expect(await until(() => !!el().querySelector('app-cat-context-menu'))).toBeTrue();
    el().querySelector<HTMLButtonElement>('button[data-command="toggle-walking"]')!.click();
    expect(await until(() => TestBed.inject(CatSettingsService).settings().autoWalk === false)).toBeTrue();
    expect(await until(() => !el().querySelector('app-cat-context-menu'))).toBeTrue();
  });
});

describe('pickWeighted', () => {
  it('never picks a zero weight', () => {
    for (let i = 0; i < 200; i++) expect(pickWeighted({ a: 0, b: 1, c: 0 })).toBe('b');
    expect(pickWeighted({ a: 0 })).toBeNull();
  });
});
