/**
 * Replaceable cat skins (see public/assets/cat/README.md).
 *
 * The desktop cat is drawn by the built-in vector artwork (coloured by the theme). A sprite-sheet skin can replace it:
 *
 *   1. assets/cat/themes/<theme id>/theme.manifest.json  (CatTheme.assetPath) – only for theme ids listed in the global
 *      manifest's "themeSkins"; then it decides for that theme
 *   2. assets/cat/cat.manifest.json                       – otherwise the global manifest decides
 *   3. neither, or invalid                                – vector
 *
 * Listing the per-theme skins in the global manifest means no request is ever made for a file that does not exist
 * (a 404 would show up as a console error in the WebView).
 *
 * A manifest with `"skin": "sprites"` plays every animation it lists from a sheet (sheet paths are relative to the
 * manifest's folder); animations it does not list keep using the vector cat. Every manifest is fetched once per page
 * and cached; any failure counts as "not present".
 */

import { CAT_ANIMATION_NAMES, CAT_ANIMATIONS, CatAnimation } from './cat-art';
import { CatTheme } from './cat-themes';

/** One entry of `animations` in a manifest. */
export interface CatSpriteSheetSpec {
  /** Path of the sheet relative to the manifest's folder, e.g. "walk/walk.png". Frames are laid out horizontally. */
  sheet: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  fps: number;
  /** Defaults to CAT_ANIMATIONS[name].loop. */
  loop?: boolean;
}

export interface CatSkinManifest {
  skin: 'vector' | 'sprites';
  animations?: Partial<Record<CatAnimation, CatSpriteSheetSpec>>;
}

/** A validated sprite clip, ready for the template. */
export interface CatSpriteClip {
  name: CatAnimation;
  /** CSS url(...) of the sheet. */
  image: string;
  frames: number;
  /** frameWidth / frameHeight, informative (the sheet is scaled to the cat box). */
  aspect: number;
  durationMs: number;
  loop: boolean;
}

export type CatSpriteSkin = Partial<Record<CatAnimation, CatSpriteClip>>;

/** Relative on purpose: resolved against the document base (the app is served from its own virtual host). */
export const CAT_SKIN_BASE = 'assets/cat/';
export const CAT_SKIN_MANIFEST_URL = `${CAT_SKIN_BASE}cat.manifest.json`;
export const CAT_THEME_MANIFEST = 'theme.manifest.json';

/** A fetched manifest: present = the file exists and is JSON; skin = its sprite skin (null = vector). */
interface LoadedManifest {
  present: boolean;
  skin: CatSpriteSkin | null;
  /** Global manifest only: theme ids that have their own themes/<id>/theme.manifest.json. */
  themeSkins: ReadonlySet<string>;
}

const NOT_PRESENT: LoadedManifest = { present: false, skin: null, themeSkins: new Set() };

const manifests = new Map<string, Promise<LoadedManifest>>();

function loadManifest(folder: string): Promise<LoadedManifest> {
  const url = folder + (folder === CAT_SKIN_BASE ? 'cat.manifest.json' : CAT_THEME_MANIFEST);
  let p = manifests.get(url);
  if (!p) {
    p =
      typeof fetch !== 'function'
        ? Promise.resolve(NOT_PRESENT)
        : fetch(url, { cache: 'no-cache' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((json: unknown) => ({ present: true, skin: parseCatSkinManifest(json, folder), themeSkins: parseThemeSkins(json) }))
            .catch(() => NOT_PRESENT);
    manifests.set(url, p);
  }
  return p;
}

/**
 * The sprite skin for a theme, or null for the vector cat. The theme's own manifest wins when it exists (even when it
 * says "vector"); otherwise the global manifest decides.
 */
export async function loadCatSkin(theme?: CatTheme | null): Promise<CatSpriteSkin | null> {
  const global = await loadManifest(CAT_SKIN_BASE);
  const folder = theme && global.themeSkins.has(theme.id) ? themeFolder(theme) : null;
  if (folder) {
    const own = await loadManifest(folder);
    if (own.present) return own.skin;
  }
  return global.skin;
}

/** "themeSkins": ["pink", …] of the global manifest (ids only; anything else is ignored). */
function parseThemeSkins(json: unknown): ReadonlySet<string> {
  const list = isRecord(json) ? json['themeSkins'] : undefined;
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) : []);
}

/** The theme's asset folder when it is a plain relative path (no scheme, no ".."), with a trailing slash. */
function themeFolder(theme?: CatTheme | null): string | null {
  const p = theme?.assetPath;
  if (!p || p.includes('..') || !/^[\w-]+(\/[\w.-]+)*\/?$/.test(p)) return null;
  return p.endsWith('/') ? p : p + '/';
}

/** Validates a manifest; returns null (vector) unless it selects sprites and lists at least one usable animation. */
export function parseCatSkinManifest(json: unknown, folder = CAT_SKIN_BASE): CatSpriteSkin | null {
  if (!isRecord(json) || json['skin'] !== 'sprites' || !isRecord(json['animations'])) return null;
  const animations = json['animations'];
  const skin: CatSpriteSkin = {};
  let count = 0;
  for (const name of CAT_ANIMATION_NAMES) {
    const clip = parseClip(name, animations[name], folder);
    if (clip) {
      skin[name] = clip;
      count++;
    }
  }
  return count > 0 ? skin : null;
}

function parseClip(name: CatAnimation, raw: unknown, folder: string): CatSpriteClip | null {
  if (!isRecord(raw)) return null;
  const sheet = raw['sheet'];
  const frames = raw['frames'];
  const frameWidth = raw['frameWidth'];
  const frameHeight = raw['frameHeight'];
  const fps = raw['fps'];
  const loop = raw['loop'];
  // Only plain relative paths inside the manifest's folder (no scheme, no "..", no absolute paths, no CSS-breaking characters).
  if (typeof sheet !== 'string' || !/^[\w-]+(\/[\w.-]+)*\.(png|webp|gif|jpe?g|svg)$/i.test(sheet) || sheet.includes('..')) return null;
  if (!isInt(frames, 1, 240) || !isNum(frameWidth, 1, 4096) || !isNum(frameHeight, 1, 4096) || !isNum(fps, 1, 60)) return null;
  if (loop !== undefined && typeof loop !== 'boolean') return null;
  return {
    name,
    image: `url("${folder}${sheet}")`,
    frames,
    aspect: frameWidth / frameHeight,
    // walk / run are synced to the movement speed through strideBoxWidths, which is defined per CAT_ANIMATIONS cycle:
    // their sheets always play one cycle in CAT_ANIMATIONS[name].durationMs (fps is ignored for them)
    durationMs: CAT_ANIMATIONS[name].strideBoxWidths ? CAT_ANIMATIONS[name].durationMs : Math.round((frames / fps) * 1000),
    loop: loop ?? CAT_ANIMATIONS[name].loop,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return isNum(v, min, max) && Number.isInteger(v);
}
