import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { catBoxSize } from '../../../core/models';
import { CAT_ANIMATIONS, CatAnimation } from '../../../cat-companion/components/cat-sprite/cat-art';
import { CatSprite } from '../../../cat-companion/components/cat-sprite/cat-sprite';
import { catTheme } from '../../../cat-companion/components/cat-sprite/cat-themes';

interface PreviewClip {
  id: CatAnimation;
  label: string;
}

const CLIPS: readonly PreviewClip[] = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Walk' },
  { id: 'run', label: 'Run' },
  { id: 'sit', label: 'Sit' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'yawn', label: 'Yawn' },
  { id: 'happy', label: 'Happy' },
  { id: 'stretch', label: 'Stretch' },
  { id: 'jump', label: 'Jump' },
  { id: 'look', label: 'Look' },
  { id: 'interact', label: 'Play' },
];

/** Pause between two plays of a one-shot clip in the preview. */
const REPLAY_GAP_MS = 900;
/** Box width (px) of a 100 % cat on the stage: 200 % still fits, 10 % is still visible. */
const STAGE_UNIT = 120;

/**
 * Live preview of the desktop cat for the Settings page: the same CatSprite the cat window uses, with the chosen
 * theme, size (proportional inside a fixed stage) and opacity, and chips that play each clip in place.
 */
@Component({
  selector: 'app-cat-preview',
  imports: [CatSprite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stage" (pointerenter)="hover.set(true)" (pointerleave)="hover.set(false)">
      <div class="floor" aria-hidden="true"></div>
      <div
        class="box"
        role="img"
        [attr.aria-label]="label()"
        [style.width.px]="boxWidth()"
        [style.height.px]="boxHeight()"
        [style.opacity]="opacity()"
      >
        <app-cat-sprite
          [theme]="theme()"
          [attentive]="hover()"
          [animation]="clip()"
          [rate]="1"
          (finished)="onFinished($event)"
        />
      </div>
      <span class="meta">{{ themeName() }} · {{ actual().width }} × {{ actual().height }} px</span>
    </div>
    <div class="clips" role="group" aria-label="Preview animation">
      @for (c of clips; track c.id) {
        <button type="button" class="clip" [attr.aria-pressed]="selected() === c.id" (click)="select(c.id)">{{ c.label }}</button>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .stage {
      position: relative;
      height: 236px;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      background:
        radial-gradient(120% 90% at 50% 0%, var(--accent-soft), transparent 70%),
        linear-gradient(180deg, var(--surface-2), var(--surface));
      overflow: hidden;
    }
    .floor {
      position: absolute;
      left: 16px;
      right: 16px;
      bottom: 34px;
      border-top: 1px dashed var(--border-strong);
    }
    .box {
      position: absolute;
      left: 50%;
      bottom: 34px;
      transform: translateX(-50%);
      transition:
        width var(--duration-base) var(--ease-out),
        height var(--duration-base) var(--ease-out),
        opacity var(--duration-base) var(--ease-out);
    }
    app-cat-sprite {
      display: block;
      width: 100%;
      height: 100%;
    }
    .meta {
      position: absolute;
      left: 14px;
      bottom: 9px;
      font-size: 0.78rem;
      color: var(--text-faint);
      font-variant-numeric: tabular-nums;
    }
    .clips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .clip {
      min-height: 28px;
      padding: 0 11px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--surface);
      color: var(--text-muted);
      font-size: 0.82rem;
      font-weight: 500;
      transition:
        background var(--duration-fast) var(--ease-out),
        color var(--duration-fast) var(--ease-out);
    }
    .clip:hover {
      background: var(--surface-2);
      color: var(--text);
    }
    .clip[aria-pressed='true'] {
      border-color: transparent;
      background: var(--accent-soft);
      color: var(--accent-2);
    }
  `,
})
export class CatPreview {
  /** CatSettings.scale (0.1–2). */
  readonly scale = input(1);
  readonly theme = input('classic');
  readonly opacity = input(1);

  protected readonly clips = CLIPS;
  protected readonly selected = signal<CatAnimation>('idle');
  /** What the sprite plays: the selected clip, or idle between two plays of a one-shot clip. */
  protected readonly clip = signal<CatAnimation>('idle');
  protected readonly hover = signal(false);

  protected readonly boxWidth = computed(() => Math.max(8, Math.round(STAGE_UNIT * this.scale())));
  protected readonly boxHeight = computed(() => Math.max(6, Math.round(STAGE_UNIT * 0.75 * this.scale())));
  protected readonly actual = computed(() => catBoxSize(this.scale()));
  protected readonly themeName = computed(() => catTheme(this.theme()).name);
  protected readonly label = computed(
    () => `Preview: ${this.themeName()} cat at ${Math.round(this.scale() * 100)} %, ${CLIPS.find((c) => c.id === this.selected())?.label ?? ''}`,
  );

  private replayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearReplay());
  }

  protected select(id: CatAnimation): void {
    this.clearReplay();
    this.selected.set(id);
    this.clip.set(id);
  }

  /** One-shot clips repeat while their chip is selected: back to idle for a moment, then again. */
  protected onFinished(clip: CatAnimation): void {
    if (clip !== this.selected() || CAT_ANIMATIONS[clip].loop) return;
    this.clip.set('idle');
    this.clearReplay();
    this.replayTimer = setTimeout(() => {
      this.replayTimer = null;
      if (this.selected() === clip) this.clip.set(clip);
    }, REPLAY_GAP_MS);
  }

  private clearReplay(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
  }
}
