import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject } from '@angular/core';
import { browserCatStage } from '../../../core/desktop/browser-cat-stage';
import { CAT_OVERLAY, CatCompanionWindow } from '../../cat-companion-window';

/**
 * Plain-browser stand-in for the host's cat window (`ng serve`): a fixed box over the main UI that hosts the
 * cat UI. Its position, size and visibility belong to the BrowserHostSimulator (browserCatStage), exactly like the
 * real window belongs to the C# host; nothing here moves it.
 */
@Component({
  selector: 'app-cat-overlay',
  imports: [CatCompanionWindow],
  providers: [{ provide: CAT_OVERLAY, useValue: true }],
  template: '<app-cat-companion-window />',
  styles: `
    :host {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 9000;
      display: block;
      width: 160px;
      height: 120px;
      pointer-events: none;
      will-change: transform;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatOverlay {
  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    browserCatStage.attach(element);
    inject(DestroyRef).onDestroy(() => browserCatStage.detach(element));
  }
}
