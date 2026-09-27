# walk sprite sheet

One full walk cycle (every paw steps once). The behaviour code sets the playback rate from the walking speed assuming the cat moves **0.167 box widths per cycle** (`strideBoxWidths` in `cat-art.ts`); keep the cycle length and stride so the paws do not slide, or change both there.

- Expected file: `walk/walk.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.walk` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- Looping clip.
  The vector cat's clip is 520 ms long; a matching sheet is for example 8 frames at 15.4 fps.

As long as no manifest lists `walk`, the built-in vector cat draws it.
