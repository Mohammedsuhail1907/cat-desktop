/**
 * Browser-only stand-in for the host's cat window frame (`ng serve` in a plain browser).
 *
 * The BrowserHostSimulator owns the geometry, exactly like the C# CatWindowService owns the real window; the
 * CatOverlay component only registers its element here. Movement is written straight to the element's style
 * (no Angular change detection per frame), so the cat UI behaves the same as in the desktop host.
 */
export interface BrowserCatGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

class BrowserCatStage {
  private element: HTMLElement | null = null;
  private geometry: BrowserCatGeometry | null = null;

  attach(element: HTMLElement): void {
    this.element = element;
    this.paint();
  }

  detach(element: HTMLElement): void {
    if (this.element === element) this.element = null;
  }

  /** The element the cat UI lives in, when one is attached. */
  get host(): HTMLElement | null {
    return this.element;
  }

  update(geometry: BrowserCatGeometry): void {
    this.geometry = geometry;
    this.paint();
  }

  private paint(): void {
    const el = this.element;
    const g = this.geometry;
    if (!el || !g) return;
    el.style.transform = `translate3d(${Math.round(g.x)}px, ${Math.round(g.y)}px, 0)`;
    el.style.width = `${g.width}px`;
    el.style.height = `${g.height}px`;
    el.style.display = g.visible ? '' : 'none';
  }
}

export const browserCatStage = new BrowserCatStage();
