#!/usr/bin/env python3
"""Hand-animated cinematic treatment for the US jobless claims line chart.

Source: cJMcQ-us-jobless-benefits-filings-near-six-decade-low-

Same family as brent.py — Reuters dark theme, real stroked <path>, so `trace`
again — but three structural differences drive a different sequence:

  * No area fill. `<g id="area-fills-svg"/>` is empty, so there is nothing to
    clip; the whole x-at-length machinery sits idle for this chart.
  * There IS a legend (swatch + two bare <text> siblings), which brent.py's
    chart lacked. bubble.fade_legend finally has something to do.
  * The annotation is a *callout* — a rule and an arrowhead pointing at the
    final dot — not a vertical rule at a mid-chart date. So it cannot cue a
    mid-draw pause; it belongs at the end, aimed at the payoff.

That last point reshapes the story. Brent held mid-line for an annotation that
explained the coming drop; there was something to wait FOR. Here there is not —
the callout can only land at the end, so a mid-line hold would be a pause with
nothing in it. The line traces straight through in one continuous run and the
whole payoff (dot, value, callout) lands together once it arrives.

Output: EDITED_chart4_jobless.svg (+ _alpha), gitignored — inlines the licensed
woffs — plus a standalone preview page.
"""

import re
from pathlib import Path

import bubble
import cinematic as cin
import pilot_line_charts as plc

HERE = Path(__file__).parent
SRC = HERE / "cJMcQ-us-jobless-benefits-filings-near-six-decade-low-.svg"
OUT = HERE / "EDITED_chart4_jobless.svg"
OUT_ALPHA = HERE / "EDITED_chart4_jobless_alpha.svg"
PREVIEW = HERE / "jobless_preview.html"

LINE_ID = "New jobless claims"
VALUE_LABEL = '<g id="187k-svg">'

# --- timeline (seconds) ----------------------------------------------------
TITLE_BEGIN = 0.0
SUB_BEGIN = 0.20
BUBBLE_WINDOW = 0.70
LEGEND_BEGIN = 0.35       # arrives right as the line it explains starts drawing
FOOTER_BEGIN = 1.00

# The line draws from t=0 — first thing on screen, under the bubbling header.
# One continuous draw, no hold; ease-in-out so it settles into the endpoint
# rather than slamming in, giving the callout something to land on.
TRACE = (0.0, 4.0, "0.4 0 0.3 1")
ENDPOINT = (4.00, 0.40)               # dot pop, then 187k, as the trace lands
CALLOUT_TEXT = (4.35, 0.45)           # "Lowest since September 1969"
CALLOUT_RULE = (4.50, 0.40)           # rule draws toward the dot
CALLOUT_HEAD = (4.85, 0.20)           # arrowhead lands
DURATION = 6.0                        # ~1s static tail after the last element

# Chrome text that turns white-on-shadow for compositing over footage. NOT the
# axis ticks or the value label — those stay as drawn (see cin.shadow_between).
# Each entry is (start_marker, end_marker) bracketing one run in the document.
SHADOW_REGIONS = [
    ("container-header-svg", '<g id="chart-svg">'),   # title + subtitle
    ("legend-color-svg", '<g id="svelte-1ou6m5y-svg"'),  # legend label
    # Axis tick labels — years then the left-hand numbers, in one contiguous
    # slice that ends before the orange 187k value. The grey gridlines sit
    # earlier in the document, so they stay grey (pure-white grid would fight
    # the data); only the too-grey label text turns white.
    ("x-tick-labels-svg", "value-labels-svg"),
    ("container-footer-svg", "</svg>"),               # Note + Source credits
]
PAD_FRAC = 0.05           # 5% transparent margin on every side

# Horizontal gridlines: Datawrapper ships them at rgb(83,83,83), near-invisible
# once the plate is gone. Lift to a very-slightly-greyed white so they read over
# footage without competing with the orange line — not pure white, which would.
GRID_RGB = "rgb(210,210,210)"

