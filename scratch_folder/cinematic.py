#!/usr/bin/env python3
"""Chart-agnostic pieces of the hand-animation pipeline.

Extracted from brent.py once a second chart needed the same geometry. Each
chart still gets its own script for its own sequencing — the timing and the
storytelling are per-chart decisions — but nothing here knows about a
particular chart.

Deliberately separate from the pilot modules (`pilot_line_charts`,
`stage_camera`, `bubble`): those are being read as the porting reference for
animate.js/export.js, so they stay untouched. This imports from them.
"""

import re

import pilot_line_charts as plc

FADE_SPLINE = "0.33 1 0.68 1"


# --- document prep ---------------------------------------------------------

def stamp_viewbox(svg):
    """Give the root a viewBox so it can be scaled to any output size.

    Datawrapper ships width/height only. CSS width on a viewBox-less <svg>
    resizes the viewport without touching the coordinate space, so the chart
    renders at its intrinsic size in the top-left of a 1920-wide frame — which
    is exactly what came out of the first Brent ProRes.

    ADR 0004; app.js:187 does this on injection and stage_camera.py:171 does it
    for the camera path. Neither runs here, so a chart with no camera move has
    to stamp its own. Cheap and idempotent, so it happens first.
    """
    if re.search(r'<svg[^>]*\bviewBox=', svg):
        return svg
    m = re.search(r'(<svg\b[^>]*\bwidth=")([\d.]+)("[^>]*\bheight=")([\d.]+)(")', svg)
    if not m:
        raise SystemExit("stamp_viewbox: no width/height on the root <svg>")
    return svg.replace(m.group(0), f'{m.group(0)} viewBox="0 0 {m.group(2)} {m.group(4)}"', 1)


def embed_font(svg, font_css):
    """Put the @font-face rules in <defs> — checklist §0, before anything measures."""
    if "<defs/>" in svg:
        return svg.replace("<defs/>", f"<defs><style>{font_css}</style></defs>", 1)
    if "<defs>" in svg:
        return svg.replace("<defs>", f"<defs><style>{font_css}</style>", 1)
    raise SystemExit("embed_font: no <defs> to put the font in")


def pad_viewbox(svg, frac=0.05):
    """Inset the content by `frac` of the frame on every side.

    Rewrites the viewBox only, leaving width/height alone: the SVG viewport
    keeps its pixel size and aspect, and the content shrinks to sit inside a
    margin. On the transparent export those margins are clear, so a composited
    chart never runs hard to the frame edge. Symmetric expansion preserves
    aspect, so nothing stretches.
    """
    m = re.search(r'(<svg[^>]*\bviewBox=")([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)(")', svg)
    if not m:
        raise SystemExit("pad_viewbox: no viewBox (call stamp_viewbox first)")
    x, y, w, h = (float(m.group(i)) for i in (2, 3, 4, 5))
    fw, fh = w / (1 - 2 * frac), h / (1 - 2 * frac)
    nx, ny = x - (fw - w) / 2, y - (fh - h) / 2
    return svg.replace(
        m.group(0),
        f'{m.group(1)}{nx:.3f} {ny:.3f} {fw:.3f} {fh:.3f}{m.group(6)}', 1)


# The drop-shadow filter that survives frame-capture export (a CSS text-shadow
# would not). Same feDropShadow the pilot uses; lifts white type off footage.
TEXT_SHADOW = plc.TEXT_SHADOW


def add_shadow_def(svg):
    if 'id="textShadow"' in svg:
        return svg
    if "</defs>" not in svg:
        raise SystemExit("add_shadow_def: no </defs> (embed_font first)")
    return svg.replace("</defs>", TEXT_SHADOW + "</defs>", 1)


def _whiten_shadow(chunk):
    chunk = chunk.replace("<text ", '<text filter="url(#textShadow)" ')
    return re.sub(r'fill="rgb\([\d,\s]+\)"', 'fill="rgb(255,255,255)"', chunk)


