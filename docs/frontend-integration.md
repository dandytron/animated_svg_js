# Frontend overhaul + Reuters Exporter integration

**From the 2026-07-27 `/grill-with-docs` session.** Companion to
`docs/adr/0010-appearance-ownership-look-and-alpha.md`, which records the
appearance model in full. This document is the working plan: what was decided,
what to build in what order, what's parked, and what needs Ben.

---

## The target

**Reuters Datawrapper Exporter** — `https://export.datahub.reuters.com/`,
Ben Welsh (News Applications), SvelteKit on Vercel, publicly reachable.

Flow today: paste a Datawrapper chart ID or a `reuters.com/graphics/…` URL →
"Try a sample" → format row (1:1 / 4:5 / 9:16 / Newsletter / Video) → Download.

**The format row is stills-only.** 9:16 there is a still, not a promise this
tool has to honour — aspect ratio for video is ours to own. Clicking **Video**
(better named **Animation** — its siblings are formats, this is a mode) surfaces
this tool.

## The intended flow

1. User picks the Animation tab and enters a chart URL.
2. The tab renders a **first-pass preview** — auto-detected elements animating,
   showing *what can be animated*. Framed as a first pass, not a deliverable.
3. An **"Edit animation"** button wipes the entry bar away and brings up the
   editor.
4. A back arrow returns to the entry bar for a different chart.

Two consequences of framing step 2 as a preview rather than an output:

- A detection miss becomes a visible, understandable outcome — nothing moves,
  and the user learns the tool can't help *before* investing effort.
- The preview is SMIL injection only. No frame capture, no ffmpeg.wasm. The
  31MB WASM module loads only for someone who clicks through and exports, so
  casual browsing costs Ben's page almost nothing.

## Decisions settled

**Appearance** — see ADR 0010. In brief: Datawrapper **Theme** is authored
upstream and never overridden (the `PATCH { theme }` and its 1s propagation
sleep come out of `fetch-svg.js` on both paths); **Look** (White/Black) is a
downstream *delta* between Source Ground and Destination Ground; **Alpha** is an
orthogonal toggle, not a third Look; **Video Treatment** is opt-in legibility
adjustments shared across Looks; a Look touches Chart Decoration only, never
data, with a contrast **warning** rather than a silent fix.

**Packaging — Web Component.** The tool becomes a custom element Ben's app drops
in. Preserves the no-build architecture, keeps the export pipeline in the repo
that understands it, gives Ben a one-line integration. Reversible: to an iframe,
to a plain mountable bundle, or back to standalone, all cheaply. The one
expensive direction (a full Svelte port) is no worse from here than from
anywhere else.

**Shadow DOM — yes, but sequenced.** Styles should be separate from Ben's. The
real threat is his *global* stylesheet (resets, base typography) — Svelte already
scopes component styles, and class-prefixing wouldn't stop element selectors
anyway. Take the shadow boundary as its own step, after the frontend works, with
font behaviour tested on a real chart.

**Chart-type detection — three-tier, advisory.** Ask Datawrapper for the
canonical type (`d3-lines`, `d3-bars-stacked`, `d3-pies`, …), fall back to
autodetect, offer a manual override (already in the backlog from 2026-07-15,
ADR-0006 "Future work"). **The type map never gates detection** — run detection
regardless, consult the type *only* when detection finds nothing, to explain
why. A wrong map entry then costs a slightly-off message instead of a silently
lost capability.

**Unsupported types get a named, useful refusal.** Human name, not the API id,
and say what the tool *can* do: *"This is a pie chart. The tool can't animate pie
charts yet — it currently handles line, bar, column, area and scatter charts."*

**Two animation systems stay.** ADR 0003's constraint is narrower than it reads
— `XMLSerializer` can't capture SMIL state, so *export* can't use SMIL; nothing
forbids preview using the export mechanism. Unification is therefore available
but not taken now: it trades native GPU playback for a JS loop, during a
frontend overhaul. Instead, **the preview↔export parity test becomes mandatory**
for any new control affecting rendering. The suite already does this in pairs
(`test_unit_trace_preview`/`_export`, `bubble_up`, `wipe`, `camera`); this makes
it the rule.

**Terminology** — `~/workspace/animated_svg/CONTEXT.md` updated. **Preset** →
**Animation Preset** (the bare word kept reaching for the appearance slot).
New: **Prepared SVG**, **Ground**, **Look**, **Alpha**, **Video Treatment**.
**CORS Proxy** → **Ingest**, named for what it produces rather than the
constraint that forces it server-side.