# One fact from the story the source chart doesn't show:
#   * "Seasonally adjusted ... seasonal quirks were partly to blame" — the empty
#     Note: label was meant to carry this caveat (fill_note).
# Two others were tried and cut: a 187k record threshold rule (a dashed guide
# read as clutter once the callout already names the record), and a 212k
# forecast ghost (212k sits mid-cloud on this noisy series, so the miss reads
# in prose but not on the axis). Both left out deliberately.
NOTE_TEXT_STR = ("Seasonally adjusted; summer auto-plant shutdowns can skew the "
                 "weekly figure, which may rebound toward the low 200,000s.")


def fill_note(svg):
    """Put the seasonal caveat into the empty Note: label.

    Datawrapper emitted the "Note:" heading with no note attached; the caveat
    the reporter led with is missing from the graphic. Appended as a sibling
    tspan so it inherits the footer's fade.
    """
    if ">Note:</tspan>" not in svg:
        raise SystemExit("fill_note: Note: label not found")
    added = (
        '>Note:</tspan>'
        '<tspan dx="4" fill="rgb(187,187,187)" '
        'style="font-family: Knowledge; font-weight: 300; font-stretch: 100%; '
        f'font-size: 13px;">{NOTE_TEXT_STR}</tspan>'
    )
    return svg.replace(">Note:</tspan>", added, 1)


def reveal_callout(svg):
    """Land the callout on the endpoint: label, then rule, then arrowhead.

    Datawrapper builds it as two unnamed <path> children of #callout-line-svg —
    a horizontal rule and a two-legged arrowhead — inside a group translated to
    the dot. Both are `fill: none` strokes, so both take the same
    stroke-dashoffset draw the data line uses.

    Drawing the rule left-to-right and only then popping the head means the
    callout reads as reaching for the value rather than appearing beside it.
    """
    for d_prefix, spec in ((r'M -53,0 L -5,0', CALLOUT_RULE),
                           (r'M-4\.75,-3\.75', CALLOUT_HEAD)):
        m = re.search(r'<path d="%s[^"]*"[^>]*/>' % d_prefix, svg)
        if not m:
            raise SystemExit(f"callout: no path matching {d_prefix!r}")
        svg = cin.draw_path_literal(svg, m.group(0), spec[0], spec[1])

    label = re.search(r'<text transform="translate\(618\.953125[^"]*"[^>]*>.*?</text>',
                      svg, re.S)
    if not label:
        raise SystemExit("callout: label not found")
    # White + drop shadow, same as the chrome — it composites over footage too,
    # and it sits outside the three SHADOW_REGIONS so it needs treating here.
    treated = cin.shadow_markup(label.group(0))
    return svg.replace(label.group(0),
                       cin.fade_markup(treated, *CALLOUT_TEXT), 1)


def build():
    svg = cin.stamp_viewbox(SRC.read_text())
    font_css = cin.font_css()

    # Checklist §0 — font before anything measures text.
    svg = cin.embed_font(svg, font_css)

    points = cin.points_of(svg, LINE_ID)

    svg = bubble.apply(
        svg, font_css,
        title_begin=TITLE_BEGIN, sub_begin=SUB_BEGIN, window=BUBBLE_WINDOW,
        title_mode="letter", sub_mode="word",
        legend_begin=LEGEND_BEGIN, source_begin=FOOTER_BEGIN,
    )
    # No clip_area call: this chart's area-fills group is empty.
    svg = fill_note(svg)
    svg = cin.draw_trace(svg, LINE_ID, *TRACE)
    svg = cin.pop_dot(svg, *ENDPOINT, overshoot=1.3)
    svg = cin.fade_group_literal(svg, VALUE_LABEL, ENDPOINT[0] + 0.1, ENDPOINT[1])
    svg = reveal_callout(svg)

    # Compositing treatment: white type + drop shadow on the chrome only, then a
    # 5% transparent margin. Shadow first (it edits text runs), pad last (it only
    # touches the viewBox).
    svg = cin.add_shadow_def(svg)
    for start, end in SHADOW_REGIONS:
        svg = cin.shadow_between(svg, start, end)
    svg = cin.recolor_strokes(svg, "y-grid-lines-svg", "area-fills-svg", GRID_RGB)
    svg = cin.pad_viewbox(svg, PAD_FRAC)

    OUT.write_text(svg)                       # padded, shadowed, still on its plate
    OUT_ALPHA.write_text(cin.drop_plate(svg))  # the compositing master

    _write_preview(cin.drop_plate(svg))

    print(f"vertices        {len(points)}")
    print(f"wrote           {OUT.name}  ({OUT.stat().st_size:,} bytes)")
    print(f"wrote           {OUT_ALPHA.name}  (no backdrop plate)")
    print(f"wrote           {PREVIEW.name}")


