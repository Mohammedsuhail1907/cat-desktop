# dragged sprite sheet

Carried by the scruff: hanging from the **top** of the frame (grab point just left of centre), legs and tail dangling, paws well above the floor.

- Expected file: `dragged/dragged.png` (WebP, GIF, JPEG or SVG also work), registered in `../cat.manifest.json` under
  `animations.dragged` (or next to a theme's `theme.manifest.json` for a single theme).
- One row of frames, left to right, each frame **4:3** (320×240 px recommended), drawn facing **right**, feet on the
  bottom edge (see `../README.md`).
- Looping clip.
  The vector cat's clip is 1200 ms long; a matching sheet is for example 12 frames at 10 fps.

As long as no manifest lists `dragged`, the built-in vector cat draws it.
