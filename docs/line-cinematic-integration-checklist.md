# Line-chart cinematic treatment — integration checklist

**Date:** 2026-07-20
**Status (updated 2026-07-24):** **§0–§5 ported** to the tool on branch
`feat/line-cinematic-port` (suite 173/173, both animation systems). **§6 (export
presets) and §7 (9:16 vertical) are still outstanding.** See "Port status" and
"Open questions & follow-ups" at the foot before picking this up again.

A hand-animation pilot (two real Datawrapper line charts: China oil imports,
U.S. SPR) built a full cinematic treatment outside the tool: header bubble-up →
line paint-on → data-driven camera push → hold the fall → paint the fall while
pulling back, with anchored scrolling axes, then ProRes 4444 export at 16:9 and
9:16.

Everything below is **working** in `scratch_folder/` (`pilot_pages.py` and its
modules) and verified live. Each item ties to a real prototype file and, where
relevant, to the existing ADR 0008 roadmap number. The unticked boxes below are
preserved as the **original pilot spec**; what actually shipped is recorded in
"Port status" at the foot.

Cross-cutting rule (ADR 0003): every animation lands in **both** `animate.js`
(SMIL preview) and `export.js` (per-frame attribute writes). Everything here was
verified to survive frame-capture export — the ProRes came out of exactly this.

---

## 0. Do this first — it is the spine, not a detail

- [ ] **Embed the font before anything measures or lays out text.**
  This bit us **three** separate times in one session, all from the same root:
  Datawrapper writes `font-family: Knowledge` but ships no font file.
    1. Headlines rendered clipped (fallback face wider than its own mask).
    2. Chart 01's standalone export silently lost the font when the camera
       opened `<defs>` and `restyle`'s `<defs/>` match stopped firing.
    3. Bubble-up glyph positions were measured in the fallback face — **27%
       wider** (467px vs 367px) — and every letter got pinned to the wrong spot.
  **Rule for the port:** font embedding is step one of the pipeline, before
  layout, measurement, split, or camera. Not a final styling pass.
  Prototype: `pilot_line_charts.py::_font_face_css`, `restyle`.

---

## 1. Line paint-on — two techniques, chosen by detection  · ADR 0008 #1

- [ ] **`trace` (stroke-dashoffset) for a real `<path>` line.**
  `pathLength="1"` + `stroke-dashoffset` 1→0. The `pathLength` normalisation is
  the key trick: dash values become fractions, so **no `getTotalLength()`** —
  which matters because `export.js` works on detached `DOMParser` output with no
  layout. Prototype: `pilot_line_charts.py::draw_on_path`.
- [ ] **`wipe` for a dots-rendered "line".**
  The SPR chart is **not** a path — it's 2,285 `<g id="dot-svg">` circles 0.24px
  apart that only *look* continuous. No stroke to dash → clipPath wipe over
  `#dots-svg` instead (reuses `injectWipeRight` geometry). Prototype:
  `pilot_line_charts.py::wipe_group`.
- [ ] **detect.js must distinguish path-as-line from dots-as-line** and route to
  trace vs wipe. Datawrapper emits both from what a user calls "a line chart."
  This is the one genuinely new detection case.

## 2. Split-timing draw — delay part of a line  · (new; relates to #4)

- [ ] **Two `<animate>` on one `stroke-dashoffset`, different `begin`.** First
  run draws to a split fraction and freezes; second picks up from exactly there
  and finishes. Stays a single stroke, so the join can't seam. Split fraction is
  measured off the polyline's own segment lengths, not hand-set.
  This is what lets the fall wait until the camera is on it.
  Prototype: `pilot_line_charts.py::draw_split`, `split_fraction`.

## 3. Camera moves — the big one  · ADR 0008 #5

- [ ] **Animate a transform on the plot container, NOT the root `viewBox`.**
  Root-viewBox zoom drags the headline and footer along with the data. Moving
  one level down (animated `transform` on `svg-main-svg`, clipped to the plot
  band) leaves all chrome static by construction — nothing outside the plot is
  animated, so nothing needs counter-animating. Prototype: `stage_camera.py`.
- [ ] **The clip goes on a wrapper `<g>`, never on the transformed group.**
  An element's own transform defines the space its `clip-path` resolves in, so a
  clip on the moving group gets dragged by the animation it's meant to contain —
  it sliced the plot at a moving height (the "shredded line" bug). Wrap, then
  animate the inner group.
- [ ] **Frames are derived from the data.** Steepest-sustained-fall detection
  finds the drop; frames look up where the series sits per x-band. No hand-placed
  keyframes — they wouldn't survive a different chart. `stage_camera.build_frames`.
- [ ] **A frame must contain the line it's looking at.** Each frame grows until
  the series in its x-window fits with headroom; this is what stops the push
  going so far the line leaves frame (the SPR fall did exactly that early on).
- [ ] **Pull-back reveal for a tall fall.** Push tight (2.8×) on the summit, then
  open back out *as the fall draws*, the frame growing at the fall's own rate.
  Beats a static close-up, which is stuck at the widest thing the shot ever needs
  (1.3× here). The move borrows the fall's easing so camera and line accelerate
  together. `stage_camera.build_frames` + the CHINA_* keytimes in `pilot_pages.py`.

