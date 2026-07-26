"""Text-intro "bubble up" for the header, plus fades for the legend and source.

Rebuilt from ADR 0007 — the SpaceX prototype it describes
(`scratch_folder/SpaceX price/bubble_up.mjs`) was never committed, so only the
decision record survived. Everything here follows that record:

  * Header text is a single <text>/<tspan> run, so a per-unit stagger is
    impossible inside it. The run has to be split into one <text> per unit.
  * Splitting without spacing drift needs the real glyph positions, which means
    measuring `getStartPositionOfChar` in a browser — no static parser can lay
    out text (same reasoning as ADR 0003/0004).
  * Positions come back in the run's *local* space, so the generated units get
    wrapped in a <g> carrying the original run's transform.
  * Each unit starts at opacity 0, offset below its resting place, then floats
    up and fades in, staggered left to right.
  * Stagger is auto-sized so the whole intro lands inside one window however
    long the run is.
  * The footer fades only — no movement.
"""

import os
import re
import tempfile

_PWLIBS = os.path.expanduser("~/.pwlibs/extracted/usr/lib/x86_64-linux-gnu")
if os.path.isdir(_PWLIBS):
    os.environ["LD_LIBRARY_PATH"] = _PWLIBS + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")

from playwright.sync_api import sync_playwright  # noqa: E402

RISE = 10           # px each unit floats up from
UNIT_DUR = 0.32     # how long one unit takes to arrive
STAGGER_CAP = 0.045
EASE = "0.16 1 0.3 1"   # ease-out — arrives quickly, settles softly


def _measure(svg_text, selectors):
    """Per-character positions for each header run, in its own local space.

    ADR 0007 is explicit that these have to be measured in the *real* font, and
    it is easy to get wrong: Datawrapper names Knowledge but ships no font file,
    so measuring the raw export lays the text out in a fallback face. Those
    positions are ~27% wider than the real ones, and pinning each letter to them
    spreads the headline out. The caller passes in the @font-face CSS so the
    measurement happens against the face that will actually render.
    """
    js = """(sels) => sels.map(sel => {
      const t = document.querySelector(sel);
      if (!t) return null;
      const span = t.querySelector('tspan');
      const text = span.textContent;
      const chars = [];
      for (let i = 0; i < text.length; i++) {
        const p = t.getStartPositionOfChar(i);
        chars.push({c: text[i], x: +p.x.toFixed(2), y: +p.y.toFixed(2)});
      }
      return {transform: t.getAttribute('transform') || '',
              style: span.getAttribute('style') || '',
              fill: span.getAttribute('fill') || '#fff',
              text, chars};
    })"""
    tmp = tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False)
    tmp.write(svg_text)
    tmp.close()
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.goto("file://" + tmp.name)
        page.wait_for_timeout(500)
        out = page.evaluate(js, selectors)
        b.close()
    os.unlink(tmp.name)
    return out


def _units(run, mode):
    """Group measured characters into the units that animate together."""
    if mode == "letter":
        return [(c["c"], c["x"], c["y"]) for c in run["chars"] if c["c"] != " "]
    words, cur = [], None
    for c in run["chars"]:
        if c["c"] == " ":
            cur = None
            continue
        if cur is None:
            cur = [c["c"], c["x"], c["y"]]
            words.append(cur)
        else:
            cur[0] += c["c"]
    return [tuple(w) for w in words]


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def bubble_run(run, begin, window, mode="letter"):
    """Markup replacing one header run with staggered, rising units."""
    units = _units(run, mode)
    n = len(units)
    stagger = min(STAGGER_CAP, window / max(n - 1, 1))

    out = [f'<g transform="{run["transform"]}">']
    for k, (txt, x, y) in enumerate(units):
        t0 = round(begin + k * stagger, 3)
        out.append(
            f'<text x="{x}" y="{y}" fill="{run["fill"]}" style="{run["style"]}" '
            f'opacity="0" transform="translate(0,{RISE})">'
            f'<animate attributeName="opacity" from="0" to="1" '
            f'dur="{UNIT_DUR}s" begin="{t0}s" fill="freeze" '
            f'calcMode="spline" keyTimes="0;1" keySplines="{EASE}"/>'
            f'<animateTransform attributeName="transform" type="translate" '
            f'from="0 {RISE}" to="0 0" dur="{UNIT_DUR}s" begin="{t0}s" '
            f'fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="{EASE}"/>'
            f'<tspan fill="{run["fill"]}">{_esc(txt)}</tspan></text>')
    out.append("</g>")
    return "".join(out)


def _fade_anim(begin, dur):
    return (f'<animate attributeName="opacity" from="0" to="1" dur="{dur}s" '
            f'begin="{begin}s" fill="freeze" calcMode="spline" '
            f'keyTimes="0;1" keySplines="0.33 1 0.68 1"/>')


def fade_group(svg, group_id, begin, dur=0.6):
    """Fade a whole group in, no movement — the footer treatment."""
    anchor = re.search(r'<g id="%s[^"]*"' % re.escape(group_id), svg)
    if not anchor:
        return svg
    tag_end = svg.index(">", anchor.end())
    return (svg[:anchor.end()] + ' opacity="0"' + svg[anchor.end():tag_end + 1]
            + _fade_anim(begin, dur) + svg[tag_end + 1:])


def fade_legend(svg, begin, dur=0.6):
    """Fade the legend — swatch and label together.

    Datawrapper puts only the colour swatch inside legend-color-svg; the label
    that goes with it is a pair of bare <text> siblings straight after. Fading
    the group alone leaves the words on screen from frame one, so the swatch and
    its text have to be wrapped and faded as one.
    """
    m = re.search(
        r'<g id="legend-color-svg[^"]*"[^>]*>.*?</g>(?:\s*<text\b.*?</text>)*',
        svg, re.S)
    if not m:
        return svg
    return (svg[:m.start()] + f'<g opacity="0">{_fade_anim(begin, dur)}'
            + m.group(0) + "</g>" + svg[m.end():])


def apply(svg, font_css, title_begin=0.0, sub_begin=0.18, window=0.75,
          title_mode="letter", sub_mode="letter",
          legend_begin=0.9, source_begin=1.1):
    """Bubble the two header runs, then fade the legend and the source note."""
    # Measure a copy of this very SVG with the font already in it, so the glyph
    # positions match what will be rendered.
    if "<defs/>" in svg:
        probe = svg.replace("<defs/>", f"<defs><style>{font_css}</style></defs>", 1)
    else:
        probe = svg.replace("<defs>", f"<defs><style>{font_css}</style>", 1)

    runs = _measure(probe, [
        '[id*="container-header-svg"] text:nth-of-type(1)',
        '[id*="container-header-svg"] text:nth-of-type(2)',
    ])
    if not runs[0] or not runs[1]:
        raise SystemExit("bubble: header runs not found")

    header = re.search(r'(<g id="[^"]*container-header-svg[^"]*">)(.*?)(</g>)', svg, re.S)
    if not header:
        raise SystemExit("bubble: header group not found")

    svg = svg.replace(
        header.group(0),
        header.group(1)
        + bubble_run(runs[0], title_begin, window, title_mode)
        + bubble_run(runs[1], sub_begin, window, sub_mode)
        + header.group(3),
        1)

    svg = fade_legend(svg, legend_begin)
    return fade_group(svg, "container-svg container-footer-svg", source_begin)
