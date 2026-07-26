#!/usr/bin/env python3
"""Hand-pilot 'paint on' reveals for two Datawrapper line charts.

Chart 1 (China oil) is a real <path> line   -> stroke-dashoffset draw.
Chart 2 (SPR)       is 2285 positioned dots -> clipPath wipe over #dots-svg.

The two charts look the same to a reader but have nothing in common in the DOM,
so they need different techniques. That split is the finding this pilot exists
to prove; see the notes at the bottom of the generated preview.

Writes EDITED_* copies next to the sources plus a self-contained preview page
(both SVGs inlined so it opens over file:// without a server).
"""

import base64
import re
from pathlib import Path

HERE = Path(__file__).parent
FONTS = HERE.parent / "fonts"

CHART1_SRC = HERE / "MzYt3-china-s-oil-imports-slump-amid-iran-war-.svg"
CHART2_SRC = HERE / "EmOh7-u.s.-strategic-petroleum-reserve-falls-to-lowest-level-since-1983-copy-.svg"

CHART1_OUT = HERE / "EDITED_chart1_china_oil.svg"
CHART2_OUT = HERE / "EDITED_chart2_spr.svg"
PREVIEW_OUT = HERE / "pilot_preview.html"      # standalone, opens over file://
ARTIFACT_OUT = HERE / "pilot_artifact.html"    # body-only, for publishing

DUR = "2s"
BEGIN = "0s"
# easeOutCubic. Fast off the mark, settles into the final value — reads as
# "drawn with intent" rather than the linear v1 wipe.
SPLINE = "0.33 1 0.68 1"

# Wipe extents for chart 2, in #dots-svg's local space (it has no transform, so
# this is the same space the dot translates live in). Dots span x 55.67->612.33.
WIPE_X = 52
WIPE_W = 565
WIPE_H = 320


# Datawrapper writes `font-family: Knowledge` but ships no font, so anything
# outside the newsroom renders in a fallback face. Only 300 and 700 appear in
# these two exports; embedding just those keeps the payload down.
FONT_WEIGHTS = {300: "Knowledge2017-Light.woff", 700: "Knowledge2017-Bold.woff"}

# Matches the hand-animated stacked chart: white text lifted off the footage
# with a soft dark shadow.
TEXT_SHADOW = (
    '<filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">'
    '<feDropShadow dx="1" dy="1" stdDeviation="1.5" '
    'flood-color="rgb(0,0,0)" flood-opacity="0.7"/></filter>'
)


def _font_face_css():
    """@font-face rules with the .woff bytes inlined as data URIs.

    The font has to travel inside the file: export.js rasterises the SVG on its
    own, and a relative url(../fonts/...) would silently fall back there and in
    any preview opened over file://.
    """
    rules = []
    for weight, filename in sorted(FONT_WEIGHTS.items()):
        b64 = base64.b64encode((FONTS / filename).read_bytes()).decode("ascii")
        rules.append(
            "@font-face{font-family:'Knowledge';font-style:normal;"
            f"font-weight:{weight};"
            f"src:url(data:font/woff;base64,{b64}) format('woff');}}"
        )
    return "".join(rules)


def _eased(attr, frm, to):
    """A spline-eased SMIL <animate>, as an attribute-ordered string."""
    return (
        f'<animate attributeName="{attr}" from="{frm}" to="{to}" '
        f'dur="{DUR}" begin="{BEGIN}" fill="freeze" '
        f'calcMode="spline" keyTimes="0;1" keySplines="{SPLINE}"/>'
    )


def draw_on_path(svg, path_id):
    """stroke-dashoffset draw on a single stroked <path>.

    pathLength="1" renormalises the path's length to 1 user unit, so the dash
    numbers are fractions and we never have to measure the real geometry. That
    matters for the eventual tool: getTotalLength() needs a live layout, and
    export.js works on detached DOMParser output where there isn't one.

    dasharray "1 1" = one full-length dash followed by one full-length gap;
    dashoffset 1 parks the gap over the whole line, and animating it to 0 slides
    the dash in from the left.
    """
    tag = re.search(r'<path\b[^>]*\bid="%s"[^>]*/>' % re.escape(path_id), svg)
    if not tag:
        raise SystemExit(f"chart 1: no <path id={path_id!r}> found")
    old = tag.group(0)
    new = old[:-2].rstrip() + (
        ' pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">'
        + _eased("stroke-dashoffset", 1, 0)
        + "</path>"
    )
    return svg.replace(old, new, 1)