## 4. Anchored, scrolling axes  · (extends #5)

- [ ] **Labels live outside the transformed group.** They hold their on-screen
  size for free (no counter-scaling), and only their *position* is animated: an
  amount tracks its gridline along the frame's left gutter, a year tracks its
  tick across the axis. `stage_camera.inject`.
- [ ] **"Scrolly" feel = lag + fade-by-overhang.** Labels trail the plot ~0.1s
  and dissolve in proportion to how far they've crossed the frame edge (not a
  simple distance-to-edge, which dims labels that are fully visible). Reads as
  the axis scrolling past rather than the numbers stretching apart.
- [ ] **Gridlines: `vector-effect="non-scaling-stroke"`** so a 1px rule doesn't
  thicken into a bar at zoom. Scope the rule to the plot subtree — the legend's
  colour swatch is also a `<line>` and got stretched across the chart.
- [ ] **Gridline left-gutter margin** so rules start clear of the y-axis numbers,
  matching the source chart.

## 5. Header text-intro (bubble-up)  · ADR 0007 — now built

- [ ] Split each header run into per-**letter** (or per-word) `<text>`, each
  starting 10px low at opacity 0, floating up on a stagger. Stagger auto-sized so
  the whole intro lands under ~1s. Prototype: `bubble.py` (rebuilt from ADR 0007;
  the original SpaceX prototype was never committed and is gone).
- [ ] **Measure glyph positions in the REAL font** (`getStartPositionOfChar` in a
  browser, against an SVG that already has the `@font-face`). See §0 — this is
  the exact trap ADR 0007 warned about and I still fell into.
- [ ] Wrap the split units in a `<g>` carrying the original run's transform, so
  spacing can't drift.
- [ ] **Legend + source fade** (opacity only). Note the legend *label* is bare
  `<text>` siblings outside `legend-color-svg` (which holds only the swatch) —
  wrap swatch + label to fade as one. `bubble.py::fade_legend`.

## 6. Export — ProRes 4444  · ADR 0002

- [ ] Working local exporter: `scratch_folder/export_prores.py` (Playwright frame
  capture → `ffmpeg prores_ks -profile 4444 -pix_fmt yuva444p10le`). This is the
  Python twin of `capture_frames.mjs`; the shipping tool uses ffmpeg.wasm, so
  this is a reference for the frame-timing loop, not a drop-in.
- [ ] **NTSC is the default** (29.97 = `30000/1001`), never PAL. Now recorded;
  ADR 0002 needs the note (below).
- [ ] **Vertical needs its own preset width.** ADR 0002's widths assume a
  landscape chart — `1080p → 1920px` put 1920 on the *long* edge of a 9:16 source
  and produced 1920×3414. Presets should carry the **short-edge** width, or ship
  a separate vertical set. `--width` is the current workaround.
- [ ] **Round durations overshoot in NTSC.** 10s × 29.97 = 299.7 frames → 300 →
  10.010s. Decide the house rule (round up vs down) and surface it, don't
  silently trim.

## 7. 9:16 vertical  · (new)

- [ ] **Re-export from Datawrapper at 9:16; don't reframe the landscape.** A
  native portrait export reflows the axis (2 date ticks vs 9) and fills 76% of
  frame; the scale-and-centre reframe filled ~32% with landscape line breaks. The
  whole pipeline runs unchanged on the portrait source — it just needs its own
  stage band, offsets and tick set. Prototype: `pilot_pages.py` chart `01v`.

---

## Suggested order (smallest blast radius first)

1. **§0 font-first** — reorder the existing pipeline. Cheap, and unblocks the
   rest by removing the recurring failure.
2. **§1 trace + detection** — ADR 0008 already ranks this HIGH; both halves
   prototyped.
3. **§5 bubble-up** — self-contained, ADR 0007 is now proven.
4. **§3 camera + §4 axes** — the substantial piece; do together, they share the
   stage model. Wants ADR 0008 #4 (timeline model) underneath it.
5. **§6/§7 export + vertical** — mostly preset/config work once the above render.

## Files (all in `scratch_folder/`, all gitignored where font-bearing)

| File | What |
|------|------|
| `pilot_pages.py` | builds the whole preview; the sequencing lives here |
| `pilot_line_charts.py` | font embed, restyle, draw/wipe/split |
| `stage_camera.py` | plot-container camera, anchored axes, `to_vertical` |
| `bubble.py` | header bubble-up + legend/source fade (rebuilt from ADR 0007) |
| `extract_ticks.py` | reads tick text + positions from a live DOM |
| `export_prores.py` | frame capture → ProRes 4444 |

Preview (password-gated): https://svg-draft-previews.vercel.app/line-paint-on

---

# Port status (2026-07-24)

Branch `feat/line-cinematic-port`. Suite 173/173. Every animation landed in
**both** systems (ADR 0003). New functions are idempotent by construction (pure,
read-only, or guarded), and the camera lives in its own module driven by a
separate `config.camera` block kept out of the per-element animation switch.

