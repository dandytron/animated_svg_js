# ADR 0009 — Transparent-export compositing treatment and fill/key delivery

**Status:** Proposed
**Date:** 2026-07-26

## Context

ADR 0002 specs the export *formats* (ProRes 4444 alpha, presets, frame rate).
It does not say what the chart should *look like* once the opaque plate is gone
and it is composited over footage. Hand-producing real Reuters deliverables this
cycle — the Brent crude and US jobless-claims line charts, both dark-theme
Datawrapper exports — surfaced a treatment the tool does not yet perform, and
one delivery path (Sony Hive) that ProRes-in-`.mov` cannot satisfy at all.

Everything below was built and shipped by hand (`scratch_folder/cinematic.py`,
`export_prores.py`, `export_fillkey.py`) and verified frame-by-frame, so these
are records of what worked, not proposals in the abstract. Where a first attempt
was wrong it is marked.

Cross-cutting constraint (ADR 0003): anything adopted into the tool lands in
**both** `animate.js` (SMIL preview) and `export.js` (per-frame attribute writes
on detached DOM). Nothing here needs layout, so all of it survives that split.

## The treatment

### 1. Drop the plate; whiten and shadow the **chrome only** — never axis or data

For compositing, the full-canvas background `<rect>` is removed. Type then has
to read over arbitrary footage, so title, subtitle, legend label, credits, and
the annotation callout get white fill + an SVG `feDropShadow` (a CSS
`text-shadow` does not survive frame-capture export; the filter does).

The load-bearing correction: the treatment is **scoped to the chrome**. The
pilot's `pilot_line_charts.py::restyle` whitens *every* `tspan` fill — correct
for a light-theme source, **wrong** for these dark Reuters exports, where it
would flatten the deliberate grey axis hierarchy and repaint the coloured value
label. The rule is:

> Whiten and shadow the chrome (title / subtitle / legend / credits / callout).
> Never touch the axis ticks, gridlines, the series, or a coloured value label.
> The source may already be dark — do not assume it needs inverting.

This is the general form of a bug found in the merged camera port, which
hard-codes rebuilt axis labels to `rgb(255,255,255)`: the same "assume the
ground is dark, so white is safe" mistake at a different altitude. Had this
constraint been written when `restyle` was built, that bug could not have been
expressed. A theme flag (dark source → chrome only; light source → full restyle)
is the tool-side shape, but is **not** committed here — see Consequences.

### 2. Gridlines: lift, and prefer a shadow over pure brightness

With the plate gone, Datawrapper's `rgb(83,83,83)` gridlines are near-invisible.
Lifting them to a slightly-greyed white (`rgb(210,210,210)` shipped) reads over a
dark bed. But over a **grey** composite (a common blurred backdrop) brightness
alone loses — a light line vanishes against a light patch. The durable fix is a
drop shadow on the rules, which gives contrast against *any* ground; treat the
brightness value as a starting point the operator tunes to the actual bed.

### 3. 5% pad via viewBox expansion, not width/height

Composited charts should not run to the frame edge. Expanding the **viewBox**
symmetrically (not width/height) insets the content while preserving the
viewport pixel size and aspect, so the export dimensions are unchanged and
nothing stretches. `cinematic.py::pad_viewbox` does this after all animation
injection; it must run *after* any viewBox stamp (ADR 0004), never before.

### 4. Judge the proxy over the target ground, not black

An H.264 proxy composited over **black** flatters everything — it hid a
grey-on-grey gridline problem for three review rounds. Preview proxies should be
composited over the actual destination (broadcast grey, or the real backdrop),
per the composite-proxy idea in the ADR 0008 roadmap (§8).

## Fill/key delivery for Hive (extends ADR 0002)

Sony Hive rejects the `.mov` wrapper that ProRes 4444's alpha requires.
DNxHR-in-MXF is Hive-native but carries **no** alpha channel. So transparency is
split into two ordinary videos — the broadcast fill+key idiom:

- **FILL** — the picture, colour composited over black.
- **KEY** — the alpha as a luma matte (white = opaque, black = transparent).

`FILL` alone **is** the opaque-black deliverable; `FILL` + `KEY` recombined
(Premiere Track Matte Key, Composite Using = Luma) is the transparent one. One
fill file, two uses; the key carries the transparency the MXF wrapper cannot.
Spec, validated by `ffprobe` against a prior accepted delivery: **DNxHR HQX,
`yuv422p10le`, MXF, 29.97 = `30000/1001`**. Implemented in
`scratch_folder/export_fillkey.py`.

Two operational notes worth keeping:

- **The KEY is invariant to text/colour changes.** A luma matte depends only on
  alpha geometry, so re-colouring labels regenerates an identical KEY — only the
  FILL needs re-encoding.
- **VLC is not a judge.** It decodes DNxHR-MXF and ProRes-4444-alpha badly
  (partial frame, then stall). The files are frame-perfect for Premiere; always
  hand over an H.264 proxy for eyeballing, and verify a suspect render by
  extracting frames with `ffmpeg -ss`, not by trusting a player.

## Decision

Record the treatment and the fill/key path as the house approach for
transparent/composited delivery. Keep the reference implementations in
`scratch_folder/` as the source of truth until they are ported.

Do **not** pre-commit a tool-side API for the composite profile here. ADR 0002's
own history is the caution: its §6/§7 forward-specs sat unbuilt, and where the
line-cinematic port *was* implemented it copied the pilot's mechanism rather than
its intent (that is how the camera got hard-coded white). A written constraint
that a later implementation must satisfy — §1's "chrome only, never assume dark"
— ages better than a premature interface. State the rule; let the port choose
the shape.

## Consequences

- A future "transparent / composite" export profile bundles §1–§3 (drop plate →
  scoped chrome shadow → gridline lift → 5% pad) behind one toggle, gated on a
  **source-theme flag** so it never whitens a light chart's data or a dark
  chart's axis.
- The scoped-shadow selection must be done by **DOM role/id on the parsed tree**,
  not by the string-slice markers `cinematic.py` uses for hand work — those are
  fragile and were only ever fit for one-off scripts.
- Fonts: the compositing treatment measures and renders text, so it inherits the
  §0 font-embed dependency and its failure modes (see the checklist). It must not
  ship before font embedding is reliable in the deploy target.
- Weight 400 is not used by any real Datawrapper export (only 300 and 700);
  embedding it is dead payload. Recorded here so the port does not re-import it.

## Related

- ADR 0002 — export delivery spec (formats, presets, NTSC default)
- ADR 0003 — two animation systems (the both-halves invariant)
- ADR 0004 — viewBox stamping for canvas scaling
- ADR 0008 — animation feature roadmap (§7 compositing legibility, §8 proxy beds)
- `docs/line-cinematic-integration-checklist.md` — §0 font-first, and §8 below
