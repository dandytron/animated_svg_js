# `<chart-animator>` — integration contract

**Status:** Draft, v0. **Audience:** the Datawrapper Exporter
(`export.datahub.reuters.com`) and any agent integrating against it.

This is the *interface* only. For why it is shaped this way, see
`docs/frontend-integration.md` and `docs/adr/0010-appearance-ownership-look-and-alpha.md`.

A **stub** implementing this contract ships now (`chart-animator.js`): it accepts
every property, emits every event, and renders a placeholder. Integrate against
it today; the real component drops in later without changing your code.

---

## Mounting

The tool is a **Web Component** — a custom element. No build step, no framework,
no bundler config. One script tag and one tag.

```html
<script src="https://…/chart-animator.js" defer></script>

<chart-animator id="animator"></chart-animator>
```

```js
const el = document.getElementById('animator');
el.svg       = preparedSvgString;   // required
el.chartType = 'd3-lines';          // strongly preferred
el.chartId   = 'lg30Q';             // optional
```

**Set `svg` as a JS property, never an HTML attribute.** A Datawrapper export is
tens to hundreds of kilobytes; attributes are the wrong transport and will be
mangled by escaping. Everything else may be either.

In Svelte, `<chart-animator bind:this={el} />` then assign in `onMount`.

---

## Properties

| Property | Type | Required | Meaning |
|---|---|---|---|
| `svg` | `string` | **yes** | The Prepared SVG (see below). Assigning it (re)initialises the component. |
| `chartType` | `string` | no, but ask | Datawrapper's canonical type — `d3-lines`, `d3-bars-stacked`, `d3-pies`… |
| `chartId` | `string` | no | Datawrapper chart id. Provenance and error messages. |
| `look` | `'white' \| 'black'` | no | Ground the video is being made for. Defaults to the chart's own. |
| `alpha` | `boolean` | no | Leave the ground transparent for downstream compositing. Default `false`. |

### Why `chartType` matters

The component **cannot fetch it**. There is no Datawrapper token in the browser,
and Datawrapper blocks browser calls regardless. Whoever made the API call has
the answer already, so passing it costs you one field and saves us a guess.

With it, an unsupported chart produces a precise refusal — *"This is a pie chart.
The tool can't animate pie charts yet."* Without it, the same chart produces
silence, and the user doesn't learn why.

It is **advisory, never a gate.** Element detection runs regardless; the type is
consulted only to explain a miss. A wrong or absent value costs a worse message,
never a lost capability.

---

## The Prepared SVG

What `svg` must contain.

**Required**

1. A Datawrapper SVG export, as a string.
2. `width` and `height` on the root `<svg>`. Datawrapper omits `viewBox`; the
   tool stamps one (ADR 0004) and needs the pixel dimensions to do it.

**Strongly preferred**

3. Exported with `transparent=true`. If the export is opaque the tool removes the
   full-canvas background rect, but that detection is heuristic — a plate it
   fails to recognise survives into every exported frame.
4. **The chart's own theme.** Do not re-theme on our behalf. Appearance authored
   in Datawrapper is expected to carry through; the tool applies only its own
   Look on top, and only to chart decoration.

**Not your problem**

5. **Fonts.** The tool embeds Knowledge itself, and registers the faces at
   document level so measurement resolves correctly inside a shadow root. Send
   the export as-is; embedding on your side is harmless but redundant.
6. **Sanitisation.** The tool sanitises on ingest regardless of source.

---

## Events

All are `CustomEvent` on the element, and all bubble.

| Event | `detail` | When |
|---|---|---|
| `ready` | `{ animatable, chartType, supported, message }` | Ingest finished and detection ran. |
| `exported` | `{ blob, filename, format }` | An export completed. `format` is one of `svg`, `gif`, `mov`. |
| `cancel` | `{}` | The user chose to go back. **Restore your entry UI.** |
| `error` | `{ code, message }` | Something failed. `message` is user-facing. |

```js
el.addEventListener('ready', e => {
  if (!e.detail.supported) showNotice(e.detail.message);
});

el.addEventListener('exported', e => {
  const { blob, filename } = e.detail;
  const url = URL.createObjectURL(blob);
  // hand to your download flow, then URL.revokeObjectURL(url)
});

el.addEventListener('cancel', () => showEntryBar());
```

### `ready` in detail

- `animatable` — count of elements the tool can animate. **`0` is the miss case.**
- `supported` — whether this chart type is animatable at all.
- `message` — present when `supported` is `false` or `animatable` is `0`. Written
  for a journalist; display it verbatim rather than composing your own.

### `error` codes

| `code` | Meaning |
|---|---|
| `bad-svg` | `svg` was absent, empty, or unparseable. |
| `no-dimensions` | Root `<svg>` had no usable `width`/`height`. |
| `export-failed` | Encoding failed. `message` carries the reason. |

---

## What the component promises

- **It owns its own styles.** Rendered in a shadow root, so your stylesheet
  cannot reach in and its styles cannot leak out. Nothing to namespace.
- **It never re-themes the chart.** Palette, typeface and spacing are the chart
  author's. See ADR 0010.
- **It never recolours data.** A series too dark for the chosen Look produces a
  warning naming the series — never a silent recolour, because series colour is
  editorial.
- **The heavy encoder is lazy.** ffmpeg.wasm (~31MB) is fetched on first video
  export, never at page load. Mounting the component and previewing costs
  nothing beyond the SVG.
- **No credentials.** The component holds no token and makes no Datawrapper call.

## What it needs from you

- Mount it, set `svg`, listen for `cancel` to restore your own UI.
- Pass `chartType` if you have it. You do.
- Decide what happens to `exported` — join your download flow, or let the
  component offer the file itself. **Open question, see below.**

---

## Open, needs a decision

1. **Does the component live in your document, or do we navigate to ours?** The
   contract above assumes yours. A wipe-and-emerge transition implies one
   document; confirm.
2. **`exported` — who owns the download?** If it joins "Download All", the
   component emits and you handle it. If the component offers the file directly,
   the event becomes informational.
3. **Access.** The exporter is public with no edge gate; this tool currently sits
   behind Basic Auth middleware. Mounted in your page, ours retires and yours
   governs.
4. **Aspect ratios.** Your format row is stills-only, so video aspect is ours.
   Which does video need — 16:9 and 9:16, or 1:1 as well?

## Versioning

`chart-animator.js` sets `ChartAnimator.version`. Breaking changes to this
contract bump the major. The stub reports the contract version it implements.