def split_fraction(points, i):
    """Fraction of the polyline's length that lies before point i.

    The path is all straight L segments, so summing segment lengths is exact —
    no need to measure the rendered geometry, which keeps this working on
    detached DOM the same way pathLength="1" does.
    """
    seg = [((points[k + 1][0] - points[k][0]) ** 2
            + (points[k + 1][1] - points[k][1]) ** 2) ** 0.5
           for k in range(len(points) - 1)]
    total = sum(seg)
    return sum(seg[:i]) / total if total else 0.0


def draw_split(svg, path_id, frac, body, tail):
    """Draw the line in two stages, with a pause between them.

    One stroke-dashoffset run stops partway and freezes; a second picks up from
    exactly where it stopped and finishes the line. Two <animate> elements on the
    same attribute with different begin times — the later one takes over, and
    fill="freeze" holds the line in place in between.

    Splitting the timing rather than the path keeps this a single stroke, so the
    join is literally the same line continuing and cannot show a seam.

    body / tail are (begin, dur, spline) triples.
    """
    tag = re.search(r'<path\b[^>]*\bid="%s"[^>]*/>' % re.escape(path_id), svg)
    if not tag:
        raise SystemExit(f"no <path id={path_id!r}> found")
    hold = round(1 - frac, 5)

    def run(frm, to, spec):
        begin, dur, spline = spec
        return (f'<animate attributeName="stroke-dashoffset" from="{frm}" to="{to}" '
                f'dur="{dur}s" begin="{begin}s" fill="freeze" calcMode="spline" '
                f'keyTimes="0;1" keySplines="{spline}"/>')

    old = tag.group(0)
    new = old[:-2].rstrip() + (
        ' pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">'
        + run(1, hold, body)      # up to the dive, then hold
        + run(hold, 0, tail)      # the dive itself, after the camera settles
        + "</path>"
    )
    return svg.replace(old, new, 1)


def wipe_group(svg, group_id, clip_id):
    """Left-to-right clipPath wipe over a whole group.

    Same shape as injectWipeRight in animate.js: a zero-width <rect> that grows.
    The clipPath is nested as the group's first child, which is the pattern
    Datawrapper itself uses for its rect-mask clips.
    """
    anchor = f'<g id="{group_id}">'
    if anchor not in svg:
        raise SystemExit(f"chart 2: no <g id={group_id!r}> found")
    clip = (
        f'<clipPath id="{clip_id}">'
        f'<rect x="{WIPE_X}" y="0" width="0" height="{WIPE_H}">'
        + _eased("width", 0, WIPE_W)
        + "</rect></clipPath>"
    )
    return svg.replace(
        anchor, f'<g id="{group_id}" clip-path="url(#{clip_id})">{clip}', 1
    )


def restyle(svg, background):
    """Embed the Knowledge font, whiten the type, and set the backdrop.

    background="black"       -> opaque black plate, for judging the preview
    background="transparent" -> drop the plate entirely, for compositing on export

    White type + drop shadow is permanent either way: it is how the finished
    graphic sits over footage, so the preview should show the real treatment
    rather than dark-on-white that never ships.
    """
    # <defs/> is self-closing in the Datawrapper output — but by the time this
    # runs the camera may already have opened it up to add a clip, so handle
    # both. Missing this is silent: the page still looks right because a sibling
    # chart's @font-face covers the whole document, and only the standalone
    # export comes out in a fallback face.
    payload = f"<style>{_font_face_css()}</style>{TEXT_SHADOW}"
    if "<defs/>" in svg:
        svg = svg.replace("<defs/>", f"<defs>{payload}</defs>", 1)
    elif "<defs>" in svg:
        svg = svg.replace("<defs>", f"<defs>{payload}", 1)
    else:
        raise SystemExit("restyle: no <defs> to put the font in")

    # The full-canvas white rect Datawrapper paints behind everything.
    plate = re.search(r'<rect width="\d+" height="\d+" transform="translate\(0, 0\)"[^>]*/>', svg)
    if not plate:
        raise SystemExit("backdrop rect not found")
    if background == "transparent":
        svg = svg.replace(plate.group(0), "", 1)
    else:
        svg = svg.replace(
            plate.group(0),
            plate.group(0)
            .replace('fill="rgb(255, 255, 255)"', 'fill="rgb(0,0,0)"')
            .replace("fill: rgb(255, 255, 255)", "fill: rgb(0,0,0)"),
            1,
        )

    # Every label is a <tspan> carrying its own grey fill; none of the data
    # marks are, so this cannot touch the line or the dots.
    svg = re.sub(
        r'(<tspan[^>]*?)fill="rgb\([\d,\s]+\)"',
        r'\1fill="rgb(255,255,255)"',
        svg,
    )
    return svg.replace("<text ", '<text filter="url(#textShadow)" ')


