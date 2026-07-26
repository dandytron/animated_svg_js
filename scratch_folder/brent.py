#!/usr/bin/env python3
"""Hand-animated cinematic treatment for the Brent crude line chart.

Source: wrw0t-brent-crude-futures-crossed-100-per-barrel-after-almost-two-months-

A single-series Datawrapper line chart, already in Reuters' dark theme. Unlike
the SPR chart it is a real stroked <path>, so it takes the `trace`
(stroke-dashoffset) treatment rather than a clip wipe.

The sequence, and why it is shaped this way:

  header bubbles up  ->  line draws to the Iran-U.S. peace deal  ->  hold while
  the annotation arrives  ->  the drop and the recovery draw  ->  the endpoint
  dot and $100.67 land.

The split is not decorative: the annotation explains the drop, so the drawing
has to wait for it. Split fraction is measured off the polyline's own segment
lengths against the annotation's x, not hand-set (checklist §2).

Reuses the pilot modules read-only — `pilot_line_charts` for the font embed and
the split draw, `bubble` for the header intro. Nothing here writes to them.

Output: EDITED_chart3_brent.svg (gitignored — inlines the licensed woffs) plus
a standalone preview page.
"""

import re
from pathlib import Path

import bubble
import cinematic as cin
import pilot_line_charts as plc
import preview_shell

HERE = Path(__file__).parent
SRC = HERE / "wrw0t-brent-crude-futures-crossed-100-per-barrel-after-almost-two-months-.svg"
OUT = HERE / "EDITED_chart3_brent.svg"
OUT_ALPHA = HERE / "EDITED_chart3_brent_alpha.svg"
PREVIEW = HERE / "brent_preview.html"

LINE_ID = "Brent crude futures"
AREA_GROUP = "area-fills-svg"
AREA_CLIP = "brent-area-clip"

# --- timeline (seconds) ----------------------------------------------------
# Every begin lives here rather than being sprinkled through the injectors, so
# the whole sequence can be re-timed in one place. This is the ad-hoc version
# of the timeline model ADR 0008 #4 wants underneath all of this.
TITLE_BEGIN = 0.0
SUB_BEGIN = 0.20
BUBBLE_WINDOW = 0.70
FOOTER_BEGIN = 1.20

BODY = (1.0, 2.4, "0.4 0 0.35 1")     # begin, dur, spline — up to the peace deal
NOTE_LINE = (3.15, 0.45)              # dashed rule grows down
NOTE_TEXT = (3.45, 0.45)              # then the label fades in
TAIL = (4.10, 1.90, "0.45 0 0.2 1")   # the drop, then the recovery
ENDPOINT = (5.95, 0.45)               # dot pop + value label
DURATION = 6.6

# x of the annotation rule, in chart space. #svg-main-svg and #group-svg only
# translate in y, so this is the same x the plot polyline uses.
NOTE_X = 502.59375

AREA_CLIP_X = 46          # a hair left of the first vertex (x=50)
AREA_CLIP_H = 300         # the plot band, y 0..300 in #group-svg space
AREA_SAMPLES = 36         # keyTime samples per draw run


def reveal_annotation(svg):
    """Grow the dashed rule down, then fade the label in.

    The rule and its two <text> runs are adjacent siblings of #chart-svg, so
    they are wrapped together rather than hunted for individually.
    """
    rule = re.search(r'<line x1="%s"[^>]*/>' % re.escape(str(NOTE_X)), svg)
    if not rule:
        raise SystemExit("annotation rule not found")
    y1, y2 = 80.265625, 380.265625
    begin, dur = NOTE_LINE
    grown = rule.group(0)[:-2].rstrip() + (
        f'><animate attributeName="y2" from="{y1}" to="{y2}" dur="{dur}s" '
        f'begin="{begin}s" fill="freeze" calcMode="spline" keyTimes="0;1" '
        f'keySplines="0.33 1 0.68 1"/></line>'
    )
    svg = svg.replace(rule.group(0), grown.replace(f'y2="{y2}"', f'y2="{y1}"', 1), 1)

    label = re.search(r'<g id="Iran-U\.S\.[^"]*">.*?</g>\s*(?=<g id="tooltip-layer)',
                      svg, re.S)
    if not label:
        raise SystemExit("annotation label not found")
    begin, dur = NOTE_TEXT
    return svg.replace(
        label.group(0),
        f'<g opacity="0">{cin.fade_anim(begin, dur)}{label.group(0)}</g>',
        1)


def build():
    svg = cin.stamp_viewbox(SRC.read_text())
    font_css = cin.font_css()

    # §0 of the integration checklist: the font goes in before anything
    # measures text. bubble.apply re-probes with the same CSS, so the glyph
    # positions come from the real face and not a 27%-wider fallback.
    svg = cin.embed_font(svg, font_css)

    points = cin.points_of(svg, LINE_ID)
    split_i = cin.index_at_x(points, NOTE_X)
    split_frac = plc.split_fraction(points, split_i)

    svg = bubble.apply(
        svg, font_css,
        title_begin=TITLE_BEGIN, sub_begin=SUB_BEGIN, window=BUBBLE_WINDOW,
        title_mode="letter", sub_mode="word",
        legend_begin=FOOTER_BEGIN, source_begin=FOOTER_BEGIN,
    )
    svg = cin.clip_area(svg, AREA_GROUP, AREA_CLIP, points, split_frac,
                        BODY, TAIL, clip_x=AREA_CLIP_X, clip_h=AREA_CLIP_H,
                        samples=AREA_SAMPLES)
    svg = plc.draw_split(svg, LINE_ID, split_frac, BODY, TAIL)
    svg = reveal_annotation(svg)
    svg = cin.pop_dot(svg, *ENDPOINT)
    svg = cin.fade_group_literal(svg, '<g id="$100.67-svg">',
                                 ENDPOINT[0] + 0.1, ENDPOINT[1])

    OUT.write_text(svg)
    OUT_ALPHA.write_text(cin.drop_plate(svg))

    body = preview_shell.page(
        "Brent crude — cinematic pass 1",
        "hand animation",
        f"Trace + split timing on a real &lt;path&gt; line. Split at x={NOTE_X} "
        f"(vertex {split_i} of {len(points)}, {split_frac:.1%} of the line's "
        "length), so the drop waits for the annotation that explains it.",
        [preview_shell.sheet(1, "Brent crude futures", "trace + split",
                             "trace", svg, DURATION)],
        [preview_shell.finding(
            "Area fill tracks the tip, not the clock",
            "The trace advances by path length; a clip wipe advances by x. On "
            "the steep June run those differ enough to see, so the clip's "
            "width is baked as eased samples of x-at-length rather than a "
            "straight 0&rarr;full wipe.")],
        backlink=False,
    )
    PREVIEW.write_text(preview_shell.standalone(body, "Brent crude — pass 1"))

    print(f"vertices        {len(points)}")
    print(f"split vertex    {split_i} at x={points[split_i][0]} y={points[split_i][1]}")
    print(f"split fraction  {split_frac:.4f}")
    print(f"wrote           {OUT.name}  ({OUT.stat().st_size:,} bytes)")
    print(f"wrote           {OUT_ALPHA.name}  (no backdrop plate)")
    print(f"wrote           {PREVIEW.name}")


if __name__ == "__main__":
    build()
