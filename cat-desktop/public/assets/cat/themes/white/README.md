# Theme "white" – White

Optional sprite-sheet skin for this theme only. The vector cat already draws this theme from its colours in
`src/app/cat-companion/components/cat-sprite/cat-themes.ts`; nothing is needed here unless the theme should use
hand-made sheets.

To give this theme its own sheets, add `theme.manifest.json` to this folder (same format as `../../cat.manifest.json`,
see `../../README.md`), with sheet paths relative to this folder, for example:

```json
{
  "skin": "sprites",
  "animations": {
    "walk": { "sheet": "walk.png", "frames": 8, "frameWidth": 320, "frameHeight": 240, "fps": 15, "loop": true }
  }
}
```

If `theme.manifest.json` exists it decides for this theme (`"skin": "vector"` forces the vector cat); if it does not
exist, the global `assets/cat/cat.manifest.json` decides.
