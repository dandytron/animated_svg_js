# ADR 0002 — Export delivery spec: presets, frame rates, resolution

**Status:** Accepted  
**Date:** 2026-05-25  
**Update 2026-07-20:** NTSC is the default frame rate; presets need short-edge
width semantics for vertical. See the update section at the foot.

## Context

ProRes MOV exports need to work for broadcast delivery. Two variables matter:
- **Frame rate** — PAL (25fps) vs NTSC (29.97fps). Reuters distributes globally.
- **Resolution** — charts originate as 720px-wide SVGs; broadcast delivery requires upscaling.

720p was considered and rejected: no current Reuters delivery target uses it.

## Decision

MOV export is offered as named delivery presets in the Export menu, abstracting fps and resolution
from the journalist. Three resolutions × two frame rates = six presets:

| Preset | fps | Canvas width |
|--------|-----|-------------|
| PAL · 4K | 25 | 3840px |
| PAL · 1080p | 25 | 1920px |
| PAL · Preview | 25 | 960px |
| NTSC · 4K | 29.97 | 3840px |
| NTSC · 1080p | 29.97 | 1920px |
| NTSC · Preview | 29.97 | 960px |

"Preview" (960×540) is half-HD — fast to encode, usable for composition checks before committing
to a broadcast-quality render.

29.97fps is passed to ffmpeg as the exact rational `30000/1001`, not `29.97`, for
standards-compliant output.

## Canvas scaling

`captureFrames` accepts a `targetWidth` option. Canvas height is derived by scaling
the source SVG's natural height (including the +40px footer overflow buffer) by the
same factor as the width, so the buffer remains proportionally correct at 4K.

GIF export is not affected — it remains 30fps at source resolution. GIF is not a broadcast format.

## Future formats (stub)

Formats not yet implemented but worth revisiting as distribution targets evolve:

- **50p / 59.94p** — progressive high frame rate for social/digital; straightforward to add as
  presets once the need arises (just another `data-fps` value in the menu)
- **ProRes 422 HQ** — smaller than 4444, no alpha; useful if the chart will always render over a
  solid background and file size matters
- **DNx / H.264 delivery mux** — some broadcast systems accept MP4 rather than MOV; ffmpeg.wasm
  supports both containers
- **Custom resolution** — a "Custom…" preset opening a resolution input, for non-standard
  delivery specs

## Update (2026-07-20) — defaults and vertical, from the ProRes pilot

Exporting the China oil chart (`scratch_folder/export_prores.py`, a Playwright +
`prores_ks` twin of `capture_frames.mjs`) resolved two things the original spec
left open:

- **NTSC is the default.** The preset table lists PAL and NTSC side by side with
  no default marked, which led to a wrong-guess PAL render. Default is now
  **NTSC (29.97 = `30000/1001`)**; PAL only on request.
- **Preset widths assume landscape.** "1080p → 1920px canvas width" put 1920 on
  the **long** edge of a 9:16 source and produced 1920×3414. Presets should carry
  the **short-edge** width (so 1080p means 1080 on the narrow side regardless of
  orientation), or ship a separate vertical preset family. Current workaround: a
  `--width` override.
- **Round durations overshoot in NTSC.** 10s × 29.97 = 299.7 frames → 300 →
  **10.010s**. A whole-second duration is never exact at 29.97. Pick a house rule
  (round frames up vs down) and surface the real duration rather than trimming.
- **Datawrapper canvases aren't exactly 16:9.** The 838×473 export scales to
  1920×**1084**, not 1080. Fine over alpha; only matters if a delivery spec
  demands exact 1920×1080, in which case pad rather than distort.
