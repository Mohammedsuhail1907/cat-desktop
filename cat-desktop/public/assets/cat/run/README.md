# run sprite sheet

One bounding-run cycle; moves **0.41 box widths per cycle** (`strideBoxWidths`).

- Expected file: `run/run.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.run` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- Looping clip.
  The vector cat's clip is 420 ms long; a matching sheet is for example 6 frames at 14.3 fps.

As long as no manifest lists `run`, the built-in vector cat draws it.
