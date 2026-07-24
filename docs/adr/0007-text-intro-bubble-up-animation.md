# ADR 0007 — Text-intro "bubble up" animation (title/subtitle)

**Status:** Proposed
**Date:** 2026-07-15
**Update 2026-07-20:** re-implemented and proven on the China oil chart
(`scratch_folder/bubble.py`) after the original SpaceX prototype was found never
to have been committed. Confirms the spec; adds the font-ordering learning below.

## Update (2026-07-20) — measure in the real font, and embed it *first*

The rebuild fell into the exact trap this ADR already flagged ("measure in the
*real* font"), which is worth escalating from a footnote to a hard rule.
Datawrapper names Knowledge but ships no font; measuring the raw export lays the
header out in a fallback face **~27% wider** (467px vs 367px on the title), and
pinning each glyph to those positions spreads the headline out visibly. Fix:
measure against a copy of the SVG that already has the `@font-face` injected.

Generalising: the missing font caused **three** distinct bugs this session
(clipped headlines, a dropped export font, skewed glyph metrics). **Font
embedding must be the first step of the animation pipeline — before any
measurement, split, or layout — not a final styling pass.** See
`docs/line-cinematic-integration-checklist.md` §0.

## Context

Prototyped on the SpaceX line chart (`scratch_folder/SpaceX price/`). A staggered
rise-and-fade intro for the header text: each unit starts slightly below its
resting position at `opacity:0`, then floats up into place while fading in, with a
per-unit begin stagger so the words appear to "bubble up" left-to-right. The
footer (note/source) fades in afterward.

Two granularities both proved viable and are worth offering as a **user option**:

- **Per-letter** — fine shimmer rippling across the text. Editor's default pick.
- **Per-word** — chunkier, calmer, more legible on long runs (e.g. a ~90-char
  subtitle where per-letter can look busy).

Preserved prototype outputs:
- `scratch_folder/SpaceX price/EDITED_SpaceX150726.svg` — per-letter
- `scratch_folder/SpaceX price/EDITED_SpaceX150726_word.svg` — per-word
- Generator: `scratch_folder/SpaceX price/bubble_up.mjs` (`node bubble_up.mjs letter|word`)

## Implementation learnings

- **Header text is a single `<text>`/`<tspan>` run.** Per-unit stagger is impossible
  within one run, so the run must be split into per-letter or per-word `<text>`
  elements.
- **Split without spacing drift needs exact glyph positions.** Measure each unit's
  x/y in the *real* font via SVG `getStartPositionOfChar(i)` in a headless browser
  (rsvg/resvg can't lay text out; this needs a real layout engine — same rationale
  as ADR 0003/0004). Returned positions are in the text element's *local* space, so
  wrap the generated units in a `<g>` that reproduces the original run's transform.
- **Per-unit animation:** initial `opacity:0` + `translate(0, ~10)`; animate
  `transform` translate → `(0,0)` and `opacity` → `1` over ~0.32s ease-out, with a
  per-unit `begin` stagger.
- **Auto-sized stagger:** `stagger = min(cap, WINDOW / (n-1))` keeps the whole intro
  under ~1s regardless of run length (title and subtitle run concurrently).
- **Footer:** note/source fade in (opacity only, no movement) after the intro.
- **Both animation systems (ADR 0003):** SMIL drives the preview; the frame-capture
  export drives the same per-unit timing by **direct attribute writes** — at each
  frame it computes each unit's opacity/translate from the stored per-unit `begin`
  and `dur` and writes them to the DOM. (Correction, 2026-07-23: an earlier draft
  said the export uses `setCurrentTime` capture; the shipping `export.js` does not,
  and cannot — SMIL state serializes to frame-zero, per ADR 0003. The per-unit
  `begin`s are the shared *data*, not a shared mechanism.)
- **viewBox stamping (ADR 0004)** applies unchanged for scaled export.

## Decision (proposed)

Offer a header **text-intro animation** with a **`per-letter | per-word` toggle**
(default per-letter). Implement the split + stagger generator in both `animate.js`
(SMIL) and `export.js`, modeled on the prototype `bubble_up.mjs`.

## Open questions

- **Long runs:** per-letter can look busy on long subtitles — should the default be
  per-word for the subtitle specifically, per-letter for the title?
- **Params to expose:** rise distance, duration, stagger, ease — which are
  user-facing vs fixed?
- **Direction:** left-to-right only? RTL locales?
- **Detection:** how to identify the title vs subtitle text nodes generically inside
  Datawrapper's header containers (currently matched by content/size in the
  prototype).
