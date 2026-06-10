# ADR 0005 — Per-bar grow clips anchored at the inferred zero line

**Status:** Accepted
**Date:** 2026-06-10

## Context

`grow_from_baseline` originally used one whole-chart clip rect per bar, growing
upward from the bottom edge of the SVG. On the reference bar chart
(`examples/bar_chart_iphone.svg`) this produced two visible defects:

1. **Wrong direction for negative bars.** The chart has bars below the zero line
   (revenue declines). A clip growing up from the SVG bottom reveals those bars
   bottom-first — they appear to *shrink toward* the axis instead of growing
   away from it.
2. **Compressed timing.** The clip travels the full chart height (518 units)
   but a bar occupies only a fraction of it (e.g. 45 units). The bar's visible
   growth happened in roughly the last tenth of its configured duration, after
   a long invisible delay.

## Decision

Each bar gets its own clip rect, sized to the bar and anchored at the chart's
**zero line**:

- **Positive bars** (sitting on the zero line): the clip's bottom edge is pinned
  at the zero line; height grows upward over the full element duration.
- **Negative bars** (hanging below the zero line): the clip's top edge is pinned
  at the zero line; height grows downward.

### Inferring the zero line

Datawrapper encodes no explicit baseline. We infer it: collect the top and
bottom edges of every sibling bar in the same chart root, and take the most
repeated value (`_detectBaseline` in `animate.js`). Positive bars *end* at the
zero line and negative bars *start* at it, so it is the modal edge. If no edge
repeats (single bar, or no shared axis), the bar grows up from its own bottom
edge — correct for all-positive charts.

### Geometry source

Bar bounds are read from `rect` attributes plus accumulated `translate`
transforms (`_rectUnionBounds`), not `getBBox()`. Attribute parsing works on
detached DOM (DOMParser output, used by both preview and export paths);
`getBBox()` requires a live render tree.

### Both animation systems

The same geometry (`_growGeometry`) drives both systems (see ADR 0003):

- **Preview (SMIL):** two `<animate>` elements for positive bars (height up,
  y sliding), one for negative bars (height only).
- **Export (JS-driven):** geometry is stamped onto the clip rect as `data-*`
  attributes at setup; `_applyAtTime` reads them back each frame.

## Fallback

When a group assigned `grow_from_baseline` contains no `<rect>` (user applies
it to a line or area via the dropdown), the old whole-chart clip behaviour is
kept so the animation still functions.

## Consequences

- Bar growth now spans the element's full configured duration.
- Mixed positive/negative charts animate correctly in both directions.
- The clip rect is 2 units wider than the bar on each side (antialias headroom).
- Stacked bars (multiple rects per group) animate as one unit via the union of
  their rect bounds.
