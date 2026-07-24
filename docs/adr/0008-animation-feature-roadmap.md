# ADR 0008 — Animation feature roadmap (proposals)

**Status:** Proposed
**Date:** 2026-07-15
**Update 2026-07-20:** the line-chart pilot built and proved #1 (trace), #3
(text-intro/bubble-up), and #5 (camera moves), plus a new split-timing draw and
anchored scrolling axes not in this list. Full working prototypes + an
integration checklist: `docs/line-cinematic-integration-checklist.md`. Items
below annotated `[PROVEN 07-20]` where that pilot delivered them end-to-end.

## Context

Hand-animating real charts outside the tool (the stacked-bar poll and the SpaceX
line chart) surfaced techniques the tool doesn't yet support. This ADR collects
them as a prioritized feature roadmap. Each item ties to something already
prototyped in `scratch_folder/`, so these are grounded proposals, not speculation.

Cross-cutting constraint (ADR 0003): every animation must be implemented in **both**
`animate.js` (SMIL preview) and `export.js` (per-frame **direct attribute writes** —
each frame's attribute values are computed and written to the DOM so `XMLSerializer`
captures them; SMIL/`setCurrentTime` state is *not* used, as it serializes to
frame-zero). All items below were verified to survive the frame-capture export in the
prototypes.

## Proposals

### 1. Line draw-on: `trace` mode (stroke-dashoffset) — HIGH  `[PROVEN 07-20]`
The current draw-on is a left-to-right clip-wipe (per ADR 0003 / the review). Add a
per-line **`trace`** style: `pathLength="1"` + animated `stroke-dashoffset` 1→0, so
the stroke draws along its own path.
- **Why:** truer "plotting live" feel; and a *correctness fix* — a clip-wipe reveals
  a non-monotonic line's backtracks/loops out of order, whereas trace follows the
  real path. Offer `{wipe | trace}` per series.
- **Prototype:** `SpaceX price/EDITED_SpaceX150726.svg` (blue + coral lines).

### 2. Leading marker on the draw tip — MED
Optional dot/label that rides the tip of a drawing line and lands on the final value
(classic stock-chart move).
- **Impl:** `<animateMotion>` along the same path (SMIL) / sample point per frame
  (export).

### 3. Text-intro animation library — HIGH  `[PROVEN 07-20: bubble-up]`
Promote the "bubble up" intro (ADR 0007) to a **preset family** for title/subtitle:
bubble-up (letter/word), typewriter, slide-in, mask-reveal, fade.
- **Shared engine:** split the run into per-unit `<text>` elements measured with
  `getStartPositionOfChar`, then staggered enter (auto-sized stagger, <1s).
- **Prototype:** `bubble_up.mjs` (letter/word modes).

### 4. Timeline / sequencing model — HIGH (substrate)
Timing is currently implicit. Add **explicit per-group begin offsets and reveal
order** (title → series → annotations → footer), auto-fit to a target duration.
- **Why:** this is the backbone the other features schedule against. Prototyped
  ad hoc via begin offsets across legend rows, series (blue→red), and footer fade.

### 5. Camera moves: focus zoom/pan + emphasis — MED-HIGH  `[PROVEN 07-20: push/pull-back + anchored axes]`
Keyframed **zoom/pan to a target region** (animated `viewBox`), plus an
**emphasis/de-emphasis** transition (dim + shrink + recede one group while promoting
another).
- **Prototype:** stacked-bar focus-shift (row 1 dim+shrink+lift as row 2 arrives);
  end-zoom on the SpaceX $135 crossover (in progress).

### 6. Annotation reveals synced to data — MED
Let annotations / value labels appear at the moment their data point draws (e.g. a
threshold label fades in as the line crosses it).
- **Prototype context:** the static "$135 IPO PRICE" label on the SpaceX chart.

### 7. Compositing legibility toggle — MED  `[PROVEN 07-20: feDropShadow re-used]`
One-click drop-shadow / outline / glow on all text, implemented as an SVG
`feDropShadow` filter so it survives export (CSS `text-shadow` does not).
- **Prototype:** the stacked-bar `textShadow` filter.

### 8. Composite-proxy preview backdrops — MED
Preview against broadcast grey, custom hex, an uploaded still, an alpha checkerboard,
or a shadow/mask overlay — so editors judge the transparent export against its real
destination, not just black.
- **Prototype:** the grey-vs-black preview backdrops used this session.

### Lower priority
- **In-tool text editing** — edit title/subtitle/label copy with automatic per-glyph
  re-measure for text animations (from the "Back to Earth" / subtitle-trim fix).
- **Layout nudge** — element spacing/padding (from the SpaceX spacing pass); edges
  toward Datawrapper's territory rather than the tool's.

## Recommended sequencing

1. **#4 Timeline/sequencing** — the substrate everything schedules against.
2. **#1 Trace** and **#3 Text-intro** — both prototyped, low risk, high value.
3. **#5 Camera moves** — build on the timeline once it exists.

## Related

- ADR 0006 — horizontal stacked bar animation
- ADR 0007 — text-intro "bubble up" animation
