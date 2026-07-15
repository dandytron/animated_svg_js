# ADR 0006 — Animating horizontal stacked bar charts

**Status:** Proposed
**Date:** 2026-07-14

## Context

The tool currently supports line, area, vertical bar/column, and scatter charts
(`CONFIG.chartRoots`). It does not support **horizontal stacked bar** charts.

To learn what support would require, we hand-animated a real Datawrapper
horizontal stacked bar chart (a Reuters/Ipsos survey, two rows of four segments)
as a standalone SMIL SVG, outside the tool. Every finding below was then
adversarially reviewed against the actual source (`detect.js`, `config.js`,
`animate.js`, `export.js`) and all five example SVGs. Several of the author's
first-pass claims were wrong and are corrected here.

### The chart's structure

Inside `<g id="chart-svg">`, in document order: legend `<circle>`s and
`<text>`s, then per row a title `<text>`, four segment `<rect>`s (one with
`width="0"`, a 0% segment), a dashed axis `<line>`, and — after **both** rows'
rects — all value `<text>` labels. The segment rects are **flat, id-less
siblings** positioned by absolute horizontal `translate(x, y)`; there is no
`columns-svg`/`lines-svg`/`areas-svg` container.

## Findings

### 1. Detection must be content-based, gated on a nested-root test

`detectElements` (`detect.js:58-85`) iterates `CONFIG.chartRoots`
(`config.js:17-23`); none matches, so detection returns `[]`. Adding a
`chart-svg` root entry does not help: `chart-svg` is the **generic content
wrapper present in every chart type** (line/area/scatter/column all nest their
real root inside it), and the segment rects carry no ids (children mode requires
ids, `detect.js:75-76`).

Discriminator that works (verified zero false positives across all five
examples):

- **Clause 1** — `chart-svg` has positive-area **direct-child** `<rect>`s
  (`w>0 && h>0`, the same guard as `_rectUnionBounds`, `animate.js:111`). This
  positively identifies the stacked case (7 rects; the 8th, the 0% segment, is
  correctly dropped by the guard).
- **Clause 2** — `chart-svg` contains **no nested `CONFIG.chartRoots`
  container**. This is the robust gate: even if some future config placed a
  background rect directly under `chart-svg`, a genuine line/area/scatter/column
  chart still has its nested root and is excluded.

Cluster the surviving rects into rows by rounded `translate`-y (row 1 ≈ y93.67,
row 2 ≈ y152.47) — conceptually the modal-edge trick `_detectBaseline`
(`animate.js:130-146`) already uses, but grouping rather than collapsing. This
row clustering is the only irreducibly new detection machinery.

### 2. Animation is a per-row width wipe — a new variant, NOT reused `draw_on`

The reveal is a clip-path rect per row growing in `width` 0→full, so the stack
fills left-to-right as one unit with segment boundaries fixed. Direct per-segment
`width` animation is wrong: segments are pinned by absolute `translate(x,…)`, so
growing them simultaneously leaves right-hand segments floating over gaps unless
you recompute each `x` every frame.

**`draw_on` cannot be reused unmodified.** It uses a single whole-SVG `bounds`
(`animate.js:209` `_clipBounds(clone)`), never measures its element, and animates
the clip rect to whole-SVG `x/y/width/height` (`animate.js:70-81`; export
identical, `export.js:49-52,91`). It only *appeared* to work in the hand file by
two coincidences: the row was the sole content of its group (full-height clip
over-reveals nothing) and a 100%-stacked row spans the full 600px width (so
whole-SVG width ≈ row width). Neither holds for a horizontal bar that does not
fill the plot area.

Correct approach: a per-row width-wipe variant that **mirrors
`grow_from_baseline`'s element-measuring path** (`animate.js:155-162`,
`_rectUnionBounds(group)` with the 2px antialias pad) but animates `width`
instead of `height`/`y`. In export, stash the row bounds as `data-*` at setup
(as the grow branch does, `export.js:57-65`) and drive `width` in `_applyAtTime`.
This is ~5 lines on each side — a clone of the grow code with the axis swapped.

