# interact sprite sheet

Friendly reaction to the user: head tilt, slow "cat kiss" blink, ears perk, tail curls; ends standing.

- Expected file: `interact/interact.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.interact` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- One-shot clip: plays once, holds its last frame and then reports `finished` to the behaviour code.
  The vector cat's clip is 1700 ms long; a matching sheet is for example 17 frames at 10 fps.

As long as no manifest lists `interact`, the built-in vector cat draws it.
