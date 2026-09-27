# land sprite sheet

Landing after being dropped: starts just above the floor, squash-and-stretch on touchdown, settles standing.

- Expected file: `land/land.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.land` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- One-shot clip: plays once, holds its last frame and then reports `finished` to the behaviour code.
  The vector cat's clip is 620 ms long; a matching sheet is for example 8 frames at 13 fps.

As long as no manifest lists `land`, the built-in vector cat draws it.
