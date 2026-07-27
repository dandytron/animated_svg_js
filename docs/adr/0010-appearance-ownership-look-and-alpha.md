# ADR 0010 — Appearance ownership: Theme upstream, Look downstream, Alpha orthogonal

**Status:** Proposed
**Date:** 2026-07-27

## Context

The tool is being integrated into the Reuters Datawrapper Exporter
(`export.datahub.reuters.com`, SvelteKit on Vercel). Its stills format row —
1:1, 4:5, 9:16, Newsletter — is stills-only; clicking **Video** surfaces this
tool's own interface. So the exporter hands over a **Prepared SVG** it has
already fetched, and aspect ratio remains ours to own rather than inherited.

That handover forces a question the tool has never had to answer, because until
now it controlled its own ingest: **who owns appearance?**

Today `api/fetch-svg.js` answers it implicitly and wrongly for this future. It
clones the chart, `PATCH`es the theme to a hardcoded
`thomson-reuters-newsletters`, sleeps a hardcoded second for propagation,
exports transparent at a width, then embeds fonts and sanitises. The tool's
current stance is therefore *"whatever the designer chose, re-theme it to
newsletters"* — which discards Datawrapper-side design choices that, in the
integrated flow, are exactly what should carry over.

Two prior findings constrain any answer:

- **ADR 0009 §1**, learned from hand-producing the Brent and jobless deliveries:
  whiten and shadow the chrome only, never the axis ticks, gridlines, series, or
  a coloured value label — *"the source may already be dark — do not assume it
  needs inverting."*
