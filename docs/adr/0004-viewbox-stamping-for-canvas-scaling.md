# ADR 0004 — viewBox stamping for proportional canvas scaling

**Status:** Accepted  
**Date:** 2026-05-25

## Context

MOV export supports multiple output resolutions (4K, 1080p, Preview). The source SVG
is fetched from Datawrapper at ~720px wide. Frames must be captured at the target
canvas dimensions.

## The problem with Datawrapper SVGs

Datawrapper SVGs have no `viewBox` attribute. They declare size via `width` and `height`
attributes only (e.g. `width="720" height="500"`).

Without a `viewBox`, an SVG's internal coordinate space is fixed at the declared pixel
dimensions. Setting `width="3840"` on such an SVG expands the SVG *element* to 3840px
but does not scale the content — the chart still draws at 720 coordinate units in the
top-left corner of a 3840px canvas. The rest of the frame is empty.

This was confirmed in production: 4K exports showed the chart as a small thumbnail in
the top-left corner of an otherwise black frame.

## Decision

Before setting the scaled `width`/`height` on the live SVG element in `captureFrames`,
stamp a `viewBox` if one is not already present:

```js
if (!live.getAttribute('viewBox')) {
  live.setAttribute('viewBox', `0 0 ${naturalW} ${naturalH}`);
}
live.setAttribute('width',  canvasW);
live.setAttribute('height', canvasH);
```

`naturalW` and `naturalH` are the source SVG's original coordinate dimensions (including
the +40px footer overflow buffer). `canvasW` and `canvasH` are the scaled target dimensions.

The `viewBox` tells the renderer: "the content coordinate space is naturalW × naturalH;
scale it to fill whatever width × height I declare." Standard SVG scaling behaviour then
handles the rest.

## Why not CSS transform or canvas drawImage scaling?

- **CSS transform** on the live element would scale the rendered element but not affect
  `XMLSerializer` output or canvas draw dimensions — frames would still capture at source size.
- **`drawImage` scaling** (`ctx.drawImage(img, 0, 0, canvasW, canvasH)`) would upscale a
  720px raster image to 3840px, producing a blurry result. We want the SVG renderer to
  produce a native 3840px render, not a scaled-up bitmap.

## Scope

The fix applies only when `targetWidth` is set (i.e. a scaled export is requested).
At source resolution (`targetWidth = null`, `scale = 1`), `canvasW = naturalW` — setting
`width` to the same value it already has makes no visual difference, and the viewBox is
still stamped for consistency.

GIF export does not use `targetWidth` and is unaffected.

## Consequences

The live SVG element in `captureFrames` is mutated before frame capture. This is
intentional — `captureFrames` always works on a freshly parsed copy of `state.svg`,
never on the displayed SVG. Mutations do not affect the preview or the UI.
