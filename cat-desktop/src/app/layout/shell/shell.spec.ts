import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { DesktopBridgeService } from '../../core/desktop/desktop-bridge.service';
import { FocusTimerService } from '../../core/services/focus-timer.service';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { QuickActionsService } from '../../core/services/quick-actions.service';
import { SettingsService } from '../../core/services/settings.service';

/** Renders every main-window page through the real router against the browser host simulator. */
describe('Shell and feature pages', () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter(routes)],
    }).compileComponents();
    await Promise.all([
      TestBed.inject(SettingsService).load(),
      TestBed.inject(CatSettingsService).load(),
      TestBed.inject(CatWindowService).load(),
      TestBed.inject(QuickActionsService).load(),
      TestBed.inject(FocusTimerService).load(),
    ]);
    harness = await RouterTestingHarness.create();
  });

  async function open(url: string): Promise<HTMLElement> {
    await harness.navigateByUrl(url);
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  }

  it('renders the dashboard inside the shell', async () => {
    const el = await open('/dashboard');
    const host = harness.fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.sidebar .brand-name')?.textContent).toContain('CatDesktop');
    expect(host.querySelectorAll('.nav-link').length).toBe(5);
    expect(el.textContent).toContain('Open tasks');
    expect(host.querySelector('.sidebar .cat-toggle .cat-title')?.textContent).toContain('Cat');
    expect(el.querySelector('.cat-card .card-title')?.textContent).toContain('Cat');
  });

  it('adds a task from the tasks page', async () => {
    const el = await open('/tasks');
    const input = el.querySelector<HTMLInputElement>('#task-title')!;
    input.value = 'Write the spec';
    input.dispatchEvent(new Event('input'));
    await harness.fixture.whenStable();
    el.querySelector<HTMLFormElement>('form.add-form')!.requestSubmit();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(el.textContent).toContain('Write the spec');
    expect(el.textContent).toContain('1 open');
  });

  it('creates and selects a note via ?new=1', async () => {
    const el = await open('/notes?new=1');
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(el.querySelector('#note-title')).not.toBeNull();
    expect(el.querySelectorAll('.note-item').length).toBe(1);
    expect(TestBed.inject(DesktopBridgeService).isHosted).toBeFalse();
  });

  it('shows the focus ring and settings form', async () => {
    const el = await open('/focus');
    expect(el.querySelector('.ring-progress')).not.toBeNull();
    expect(el.textContent).toContain('25:00');
    expect(el.textContent).toContain('Timer settings');
  });

  it('renders every settings section with the quick action table', async () => {
    const el = await open('/settings');
    expect(el.querySelectorAll('[data-section]').length).toBe(7);
    expect(el.querySelector('section#cat')?.textContent).toContain('Bring cat to this screen');
    expect(el.querySelector('section#cat')?.textContent).toContain('Cat Companion');
    expect(el.querySelectorAll('#cat-theme [role="radio"]').length).toBeGreaterThanOrEqual(10);
    expect(el.querySelector('#cat-size input[type="range"]')).not.toBeNull();
    expect(el.querySelector('section#cat app-cat-preview app-cat-sprite')).not.toBeNull();
    expect(el.textContent).toContain('Show / hide cat');
    expect(el.querySelectorAll('.actions-table tbody tr').length).toBe(8);
    expect(el.textContent).toContain('Ctrl+Shift+P');
  });

  it('applies the size slider (debounced save) and the theme cards (click and arrow keys)', async () => {
    const el = await open('/settings');
    const bridge = TestBed.inject(DesktopBridgeService);
    const catSettings = TestBed.inject(CatSettingsService);

    const range = el.querySelector<HTMLInputElement>('#cat-size input[type="range"]')!;
    range.value = '125';
    range.dispatchEvent(new Event('input'));
    expect(catSettings.settings().scale).toBe(1.25); // optimistic, before the save
    // Checked straight after the input (before rendering the page, which can take longer than the 150 ms debounce
    // on a loaded machine): the save has not gone out yet.
    expect((await bridge.invoke('cat.getSettings')).scale).toBe(1);
    harness.detectChanges();
    expect(el.querySelector('#cat-size')?.textContent).toContain('Size: 125 %');
    const saved = async (): Promise<boolean> => (await bridge.invoke('cat.getSettings')).scale === 1.25;
    for (let waited = 0; waited < 2_000 && !(await saved()); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await bridge.invoke('cat.getSettings')).scale).toBe(1.25);

    el.querySelector<HTMLButtonElement>('#cat-theme [data-theme="black"]')!.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect((await bridge.invoke('cat.getSettings')).theme).toBe('black');
    expect(el.querySelector('#cat-theme [data-theme="black"]')?.getAttribute('aria-checked')).toBe('true');

    el.querySelector('#cat-theme app-cat-theme-picker')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await harness.fixture.whenStable();
    expect((await bridge.invoke('cat.getSettings')).theme).toBe('white');
  });
});
