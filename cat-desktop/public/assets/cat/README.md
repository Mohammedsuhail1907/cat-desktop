# Cat skins

The desktop cat (`CatSprite`, `src/app/cat-companion/components/cat-sprite/`) is drawn by a built-in **vector** cat: one
inline SVG animated with CSS and coloured by the selected **theme** (`cat-themes.ts`: every theme is a set of coat, eye,
accent and outline colours; the vector cat derives its shading from them). Every animation can also be replaced by a
**sprite sheet** without touching any code – for all themes at once, or per theme:

| manifest | applies to |
|---|---|
| `themes/<theme id>/theme.manifest.json` | that theme only, when its id is listed in `themeSkins` of `cat.manifest.json` (e.g. `"themeSkins": ["pink"]`); it then decides for the theme |
| `cat.manifest.json` (this folder) | every theme without its own manifest |

Neither present (or `"skin": "vector"`) → the vector cat. Theme manifests are only requested for the ids in
`themeSkins`, so themes without a skin never cause a request for a missing file. Example `cat.manifest.json`:

```json
{
  "skin": "sprites",
  "animations": {
    "walk": { "sheet": "walk/walk.png", "frames": 8, "frameWidth": 320, "frameHeight": 240, "fps": 15, "loop": true },
    "jump": { "sheet": "jump/jump.png", "frames": 9, "frameWidth": 320, "frameHeight": 240, "fps": 10, "loop": false }
  }
}
```

With `"sprites"`, every animation listed is played from its sheet; animations that are not listed (or whose entry is
invalid) keep using the vector cat, so a skin can be built up one animation at a time. Sheet paths are relative to the
folder of the manifest that lists them (`walk/walk.png` here, `walk.png` next to a `theme.manifest.json`).

## Animation names

`idle`, `walk`, `run`, `sit`, `sleep`, `jump`, `stretch`, `look`, `happy`, `surprised`, `dragged`, `yawn`, `land`,
`interact` – one folder each here. The behaviour code only ever uses these names (`CAT_ANIMATIONS` in `cat-art.ts`).

| name | kind | vector length | notes |
|---|---|---|---|
| idle | loop | 4000 ms | standing; breathing, blinks, ear twitches, tail sway |
| walk | loop | 520 ms | moves 0.167 box widths per cycle |
| run | loop | 420 ms | moves 0.41 box widths per cycle |
| sit | loop | 4000 ms | |
| sleep | loop | 3600 ms | curled up |
| jump | one-shot | 900 ms | must stay inside the frame, ends standing |
| stretch | one-shot | 2400 ms | ends standing |
| look | one-shot | 2600 ms | ends standing |
| happy | one-shot | 1400 ms | ends standing |
| surprised | one-shot | 1100 ms | ends standing |
| dragged | loop | 1200 ms | hanging from the top of the frame, left of centre (the scruff) |
| yawn | one-shot | 1800 ms | ends standing |
| land | one-shot | 620 ms | starts just above the floor (dropped), squashes, ends standing |
| interact | one-shot | 1700 ms | head tilt and slow blink, ends standing |

## Sheet format

* **One row** of frames, left to right, no gaps or padding: the image is `frames × frameWidth` wide and `frameHeight`
  high.
* Each frame shows the whole cat box, which is **4:3**: the cat window is `round(160 × scale)` × `round(120 × scale)`
  CSS px (scale 10 %–200 %, so 16×12 up to 320×240) and the host scales for DPI. Frames are stretched to the box, so use
  a 4:3 frame size; 320×240 (or 480×360) stays sharp at 200 % and on HiDPI screens.
* The cat faces **right**; facing left is the same sheet mirrored.
* The cat's **feet touch the bottom edge** of the frame (that edge is the taskbar / floor line). Draw a soft ground
  shadow inside the frame if you want one. Transparent background (PNG or WebP with alpha).
* Keep the cat inside the frame for the whole clip; the window is clipped to the box. The window's click area is
  `CAT_ANIMATIONS[name].hitBox` (fractions of the box, symmetric left/right), so keep the cat within it or update it.
* Sheets replace the whole cat, so the theme colours, the `attentive` state and the facial expressions of the vector
  cat do not apply to them.

## Manifest fields

| field | type | meaning |
|---|---|---|
| `sheet` | string | path relative to the manifest's folder; plain relative paths only, `..` and URLs are rejected |
| `frames` | integer 1–240 | number of frames in the row |
| `frameWidth`, `frameHeight` | number | size of one frame in px (should be 4:3) |
| `fps` | number 1–60 | playback speed; a clip lasts `frames / fps` seconds |
| `loop` | boolean, optional | defaults to the animation's kind in the table above |

Playback details:

* Frames advance with a CSS `steps()` animation (one frame per step, no blending).
* **walk** and **run** always play one cycle in the vector cat's length (520 / 420 ms, `fps` is ignored), because the
  behaviour code syncs them to the walking speed with the stride above. Draw one full stride per sheet, covering the
  same distance, and the paws will not slide.
* One-shot clips play once, hold the last frame and report `finished` when the sheet animation ends.
* The playback rate, pause and facing set by the behaviour code apply to sheets exactly like to the vector cat.
* Clip changes switch sheets immediately (the vector cat crossfades its poses).

Manifests are loaded once per page; a missing or invalid manifest counts as absent. Tip: `tests/visual/cat-preview`
renders frames of the vector cat (`mode=strip`), which makes a handy template for a new sheet.
