# idle sprite sheet

Standing, breathing, the odd blink or ear twitch, slow tail sway.

- Expected file: `idle/idle.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.idle` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- Looping clip.
  The vector cat's clip is 4000 ms long; a matching sheet is for example 16 frames at 4 fps.

As long as no manifest lists `idle`, the built-in vector cat draws it.