| § | Status | Shipped as |
|---|--------|-----------|
| §0 font-first | ✅ | `fonts.js::embedFonts` — inlines the real `@font-face` as data-URIs at the head of **every build path** (preview / capture / SVG export), not at load, so `state.svg` stays byte-identical |
| §1 trace | ✅ | `animate.js::injectTrace` + export twin (`pathLength="1"`, dashoffset 1→0) |
| §1 dots-as-line | ✅ | `detect.js::_dotsFormLine` (median dot-spacing, **not** a count) → `wipe_right`; `animate.js::_dotsWipeGeometry` for a tight wipe |
| §2 split-draw | ✅ | `camera.js::injectSplitTrace` / `setupSplitTrace` / `applySplitTraceAtTime`, driven from `plan.split` |
| §3 camera | ✅ | `camera.js`: `buildCameraPlan` (pure) → `injectCameraSMIL` + `setupCamera`/`applyCameraAtTime` (export twin, cubic-bezier keySplines interpolation) |
| §4 anchored axes | ✅ | folded into the camera plan/inject (label tracks, overhang fade, non-scaling gridlines, gutter trim) |
| §5 bubble-up | ✅ | `animate.js::measureBubbleUnits` (live-probe glyph measure in the real font) + `_splitBubbleRuns` / `injectBubbleUp` + export twin |
| §6 export presets | ❌ | not started |
| §7 9:16 vertical | ❌ | not started |

Extraction was validated against the real China chart: it reproduces the pilot's
hand-fed geometry almost exactly (stage within 0.4px of `CHINA_STAGE`, plot
offset exact, ticks parsed with the month+year split, drop lands on the real
slump).

---

# Open questions & follow-ups

Carried out of the §0–§5 port. Nothing here blocks the shipped work.

## Deferred by decision

- **Easing is inconsistent across animations.** The camera and split-draw use
  real `keySplines`; **bubble-up is deliberately linear**, and the older
  `wipe_right` / `grow_from_baseline` / `fade_in` / `draw_on` / `trace` are all
  linear. Linear was chosen to keep preview/export parity trivial. The dedicated
  easing pass (spline support in `_animate` + the matching curve in
  `_applyAtTime`) is still the separate task from the earlier save-point — doing
  it should sweep **all** animations at once so the tool reads consistently.
  `camera.js::_bezierEase` / `_sampleTrack` already exist and can be reused.
- **`detectStage` is a first-cut heuristic** (svg-main-svg root bbox + 8px pad,
  full canvas width). Accurate on the pilot charts, but the user's call was
  "build auto-extraction now, **harden later**". Overridable via
  `config.camera.stage`.

## Single-sample risk (the likeliest place to break)

- Camera extraction is validated on **two** chart families only (China line,
  `multi_line_graph`). Wants a third/fourth real Datawrapper line chart —
  especially one with a different axis density or a nested plot transform.
- **`extractDotPoints` is unit-tested but never driven end-to-end through the
  camera.** A dots-rendered line (SPR) should in principle drive the camera the
  same way a path line does; that path is untried.
- `findDrop`'s `window = 60` look-ahead is the pilot's constant, unexamined
  against series much longer or shorter than ~28 points.

## Conflicts / guards not yet enforced

- **`camera.split_draw` and a queued `trace` on the same line both animate that
  path.** Today this is convention-only ("split_draw owns the line's draw"); it
  is not guarded in code. Either detect the collision and drop one, or surface
  it in the UI.
- **Hiding the header is no longer reachable by click.** Per the 2026-07-23 UX
  decision the header is an animatable element, so clicking it queues it for
  bubble-up. The footer is still click-to-hide. If someone wants a chart with no
  header at all, there is currently no affordance — needs a separate control.

## Not exposed in the UI (config-only)

- `bubble_mode: 'letter' | 'word'` — the per-word toggle ADR 0007 asks for is
  implemented and tested but has no control; defaults to per-letter.
- Camera tuning: `tight`, `keytimes`, `splines`, `stage`, `line_id` are all
  honoured by `config.camera` but only `enabled` / `split_draw` / `duration`
  have UI.

## Still open from ADR 0007

Unchanged by this port — per-letter vs per-word default for long subtitles,
which params to expose, RTL direction, and generic title/subtitle detection
inside Datawrapper's header container.

## Repo hygiene / deployment

- **`.gitignore` has an uncommitted font-licensing hardening** (widens the
  ignore rules so pilot outputs carrying inlined Knowledge `.woff` bytes can't
  reach this public repo). Unrelated to the port, but worth committing — without
  it a new hand-animation output under an unmatched name would be tracked.
- **`fonts/` is gitignored and untracked** (licensed face), so `embedFonts`
  fetches at runtime and **gracefully no-ops wherever the fonts aren't present**
  (fresh clone, CI, public deploy) — text falls back rather than breaking. The
  real face only renders where `fonts/` exists on disk.
- ADR 0002 carries uncommitted 2026-07-20 notes covering the §6 findings (NTSC
  default, short-edge vertical widths, round-duration overshoot). Pick those up
  with §6 rather than re-deriving them.