def scope_ids(svg, prefix):
    """Namespace every id/url(#...) so two inlined SVGs can't collide.

    Both files are Datawrapper exports and share ids like 'group-svg'. Inlining
    them into one document would otherwise let chart 2's clip resolve against
    chart 1's definition.
    """
    svg = re.sub(r'\bid="([^"]+)"', lambda m: f'id="{prefix}{m.group(1)}"', svg)
    return re.sub(r'url\(#([^)]+)\)', lambda m: f'url(#{prefix}{m.group(1)})', svg)


def main():
    c1 = draw_on_path(CHART1_SRC.read_text(), "China's oil imports")
    c2 = wipe_group(CHART2_SRC.read_text(), "dots-svg", "pilot-dots-wipe")

    # Shipped files composite over footage, so they carry no backdrop at all.
    CHART1_OUT.write_text(restyle(c1, "transparent"))
    CHART2_OUT.write_text(restyle(c2, "transparent"))

    # The preview plates them on black so the white type is legible on screen.
    body = (
        BODY.replace("__CHART1__", scope_ids(restyle(c1, "black"), "c1-"))
        .replace("__CHART2__", scope_ids(restyle(c2, "black"), "c2-"))
    )
    ARTIFACT_OUT.write_text(body)
    PREVIEW_OUT.write_text(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        "<title>Line chart paint-on — pilot</title>\n</head>\n<body>\n"
        + body
        + "\n</body>\n</html>\n"
    )

    for p in (CHART1_OUT, CHART2_OUT, PREVIEW_OUT, ARTIFACT_OUT):
        print(f"wrote {p.name}  ({p.stat().st_size:,} bytes)")


