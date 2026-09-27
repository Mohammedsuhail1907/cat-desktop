/**
 * Test host for the real CatSprite component (built with the app's Angular CLI by ../component-test.mjs).
 * Exposes window.catTest so the runner can drive the inputs and read the `finished` events over CDP.
 */
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { CatSprite } from '../../../../cat-desktop/src/app/cat-companion/components/cat-sprite/cat-sprite';
import { CatAnimation } from '../../../../cat-desktop/src/app/cat-companion/components/cat-sprite/cat-art';

@Component({
  selector: 'cat-test-host',
  imports: [CatSprite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="box" [style.width.px]="width()" [style.height.px]="height()">
      <app-cat-sprite
        [animation]="animation()"
        [facing]="facing()"
        [rate]="rate()"
        [paused]="paused()"
        [gaze]="gaze()"
        [theme]="theme()"
        [attentive]="attentive()"
        (finished)="onFinished($event)"
      />
    </div>
  `,
  styles: `.box { position: relative; }`,
})
class CatTestHost {
  readonly animation = signal<CatAnimation>('idle');
  readonly facing = signal<'left' | 'right'>('right');
  readonly rate = signal(1);
  readonly paused = signal(false);
  readonly gaze = signal<{ x: number; y: number } | null>(null);
  readonly theme = signal('classic');
  readonly attentive = signal(false);
  readonly width = signal(160);
  readonly height = signal(120);
  readonly events: { clip: CatAnimation; t: number }[] = [];

  onFinished(clip: CatAnimation): void {
    this.events.push({ clip, t: performance.now() });
  }
}

bootstrapApplication(CatTestHost, { providers: [provideZonelessChangeDetection()] }).then((ref) => {
  const host = ref.components[0].instance as CatTestHost;
  (window as unknown as Record<string, unknown>)['catTest'] = { host, events: host.events };
});
