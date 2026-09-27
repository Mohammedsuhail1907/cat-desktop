/**
 * Central catalogue of cat themes (colour variants). The ONLY place themes are defined: the cat window, the settings
 * page and the live preview all read this list, and CatSprite turns a theme into the CSS custom properties that its
 * paint layers use (catThemeVars below). Adding a theme = adding one entry here (and, optionally, a folder
 * assets/cat/themes/<id>/ with a sprite-sheet skin; see assets/cat/README.md).
 *
 * The vector cat derives its shading from these colours with color-mix() (lit fur, shaded fur, far legs, iris
 * gradient), so a theme only names the real coat colours.
 */
export interface CatTheme {
  /** Stable id, stored in CatSettings.theme; also the folder name under assets/cat/themes/. */
  id: string;
  name: string;
  /** Main fur. */
  primaryColor: string;
  /** Chest, belly, muzzle and paws. */
  secondaryColor?: string;
  /** Tabby stripes; omit for a solid coat. */
  stripeColor?: string;
  eyeColor?: string;
  /** Nose, inner ears, paw pads, blush. */
  accentColor?: string;
  /** Line colour of the drawing. */
  outlineColor?: string;
  /** Folder with an optional theme-specific sprite skin (relative to the app root). */
  assetPath?: string;
  /** Optional preview image; without it the settings page renders the live vector cat. */
  preview?: string;
  /** Colour-point coats (Siamese-like): ears, face mask, paws and tail tip. */
  pointColor?: string;
  /** Colour of the lit side of the fur (a sheen); defaults to the main fur lightened. */
  highlightColor?: string;
}

export const DEFAULT_CAT_THEME_ID = 'classic';

const themeAssets = (id: string) => `assets/cat/themes/${id}/`;

export const CAT_THEMES: readonly CatTheme[] = [
  {
    // brown/orange mackerel tabby: tawny coat, dark brown stripes, white chest, green eyes
    id: 'classic', name: 'Classic', primaryColor: '#c98d55', secondaryColor: '#f7ead8', stripeColor: '#6b4125',
    eyeColor: '#8cc152', accentColor: '#f09aa8', outlineColor: '#4f3220', highlightColor: '#e0ae76',
  },
  {
    // black cat: blue-black coat with a cool sheen, golden eyes, dusky nose
    id: 'black', name: 'Black', primaryColor: '#2c2b34', secondaryColor: '#3a3945', eyeColor: '#f5c33b',
    accentColor: '#c2798e', outlineColor: '#0f0e14', highlightColor: '#5a5e74',
  },
  {
    // white cat: soft grey shading, blue eyes, pink nose and ears
    id: 'white', name: 'White', primaryColor: '#f9f7f4', secondaryColor: '#ffffff', eyeColor: '#5aaae8',
    accentColor: '#f7a6b7', outlineColor: '#9d968f', highlightColor: '#ffffff',
  },
  {
    // ginger: bright orange with deeper orange stripes and a cream belly
    id: 'orange', name: 'Orange', primaryColor: '#f0923b', secondaryColor: '#ffe6c7', stripeColor: '#c9621a',
    eyeColor: '#a3cf3e', accentColor: '#ff9db0', outlineColor: '#7e3f12', highlightColor: '#fbb56a',
  },
  {
    // grey (silver) tabby: charcoal stripes, pale belly, amber eyes
    id: 'gray', name: 'Gray', primaryColor: '#9ba3ac', secondaryColor: '#eef0f2', stripeColor: '#555c66',
    eyeColor: '#e9b53b', accentColor: '#eea3b1', outlineColor: '#3b4048', highlightColor: '#c3c9cf',
  },
  {
    // brown tabby: chocolate coat, near-black stripes, fawn belly, amber eyes
    id: 'brown', name: 'Brown', primaryColor: '#8e6040', secondaryColor: '#e9d3b8', stripeColor: '#43291a',
    eyeColor: '#d7a82c', accentColor: '#d98f98', outlineColor: '#33200f', highlightColor: '#b07f58',
  },
  {
    // cream colour-point: ivory coat, warm brown points (ears, mask, paws, tail tip), blue eyes
    id: 'cream', name: 'Cream', primaryColor: '#f3e4c9', secondaryColor: '#fffaf1', eyeColor: '#6db4e6',
    accentColor: '#f2a7b3', outlineColor: '#8d6d4d', pointColor: '#a97f59', highlightColor: '#fff7ea',
  },
  {
    // pastel fantasy: candy pink with a rose outline and violet eyes
    id: 'pink', name: 'Pink', primaryColor: '#f7b9cf', secondaryColor: '#fff0f6', eyeColor: '#8a6ae0',
    accentColor: '#ff7ea6', outlineColor: '#b0587a', highlightColor: '#ffd6e5',
  },
  {
    // pastel fantasy: sky blue with a navy outline and golden eyes
    id: 'blue', name: 'Blue', primaryColor: '#9cc3ef', secondaryColor: '#eef6ff', eyeColor: '#f6c343',
    accentColor: '#ff9fbb', outlineColor: '#44699a', highlightColor: '#c6ddf8',
  },
  {
    // pastel fantasy: lavender with mint eyes
    id: 'purple', name: 'Purple', primaryColor: '#c0a6ea', secondaryColor: '#f6f0ff', eyeColor: '#63d6b4',
    accentColor: '#ff97cc', outlineColor: '#634a9c', highlightColor: '#dccbf6',
  },
].map((t) => ({ ...t, assetPath: themeAssets(t.id) }));

/** The theme for an id; unknown ids fall back to the default theme (contract §5). */
export function catTheme(id: string | null | undefined): CatTheme {
  return CAT_THEMES.find((t) => t.id === id) ?? CAT_THEMES.find((t) => t.id === DEFAULT_CAT_THEME_ID)!;
}

/**
 * The CSS custom properties of a theme, as CatSprite sets them on its host element (the stylesheet derives the
 * shading from them with color-mix). Switching themes only swaps these values: instant, no re-render.
 */
export function catThemeVars(theme: CatTheme): Record<string, string> {
  const fur = theme.primaryColor;
  const outline = theme.outlineColor ?? `color-mix(in oklab, ${fur} 40%, black)`;
  const point = theme.pointColor;
  const vars: Record<string, string> = {
    '--cat-fur': fur,
    '--cat-fur-hi': theme.highlightColor ?? `color-mix(in oklab, ${fur}, white 22%)`,
    '--cat-belly': theme.secondaryColor ?? `color-mix(in oklab, ${fur}, white 55%)`,
    '--cat-stripe': theme.stripeColor ?? 'transparent',
    '--cat-stripes': theme.stripeColor ? '1' : '0',
    '--cat-eye': theme.eyeColor ?? '#8cc152',
    '--cat-accent': theme.accentColor ?? '#f4a3b4',
    '--cat-outline': outline,
  };
  if (theme.stripeColor) vars['--cat-tip'] = theme.stripeColor;
  if (point) {
    // colour points: ears, face mask, paws and tail tip (the stylesheet defaults them to the main fur)
    vars['--cat-point'] = point;
    vars['--cat-ear'] = point;
    vars['--cat-paw'] = point;
    vars['--cat-tip'] = point;
    vars['--cat-mask-op'] = '0.85';
  }
  return vars;
}