def shadow_markup(chunk):
    """White type + drop shadow on a standalone markup chunk.

    The chunk form of shadow_between, for text that isn't a contiguous document
    region — e.g. an annotation callout the caller has already matched and is
    about to re-wrap. Needs add_shadow_def to have run (or to run later; SVG
    resolves url(#...) by id regardless of order).
    """
    return _whiten_shadow(chunk)


def shadow_between(svg, start_marker, end_marker):
    """White type + drop shadow, but only in one slice of the document.

    Scoped rather than whole-document (which is what plc.restyle does) because
    for these dark Reuters exports only the *chrome* — title, subtitle, legend,
    credits — should turn white-on-shadow for compositing. The grey axis
    hierarchy and the coloured value label are deliberately left alone; whitening
    them would flatten the chart. Markers are plain substrings, so the caller
    picks exactly the run to treat.

    Only touches `fill="rgb(...)"` attributes and `<text>` tags, so a swatch or
    rule carrying its colour in `style="stroke:..."` inside the slice is safe.
    """
    i = svg.index(start_marker)
    j = svg.index(end_marker, i)
    return svg[:i] + _whiten_shadow(svg[i:j]) + svg[j:]


def scope_ids(svg, prefix):
    """Namespace ids/url refs so copies can share a document — via plc."""
    return plc.scope_ids(svg, prefix)


def recolor_strokes(svg, start_marker, end_marker, new_rgb):
    """Repaint every `stroke: rgb(...)` in one slice of the document.

    Scoped by markers so it hits, e.g., only the horizontal gridline group and
    not the axis ticks or the legend swatch that carry their own strokes
    elsewhere. `new_rgb` is a full CSS colour string, e.g. "rgb(210,210,210)".
    """
    i = svg.index(start_marker)
    j = svg.index(end_marker, i)
    chunk = re.sub(r'stroke:\s*rgb\([\d,\s]+\)', f'stroke: {new_rgb}', svg[i:j])
    return svg[:i] + chunk + svg[j:]


def drop_plate(svg):
    """Remove the full-canvas backdrop rect, for the compositing export.

    Not plc.restyle: that also whitens every tspan fill, which is right for a
    light-theme Datawrapper export but wrong for these — the Reuters dark
    exports already ship light-on-dark, and whitening would flatten the grey
    axis hierarchy and repaint the coloured value label. Only the plate goes.

    Known limitation: Datawrapper gives annotation and value-label text a
    legibility halo stroked in the *plate colour*. Dropping the plate leaves
    that halo as a dark box over whatever is composited behind. ADR 0008 #7
    (feDropShadow) is the fix; nothing here applies it yet.
    """
    plate = re.search(
        r'<rect width="\d+" height="\d+" transform="translate\(0, 0\)"[^>]*/>', svg)
    if not plate:
        raise SystemExit("drop_plate: backdrop rect not found")
    return svg.replace(plate.group(0), "", 1)


# --- polyline geometry -----------------------------------------------------

def points_of(svg, path_id):
    """The polyline vertices of a Datawrapper line path.

    The `d` is all absolute M/L commands, so this is a parse, not a curve
    measurement — the same reason plc.split_fraction can sum segments exactly.
    """
    pat = r'<path\b[^>]*\bid="%s"[^>]*\bd="([^"]+)"' % re.escape(path_id)
    m = re.search(pat, svg) or re.search(
        r'<path\b[^>]*\bd="([^"]+)"[^>]*\bid="%s"' % re.escape(path_id), svg)
    if not m:
        raise SystemExit(f"no <path id={path_id!r}> found")
    return [tuple(float(v) for v in pair.split(","))
            for pair in re.split(r"[ML]", m.group(1)) if pair.strip()]


def cumulative(points):
    """Running length at each vertex, and the total."""
    run, acc = [0.0], 0.0
    for a, b in zip(points, points[1:]):
        acc += ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
        run.append(acc)
    return run, acc


def index_at_x(points, x):
    """Vertex nearest a given x."""
    return min(range(len(points)), key=lambda i: abs(points[i][0] - x))