- **The 2026-07-26 correctness sweep** (PRs #20/#22, seven fixes) was almost
  entirely appearance hard-coding: white axis labels, 13px type, a font-load race
  resolving against the fallback face. ADR 0009 names the camera's hard-coded
  white as the same mistake at a different altitude. Any design that lets this
  tool own appearance by default is designing for that bug again.

## Decision

**Theme is authored upstream and never overridden.** A Datawrapper Theme is set
by the chart author when editing the chart. The `PATCH { theme }` and its
propagation sleep come out of `fetch-svg.js` on **both** entry paths, so the
integrated door and the standalone door agree. The tool becomes a consumer of
prepared artifacts, not an author of them.

**Look is the downstream appearance decision, and it is a delta.** Every chart
has a Source Ground (light or dark, inherited from its Theme) and a Destination
Ground (what the video is being made for). A Look is the pairing, named for the
destination: White Look, Black Look. The treatment applied is the *difference*
between the two, so a Black Look over an already-dark chart does almost nothing.
This is the direct application of ADR 0009's warning: absolute values are the
bug, deltas are the fix.

**Source Ground is detected, not declared.** It is determinable from the Prepared
SVG, and every control we don't ask for is a control the user cannot set wrongly.
*(Assumption, not yet ratified — the alternative is an explicit "this chart is
dark" toggle. Overturning this changes one control, not the model.)*

**Alpha is orthogonal to Look, not a third Look.** Look says what ground the
chart is designed for; Alpha says whether that ground is baked into the file or
left for downstream compositing. All four combinations are meaningful, and
Black Look + Alpha is precisely what ADR 0009's fill/key delivery serves. This
also matches the code, where `export.js` already carries `transparent` as a
boolean.

**A Look touches Chart Decoration only, never data.** Series colour is
editorial: a Reuters red may be the same series across a package, or carry
meaning the reader tracks. A tool that recolours data to suit the medium is
rewriting the journalism invisibly, on export, after sign-off. Within
decoration, adopt ADR 0009's three-way split rather than a flat one — chrome is
whitened and shadowed, gridlines are lifted (preferring a drop shadow over pure
brightness, since a light line vanishes on a grey composite), axis ticks are
left alone so a deliberate grey hierarchy survives.

**Illegible data is surfaced, not fixed.** When a series colour fails a contrast
check against the Destination Ground, warn — naming the series and both routes
out ("try the White Look, or change the series colour in Datawrapper") — and let
the user export past it. The tool makes the problem visible without taking an
editorial decision it has no standing to make.

**Video Treatment is opt-in and separate from Look.** The legibility
adjustments a chart needs to survive as video — type scale, gridline weight,
marker size — are the same whichever Ground is chosen, so they exist once and
are shared rather than duplicated per Look. Opt-in, because a chart authored for
video may already satisfy them. Shipping as a single switch; split into granular
controls only when a real case demands it.

## Consequences

- `fetch-svg.js` loses the clone-PATCH-sleep sequence. Ingest gets roughly a
  second faster and one Datawrapper write cheaper per chart.
- **Chart Decoration needs a registry**, the way `config.js::chartRoots` already
  gives data one. Today decoration is defined negatively — whatever wasn't data —
  which is why `front-svg` had to be blocked from hiding for being "too broad",
  and why `camera.js` reaches for `y-tick-labels-svg` / `x-tick-labels-svg` by
  name independently of the hide feature. One registry serves Looks, the camera,
  and hiding.
- **Background becomes a first-class property of the Animation Config.** Today it
  is only a preview CSS class (`app.js::setPreviewBg` → `.bg-white` /
  `.bg-black` / `.bg-checkerboard`) plus an export boolean; nothing in the render
  pipeline reads it. The preview switcher currently mixes both axes — checkerboard
  is Alpha, white/black are Look — and must be split to match.
- **Issue #21 (camera axis-label reparent) lands first.** The camera currently
  *rebuilds* axis labels (`_cel('text')` + `_styleLabel`, four sites across both
  systems), so the obvious home for Look's decoration colour is `_styleLabel` —
  which #21 deletes. Beyond the rework, a rebuilt label is inherently
  absolute-value authoring: something must decide what colour to write, which is
  how the camera got hard-coded white. Reparenting preserves source appearance by
  construction, which is what the delta model above requires. After the reparent,
  a Look modifies existing nodes rather than authoring new ones — including where
  `fill` sits on a `<tspan>` rather than the `<text>`.
- Per ADR 0003, Look and Video Treatment must land in **both** animation systems.
  Two of the seven fixes on 2026-07-26 were preview-right/export-wrong, passing
  their tests by measuring static setup instead of driving `applyCameraAtTime`.
  Appearance work is exactly the class of change that split hides.
- Contrast checking needs a stated threshold and a measurement space. Not fixed
  here; naive sRGB distance will misjudge, and the threshold should be defended
  rather than guessed.
- **Fonts are present in the Reuters deployment** (Knowledge). The runtime
  graceful-no-op in `fonts.js` becomes a safety net rather than the normal path —
  which raises, not lowers, the importance of the `ensureFontsLoaded` fix in
  `1c3b1b3`: the font-load race is latent while fonts are absent and armed the
  moment they ship.

## Alternatives considered

- **A tool-applied `thomson-reuters-video` theme.** Better aimed than the
  newsletter override, but a Datawrapper theme is wholesale, not additive, so it
  still discards the author's choices — the same override with better taste. It
  also cannot carry background, which varies per output, without multiplying into
  `video-white` / `video-black` / `video-transparent`.
- **A three-way White / Black / Transparent list.** Rejected because it conflates
  two independent axes. The transparent entry then has no way to derive label
  colour, since there is no ground to contrast against — a hole that simply does
  not exist once Alpha is a toggle.
- **Letting a Look recolour data**, with or without per-series overrides. Solves
  legibility, but makes the tool an editorial actor.

## Related

- ADR 0002 — export delivery spec (formats, presets, NTSC default)
- ADR 0003 — two animation systems (the both-halves invariant)
- ADR 0009 — transparent-export compositing; chrome-only rule; fill/key delivery
- `~/workspace/animated_svg/CONTEXT.md` — Theme, Ground, Look, Alpha,
  Video Treatment, Prepared SVG, Animation Preset
