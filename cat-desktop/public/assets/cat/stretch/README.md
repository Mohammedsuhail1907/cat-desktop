# stretch sprite sheet

Front legs forward, rear up, then back to standing.

- Expected file: `stretch/stretch.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.stretch` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- One-shot clip: plays once, holds its last frame and then reports `finished` to the behaviour code.
  The vector cat's clip is 2400 ms long; a matching sheet is for example 12 frames at 5 fps.

As long as no manifest lists `stretch`, the built-in vector cat draws it.