def last_high_peak(points, tol=0.1):
    """Index of the LAST peak that reaches near the series high.

    Where a final descent begins, derived from the data rather than placed by
    hand — the same principle as stage_camera.build_frames.

    "Near the high" rather than "the highest": a plain argmax picks an early
    spike on any series that revisits its high, and a plain "last local
    maximum" picks whatever noise sits one vertex from the end. Taking the last
    peak within `tol` of the full y-range of the top gives "the last time it
    was up there", which is the beat a hold wants.

    SVG y grows downward, so a peak in the data is a *minimum* in y.
    """
    ys = [p[1] for p in points]
    top, bottom = min(ys), max(ys)
    ceiling = top + tol * (bottom - top)
    for i in range(len(points) - 2, 0, -1):
        if (points[i][1] <= points[i - 1][1] and points[i][1] <= points[i + 1][1]
                and points[i][1] <= ceiling):
            return i
    raise SystemExit("last_high_peak: no qualifying peak found")


def x_at_length(points, run, total, frac):
    """The x reached after drawing `frac` of the line's length.

    The inverse of split_fraction: length-domain in, x-domain out. Needed
    because a trace advances by path length while a clip advances by x, and on
    a steep segment those run at very different rates.
    """
    target = frac * total
    for i in range(len(run) - 1):
        if run[i + 1] >= target:
            span = run[i + 1] - run[i]
            t = (target - run[i]) / span if span else 0.0
            return points[i][0] + t * (points[i + 1][0] - points[i][0])
    return points[-1][0]


def bezier_ease(spline, t):
    """Evaluate a keySplines cubic at time fraction t.

    SMIL eases in the time domain: the control points define x(s)=time and
    y(s)=progress, so getting progress for a given time means solving x(s)=t
    first. Bisection rather than Newton — exact enough at these sample counts
    and it cannot diverge.
    """
    x1, y1, x2, y2 = (float(v) for v in spline.split())

    def bez(a, b, s):
        u = 1 - s
        return 3 * u * u * s * a + 3 * u * s * s * b + s ** 3

    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if bez(x1, x2, mid) < t:
            lo = mid
        else:
            hi = mid
    return bez(y1, y2, (lo + hi) / 2)


# --- injectors -------------------------------------------------------------

def fade_anim(begin, dur, spline=FADE_SPLINE):
    return (f'<animate attributeName="opacity" from="0" to="1" dur="{dur}s" '
            f'begin="{begin}s" fill="freeze" calcMode="spline" '
            f'keyTimes="0;1" keySplines="{spline}"/>')


def fade_markup(markup, begin, dur):
    """Wrap arbitrary markup in a group that fades in."""
    return f'<g opacity="0">{fade_anim(begin, dur)}{markup}</g>'


def clip_area(svg, group_id, clip_id, points, split_frac, body, tail,
              clip_x=46, clip_h=300, samples=36):
    """Reveal an area fill in lockstep with the drawing line.

    A plain linear left-to-right wipe desyncs: the trace is eased *and* moves
    through x at a rate that depends on how steep the line is. So the clip's
    width is baked as sampled keyTimes — for each sample time, ease it, convert
    that length fraction to an x, and emit that width. One run per draw stage,
    matching draw_split's begins; fill="freeze" holds it through the pause.
    """
    run, total = cumulative(points)

    def stage(begin, dur, spline, frm, to):
        times, widths = [], []
        for k in range(samples + 1):
            t = k / samples
            drawn = frm + (to - frm) * bezier_ease(spline, t)
            times.append(f"{t:.4f}")
            widths.append(f"{x_at_length(points, run, total, drawn) - clip_x:.2f}")
        return (f'<animate attributeName="width" values="{";".join(widths)}" '
                f'keyTimes="{";".join(times)}" dur="{dur}s" begin="{begin}s" '
                f'fill="freeze" calcMode="linear"/>')

    clip = (
        f'<clipPath id="{clip_id}">'
        f'<rect x="{clip_x}" y="0" width="0" height="{clip_h}">'
        + stage(body[0], body[1], body[2], 0.0, split_frac)
        + stage(tail[0], tail[1], tail[2], split_frac, 1.0)
        + "</rect></clipPath>"
    )
    anchor = f'<g id="{group_id}">'
    if anchor not in svg:
        raise SystemExit(f"clip_area: no <g id={group_id!r}>")
    return svg.replace(
        anchor, f'<g id="{group_id}" clip-path="url(#{clip_id})">{clip}', 1)