Do **not** generalize `grow_from_baseline` with an orientation parameter: every
geometry helper (`_rectUnionBounds`, `_detectBaseline`, `_growGeometry`) is
axis-hardcoded, it forks both animation systems, and it is semantically wrong —
a 100%-stacked bar has no zero line; its baseline is simply the left edge.

### 3. Binding requires one synthesized `<g>` per row

The pipeline resolves each element to a **single** node and sets `clip-path` on
it (`animate.js:218` `querySelector('[id="…"]')` → `:233`; export
`export.js:38,69,81`). Assigning a shared `clip-path` to each rect while keying
the animation by a synthetic group id **mismatches** this: the synthetic id
resolves to no node and the element is skipped (`animate.js:219-221`,
`export.js:39-42`).

Minimal integration: wrap each row's rects **plus its value texts** in one
synthesized `<g id="row-N-svg">`. `group_id` then resolves to a real node, one
`clip-path` set clips the whole row, and `_applyAtTime` mutates the indexed clip
rect exactly as today — zero pipeline changes. This is a small, targeted reparent
(the value texts, which sit after all rects, move into their row group; keep them
**after** the rects inside the group to preserve label-on-top z-order).

### 4. Both animation systems, kept in sync (ADR 0003)

The row width-wipe must be implemented in **both** `animate.js` (SMIL `<animate>`)
and `export.js` (per-frame `width` writes). This is non-negotiable per ADR 0003.
Because it clones the existing grow pattern, the sync cost is low.

### 5. Value labels associate to rows geometrically

Label→row association must be by **y-proximity to the row band**, never by count
or document order: rows have differing label counts (row 1 has two, row 2 has
three), small and 0% segments get no label, and all labels are dumped after both
rows' rects.

### 6. viewBox stamping still applies (ADR 0004)

These SVGs also ship no `viewBox`, so scaled export must stamp one first. Confirmed
in the hand export: `viewBox="0 0 600 238"` stamped before scaling to the 1920×762
NTSC-1080p canvas, otherwise the chart renders as a corner thumbnail.

## Decision (proposed)

1. Add a content-based detection branch: within `chart-svg`, require positive-area
   direct-child rects (clause 1) **and** no nested `CONFIG.chartRoots` container
   (clause 2); cluster surviving rects into rows by `translate`-y.
2. Wrap each row in a synthesized `<g id="row-N-svg">` (rects + value texts
   associated by y-proximity, texts after rects).
3. Add a row width-wipe animation type modeled on `grow_from_baseline`'s
   element-measuring path, axis swapped to `width`; implement in both `animate.js`
   and `export.js`.
4. Do **not** generalize `grow_from_baseline`, reuse `draw_on` unmodified, or
   special-case the 0-width segment (a no-op under a clip wipe).

## Open questions (one sample cannot answer)

- **Structural stability:** does Datawrapper always emit flat, id-less rects
  directly under `chart-svg`, or do other versions/configs wrap rows/segments in
  `<g>` (possibly with ids)? That would change detection and binding.
- **Diverging / grouped / non-stacked horizontal bars:** diverging bars have a
  center baseline with segments on both sides — a pure left-to-right wipe is
  wrong for them.
- **Row-clustering robustness:** are row heights and inter-row gaps always
  uniform? Mixed heights, wrapped labels, or sub-rows would break naive
  y-clustering.
- **Label association** ambiguity in tall or overlapping row bands.
- **Direction & easing:** always left-to-right (RTL locales)? The tool's
  `_animate` (`animate.js:56-66`) is linear only; the hand file used `keySplines`
  ease-in-out — is easing a requirement or a preference?
- **Axis line and legend:** reveal with the rows, fade independently, or stay
  static? One hand-tuned sample cannot establish the intended default.

## Future work

- **Manual chart-type selector (override for autodetection).** Rather than relying
  solely on content-based autodetect — which is inherently fragile on a single
  sample per type — let the user pick the chart type at upload time. Autodetect
  stays as the default/fallback; the manual choice is an escape hatch when
  detection is wrong or ambiguous. App-wide, not stacked-specific. Deferred;
  autodetect only for now.