## Build order

**1. Issue #21 first — the camera axis-label reparent.** Recorded on the issue
and in ADR 0010. The camera currently *rebuilds* labels (`_cel('text')` +
`_styleLabel`, four sites across both systems), so Look's decoration colour would
land in `_styleLabel` — which #21 deletes. Beyond the rework, a rebuilt label is
inherently absolute-value authoring, which is how the camera got hard-coded
white. Reparenting preserves source appearance by construction, which is what
ADR 0010's delta model needs. Non-trivial: five documented silent-failure modes
and a demand for realistic fixtures.

**2. Rewrite `app.js` root-relative and mountable.** All 49 `document.getElementById`
calls go through a single root reference:

```js
const root = this.shadowRoot || document;
root.getElementById('camera-toggle');
```

Free while rewriting, expensive to retrofit. It is what makes the shadow
boundary a one-line switch *and* what makes the test harness page possible. The
engine modules are already clean — `animate.js`, `camera.js`, `export.js`,
`detect.js`, `fonts.js` have **zero** `getElementById`/`querySelector` calls
between them, so all UI coupling is in one file.

**3. Test harness page.** A near-empty HTML file that mounts the component and
hands it a Prepared SVG; point the suite at it instead of `index.html`. Of 46
test functions, 24 are `test_unit_*` calling functions directly and need only
*a* page with the modules loaded — they migrate unchanged. Only ~6 drive the UI,
and those are in scope for the overhaul anyway. Much smaller than "187 tests".

**4. Then the appearance work** — Look, Alpha, Video Treatment, contrast warning,
aspect control.

**Sweep during the overhaul, don't port:**
- Export menu lists **PAL 25fps first**, contradicting ADR 0002's NTSC default.
- **No affordance to hide the header** — it's click-to-queue now.
- `camera.split_draw` + a queued `trace` on the same line both animate it;
  unguarded, convention-only. The checklist asks for it to be surfaced in the UI.
- Config-only parameters with no controls: `bubble_mode` letter/word, and the
  camera's `tight`, `keytimes`, `splines`, `stage`, `line_id`. Decide which
  become real controls.
- **Issue #17** — 4K export has no time estimate or upfront warning. Embedded in
  Ben's page this needs progress and an abort, plus defined behaviour if the user
  navigates away mid-encode.
- **Issue #16** — smoke-test checklist, likely stale at 187 tests; triage or close.

## Questions for Ben

1. **Is the wipe literally your page transforming?** It decides embedded vs
   navigate, and half the reasoning above depends on it. A wipe and an emerge are
   animations, which implies one document — but confirm.
2. **Does the handoff carry the chart ID alongside the Prepared SVG?** Cheap to
   include and it preserves the authoritative chart type (and anything else we
   need from the API later). Without it, the type tier is gone.
3. **What happens to the finished file?** Does the video join "Download All", or
   download separately from our surface?
4. **Access.** The exporter answers publicly with no edge gate; this tool sits
   behind Basic Auth middleware. Whichever surfacing model wins, one has to change
   — embedded, ours retires entirely.

## Parked

- **SVG upload.** Deferred, but flagged as likely-important later. It breaks the
  Prepared SVG contract (no guarantee of transparency, fonts, width) *and* the
  sanitiser's threat model — its own comment says *"Source is Datawrapper's own
  export, so this is defence in depth, not a hostile-input parser."* Upload
  inverts that. Needs its own decision, not inheritance from the Datawrapper path.
- **State persistence.** YAGNI for now. Today a half-built Animation Config is
  lost silently on back-arrow or refresh. Revisit once the editor's shape settles;
  it raises questions (lifetime, stale config against a re-fetched SVG) not worth
  answering yet.
- **Download from the Animation tab.** Assumed for now to be "Edit animation"
  only, keeping the export pipeline entirely behind the wipe. The alternative is
  offering animated SVG there, since it's nearly free.
- **Video Treatment granularity.** Ships as one switch. Split only when a real
  case demands 90% of it.
- **Unifying the two animation systems.** Available, not taken. Revisit if the
  doubling genuinely hurts.

## Open, not blocking

- **Source Ground: detect or declare.** ADR 0010 assumes detect and says so.
  Flipping it changes one control, not the model.
- **Contrast threshold and colour space.** Deliberately unfixed — naive sRGB
  distance will misjudge this and it deserves a defended number.
- **Which aspects video actually needs** — 16:9 and 9:16, or 1:1 too? §7 was
  never started.