# Broadcast grey, an alpha checkerboard, and black — the three backdrops an
# editor judges a transparent overlay against (checklist §8, composite-proxy
# preview backdrops). White-on-shadow has to read on all three.
def _write_preview(alpha_svg):
    panels = [
        ("Broadcast grey", "background:rgb(128,128,128);"),
        ("Alpha checker",
         "background-color:rgb(90,90,90);"
         "background-image:"
         "linear-gradient(45deg,rgb(60,60,60) 25%,transparent 25%),"
         "linear-gradient(-45deg,rgb(60,60,60) 25%,transparent 25%),"
         "linear-gradient(45deg,transparent 75%,rgb(60,60,60) 75%),"
         "linear-gradient(-45deg,transparent 75%,rgb(60,60,60) 75%);"
         "background-size:24px 24px;"
         "background-position:0 0,0 12px,12px -12px,-12px 0;"),
        ("Black", "background:rgb(0,0,0);"),
    ]
    # Each copy shares ids (clip, filter) with the others; scope them per panel
    # so url(#...) can't resolve across the three inlined SVGs.
    cards = []
    for i, (name, bg) in enumerate(panels):
        one = cin.scope_ids(alpha_svg, f"p{i}-")
        cards.append(
            f'<figure class="card"><figcaption>{name}</figcaption>'
            f'<div class="stage" style="{bg}">{one}</div></figure>')
    html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>US jobless claims — transparent proxy</title>
<style>
  body{{margin:0;background:rgb(24,24,24);color:rgb(210,210,210);
       font:15px/1.5 system-ui,sans-serif}}
  header{{padding:20px 28px 4px}} h1{{font-size:18px;margin:0}}
  p.sub{{margin:6px 0 0;color:rgb(150,150,150);max-width:70ch}}
  .bar{{padding:12px 28px}} button{{font:inherit;padding:7px 16px;cursor:pointer;
       border:1px solid rgb(90,90,90);border-radius:6px;
       background:rgb(45,45,45);color:inherit}}
  .grid{{display:flex;flex-wrap:wrap;gap:20px;padding:8px 28px 32px}}
  .card{{margin:0;flex:1 1 420px}} figcaption{{font-size:13px;
       color:rgb(150,150,150);margin-bottom:6px}}
  .stage{{border-radius:8px;overflow:hidden}}
  .stage svg{{display:block;width:100%;height:auto}}
</style></head><body>
<header>
  <h1>US jobless claims — transparent compositing proxy</h1>
  <p class="sub">Same SVG as the key/fill master: plate dropped, 5% margin,
  white type + drop shadow on title, subtitle, legend and credits only. Judge
  the type legibility on each backdrop — grey approximates the Hive preview,
  checker shows the true alpha, black is the old preview for reference.</p>
</header>
<div class="bar"><button id="replay" type="button">Replay all</button></div>
<div class="grid">{"".join(cards)}</div>
<script>
  document.getElementById('replay').addEventListener('click', () => {{
    document.querySelectorAll('svg').forEach(s => {{
      try {{ s.setCurrentTime(0); }} catch (e) {{}}
    }});
  }});
</script>
</body></html>
"""
    PREVIEW.write_text(html)


if __name__ == "__main__":
    build()