BODY = """<title>Line chart paint-on — pilot</title>
<style>
  /* Cool graphite ground biased toward chart 2's navy; the chart sheets stay
     white in both themes because the Datawrapper exports bake in a white
     background rect. Reads as paper on a workbench. */
  :root {
    --ground:  #e8ebef;
    --surface: #ffffff;
    --sheet:   #ffffff;
    --line:    #ccd2da;
    --line-soft: #dfe4ea;
    --ink:     #171a1f;
    --ink-mid: #5a626d;
    --ink-dim: #8b929c;
    --navy:    #0a4286;
    --rust:    #e6550d;
    --shadow:  0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06);

    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:  #14171c;
      --surface: #1c2027;
      --line:    #2c323b;
      --line-soft: #242932;
      --ink:     #e3e8ef;
      --ink-mid: #9aa3af;
      --ink-dim: #6b7480;
      --navy:    #7aa7e0;
      --rust:    #ff8340;
      --shadow:  0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --ground:  #14171c;
    --surface: #1c2027;
    --line:    #2c323b;
    --line-soft: #242932;
    --ink:     #e3e8ef;
    --ink-mid: #9aa3af;
    --ink-dim: #6b7480;
    --navy:    #7aa7e0;
    --rust:    #ff8340;
    --shadow:  0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    color-scheme: dark;
  }
  :root[data-theme="light"] {
    --ground:  #e8ebef;
    --surface: #ffffff;
    --line:    #ccd2da;
    --line-soft: #dfe4ea;
    --ink:     #171a1f;
    --ink-mid: #5a626d;
    --ink-dim: #8b929c;
    --navy:    #0a4286;
    --rust:    #e6550d;
    --shadow:  0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06);
    color-scheme: light;
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 15px/1.6 var(--sans);
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 940px;
    margin: 0 auto;
    padding: 40px 24px 72px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  /* ── masthead ───────────────────────────────────────────────────── */
  .masthead { display: flex; flex-direction: column; gap: 6px; }
  .eyebrow {
    font: 500 11px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }
  h1 {
    font-size: 27px;
    font-weight: 620;
    letter-spacing: -.02em;
    margin: 0;
    text-wrap: balance;
  }
  .standfirst {
    margin: 0;
    max-width: 62ch;
    color: var(--ink-mid);
  }

  /* ── transport ──────────────────────────────────────────────────── */
  .transport {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 16px;
    box-shadow: var(--shadow);
  }
  button {
    font: 500 14px/1 var(--sans);
    background: var(--ink); color: var(--ground);
    border: 0; border-radius: 7px;
    padding: 10px 18px; cursor: pointer;
    transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  button:focus-visible { outline: 2px solid var(--navy); outline-offset: 2px; }
  .scrub { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 240px; }
  .scrub label {
    font: 500 11px/1 var(--mono);
    letter-spacing: .08em; text-transform: uppercase;
    color: var(--ink-dim);
  }
  input[type=range] { flex: 1; accent-color: var(--navy); min-width: 120px; }
  input[type=range]:focus-visible { outline: 2px solid var(--navy); outline-offset: 3px; }
  .clock {
    font: 500 13px/1 var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--ink-mid);
    min-width: 4.5ch; text-align: right;
  }

  /* ── chart sheets ───────────────────────────────────────────────── */
  .sheet {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .sheet-hd {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 18px;
    border-bottom: 1px solid var(--line-soft);
  }
  .sheet-hd h2 {
    font-size: 15px; font-weight: 600; margin: 0;
    letter-spacing: -.01em;
  }
  .idx {
    font: 600 11px/1 var(--mono);
    color: var(--ink-dim);
    letter-spacing: .06em;
  }
  .technique {
    margin-left: auto;
    font: 500 11px/1 var(--mono);
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 5px 10px;
  }
  .technique.draw { color: var(--rust); }
  .technique.wipe { color: var(--navy); }
  /* Black plate in both themes. The shipped SVGs are transparent; the preview
     copies carry a black backdrop rect, and this matches the surround to it so
     the sheet edge doesn't cut across the graphic. */
  .stage { background: #000; padding: 0; overflow-x: auto; }
  .stage svg { display: block; margin: 0 auto; }

  /* ── findings ───────────────────────────────────────────────────── */
  .findings {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 22px 24px;
    display: flex; flex-direction: column; gap: 18px;
  }
  .findings h3 {
    font: 500 11px/1 var(--mono);
    letter-spacing: .1em; text-transform: uppercase;
    color: var(--ink-dim);
    margin: 0;
  }
  .finding { display: flex; flex-direction: column; gap: 4px; }
  .finding b { font-weight: 600; }
  .finding p { margin: 0; color: var(--ink-mid); max-width: 68ch; }
  code {
    font: 12.5px var(--mono);
    background: var(--line-soft);
    padding: 1.5px 5px; border-radius: 4px;
    color: var(--ink);
  }
  .compare {
    width: 100%; border-collapse: collapse;
    font-size: 14px;
  }
  .compare th, .compare td {
    text-align: left; padding: 9px 12px 9px 0;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: top;
  }
  .compare th {
    font: 500 11px/1.4 var(--mono);
    letter-spacing: .06em; text-transform: uppercase;
    color: var(--ink-dim);
  }
  .compare td:first-child { color: var(--ink-mid); white-space: nowrap; }
  .compare tr:last-child th, .compare tr:last-child td { border-bottom: 0; }
  .num { font-variant-numeric: tabular-nums; }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style>

<div class="page">

  <header class="masthead">
    <span class="eyebrow">Pilot · hand-edited SMIL</span>
    <h1>Line chart paint-on</h1>
    <p class="standfirst">
      Two Datawrapper line charts, each revealed left&#8594;right over 2s with an
      easeOutCubic curve. They need different techniques — scrub the timeline to
      see why.
    </p>
  </header>

  <div class="transport">
    <button id="play" type="button">Replay both</button>
    <div class="scrub">
      <label for="t">Time</label>
      <input id="t" type="range" min="0" max="2.4" step="0.01" value="0">
      <span class="clock" id="clock">0.00s</span>
    </div>
  </div>

  <section class="sheet">
    <div class="sheet-hd">
      <span class="idx">01</span>
      <h2>China oil imports</h2>
      <span class="technique draw">stroke-dashoffset draw</span>
    </div>
    <div class="stage">__CHART1__</div>
  </section>

  <section class="sheet">
    <div class="sheet-hd">
      <span class="idx">02</span>
      <h2>U.S. strategic petroleum reserve</h2>
      <span class="technique wipe">clipPath wipe</span>
    </div>
    <div class="stage">__CHART2__</div>
  </section>

  <section class="findings">
    <h3>What the pilot found</h3>

    <div class="finding">
      <b>These are not the same chart type underneath.</b>
      <p>Both read as a line to a viewer, but they share no structure. Chart 1 is
      one stroked <code>&lt;path&gt;</code> with ~120 points. Chart 2 has no line
      at all — it is 2,285 <code>&lt;g id="dot-svg"&gt;</code> circles spaced
      0.24px apart, close enough to look continuous.</p>
    </div>

    <div class="finding">
      <b>So one technique cannot cover both.</b>
      <p>A draw needs a stroke to dash, which chart 2 does not have. A wipe works
      on anything but cannot trace the data's own shape.</p>
    </div>

    <table class="compare">
      <tr>
        <th></th>
        <th>01 · China</th>
        <th>02 · SPR</th>
      </tr>
      <tr>
        <td>Geometry</td>
        <td>1 <code>&lt;path&gt;</code></td>
        <td class="num">2,285 dot groups</td>
      </tr>
      <tr>
        <td>Technique</td>
        <td>stroke-dashoffset&nbsp;1&#8594;0</td>
        <td>clip rect width&nbsp;0&#8594;565</td>
      </tr>
      <tr>
        <td>Leading edge</td>
        <td>traces the line</td>
        <td>straight vertical</td>
      </tr>
      <tr>
        <td>Also reveals</td>
        <td>the line only</td>
        <td>everything in the group</td>
      </tr>
      <tr>
        <td>Source size</td>
        <td class="num">11 KB</td>
        <td class="num">366 KB</td>
      </tr>
      <tr>
        <td>With font embedded</td>
        <td class="num">142 KB</td>
        <td class="num">497 KB</td>
      </tr>
    </table>

    <div class="finding">
      <b>Measuring path length is avoidable.</b>
      <p>Chart 1 sets <code>pathLength="1"</code>, so the dash values are
      fractions and nothing has to call <code>getTotalLength()</code>. That
      matters for the tool: <code>export.js</code> works on detached
      <code>DOMParser</code> output, where there is no layout to measure against.</p>
    </div>

    <div class="finding">
      <b>The clipped headlines were the missing font, not the export.</b>
      <p>Earlier these were cut off mid-word on the right. Datawrapper writes
      <code>font-family: Knowledge</code> but ships no font file, so the text
      rendered in a wider fallback and overflowed its own
      <code>rect-mask</code>. Embedding the real face fixed the overflow — no
      layout change needed.</p>
    </div>

    <div class="finding">
      <b>Backdrop differs by destination.</b>
      <p>The shipped SVGs have no background rect at all, so they composite over
      footage. These previews plate them on black so the white type is legible
      on screen — the type treatment itself is identical in both.</p>
    </div>
  </section>

</div>

<script>
  const svgs  = [...document.querySelectorAll('.stage svg')];
  const range = document.getElementById('t');
  const clock = document.getElementById('clock');
  const play  = document.getElementById('play');
  let following = true;   // track playback until the user grabs the scrubber

  const show = t => clock.textContent = t.toFixed(2) + 's';

  play.addEventListener('click', () => {
    following = true;
    svgs.forEach(s => { s.setCurrentTime(0); s.unpauseAnimations(); });
  });

  range.addEventListener('input', () => {
    following = false;
    const t = +range.value;
    svgs.forEach(s => { s.pauseAnimations(); s.setCurrentTime(t); });
    show(t);
  });

  // Mirror playback position back onto the scrubber.
  (function tick() {
    if (following && svgs.length) {
      const t = Math.min(svgs[0].getCurrentTime(), +range.max);
      range.value = t;
      show(t);
    }
    requestAnimationFrame(tick);
  })();
</script>
"""


if __name__ == "__main__":
    main()
