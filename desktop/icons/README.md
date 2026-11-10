# Application icon

The icon draws a drawing sheet over the set behind it: a Bone sheet with a hatched
title-block strip and a floor plan, dimensioned below, in front of a Steel sheet on a
Filament drafting grid. An Ember revision cloud, the scalloped outline reviewers draw
around a questioned detail, circles a room corner as a finding. It follows Forge: flat
Ink surface, hairline structure and Ember as the single accent.

| File                  | Use                                                             |
| --------------------- | --------------------------------------------------------------- |
| `icon.svg`            | Source on the macOS icon grid, with its shadow                  |
| `icon-full-bleed.svg` | Source filling the canvas, with heavier strokes for small icons |
| `icon.icns`           | macOS application and disk image icon, 16 through 1024 px       |
| `icon.png`            | 1024 px Linux icon and Linux window icon                        |
| `icon.ico`            | Windows executable and installer icon, 16 through 256 px        |

The ICNS file is prebuilt because Electron Builder's PNG-to-ICNS converter
hangs under Bun. Edit the SVG sources, then regenerate every raster file with resvg:

```sh
bun scripts/build-icons.ts
```