- **Verify the Charts API returns `type`** — **BLOCKED**, needs the token. Vercel
  redacts sensitive variables on `vercel env pull` (the value comes back empty),
  so this can't be checked from the repo alone. See "Spike B" below.

## Spike results (2026-07-27)

### Spike A — fonts do **not** survive a shadow root. Fix identified. ❌→✅

Measured with the real API (`getComputedTextLength` / `getStartPositionOfChar`)
on `Knowledge 300 @ 21px`, each scenario in its **own browser context**:

| scenario | measured width | `document.fonts` |
|---|---|---|
| light DOM, fonts embedded (reference) | **251.000** | `Knowledge 300/700 loaded` |
| shadow root, fonts embedded | **303.000** | *(empty)* |
| light DOM, no font (control) | **303.000** | *(empty)* |

The shadow-rooted case measures **identically to the fallback control** — 20.7%
wide, the §0 signature. `<style data-embedded-fonts>` is present in the SVG but
completely inert: the document's font set stays empty, so `ensureFontsLoaded`'s
`document.fonts.load()` has no face to load and `ready` resolves against the
fallback.

**Isolation was the whole test.** A first version ran all three scenarios in one
page and reported a false PASS — the light-DOM case had already registered
Knowledge in `document.fonts`, and the shadow case measured against *that*.

**The fix, verified:** keep embedding into the SVG (export rasterises it
standalone and still needs the bytes inline), and *additionally* register the
same bytes at document level:

```js
const face = new FontFace('Knowledge', await resp.arrayBuffer(), { weight: '300' });
await face.load();
document.fonts.add(face);
```

Shadow-rooted measurement then returns **251.000** — identical to the reference.

**Consequences:** `fonts.js` grows a document-level registration step alongside
`embedFonts`; the two paths serve different masters (inline = export portability,
`document.fonts` = live measurement and rendering) and both are required. This
also means the shadow-DOM decision is *safe to keep* — it just isn't free.

Still unverified: the six `document.body` references in the engine modules are
likely measurement hosts. Measuring against `document.body` while rendering
inside a shadow root can resolve different computed styles. With the fix above
the *font* resolves either way, but inherited size/weight may not — worth a
follow-up probe when the component is real.

### Spike B — answered from the docs: the API **does** return `type` ✅

Datawrapper's documentation shows `type` as a top-level field on the chart
object — their create-chart example response carries
`"title": …, "theme": "datawrapper", "type": "d3-bars-stacked"`, and the
reference describes `GET /v3/charts/{id}` returning values like
`d3-scatter-plot`. Three-tier detection stands.

**Documented, not verified against our account** (no token — see below). And
`fetch-svg.js` currently reads only `.id` from the **copy** response; whether
that response also carries `type`, or whether the standalone path needs a
separate `GET`, is a five-minute check at implementation time.

*Dead end worth recording:* chart `lg30Q` is public and its dwcdn embed returns
200, but the page contains only Datawrapper's full **type registry** — every
`d3-*` identifier the runtime knows — not that chart's own type. Grepping it for
chart-type strings looks like a positive result and isn't one.

### Token handling — not ours in either path

**The component never handles a token in either path.** Integrated: Ben's
exporter holds its own, makes the call, hands over a Prepared SVG. Standalone:
`api/fetch-svg.js` runs server-side with the token in `process.env` and the
browser never sees it.

So **the chart type must arrive as data** — the component can't fetch it (no
browser token, and Datawrapper blocks browser calls regardless). That upgrades
Ben question #2 from "send the chart ID" to "**send the chart type**": he has
already made the call, so it costs him a field rather than us a round trip.

This dissolves the spike as a gate. Ben's path is unaffected by whatever the API
returns to us; only our standalone path cares, and we own that code — read the
copy response when implementing Phase 4 and surface what's there. If the field
is absent, standalone needs a second call or falls back to autodetect.

`DATAWRAPPER_ACCESS_TOKEN` exists in Vercel (Production) but pulls back **empty**
— Vercel redacts sensitive values after creation. To check it directly, with a
token in the environment:

```bash
curl -s -H "Authorization: Bearer $DATAWRAPPER_ACCESS_TOKEN" \
  https://api.datawrapper.de/v3/charts/28iGD | python3 -m json.tool | grep -i '"type"'
```

Chart IDs harvested from the committed fixtures: `28iGD`, `bOOMw`, `HB6p6`,
`lg30Q`, `pe8Ur`, `v0iRD`. If `type` is absent, the three-tier detection collapses
to two and the manual override matters more.