def draw_trace(svg, path_id, begin, dur, spline):
    """One continuous stroke-dashoffset draw on a line path.

    plc.draw_on_path does the same trick but reads its timing from module-level
    constants (2s at 0s), which no chart's sequence actually wants; and
    plc.draw_split is the two-stage version. This is the single-run form with
    its begin/dur/spline passed in, so a chart that needs no mid-line hold does
    not have to fake one with a degenerate split.

    pathLength="1" renormalises the path to one user unit, so the dash values
    are fractions and nothing has to measure real geometry — which is what lets
    the same technique survive export.js's detached DOM.
    """
    tag = re.search(r'<path\b[^>]*\bid="%s"[^>]*/>' % re.escape(path_id), svg)
    if not tag:
        raise SystemExit(f"draw_trace: no <path id={path_id!r}> found")
    drawn = tag.group(0)[:-2].rstrip() + (
        ' pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">'
        f'<animate attributeName="stroke-dashoffset" from="1" to="0" '
        f'dur="{dur}s" begin="{begin}s" fill="freeze" calcMode="spline" '
        f'keyTimes="0;1" keySplines="{spline}"/></path>'
    )
    return svg.replace(tag.group(0), drawn, 1)


def pop_dot(svg, begin, dur, overshoot=1.25):
    """Pop the terminal dot once the line arrives.

    Datawrapper draws it as a unit circle path already carrying
    `translate(...) scale(n)`; an additive scale multiplies into that list, so
    the pop happens about the dot's own centre without restating the placement.
    """
    dot = re.search(r'<path d="M1,0A1,1[^"]*"[^>]*/>', svg)
    if not dot:
        raise SystemExit("pop_dot: endpoint dot not found")
    popped = dot.group(0)[:-2].rstrip() + (
        f' opacity="0">'
        f'<animate attributeName="opacity" from="0" to="1" dur="{dur}s" '
        f'begin="{begin}s" fill="freeze"/>'
        f'<animateTransform attributeName="transform" type="scale" '
        f'values="0;{overshoot};1" dur="{dur}s" begin="{begin}s" '
        f'additive="sum" fill="freeze" calcMode="spline" '
        f'keyTimes="0;0.65;1" keySplines="{FADE_SPLINE};{FADE_SPLINE}"/>'
        f'</path>'
    )
    return svg.replace(dot.group(0), popped, 1)


def fade_group_literal(svg, anchor, begin, dur):
    """Fade a group whose opening tag is known verbatim.

    For ids that regex badly — Datawrapper names value-label groups after their
    own text, so they arrive as `<g id="$100.67-svg">` or `<g id="187k-svg">`.
    """
    if anchor not in svg:
        raise SystemExit(f"fade_group_literal: {anchor!r} not found")
    opened = anchor[:-1] + f' opacity="0">{fade_anim(begin, dur)}'
    return svg.replace(anchor, opened, 1)


def draw_path_literal(svg, path_markup, begin, dur, spline=FADE_SPLINE):
    """stroke-dashoffset draw on a path given verbatim.

    Same trick as plc.draw_on_path (pathLength="1", so no getTotalLength), but
    keyed off the markup rather than an id — callout rules and arrowheads are
    unnamed <path> children of a named group.
    """
    if path_markup not in svg:
        raise SystemExit("draw_path_literal: path not found")
    drawn = path_markup[:-2].rstrip() + (
        ' pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">'
        f'<animate attributeName="stroke-dashoffset" from="1" to="0" '
        f'dur="{dur}s" begin="{begin}s" fill="freeze" calcMode="spline" '
        f'keyTimes="0;1" keySplines="{spline}"/></path>'
    )
    return svg.replace(path_markup, drawn, 1)


def font_css():
    return plc._font_face_css()
