# sleep sprite sheet

Curled up asleep, slow breathing.

- Expected file: `sleep/sleep.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.sleep` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- Looping clip.
  The vector cat's clip is 3600 ms long; a matching sheet is for example 12 frames at 3.33 fps.

As long as no manifest lists `sleep`, the built-in vector cat draws it.
