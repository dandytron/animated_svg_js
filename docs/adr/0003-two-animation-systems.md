# ADR 0003 — Two animation systems: SMIL for preview, direct attributes for export

**Status:** Accepted  
**Date:** 2026-05-25

## Context

The tool needs to animate SVG elements (drawing lines on, fading in, growing bars) in two
contexts:

1. **Live preview** — the user clicks Preview and sees the animation play in the browser
2. **Export** — frames are captured to canvas and encoded into GIF or ProRes MOV

The natural instinct is to use one animation system for both. We do not.

## Decision

**Preview uses SMIL `<animate>` elements**, injected by `animate.js`. The browser's SMIL
engine plays them natively — no JS animation loop needed.

**Export uses direct DOM attribute writes**, driven frame-by-frame in `export.js`
via `_applyAtTime`. At each timestamp, we set `width`, `height`, `opacity`, etc. directly
on the SVG elements, then serialize with `XMLSerializer` and draw to canvas.

## Why not SMIL for export?

`XMLSerializer` captures the static DOM — the attribute values as they exist in the
document at the moment of serialization. It does not capture SMIL animation engine state.

If you serialize a SMIL-animated SVG mid-animation, you get the unanimated values (the
`from` state or the original attribute), not what the user sees on screen. Every frame
would be identical — frame zero.

This was confirmed during development. There is no workaround short of replacing
`XMLSerializer` entirely.

## Why not direct attributes for preview?

Direct attribute writes require a JS animation loop (`requestAnimationFrame` or `setInterval`)
running at display refresh rate. SMIL is free — the browser handles it natively, it
composites on the GPU, and it degrades gracefully. For preview, SMIL is strictly better.

## Consequences

- `animate.js` and `export.js` both implement the same logical animations (draw on, fade in,
  pop in, grow from baseline) but with different mechanisms. They must be kept in sync when
  animation behaviour changes.
- `export.js` creates static `<clipPath>` rects in `<defs>` and mutates them each frame.
  `animate.js` creates `<animate>` children inside the same clip rects. The DOM structure
  is similar but the contents differ.
- Do not attempt to "unify" these systems. The serialization constraint is fundamental.
