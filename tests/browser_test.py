"""
Browser test harness — drives the real app at http://localhost:5001 with Playwright.

Covers the automatable parts of the smoke-test checklist (issue #16) plus
regression tests for detection, hiding, preview, frame capture, and the
per-bar grow_from_baseline geometry.

Run:  python3 tests/browser_test.py
Requires the Flask server to be running (python3 server.py).
"""

import json
import os
import sys

# This WSL2 box lacks chromium's system libs (no sudo); point at the
# locally-extracted copies. Rebuild if missing:
#   mkdir -p ~/.pwlibs/debs && cd ~/.pwlibs/debs && \
#   apt-get download libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libxdamage1 libatspi2.0-0 && \
#   for f in *.deb; do dpkg -x "$f" ../extracted/; done
_PWLIBS = os.path.expanduser('~/.pwlibs/extracted/usr/lib/x86_64-linux-gnu')
if os.path.isdir(_PWLIBS):
    os.environ['LD_LIBRARY_PATH'] = _PWLIBS + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')

from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5001'

PASS, FAIL = 0, 1
results = []


def check(name, cond, detail=''):
    ok = bool(cond)
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ''))
    return ok


# Load an example SVG through the app's own pipeline — loadSvgString is the
# shared tail of every real load path (Datawrapper fetch, file upload, paste).
LOAD_EXAMPLE_JS = """
async (path) => {
  const svg = await (await fetch(path)).text();
  loadSvgString(svg);
  return state.elements.map(e => ({ id: e.group_id, label: e.label, type: e.animation_type }));
}
"""


# Click the Test button and wait until the multi-line graph has actually been
# loaded and detected. #queue-section visibility is NOT a safe signal — it stays
# visible from a previous load, so a bare wait races against the async fetch.
def load_via_test_button(page):
    page.click('#test-btn')
    # 6 = 4 lines + area fills + the header bubble_up element (§5).
    page.wait_for_function('state.elements.length === 6 && state.queue.length === 0')


def test_load_and_detection(page):
    # ── Test button: loads examples/multi_line_graph.svg statically ──
    page.goto(BASE)
    load_via_test_button(page)

    warning_hidden = page.eval_on_selector('#no-elements-warning', 'el => el.hidden')
    check('Test button: no "no elements" warning', warning_hidden)

    elements = page.evaluate('state.elements.map(e => ({id: e.group_id, label: e.label, type: e.animation_type}))')
    # §5: the header is now detected too (4 lines + area fills + header = 6).
    check('Test button: 6 elements detected (4 lines + area fills + header)', len(elements) == 6,
          f'got {len(elements)}: {[e["id"] for e in elements]}')

    labels = {e['label'] for e in elements}
    check('Labels are human-readable (WORKDAY CLASS A, not raw id)',
          'WORKDAY CLASS A' in labels, f'labels: {labels}')

    types = {e['id']: e['type'] for e in elements}
    # §1 / ADR 0008 #1: stroke-only line paths default to trace; §5: header → bubble_up.
    def _is_line(i):
        return i != 'area-fills-svg' and 'container-header-svg' not in i
    check('Lines detected as trace',
          all(t == 'trace' for i, t in types.items() if _is_line(i)), str(types))
    check('Area fills detected as fade_in', types.get('area-fills-svg') == 'fade_in', str(types))
    check('§5: header detected as bubble_up',
          any(t == 'bubble_up' for i, t in types.items() if 'container-header-svg' in i), str(types))


def test_detection_per_chart(page):
    # §5: every chart also detects its header as a bubble_up element (+1, +bubble_up).
    expectations = {
        '/examples/area_graph_bv.svg':    (11, {'fade_in', 'bubble_up'}),
        '/examples/bar_chart_iphone.svg': (11, {'grow_from_baseline', 'bubble_up'}),
        '/examples/scatter_plot.svg':     (2,  {'pop_in', 'bubble_up'}),
    }
    for path, (count, types) in expectations.items():
        els = page.evaluate(LOAD_EXAMPLE_JS, path)
        name = path.split('/')[-1]
        check(f'{name}: {count} elements detected', len(els) == count,
              f'got {len(els)}: {[e["id"] for e in els]}')
        got_types = {e['type'] for e in els}
        check(f'{name}: all {types}', got_types == types, f'got {got_types}')

    # Bar labels drop the positional index: "Q1-svg 2024-0-svg" → "Q1 2024"
    els = page.evaluate(LOAD_EXAMPLE_JS, '/examples/bar_chart_iphone.svg')
    check('Bar labels read "Q1 2024" (index stripped)',
          any(e['label'] == 'Q1 2024' for e in els), str([e['label'] for e in els]))


# ── Unit tests: stacked-bar helpers (detect.js) ───────────────────────────────
# Synthetic, hand-built inputs — one function and one behaviour per assertion,
# including edge cases the single-fixture integration tests don't reach. Runs in
# the real browser DOM (the functions use querySelector/children/createElementNS),
# so no jsdom dependency is introduced.

# Parse a fragment into a live <svg> documentElement, in-page.
_MK = "const mk = s => new DOMParser().parseFromString(s, 'image/svg+xml').documentElement;"


def test_unit_translate_y(page):
    r = page.evaluate("() => { %s" % _MK + """
      const one = s => mk(`<svg xmlns='http://www.w3.org/2000/svg'><rect ${s}/></svg>`).querySelector('rect');
      return {
        comma:   _translateY(one("transform='translate(5, 30)'")),
        space:   _translateY(one("transform='translate(5 30)'")),
        noY:     _translateY(one("transform='translate(5)'")),
        none:    _translateY(one("")),
        negative:_translateY(one("transform='translate(5, -12.5)'")),
      };
    }""")
    check('_translateY: comma-separated y', r['comma'] == 30, str(r))
    check('_translateY: space-separated y', r['space'] == 30, str(r))
    check('_translateY: x-only → 0', r['noY'] == 0, str(r))
    check('_translateY: no transform → 0', r['none'] == 0, str(r))
    check('_translateY: negative y', r['negative'] == -12.5, str(r))


def test_unit_positive_direct_rects(page):
    # 2 positive direct rects; a 0-width and a 0-height rect are dropped; a rect
    # nested inside a <g> is NOT a direct child and must be ignored.
    r = page.evaluate("() => { %s" % _MK + """
      const chart = mk(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'>
        <rect width='10' height='5'/>
        <rect width='0'  height='5'/>
        <rect width='10' height='0'/>
        <rect width='7'  height='5'/>
        <g><rect width='99' height='9'/></g>
      </g></svg>`).querySelector('[id="chart-svg"]');
      return _positiveDirectRects(chart).length;
    }""")
    check('_positiveDirectRects: drops 0-area + nested, keeps 2', r == 2, str(r))


def test_unit_has_nested_chart_root(page):
    r = page.evaluate("() => { %s" % _MK + """
      const withRoot = mk(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'>
        <g id='columns-svg'></g></g></svg>`).querySelector('[id="chart-svg"]');
      const bare = mk(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'>
        <rect width='5' height='5'/></g></svg>`).querySelector('[id="chart-svg"]');
      return { withRoot: _hasNestedChartRoot(withRoot), bare: _hasNestedChartRoot(bare) };
    }""")
    check('_hasNestedChartRoot: true when a chartRoot nests', r['withRoot'] is True, str(r))
    check('_hasNestedChartRoot: false when only rects', r['bare'] is False, str(r))


def test_unit_is_stacked_bar_chart(page):
    r = page.evaluate("() => { %s" % _MK + """
      const q = svg => mk(svg).querySelector('[id="chart-svg"]');
      const stacked = q(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'>
        <rect width='10' height='5'/></g></svg>`);
      const gated = q(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'>
        <rect width='10' height='5'/><g id='lines-svg'></g></g></svg>`);
      const empty = q(`<svg xmlns='http://www.w3.org/2000/svg'><g id='chart-svg'></g></svg>`);
      return {
        stacked: isStackedBarChart(stacked),
        gated:   isStackedBarChart(gated),
        empty:   isStackedBarChart(empty),
        nul:     isStackedBarChart(null),
      };
    }""")
    check('isStackedBarChart: rects + no root → true', r['stacked'] is True, str(r))
    check('isStackedBarChart: clause-2 nested root → false', r['gated'] is False, str(r))
    check('isStackedBarChart: no rects → false', r['empty'] is False, str(r))
    check('isStackedBarChart: null-safe → false', r['nul'] is False, str(r))


def test_unit_cluster_rows_by_y(page):
    # Unordered input clusters into rows sorted top→bottom; near-equal y values
    # (93.7 vs 94.1) round into one row.
    r = page.evaluate("() => { %s" % _MK + """
      const rects = [...mk(`<svg xmlns='http://www.w3.org/2000/svg'>
        <rect transform='translate(1, 152)'/>
        <rect transform='translate(1, 93.7)'/>
        <rect transform='translate(1, 94.1)'/>
        <rect transform='translate(1, 152.4)'/>
        <rect transform='translate(1, 152)'/>
      </svg>`).querySelectorAll('rect')];
      return clusterRowsByY(rects).map(row => row.length);
    }""")
    check('clusterRowsByY: sorted top→bottom, rounded → [2, 3]', r == [2, 3], str(r))


def test_unit_first_rect_fill(page):
    r = page.evaluate("() => { %s" % _MK + """
      const g = s => mk(`<svg xmlns='http://www.w3.org/2000/svg'><g>${s}</g></svg>`).querySelector('g');
      return {
        skipsWhite: _firstRectFill(g(`<rect style='fill: rgb(255,255,255)'/><rect style='fill: rgb(246,142,38)'/>`)),
        fillAttr:   _firstRectFill(g(`<rect fill='rgb(1,2,3)'/>`)),
        none:       _firstRectFill(g(`<rect/>`)),
      };
    }""")
    check('_firstRectFill: skips white, returns first colour', r['skipsWhite'] == 'rgb(246,142,38)', str(r))
    check('_firstRectFill: reads fill attribute too', r['fillAttr'] == 'rgb(1,2,3)', str(r))
    check('_firstRectFill: no colour → empty string', r['none'] == '', str(r))


# A synthetic stacked chart mirroring the real structure: legend text, a title
# above each row, positive + one 0-width rect per row, and value labels dumped
# after all rects. Row 1 = 3 rects (1 zero-width) + 2 labels; row 2 = 4 rects + 3.
SYNTH_STACKED = """<svg xmlns='http://www.w3.org/2000/svg' width='600' height='240'>
  <g id='chart-svg'>
    <text transform='translate(14, 40)'>Legend A</text>
    <text transform='translate(1, 73)'>Row One Title</text>
    <rect width='100' height='27' transform='translate(1, 94)'/>
    <rect width='0'   height='27' transform='translate(1, 94)'/>
    <rect width='50'  height='27' transform='translate(101, 94)'/>
    <line/>
    <text transform='translate(1, 131)'>Row Two Title</text>
    <rect width='80' height='27' transform='translate(1, 152)'/>
    <rect width='60' height='27' transform='translate(81, 152)'/>
    <rect width='40' height='27' transform='translate(141, 152)'/>
    <rect width='30' height='27' transform='translate(181, 152)'/>
    <text transform='translate(6, 98)'>v1</text>
    <text transform='translate(110, 98)'>v2</text>
    <text transform='translate(6, 157)'>w1</text>
    <text transform='translate(90, 157)'>w2</text>
    <text transform='translate(150, 157)'>w3</text>
  </g>
</svg>"""


def test_unit_synthesize_label_association(page):
    # The fragile bit: value labels join their row by band-containment, while the
    # legend and BOTH row titles (y=73 between nothing, y=131 between the rows)
    # must stay OUTSIDE every group.
    r = page.evaluate("(svg) => { %s" % _MK + """
      const root  = mk(svg);
      const groups = synthesizeStackedRows(root);
      const chart = root.querySelector('[id="chart-svg"]');
      const g = groups.map(grp => {
        const kids = [...grp.children];
        return {
          id: grp.getAttribute('id'),
          rects: kids.filter(k => k.tagName.toLowerCase() === 'rect').length,
          texts: kids.filter(k => k.tagName.toLowerCase() === 'text').map(t => t.textContent),
        };
      });
      // Texts still directly under chart-svg (i.e. NOT pulled into a row group).
      const looseTexts = [...chart.children]
        .filter(c => c.tagName.toLowerCase() === 'text').map(t => t.textContent);
      return { count: groups.length, g, looseTexts };
    }""", SYNTH_STACKED)

    check('synthesize: two row groups created', r['count'] == 2, str(r['count']))
    g0, g1 = r['g']
    check('synthesize: row 1 = 3 rects (incl 0-width) + labels [v1, v2]',
          g0['rects'] == 3 and g0['texts'] == ['v1', 'v2'], str(g0))
    check('synthesize: row 2 = 4 rects + labels [w1, w2, w3]',
          g1['rects'] == 4 and g1['texts'] == ['w1', 'w2', 'w3'], str(g1))
    check('synthesize: legend + both titles stay OUT of groups',
          sorted(r['looseTexts']) == ['Legend A', 'Row One Title', 'Row Two Title'], str(r['looseTexts']))


def test_unit_synthesize_gating_and_idempotency(page):
    r = page.evaluate("(svg) => { %s" % _MK + """
      // Non-stacked (nested columns-svg) → no-op.
      const nonStacked = synthesizeStackedRows(mk(`<svg xmlns='http://www.w3.org/2000/svg'>
        <g id='chart-svg'><rect width='9' height='9'/><g id='columns-svg'></g></g></svg>`)).length;
      // No chart-svg at all → no-op.
      const noChart = synthesizeStackedRows(mk(`<svg xmlns='http://www.w3.org/2000/svg'><g id='x'></g></svg>`)).length;
      // Idempotent: second pass returns the existing 2 and does not double-wrap.
      const root = mk(svg);
      const first  = synthesizeStackedRows(root).length;
      const second = synthesizeStackedRows(root).length;
      const total  = root.querySelectorAll('[data-row-wipe]').length;
      return { nonStacked, noChart, first, second, total };
    }""", SYNTH_STACKED)
    check('synthesize: non-stacked chart → no-op', r['nonStacked'] == 0, str(r))
    check('synthesize: missing chart-svg → no-op', r['noChart'] == 0, str(r))
    check('synthesize: idempotent (2 then 2, total 2)',
          r['first'] == 2 and r['second'] == 2 and r['total'] == 2, str(r))


def test_unit_detect_elements_row_labels(page):
    # detectElements emits one wipe_right element per row with an explicit
    # "Row N" label (NOT via _labelFromId, which would collapse both to "Row").
    r = page.evaluate("(svg) => { %s" % _MK + """
      const root = mk(svg);
      synthesizeStackedRows(root);
      return detectElements(root).map(e => ({ id: e.group_id, label: e.label, type: e.animation_type }));
    }""", SYNTH_STACKED)
    check('detectElements: 2 row elements', len(r) == 2, str(r))
    check('detectElements: distinct "Row 1"/"Row 2" labels (not collapsed)',
          [e['label'] for e in r] == ['Row 1', 'Row 2'], str([e['label'] for e in r]))
    check('detectElements: both wipe_right', all(e['type'] == 'wipe_right' for e in r), str(r))


# ── Unit tests: wipe geometry + injection (animate.js) ─────────────────────────
# Synthetic single-row groups exercise the wipe's measuring path in isolation,
# including the edge cases that separate it from a naive whole-chart clip.

def test_unit_wipe_geometry(page):
    r = page.evaluate("() => { %s" % _MK + """
      const g = rects => mk(`<svg xmlns='http://www.w3.org/2000/svg'><g>${rects}</g></svg>`).querySelector('g');

      // 1. Partial-width row: two segments spanning x 1→300 (NOT full plot width).
      //    Wipe must measure the row itself → w≈299, x=1 — never the whole chart.
      const partial = _wipeGeometry(g(`
        <rect width='150' height='27' transform='translate(1, 94)'/>
        <rect width='149' height='27' transform='translate(151, 94)'/>`));

      // 2. Trailing 0%-segment parked far right (x=400). The positive-area guard
      //    must drop it, so width stops at the last REAL segment (~100), not ~399.
      const zeroSeg = _wipeGeometry(g(`
        <rect width='100' height='27' transform='translate(1, 94)'/>
        <rect width='0'   height='27' transform='translate(400, 94)'/>`));

      // 3. Indented row: leftmost segment starts at x=50. Clip must start there.
      const indented = _wipeGeometry(g(`
        <rect width='80' height='27' transform='translate(50, 94)'/>
        <rect width='70' height='27' transform='translate(130, 94)'/>`));

      // 4. No rects → null (caller falls back to a whole-chart wipe).
      const noRects = _wipeGeometry(g(`<text>hi</text><line/>`));

      return { partial, zeroSeg, indented, noRects };
    }""")
    near = lambda a, b, tol=0.5: abs(a - b) <= tol

    check('wipe geo: partial-width row measures ITS OWN width (~299, not ~598)',
          near(r['partial']['w'], 299) and near(r['partial']['x'], 1), str(r['partial']))
    check('wipe geo: vertical antialias pad — y = top−2 (92), h = height+4 (31)',
          near(r['partial']['y'], 92) and near(r['partial']['h'], 31), str(r['partial']))
    check('wipe geo: trailing 0%-segment ignored — width stops at last real segment (~100)',
          near(r['zeroSeg']['w'], 100), str(r['zeroSeg']))
    check('wipe geo: indented row starts at its own left edge (x=50, w=150)',
          near(r['indented']['x'], 50) and near(r['indented']['w'], 150), str(r['indented']))
    check('wipe geo: group with no rects → null', r['noRects'] is None, str(r['noRects']))


def test_unit_wipe_inject(page):
    r = page.evaluate("() => { %s" % _MK + """
      const build = inner => {
        const svg  = mk(`<svg xmlns='http://www.w3.org/2000/svg'><defs></defs>${inner}</svg>`);
        return { svg, defs: svg.querySelector('defs') };
      };
      const readClip = (svg, id) => {
        const rect = svg.querySelector(`#${id} rect`);
        const anim = svg.querySelector(`#${id} animate`);
        return {
          x: +rect.getAttribute('x'), y: +rect.getAttribute('y'),
          w0: +rect.getAttribute('width'), h: +rect.getAttribute('height'),
          anim: { attr: anim.getAttribute('attributeName'),
                  from: +anim.getAttribute('from'), to: +anim.getAttribute('to'),
                  begin: anim.getAttribute('begin'), dur: anim.getAttribute('dur'),
                  fill: anim.getAttribute('fill') },
        };
      };

      // Normal: a measurable row group.
      const a = build(`<g id='row-1-svg'>
        <rect width='150' height='27' transform='translate(1, 94)'/>
        <rect width='149' height='27' transform='translate(151, 94)'/></g>`);
      const group = a.svg.querySelector('[id="row-1-svg"]');
      injectWipeRight(a.defs, 'clip-0', group, '1.5s', '2s', { x: 0, y: -60, w: 1290, h: 460 });
      const normal = readClip(a.svg, 'clip-0');
      normal.clipPath = group.getAttribute('clip-path');

      // Fallback: a group with no rects → whole-chart wipe from the passed bounds.
      const b = build(`<g id='blank'><text>x</text></g>`);
      const blank = b.svg.querySelector('[id="blank"]');
      injectWipeRight(b.defs, 'clip-1', blank, '0s', '2s', { x: 0, y: -60, w: 1290, h: 460 });
      const fallback = readClip(b.svg, 'clip-1');
      fallback.clipPath = blank.getAttribute('clip-path');

      return { normal, fallback };
    }""")
    near = lambda a, b, tol=0.5: abs(a - b) <= tol
    n, f = r['normal'], r['fallback']

    check('wipe inject: clip rect starts at width 0, animates width 0 → row width (~299)',
          n['w0'] == 0 and n['anim']['attr'] == 'width' and n['anim']['from'] == 0 and near(n['anim']['to'], 299),
          str(n))
    check('wipe inject: begin/dur passed through, holds final value (fill=freeze)',
          n['anim']['begin'] == '1.5s' and n['anim']['dur'] == '2s' and n['anim']['fill'] == 'freeze', str(n))
    check('wipe inject: group receives its clip-path', n['clipPath'] == 'url(#clip-0)', str(n))
    check('wipe inject: no-rects group falls back to whole-chart wipe (width 0 → bounds.w 1290)',
          near(f['anim']['to'], 1290) and near(f['h'], 460) and f['clipPath'] == 'url(#clip-1)', str(f))


# Content-based stacked horizontal bar detection (ADR 0006). These exercise the
# pure predicate/clustering directly on a parsed chart-svg — row-group synthesis
# and full detectElements wiring come in a later step.
STACKED_DETECT_JS = """
async (path) => {
  const svg   = await (await fetch(path)).text();
  const doc   = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const chart = doc.querySelector('[id="chart-svg"]');
  return {
    hasChart: !!chart,
    stacked:  isStackedBarChart(chart),
    rows:     chart ? clusterRowsByY(_positiveDirectRects(chart)).map(r => r.length) : [],
  };
}
"""


def test_detection_stacked(page):
    # The real Reuters/Ipsos survey: two rows of segments (3 + 4 positive-area
    # rects; the 0-width 0% segment is dropped by the positive-area guard).
    r = page.evaluate(STACKED_DETECT_JS, '/examples/stacked_bar_survey.svg')
    check('stacked fixture: detected as stacked', r['stacked'], str(r))
    check('stacked fixture: clusters into 2 rows of [3, 4]', r['rows'] == [3, 4], str(r['rows']))

    # Clause 2 must exclude every existing chart type — including test.svg, which
    # has a stray positive direct rect (clause 1 fires) but a nested lines-svg.
    for path in ('/examples/area_graph_bv.svg', '/examples/bar_chart_iphone.svg',
                 '/examples/multi_line_graph.svg', '/examples/scatter_plot.svg',
                 '/examples/test.svg'):
        r = page.evaluate(STACKED_DETECT_JS, path)
        name = path.split('/')[-1]
        check(f'{name}: NOT a false-positive stacked', r['stacked'] is False, str(r))


# Row-group synthesis: load the stacked fixture through the real loadSvgString
# pipeline and inspect the baked state (state.svg + state.elements).
STACKED_SYNTH_JS = """
async (path) => {
  const svg = await (await fetch(path)).text();
  loadSvgString(svg);

  const doc   = new DOMParser().parseFromString(state.svg, 'image/svg+xml');
  const groups = [...doc.querySelectorAll('[data-row-wipe]')].map(g => {
    const kids  = [...g.children];
    const rects = kids.filter(k => k.tagName.toLowerCase() === 'rect');
    const texts = kids.filter(k => k.tagName.toLowerCase() === 'text');
    const lastRectIdx = kids.map(k => k.tagName.toLowerCase()).lastIndexOf('rect');
    const firstTextIdx = kids.map(k => k.tagName.toLowerCase()).indexOf('text');
    return {
      id: g.getAttribute('id'),
      rects: rects.length,
      texts: texts.length,
      labelsAfterRects: firstTextIdx === -1 || firstTextIdx > lastRectIdx,
    };
  });

  // Idempotency: a second synthesis pass on a fresh parse must not double-wrap.
  const doc2 = new DOMParser().parseFromString(state.svg, 'image/svg+xml');
  const again = synthesizeStackedRows(doc2.documentElement);

  return {
    elements: state.elements.map(e => ({ id: e.group_id, label: e.label, type: e.animation_type, color: e.color })),
    baked: state.svg.includes('id=\\"row-1-svg\\"') && state.svg.includes('id=\\"row-2-svg\\"'),
    groups,
    idempotentCount: again.length,
    idempotentGroups: doc2.querySelectorAll('[data-row-wipe]').length,
  };
}
"""


def test_synthesis_stacked(page):
    r = page.evaluate(STACKED_SYNTH_JS, '/examples/stacked_bar_survey.svg')

    # §5: the real stacked chart also detects a header (bubble_up); filter to rows.
    els = [e for e in r['elements'] if e['id'].startswith('row-')]
    check('synthesis: 2 row elements emitted', len(els) == 2, str(els))
    check('synthesis: labels are "Row 1" / "Row 2"',
          [e['label'] for e in els] == ['Row 1', 'Row 2'], str([e['label'] for e in els]))
    check('synthesis: type is wipe_right', all(e['type'] == 'wipe_right' for e in els), str(els))
    check('synthesis: rows get a real colour swatch', all(e['color'] for e in els), str([e['color'] for e in els]))
    check('synthesis: header also detected as bubble_up',
          any(e['type'] == 'bubble_up' for e in r['elements']), str(r['elements']))

    check('synthesis: row-N-svg baked into state.svg', r['baked'], str(r['baked']))

    g = {x['id']: x for x in r['groups']}
    check('synthesis: row-1-svg has 4 rects + 2 labels',
          g.get('row-1-svg', {}).get('rects') == 4 and g['row-1-svg']['texts'] == 2, str(g.get('row-1-svg')))
    check('synthesis: row-2-svg has 4 rects + 3 labels',
          g.get('row-2-svg', {}).get('rects') == 4 and g['row-2-svg']['texts'] == 3, str(g.get('row-2-svg')))
    check('synthesis: labels sit after rects (z-order)',
          all(x['labelsAfterRects'] for x in r['groups']), str(r['groups']))

    check('synthesis: idempotent — returns existing 2, no double-wrap',
          r['idempotentCount'] == 2 and r['idempotentGroups'] == 2, str(r))


# Non-stacked charts must pass through synthesis untouched: state.svg stays the
# exact original string and no row groups are injected.
def test_synthesis_leaves_others_untouched(page):
    r = page.evaluate("""
      async (path) => {
        const svg = await (await fetch(path)).text();
        loadSvgString(svg);
        return { unchanged: state.svg === svg, hasRows: state.svg.includes('data-row-wipe') };
      }
    """, '/examples/multi_line_graph.svg')
    check('synthesis: non-stacked state.svg is byte-identical original', r['unchanged'], str(r))
    check('synthesis: non-stacked gets no row groups', r['hasRows'] is False, str(r))


def test_queue_all(page):
    page.evaluate(LOAD_EXAMPLE_JS, '/examples/bar_chart_iphone.svg')
    page.click('#queue-all-btn')
    queue_len = page.evaluate('state.queue.length')
    # §5: 10 bars + the header bubble_up element = 11.
    check('Queue all: queue fills with all detected series', queue_len == 11, f'queue={queue_len}')
    check('Queue all: button greys out after',
          page.eval_on_selector('#queue-all-btn', 'el => el.disabled'))

    # Removing one re-enables the button
    page.evaluate('document.querySelector(".remove-btn").click()')
    check('Queue all: re-enabled after removing an item',
          not page.eval_on_selector('#queue-all-btn', 'el => el.disabled'))


def test_camera_toggle_labels(page):
    # Regression: the Camera and split-draw checkboxes were wrapped in ONE
    # <label>, so a label's labeled control is only its first labelable
    # descendant — clicking the "split-draw" text toggled Camera, and the
    # split-draw box had no label of its own. Each must own its own label.
    # Also checks syncCamera() ran at init so state matches the (unticked) DOM.
    page.goto(BASE)
    r = page.evaluate("""
      () => {
        const cam = document.getElementById('camera-toggle');
        const split = document.getElementById('camera-split-toggle');
        return {
          camLabels: cam.labels.length,
          splitLabels: split.labels.length,
          distinct: cam.labels.length === 1 && split.labels.length === 1
                    && cam.labels[0] !== split.labels[0],
          stateCam: state.camera,
          splitDisabled: split.disabled,
        };
      }
    """)
    check('camera labels: Camera checkbox owns exactly one label', r['camLabels'] == 1, str(r))
    check('camera labels: split-draw owns its own label (not the Camera label)',
          r['splitLabels'] == 1, str(r))
    check('camera labels: the two checkboxes have distinct labels', r['distinct'], str(r))
    check('camera init: syncCamera ran — state.camera null + split disabled on unticked load',
          r['stateCam'] is None and r['splitDisabled'] is True, str(r))


def test_header_queue_and_footer_hide(page):
    # §5: the header is now an animatable element, so clicking it QUEUES it for
    # bubble-up (was: hides it). The footer is still a click-to-hide target.
    load_via_test_button(page)

    page.eval_on_selector('#svg-container [id*="container-header-svg"] text',
                          'el => el.dispatchEvent(new MouseEvent("click", {bubbles: true}))')
    queued = page.evaluate(
        'state.queue.some(q => q.group_id.includes("container-header-svg") '
        '&& q.animation_type === "bubble_up")')
    check('Click header: queued as bubble_up (not hidden)',
          queued and page.evaluate('state.hidden.size') == 0, str(queued))
    check('Click header: hidden panel stays empty',
          page.eval_on_selector('#hidden-panel', 'el => el.hidden'))

    page.eval_on_selector('#svg-container [id*="container-footer-svg"] text',
                          'el => el.dispatchEvent(new MouseEvent("click", {bubbles: true}))')
    check('Click footer: hidden', page.evaluate('state.hidden.size') == 1)

    page.click('.restore-btn')
    check('Restore footer: panel empties and hides',
          page.evaluate('state.hidden.size') == 0
          and page.eval_on_selector('#hidden-panel', 'el => el.hidden'))


def test_preview(page):
    load_via_test_button(page)
    page.click('#queue-all-btn')
    page.click('#preview-btn')
    page.wait_for_selector('#preview-container svg')

    n_animates = page.eval_on_selector_all('#preview-container animate', 'els => els.length')
    check('Preview: SMIL <animate> elements injected', n_animates > 0, f'got {n_animates}')

    bg_rect_hidden = page.evaluate(
        '() => _findBackgroundRect(document.querySelector("#preview-container svg"))'
        '?.style.display === "none"')
    check('Preview: SVG background rect hidden so CSS bg shows', bg_rect_hidden)

    for bg in ('white', 'black', 'checkerboard'):
        page.check(f'input[name="preview-bg"][value="{bg}"]')
        cls = page.eval_on_selector('#preview-container', 'el => el.className')
        check(f'Preview bg switcher: {bg}', cls == f'bg-{bg}', f'class={cls}')


def test_overhang_validation(page):
    load_via_test_button(page)
    page.click('#queue-all-btn')
    page.fill('.queue-row[data-index="0"] .start-time', '7.5')
    warn_visible = page.eval_on_selector(
        '.queue-row[data-index="0"] .overhang-warning', 'el => !el.hidden')
    check('Overhang: warning shows when start+dur > total', warn_visible)
    page.click('.queue-row[data-index="0"] .extend-btn')
    total = page.eval_on_selector('#total-duration', 'el => +el.value')
    check('Overhang: Extend button updates total duration', total == 9.5, f'total={total}')


def test_animated_svg_export_structure(page):
    """exportSvg path: buildAnimatedSvg output contains correct SMIL per type."""
    out = page.evaluate("""
      async () => {
        const svg   = await (await fetch('examples/multi_line_graph.svg')).text();
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: 'SALESFORCE-svg',  animation_type: 'draw_on', start_time: 0, element_duration: 2 },
          { group_id: 'area-fills-svg',  animation_type: 'fade_in', start_time: 1, element_duration: 2 },
        ]};
        const out = buildAnimatedSvg(svgEl, config);
        const clipAnim = out.querySelector('clipPath rect animate');
        const fadeAnim = out.querySelector('[id="area-fills-svg"] > animate');
        return {
          clip: clipAnim && { attr: clipAnim.getAttribute('attributeName'),
                              begin: clipAnim.getAttribute('begin'),
                              fill: clipAnim.getAttribute('fill') },
          fade: fadeAnim && { attr: fadeAnim.getAttribute('attributeName'),
                              begin: fadeAnim.getAttribute('begin') },
        };
      }
    """)
    check('exportSvg: draw_on gets clip width animate with freeze',
          out['clip'] and out['clip']['attr'] == 'width' and out['clip']['fill'] == 'freeze',
          json.dumps(out))
    check('exportSvg: fade_in gets opacity animate at start_time',
          out['fade'] and out['fade']['attr'] == 'opacity' and out['fade']['begin'] == '1s',
          json.dumps(out))


# ── Bar chart grow_from_baseline geometry ─────────────────────────────────────
#
# bar_chart_iphone.svg facts (read from the file):
#   zero line at y = 224.61 in columns-svg space
#   Q1 2024 (positive): rect top 179.91, height 44.70, bottom = 224.61 = baseline
#   Q2 2024 (negative): rect top 224.61, height 78.39 — hangs below the baseline
Q1, Q2 = 'Q1-svg 2024-0-svg', 'Q2-svg 2024-1-svg'
BASELINE = 224.61


def test_bar_export_clip_geometry(page):
    out = page.evaluate("""
      async ([q1, q2]) => {
        const svg   = await (await fetch('/examples/bar_chart_iphone.svg')).text();
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        document.body.appendChild(svgEl);   // live DOM so geometry resolves
        const config = { elements: [
          { group_id: q1, animation_type: 'grow_from_baseline', start_time: 0, element_duration: 2 },
          { group_id: q2, animation_type: 'grow_from_baseline', start_time: 0, element_duration: 2 },
        ]};
        const bounds = _clipBounds(svgEl);
        _setupExportClips(svgEl, config, bounds);

        const read = i => {
          const r = svgEl.querySelector(`#ecl-${i} rect`);
          return { y: +r.getAttribute('y'), h: +r.getAttribute('height'),
                   w: +r.getAttribute('width'), x: +r.getAttribute('x') };
        };
        const at = t => { _applyAtTime(svgEl, config, bounds, t); return [read(0), read(1)]; };

        const result = { t0: at(0), mid: at(1), end: at(2) };
        svgEl.remove();
        return result;
      }
    """, [Q1, Q2])

    t0, mid, end = out['t0'], out['mid'], out['end']
    near = lambda a, b, tol=1.0: abs(a - b) <= tol

    check('Bar export: clips start at height 0', t0[0]['h'] == 0 and t0[1]['h'] == 0, json.dumps(t0))
    check('Bar export: positive bar clip anchored at baseline, grows upward',
          near(t0[0]['y'] + t0[0]['h'], BASELINE) and near(mid[0]['y'] + mid[0]['h'], BASELINE)
          and mid[0]['y'] < BASELINE, json.dumps({'t0': t0[0], 'mid': mid[0]}))
    check('Bar export: positive bar fully revealed at end (height ≈ 44.7, top ≈ 179.9)',
          near(end[0]['h'], 44.7) and near(end[0]['y'], 179.9), json.dumps(end[0]))
    check('Bar export: negative bar anchored at baseline, grows downward',
          near(t0[1]['y'], BASELINE) and near(mid[1]['y'], BASELINE) and mid[1]['h'] > 0,
          json.dumps({'t0': t0[1], 'mid': mid[1]}))
    check('Bar export: negative bar fully revealed at end (height ≈ 78.4)',
          near(end[1]['h'], 78.4) and near(end[1]['y'], BASELINE), json.dumps(end[1]))
    check('Bar export: mid-animation height is ~half',
          near(mid[0]['h'], 44.7 / 2, 2) and near(mid[1]['h'], 78.4 / 2, 2),
          json.dumps(mid))
    check('Bar export: clip width covers the bar (~47.4 + padding)',
          end[0]['w'] >= 47.4 and end[0]['w'] <= 60, json.dumps(end[0]))


# ── Unit tests: wipe export (export.js per-frame) ─────────────────────────────
# Synthetic rows driven through _setupExportClips + _applyAtTime directly. A
# partial-width row (spans x 1→300, w≈299) proves the export reveals to the row's
# OWN width, not the whole chart; a start_time offset checks progress alignment.
def test_unit_wipe_export(page):
    out = page.evaluate("""
      () => {
        const svgEl = new DOMParser().parseFromString(`
          <svg xmlns='http://www.w3.org/2000/svg' width='600' height='240'>
            <g id='row-1-svg'>
              <rect width='150' height='27' transform='translate(1, 94)'/>
              <rect width='149' height='27' transform='translate(151, 94)'/>
            </g>
            <g id='blank'><text>x</text></g>
          </svg>`, 'image/svg+xml').documentElement;
        document.body.appendChild(svgEl);

        const config = { elements: [
          // Row starting at t=1 so we can check progress alignment off zero.
          { group_id: 'row-1-svg', animation_type: 'wipe_right', start_time: 1, element_duration: 2 },
          // No-rects group → fallback to whole-chart wipe.
          { group_id: 'blank',     animation_type: 'wipe_right', start_time: 0, element_duration: 2 },
        ]};
        const bounds = _clipBounds(svgEl);          // no viewBox → {x:0,y:-60,w:600,h:300}
        _setupExportClips(svgEl, config, bounds);

        const wOf = i => +svgEl.querySelector(`#ecl-${i} rect`).getAttribute('width');
        const dataW = i => +svgEl.querySelector(`#ecl-${i} rect`).getAttribute('data-w');
        const at = t => { _applyAtTime(svgEl, config, bounds, t); return { row: wOf(0), blank: wOf(1) }; };

        const result = {
          dataW_row: dataW(0), dataW_blank: dataW(1), boundsW: bounds.w,
          before: at(0.5),   // row not started yet (start_time=1)
          start:  at(1),     // p=0
          mid:    at(2),     // p=0.5
          end:    at(3),     // p=1
          after:  at(5),     // clamped at p=1
        };
        svgEl.remove();
        return result;
      }
    """)
    near = lambda a, b, tol=1.0: abs(a - b) <= tol

    check('wipe export: data-w stashed = row width (~299), not re-measured per frame',
          near(out['dataW_row'], 299), json.dumps(out))
    check('wipe export: no-rects fallback stashes whole-chart width (data-w = bounds.w)',
          near(out['dataW_blank'], out['boundsW']), json.dumps(out))
    check('wipe export: width is 0 before start_time (t=0.5, start=1)',
          out['before']['row'] == 0, json.dumps(out['before']))
    check('wipe export: progress clamps — 0 at start, ~half at mid, full (~299) at end',
          out['start']['row'] == 0 and near(out['mid']['row'], 149.5) and near(out['end']['row'], 299),
          json.dumps({'start': out['start'], 'mid': out['mid'], 'end': out['end']}))
    check('wipe export: width stays clamped at full past the end (no overshoot)',
          near(out['after']['row'], 299), json.dumps(out['after']))
    check('wipe export: fallback row reveals to whole-chart width at end',
          near(out['end']['blank'], out['boundsW']), json.dumps(out['end']))


# End-to-end: capture real frames of the stacked fixture and prove they actually
# CHANGE over time. If the wipe were a no-op, XMLSerializer would emit identical
# frozen frame-zero SVGs and every PNG would be byte-identical — the exact
# failure mode ADR 0003 exists to prevent.
def test_wipe_capture_animates(page):
    out = page.evaluate("""
      async () => {
        const svg = await (await fetch('/examples/stacked_bar_survey.svg')).text();
        loadSvgString(svg);                          // bakes row-N-svg into state.svg
        const config = { elements: [
          { group_id: 'row-1-svg', animation_type: 'wipe_right', start_time: 0, element_duration: 1 },
          { group_id: 'row-2-svg', animation_type: 'wipe_right', start_time: 1, element_duration: 1 },
        ]};
        const { frames } = await captureFrames(state.svg, config, 2, null, { fps: 5 });
        const sizes = await Promise.all(frames.map(async b => (await b.arrayBuffer()).byteLength));
        const first = new Uint8Array(await frames[0].arrayBuffer());
        const last  = new Uint8Array(await frames[frames.length - 1].arrayBuffer());
        const identical = first.length === last.length && first.every((v, k) => v === last[k]);
        return { n: frames.length, distinctSizes: new Set(sizes).size, identicalFirstLast: identical };
      }
    """)
    check('wipe capture: produced 10 frames (2s × 5fps)', out['n'] == 10, json.dumps(out))
    check('wipe capture: frames change over time (not frozen frame-zero)',
          out['distinctSizes'] > 1 and out['identicalFirstLast'] is False, json.dumps(out))


def test_bar_preview_smil_geometry(page):
    out = page.evaluate("""
      async ([q1, q2]) => {
        const svg   = await (await fetch('/examples/bar_chart_iphone.svg')).text();
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: q1, animation_type: 'grow_from_baseline', start_time: 0, element_duration: 2 },
          { group_id: q2, animation_type: 'grow_from_baseline', start_time: 0, element_duration: 2 },
        ]};
        const animated = buildAnimatedSvg(svgEl, config);
        const read = i => {
          const clip = animated.querySelector(`#clip-${i}`);
          const rect = clip.querySelector('rect');
          const anims = [...clip.querySelectorAll('animate')].map(a => ({
            attr: a.getAttribute('attributeName'),
            from: +a.getAttribute('from'), to: +a.getAttribute('to'),
          }));
          return { y0: +rect.getAttribute('y'), anims,
                   clipped: animated.querySelector(`[id="${i === 0 ? q1 : q2}"]`)
                            .getAttribute('clip-path') === `url(#clip-${i})` };
        };
        return [read(0), read(1)];
      }
    """, [Q1, Q2])

    pos, neg = out
    near = lambda a, b, tol=1.0: abs(a - b) <= tol
    pos_h = next((a for a in pos['anims'] if a['attr'] == 'height'), None)
    pos_y = next((a for a in pos['anims'] if a['attr'] == 'y'), None)
    neg_h = next((a for a in neg['anims'] if a['attr'] == 'height'), None)
    neg_y = next((a for a in neg['anims'] if a['attr'] == 'y'), None)

    check('Bar preview: both bars clipped to their own clip path',
          pos['clipped'] and neg['clipped'], json.dumps(out))
    check('Bar preview: positive bar height animates 0 → bar height with y sliding to bar top',
          pos_h and near(pos_h['to'], 44.7) and pos_y
          and near(pos_y['from'], BASELINE) and near(pos_y['to'], 179.9),
          json.dumps(pos))
    check('Bar preview: negative bar height animates 0 → bar height, y fixed at baseline',
          neg_h and near(neg_h['to'], 78.4) and neg_y is None and near(neg['y0'], BASELINE),
          json.dumps(neg))


def test_wipe_preview_smil_geometry(page):
    # Stacked-row wipe (ADR 0006): a per-row clip rect spanning the row height,
    # animating WIDTH 0 → full row width. Both rows are 100%-stacked so each
    # spans the full plot width (~598); height is row height (27) + 2×2px pad.
    out = page.evaluate("""
      async () => {
        const svg   = await (await fetch('/examples/stacked_bar_survey.svg')).text();
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        synthesizeStackedRows(svgEl);
        const config = { elements: [
          { group_id: 'row-1-svg', animation_type: 'wipe_right', start_time: 0, element_duration: 2 },
          { group_id: 'row-2-svg', animation_type: 'wipe_right', start_time: 0, element_duration: 2 },
        ]};
        const animated = buildAnimatedSvg(svgEl, config);
        const read = (i, id) => {
          const rect = animated.querySelector(`#clip-${i} rect`);
          const w = [...animated.querySelectorAll(`#clip-${i} animate`)]
            .find(a => a.getAttribute('attributeName') === 'width');
          return {
            x: +rect.getAttribute('x'), y: +rect.getAttribute('y'),
            h: +rect.getAttribute('height'), w0: +rect.getAttribute('width'),
            anim: w ? { attr: 'width', from: +w.getAttribute('from'), to: +w.getAttribute('to') } : null,
            clipped: animated.querySelector(`[id="${id}"]`).getAttribute('clip-path') === `url(#clip-${i})`,
          };
        };
        return [read(0, 'row-1-svg'), read(1, 'row-2-svg')];
      }
    """)
    near = lambda a, b, tol=1.0: abs(a - b) <= tol
    r1, r2 = out
    check('Wipe preview: both rows clipped to their own clip path',
          r1['clipped'] and r2['clipped'], json.dumps(out))
    check('Wipe preview: clip starts at width 0, grows to full row width (~598)',
          r1['w0'] == 0 and r1['anim'] and r1['anim']['from'] == 0 and near(r1['anim']['to'], 598, 2)
          and r2['anim'] and near(r2['anim']['to'], 598, 2), json.dumps(out))
    check('Wipe preview: clip height = row height + 2px pad each side (≈31)',
          near(r1['h'], 31) and near(r2['h'], 31), json.dumps(out))
    check('Wipe preview: clip y is row top − 2px pad (row1 ≈91.7, row2 ≈150.5)',
          near(r1['y'], 91.67) and near(r2['y'], 150.47), json.dumps(out))


def test_capture_frames(page):
    """Frame capture: count, dimensions, viewBox stamping (ADR 0004), bg hiding."""
    out = page.evaluate("""
      async () => {
        const svg = await (await fetch('/examples/bar_chart_iphone.svg')).text();
        const config = { elements: [
          { group_id: 'Q1-svg 2024-0-svg', animation_type: 'grow_from_baseline',
            start_time: 0, element_duration: 1 },
        ], hidden_ids: [] };
        const r = await captureFrames(svg, config, 1, null, { fps: 5, targetWidth: 1420 });
        return { n: r.frames.length, w: r.width, h: r.height,
                 sizes: r.frames.map(f => f.size) };
      }
    """)
    check('captureFrames: 5 frames at 5fps × 1s', out['n'] == 5, json.dumps(out))
    check('captureFrames: canvas scaled to targetWidth', out['w'] == 1420, json.dumps(out))
    check('captureFrames: aspect preserved (h ≈ 996 for 710×458+40 buffer)',
          abs(out['h'] - round((458 + 40) * 2)) <= 2, json.dumps(out))
    check('captureFrames: all frames are non-empty PNGs', all(s > 1000 for s in out['sizes']),
          json.dumps(out))


def test_camera_capture_end_to_end(page):
    # §3/§4 export wiring: captureFrames with the camera on must produce frames
    # and the plot transform must differ across time (the camera actually moved).
    out = page.evaluate("""
      async () => {
        const svg = await (await fetch('/examples/multi_line_graph.svg')).text();
        const config = { elements: [], hidden_ids: [],
          camera: { enabled: true, split_draw: true, duration: 2 } };
        const r = await captureFrames(svg, config, 2, null, { fps: 5, targetWidth: 800 });
        // Re-derive the plan the way captureFrames does, and confirm setup+apply
        // move the plot transform between t=0 and the summit.
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        await embedFonts(svgEl);
        const plan = await computeCameraPlan(svgEl, config);
        setupCamera(svgEl, plan);
        const plot = svgEl.querySelector('[id="svg-main-svg"]');
        applyCameraAtTime(svgEl, plan, 0);   const a = plot.getAttribute('transform');
        applyCameraAtTime(svgEl, plan, 1.0); const b = plot.getAttribute('transform');
        return { n: r.frames.length, sizes: r.frames.map(f => f.size),
                 hasPlan: !!plan, moved: a !== b };
      }
    """)
    check('camera capture: frames produced with camera enabled', out['n'] == 10, json.dumps(out))
    check('camera capture: all frames are non-empty PNGs', all(s > 1000 for s in out['sizes']),
          json.dumps(out))
    check('camera capture: a plan was computed and the plot transform moves over time',
          out['hasPlan'] and out['moved'], json.dumps(out))


def test_transparent_capture(page):
    """Regression: viewBox stamping (ADR 0004) must not defeat background-rect
    hiding — transparent frames must actually be mostly transparent."""
    out = page.evaluate("""
      async () => {
        const svg = await (await fetch('/examples/bar_chart_iphone.svg')).text();
        const config = { elements: [
          { group_id: 'Q1-svg 2024-0-svg', animation_type: 'grow_from_baseline',
            start_time: 0, element_duration: 1 },
        ], hidden_ids: [] };
        const { frames, width, height } = await captureFrames(
          svg, config, 1, null, { transparent: true, fps: 2, targetWidth: 710 });
        const img = await createImageBitmap(frames[1]);
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, width, height).data;
        let transparent = 0, total = px.length / 4;
        for (let i = 3; i < px.length; i += 4) if (px[i] === 0) transparent++;
        return { fraction: transparent / total };
      }
    """)
    check('Transparent capture: most of the canvas has alpha 0',
          out['fraction'] > 0.5, f"transparent fraction = {out['fraction']:.2f}")


def test_background_rect_detection(page):
    found = page.evaluate("""
      async () => {
        const svg   = await (await fetch('/examples/bar_chart_iphone.svg')).text();
        const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const bg = _findBackgroundRect(svgEl);
        return bg ? { w: bg.getAttribute('width'), h: bg.getAttribute('height') } : null;
      }
    """)
    check('Transparent export: background rect found on bar chart', found is not None, str(found))


def test_unit_embed_fonts(page):
    # Font-first (checklist §0). embedFonts inlines the Knowledge @font-face as
    # data-URIs into <defs>, gated on a Knowledge reference, idempotently.
    r = page.evaluate("""
      async () => {
        const NS = 'http://www.w3.org/2000/svg';
        const parse = s => new DOMParser().parseFromString(s, 'image/svg+xml').documentElement;

        // Datawrapper-style SVG that names Knowledge in an inline style.
        const dw = parse('<svg xmlns="' + NS + '"><defs/>' +
          '<text style="font-family: Knowledge;">hi</text></svg>');
        await embedFonts(dw);
        const style = dw.querySelector('style[data-embedded-fonts]');
        const css   = style ? style.textContent : '';

        // Idempotent: a second pass must not add a second <style>.
        await embedFonts(dw);
        const styleCount = dw.querySelectorAll('style[data-embedded-fonts]').length;

        // Gated: an SVG that never names Knowledge is left untouched.
        const plain = parse('<svg xmlns="' + NS + '"><text style="fill:#000">hi</text></svg>');
        const before = new XMLSerializer().serializeToString(plain);
        await embedFonts(plain);
        const plainUnchanged = new XMLSerializer().serializeToString(plain) === before;

        // Missing <defs>: embedFonts creates one.
        const noDefs = parse('<svg xmlns="' + NS + '"><text font-family="Knowledge">hi</text></svg>');
        await embedFonts(noDefs);
        const madeDefs = !!noDefs.querySelector('defs style[data-embedded-fonts]');

        return {
          hasStyle: !!style,
          faceCount: (css.match(/@font-face/g) || []).length,
          weights: [300, 700].every(w => css.includes('font-weight:' + w)),
          no400: !css.includes('font-weight:400'),
          dataUri: css.includes('src:url(data:font/woff;base64,'),
          styleCount, plainUnchanged, madeDefs,
        };
      }
    """)
    check('embedFonts: injects a marked <style> into defs', r['hasStyle'], str(r))
    check('embedFonts: two @font-face rules (300/700, no dead 400)',
          r['faceCount'] == 2 and r['weights'] and r['no400'], str(r))
    check('embedFonts: woff inlined as base64 data-URI', r['dataUri'], str(r))
    check('embedFonts: idempotent — one <style> after two passes', r['styleCount'] == 1, str(r))
    check('embedFonts: gated — SVG without Knowledge is byte-identical', r['plainUnchanged'], str(r))
    check('embedFonts: creates <defs> when absent', r['madeDefs'], str(r))


def test_unit_embed_fonts_partial(page):
    # allSettled, not all: if one weight's woff 404s, the others must still
    # embed. Old Promise.all rejected the whole build on a single failure, so
    # NOTHING embedded. Fresh page.goto = fresh module (null CSS cache) so the
    # fetch stub takes effect; the trailing reload clears the stub + partial
    # cache before later tests run.
    page.goto(BASE)
    r = page.evaluate("""
      async () => {
        const NS = 'http://www.w3.org/2000/svg';
        const real = window.fetch;
        window.fetch = (u, o) => String(u).includes('Bold')
          ? Promise.resolve(new Response('', { status: 404 }))
          : real(u, o);
        const dw = new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '"><defs/><text style="font-family: Knowledge;">hi</text></svg>',
          'image/svg+xml').documentElement;
        await embedFonts(dw);
        const css = (dw.querySelector('style[data-embedded-fonts]') || {}).textContent || '';
        window.fetch = real;
        return {
          faceCount: (css.match(/@font-face/g) || []).length,
          has300: css.includes('font-weight:300'),
          has700: css.includes('font-weight:700'),
        };
      }
    """)
    page.goto(BASE)  # discard the stubbed fetch and the partial-CSS cache
    check('embedFonts: a failed weight degrades that weight only (allSettled) — '
          '300 still embeds when 700 404s',
          r['faceCount'] == 1 and r['has300'] and not r['has700'], str(r))


def test_unit_trace_preview(page):
    # §1 / ADR 0008 #1: injectTrace draws a stroked line via stroke-dashoffset.
    r = page.evaluate("""
      () => {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '"><g id="ser">' +
          '<path id="p" style="fill: none; stroke: rgb(1,2,3);" d="M0,0 L10,10 L20,0"/>' +
          '</g></svg>', 'image/svg+xml').documentElement;
        injectTrace(svg.querySelector('#ser'), '0.5s', '2s');
        const p = svg.querySelector('#p');
        const a = p.querySelector('animate');
        return {
          pathLength: p.getAttribute('pathLength'),
          dasharray:  p.getAttribute('stroke-dasharray'),
          offset0:    p.getAttribute('stroke-dashoffset'),
          attr:  a && a.getAttribute('attributeName'),
          from:  a && a.getAttribute('from'),
          to:    a && a.getAttribute('to'),
          begin: a && a.getAttribute('begin'),
          dur:   a && a.getAttribute('dur'),
          fill:  a && a.getAttribute('fill'),
        };
      }
    """)
    check('trace preview: pathLength="1" + dasharray "1 1" + offset 1 (hidden)',
          r['pathLength'] == '1' and r['dasharray'] == '1 1' and r['offset0'] == '1', str(r))
    check('trace preview: animates stroke-dashoffset 1 → 0, freezing',
          r['attr'] == 'stroke-dashoffset' and r['from'] == '1' and r['to'] == '0'
          and r['fill'] == 'freeze', str(r))
    check('trace preview: begin/dur passed through', r['begin'] == '0.5s' and r['dur'] == '2s', str(r))


def test_unit_trace_export(page):
    # §1: the export twin (ADR 0003). Static dash attrs at setup; _applyAtTime
    # drives stroke-dashoffset = 1 − progress (no clip, no getTotalLength).
    r = page.evaluate("""
      () => {
        const NS = 'http://www.w3.org/2000/svg';
        const svgEl = new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '" width="100" height="100"><g id="ser">' +
          '<path style="fill: none;" d="M0,0 L50,50"/></g></svg>', 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: 'ser', animation_type: 'trace', start_time: 0, element_duration: 2 }] };
        const bounds = _clipBounds(svgEl);
        _setupExportClips(svgEl, config, bounds);
        const path = svgEl.querySelector('path');
        const setup = path.getAttribute('stroke-dashoffset');
        _applyAtTime(svgEl, config, bounds, 1);   // p = 0.5
        const mid = path.getAttribute('stroke-dashoffset');
        _applyAtTime(svgEl, config, bounds, 2);   // p = 1 → fully drawn
        const end = path.getAttribute('stroke-dashoffset');
        return { pathLength: path.getAttribute('pathLength'), setup, mid: +mid, end: +end };
      }
    """)
    check('trace export: setup sets pathLength + hidden offset 1',
          r['pathLength'] == '1' and r['setup'] == '1', str(r))
    check('trace export: dashoffset = 1 − progress (0.5 at half, 0 at end)',
          abs(r['mid'] - 0.5) < 1e-6 and abs(r['end']) < 1e-6, str(r))


def test_unit_dots_line_vs_scatter(page):
    # §1: distinguish a dots-rendered line (dense, → wipe) from a scatter plot
    # (sparse, → pop_in) by median dot spacing, and measure the dots-line wipe
    # geometry tightly (not the whole chart).
    r = page.evaluate("""
      () => {
        const NS = 'http://www.w3.org/2000/svg';
        const dot = 'M2.5,0A2.5,2.5,0,1,1,-2.5,0A2.5,2.5,0,1,1,2.5,0';
        const dots = (n, gap) => {
          let s = '';
          for (let i = 0; i < n; i++)
            s += '<g id="dot-svg" transform="translate(' + (10 + i*gap).toFixed(3) +
                 ', ' + (50 + (i % 7)).toFixed(2) + ')"><path d="' + dot +
                 '" style="fill: rgb(10,66,134);"/></g>';
          return s;
        };
        const parse = inner => new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '">' + inner + '</svg>', 'image/svg+xml').documentElement;

        const denseRoot  = parse('<g id="dots-svg">' + dots(200, 0.24) + '</g>').querySelector('#dots-svg');
        const sparseRoot = parse('<g id="dots-svg">' + dots(60, 4.6)  + '</g>').querySelector('#dots-svg');

        const geo = _dotsWipeGeometry(denseRoot);
        const noDots = _dotsWipeGeometry(
          parse('<g id="g"><rect width="5" height="5"/></g>').querySelector('#g'));

        // Detection routing through the real pipeline.
        const denseEls  = detectElements(parse('<g id="dots-svg">' + dots(200, 0.24) + '</g>'));
        const sparseEls = detectElements(parse('<g id="dots-svg">' + dots(60, 4.6)  + '</g>'));

        return {
          denseIsLine:  _dotsFormLine(denseRoot),
          sparseIsLine: _dotsFormLine(sparseRoot),
          geoX: geo.x, geoW: geo.w,             // x ≈ 10−2.5=7.5, w ≈ 199*0.24+5 ≈ 52.8
          noDots,
          denseType:  denseEls.length === 1 ? denseEls[0].animation_type : null,
          sparseType: sparseEls.length === 1 ? sparseEls[0].animation_type : null,
        };
      }
    """)
    check('dots discriminate: dense (0.24px gap) reads as a line',  r['denseIsLine'] is True, str(r))
    check('dots discriminate: sparse (4.6px gap) reads as scatter', r['sparseIsLine'] is False, str(r))
    check('dots wipe geo: tight to the dots, radius-padded (x≈7.5, w≈52.8)',
          abs(r['geoX'] - 7.5) < 0.1 and abs(r['geoW'] - 52.76) < 0.5, str(r))
    check('dots wipe geo: null when the group has no dots', r['noDots'] is None, str(r))
    check('detection: dense dots-svg → wipe_right', r['denseType'] == 'wipe_right', str(r))
    check('detection: sparse dots-svg → pop_in', r['sparseType'] == 'pop_in', str(r))


HEADER_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">'
              '<g id="hdr"><text transform="translate(0,0)">'
              '<tspan x="0" y="20" fill="rgb(1,2,3)" style="font-size:20px">Hi there</tspan>'
              '</text></g></svg>')


def test_unit_bubble_up_preview(page):
    # §5 / ADR 0007: measure header glyphs live, split into staggered rising units.
    r = page.evaluate("""
      async () => {
        const svgEl = new DOMParser().parseFromString(
          `%s`, 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: 'hdr', animation_type: 'bubble_up', start_time: 0, element_duration: 1 }] };
        const m = await measureBubbleUnits(svgEl, config);
        const animated = buildAnimatedSvg(svgEl, config, m);
        const g     = animated.querySelector('#hdr');
        const wrap  = g.querySelector('g');
        const units = [...g.querySelectorAll('text')];
        const begins = units.map(u => parseFloat(u.querySelector('animate').getAttribute('begin')));
        return {
          runCount:  m['hdr'] ? m['hdr'].length : 0,
          unitCount: units.length,
          firstText: units[0].querySelector('tspan').textContent,
          opacity0:  units[0].getAttribute('opacity'),
          startTf:   units[0].getAttribute('transform'),
          wrapTf:    wrap.getAttribute('transform'),
          hasMove:   units.every(u => !!u.querySelector('animateTransform')),
          freezes:   units.every(u => u.querySelector('animate').getAttribute('fill') === 'freeze'),
          staggered: begins.length > 1 && begins[begins.length - 1] > begins[0]
                     && begins.every((b, i) => i === 0 || b >= begins[i - 1]),
          within:    begins.every(b => b <= 1),   // whole intro inside the element window
        };
      }
    """ % HEADER_SVG.replace('`', ''))
    check('bubble preview: one run measured', r['runCount'] == 1, str(r))
    check('bubble preview: "Hi there" → 7 letter units (spaces dropped)', r['unitCount'] == 7, str(r))
    check('bubble preview: first unit is "H", starts hidden + risen',
          r['firstText'] == 'H' and r['opacity0'] == '0' and r['startTf'] == 'translate(0,10)', str(r))
    check('bubble preview: units wrapped in <g> with the run transform',
          r['wrapTf'] == 'translate(0,0)', str(r))
    check('bubble preview: each unit fades + translates, freezing',
          r['hasMove'] and r['freezes'], str(r))
    check('bubble preview: begins stagger left→right, within the window',
          r['staggered'] and r['within'], str(r))


def test_unit_bubble_up_word_mode(page):
    # ADR 0007's per-word toggle: "Hi there" → 2 word units.
    r = page.evaluate("""
      async () => {
        const svgEl = new DOMParser().parseFromString(`%s`, 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: 'hdr', animation_type: 'bubble_up', bubble_mode: 'word',
            start_time: 0, element_duration: 1 }] };
        const m = await measureBubbleUnits(svgEl, config);
        const animated = buildAnimatedSvg(svgEl, config, m);
        const units = [...animated.querySelectorAll('#hdr text')];
        return { count: units.length, first: units[0].querySelector('tspan').textContent };
      }
    """ % HEADER_SVG.replace('`', ''))
    check('bubble word mode: 2 word units', r['count'] == 2, str(r))
    check('bubble word mode: first unit is "Hi"', r['first'] == 'Hi', str(r))


def test_unit_bubble_up_export(page):
    # §5 export twin (ADR 0003): per-unit opacity/translate driven by data-bubble-*.
    r = page.evaluate("""
      async () => {
        const svgEl = new DOMParser().parseFromString(`%s`, 'image/svg+xml').documentElement;
        const config = { elements: [
          { group_id: 'hdr', animation_type: 'bubble_up', start_time: 0, element_duration: 1 }] };
        const m = await measureBubbleUnits(svgEl, config);
        const bounds = _clipBounds(svgEl);
        _setupExportClips(svgEl, config, bounds, m);
        const units = [...svgEl.querySelectorAll('#hdr text[data-bubble-begin]')];
        const first = units[0];
        _applyAtTime(svgEl, config, bounds, 0);
        const at0 = { op: first.getAttribute('opacity'), tf: first.getAttribute('transform') };
        _applyAtTime(svgEl, config, bounds, 1);
        const at1 = { op: first.getAttribute('opacity'), tf: first.getAttribute('transform') };
        return { count: units.length, dur: first.getAttribute('data-bubble-dur'), at0, at1 };
      }
    """ % HEADER_SVG.replace('`', ''))
    check('bubble export: 7 split units with timing data', r['count'] == 7, str(r))
    check('bubble export: at t=0 first unit hidden + fully risen',
          r['at0']['op'] == '0' and r['at0']['tf'] == 'translate(0,10.000)', str(r))
    check('bubble export: at end first unit opaque + at rest',
          r['at1']['op'] == '1' and r['at1']['tf'] == 'translate(0,0.000)', str(r))
    check('bubble export: unit dur capped to fit window (0.32)', r['dur'] == '0.32', str(r))


def test_unit_camera_frame_math(page):
    # §3/§2 pure frame math (camera.js). Deterministic — synthetic points whose
    # steepest fall is a known interior segment.
    r = page.evaluate("""
      () => {
        // y grows downward; index 3 (y=20) is the summit, then it dives to y≈82.
        const pts = [[0,50],[10,48],[20,52],[30,20],[40,80],[50,78],[60,82]];
        const stage = [0, 0, 100, 100];
        const drop  = findDrop(pts);
        const fr    = buildCameraFrames(pts, stage, 2.0);
        return {
          dropI: drop.i,
          frameCount: fr.frames.length,
          framesDrop: fr.drop,
          wideW: fr.frames[0][2],
          summitW: fr.frames[2][2],
          summitInStage: fr.frames[2][0] >= 0 && fr.frames[2][1] >= 0
            && fr.frames[2][0] + fr.frames[2][2] <= 100.01
            && fr.frames[2][1] + fr.frames[2][3] <= 100.01,
          sf0: splitFraction(pts, 0),
          sfEnd: splitFraction(pts, pts.length - 1),
          sfMid: splitFraction(pts, 3),
        };
      }
    """)
    check('camera math: findDrop locates the interior summit (i=3)', r['dropI'] == 3, str(r))
    check('camera math: six frames (wide,wide,summit,summit,held,held) + drop index',
          r['frameCount'] == 6 and r['framesDrop'] == 3, str(r))
    check('camera math: summit frame is tighter than wide', r['summitW'] < r['wideW'], str(r))
    check('camera math: summit frame clamped inside the stage', r['summitInStage'], str(r))
    check('camera math: splitFraction 0 at start, 1 at end, interior between',
          r['sf0'] == 0 and abs(r['sfEnd'] - 1) < 1e-9 and 0 < r['sfMid'] < 1, str(r))


def test_unit_camera_extraction(page):
    # §3/§4 read-only extraction against a live, committed chart. Structural
    # assertions + idempotency (extractors never mutate, so repeat = identical).
    r = page.evaluate("""
      async () => {
        const svg = await (await fetch('/examples/multi_line_graph.svg')).text();
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;height:600px';
        host.innerHTML = svg;
        document.body.appendChild(host);
        const svgEl = host.querySelector('svg');
        try {
          const path  = svgEl.querySelector('[id="lines-svg"] path');
          const before = new XMLSerializer().serializeToString(svgEl);
          const pts   = extractLinePoints(svgEl, path);
          const ticks = extractTicks(svgEl);
          const stage = detectStage(svgEl);
          const after = new XMLSerializer().serializeToString(svgEl);
          return {
            nPts: pts.length,
            firstFinite: Number.isFinite(pts[0][0]) && Number.isFinite(pts[0][1]),
            nX: ticks.x.length, nY: ticks.y.length,
            tickHasText: ticks.x.every(t => t.text) && ticks.y.every(t => t.text),
            stage,
            stageSane: stage[0] === 0 && stage[2] > 600 && stage[1] > 0
                       && stage[1] + stage[3] <= 443.5 && stage[3] > 0,
            readOnly: before === after,
            stable: extractLinePoints(svgEl, path).length === pts.length
                    && JSON.stringify(detectStage(svgEl)) === JSON.stringify(stage),
          };
        } finally { document.body.removeChild(host); }
      }
    """)
    check('camera extract: line path → many root-space points', r['nPts'] > 20 and r['firstFinite'], str(r))
    check('camera extract: x and y ticks parsed with text',
          r['nX'] > 0 and r['nY'] > 0 and r['tickHasText'], str(r))
    check('camera extract: stage is full-width, within canvas height', r['stageSane'], str(r['stage']))
    check('camera extract: extractors never mutate the SVG (read-only)', r['readOnly'], str(r))
    check('camera extract: idempotent — repeat calls identical', r['stable'], str(r))


def test_unit_camera_plan(page):
    # §3/§4 pure plan math (camera.js). Deterministic synthetic geometry.
    r = page.evaluate("""
      () => {
        const points = [[0,50],[10,48],[20,52],[30,20],[40,80],[50,78],[60,82]];
        const stage  = [0, 10, 300, 260];   // sx sy sw sh
        const ticks  = { y: [{x:0,y:40,text:'30'},{x:0,y:120,text:'20'}],
                         x: [{x:100,y:250,text:'Jan'},{x:200,y:250,text:'Feb'}] };
        const plan = buildCameraPlan(points, stage, ticks, 10, { ox: 0, oy: 50, gx: 20 });
        return {
          nFrames: plan.frames.length,
          scale0: plan.scales[0], scaleSummit: plan.scales[2],
          tx0: plan.tx[0], ty0: plan.ty[0],           // wide → original offset (ox,oy)
          yLabels: plan.yLabels.length, xLabels: plan.xLabels.length,
          yTrackLen: plan.yLabels[0].ys.length, yOpsLen: plan.yLabels[0].ops.length,
          yWideOp: plan.yLabels[0].ops[0],            // fully inside at wide → 1
          gridStartsLen: plan.gridStarts.length,
          hasSplit: typeof plan.splitFraction === 'number' && plan.splitFraction > 0,
        };
      }
    """)
    check('camera plan: six keyframes', r['nFrames'] == 6, str(r))
    check('camera plan: wide scale 1, summit scale > 1 (tighter)',
          r['scale0'] == 1 and r['scaleSummit'] > 1, str(r))
    check('camera plan: wide transform reproduces plot offset (tx=ox, ty=oy)',
          abs(r['tx0'] - 0) < 0.01 and abs(r['ty0'] - 50) < 0.01, str(r))
    check('camera plan: one label track per tick, 6 samples each',
          r['yLabels'] == 2 and r['xLabels'] == 2 and r['yTrackLen'] == 6 and r['yOpsLen'] == 6, str(r))
    check('camera plan: label fully inside at wide → opacity 1', r['yWideOp'] == 1, str(r))
    check('camera plan: gridline trim + split fraction present',
          r['gridStartsLen'] == 6 and r['hasSplit'], str(r))


def test_unit_camera_inject_smil(page):
    # §3/§4 SMIL injection structure + idempotency (camera.js).
    r = page.evaluate("""
      () => {
        const NS = 'http://www.w3.org/2000/svg';
        const svgEl = new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '" width="400" height="300">' +
          '<g id="svg-main-svg" transform="translate(0,50)">' +
            '<g id="group-svg" transform="translate(20,0)">' +
              '<g id="y-grid-lines-svg"><line x1="0" x2="300" y1="10" y2="10"/></g>' +
            '</g>' +
            '<g id="y-tick-labels-svg"><text><tspan>30</tspan></text></g>' +
            '<g id="x-tick-labels-svg"><text><tspan>Jan</tspan></text></g>' +
            '<path style="fill:none;stroke:red" d="M0,0 L100,100"/>' +
          '</g></svg>', 'image/svg+xml').documentElement;

        const points = [[0,50],[10,48],[20,52],[30,20],[40,80],[50,78],[60,82]];
        const ticks  = { y:[{x:0,y:40,text:'30'}], x:[{x:100,y:250,text:'Jan'}] };
        const plan = buildCameraPlan(points, [0,10,300,260], ticks, 10, { ox:0, oy:50, gx:20 });
        injectCameraSMIL(svgEl, plan);

        const plot = svgEl.querySelector('[id="svg-main-svg"]');
        const wrap = svgEl.querySelector('g[data-camera]');
        const line = svgEl.querySelector('[id="y-grid-lines-svg"] line');
        const before = svgEl.querySelectorAll('g[data-camera]').length;
        injectCameraSMIL(svgEl, plan);   // idempotency
        const after = svgEl.querySelectorAll('g[data-camera]').length;

        return {
          clipRect: !!svgEl.querySelector('clipPath#stage-clip rect'),
          wrapped:  !!wrap && wrap.querySelector('[id="svg-main-svg"]') === plot,
          nTransforms: plot.getElementsByTagName('animateTransform').length,
          hasScaleAdditive: [...plot.getElementsByTagName('animateTransform')]
            .some(a => a.getAttribute('type') === 'scale' && a.getAttribute('additive') === 'sum'),
          origYHidden: svgEl.querySelector('[id="y-tick-labels-svg"]').getAttribute('opacity') === '0',
          origXHidden: svgEl.querySelector('[id="x-tick-labels-svg"]').getAttribute('opacity') === '0',
          gridNonScaling: line.getAttribute('vector-effect') === 'non-scaling-stroke',
          gridAnimated: line.getElementsByTagName('animate').length === 1,
          axisLabels: svgEl.querySelector('g[data-camera-axes]')
            ? svgEl.querySelector('g[data-camera-axes]').getElementsByTagName('text').length : 0,
          idempotent: before === 1 && after === 1,
        };
      }
    """)
    check('camera SMIL: static stage clip rect created', r['clipRect'], str(r))
    check('camera SMIL: plot wrapped in a clip <g> (clip on wrapper, not plot)', r['wrapped'], str(r))
    check('camera SMIL: plot gets translate + additive-scale animateTransform',
          r['nTransforms'] == 2 and r['hasScaleAdditive'], str(r))
    check('camera SMIL: original tick labels hidden', r['origYHidden'] and r['origXHidden'], str(r))
    check('camera SMIL: gridline non-scaling-stroke + x1 trim animate',
          r['gridNonScaling'] and r['gridAnimated'], str(r))
    check('camera SMIL: anchored axis labels rebuilt (y + x)', r['axisLabels'] == 2, str(r))
    check('camera SMIL: idempotent — re-run does not double-wrap', r['idempotent'], str(r))


CAMERA_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">'
              '<g id="svg-main-svg" transform="translate(0,50)">'
                '<g id="group-svg" transform="translate(20,0)">'
                  '<g id="y-grid-lines-svg"><line x1="0" x2="300" y1="10" y2="10"/></g>'
                '</g>'
                '<g id="y-tick-labels-svg"><text><tspan>30</tspan></text></g>'
                '<g id="x-tick-labels-svg"><text><tspan>Jan</tspan></text></g>'
                '<path style="fill:none;stroke:red" d="M0,0 L100,100"/>'
              '</g></svg>')


def test_unit_camera_export(page):
    # §3/§4 export twin (ADR 0003): setupCamera scaffolds statically; applyCameraAtTime
    # writes the eased, interpolated transform + label positions per frame.
    r = page.evaluate("""
      () => {
        const svgEl = new DOMParser().parseFromString(`%s`, 'image/svg+xml').documentElement;
        const points = [[0,50],[10,48],[20,52],[30,20],[40,80],[50,78],[60,82]];
        const ticks  = { y:[{x:0,y:40,text:'30'}], x:[{x:100,y:250,text:'Jan'}] };
        const plan = buildCameraPlan(points, [0,10,300,260], ticks, 10, { ox:0, oy:50, gx:20 });
        setupCamera(svgEl, plan);
        const plot = svgEl.querySelector('[id="svg-main-svg"]');
        const scaleOf = () => parseFloat((plot.getAttribute('transform').match(/scale\\(([-\\d.]+)/) || [])[1]);
        const yLabel = svgEl.querySelector('text[data-cam-yi]');

        applyCameraAtTime(svgEl, plan, 0);      // wide
        const s0 = scaleOf(), y0 = yLabel.getAttribute('y');
        applyCameraAtTime(svgEl, plan, 4.8);    // ~summit (keytimes .46–.50)
        const sMid = scaleOf(), yMid = yLabel.getAttribute('y');

        const before = svgEl.querySelectorAll('g[data-camera]').length;
        setupCamera(svgEl, plan);               // idempotency
        const after = svgEl.querySelectorAll('g[data-camera]').length;

        return {
          scaffolded: !!svgEl.querySelector('g[data-camera]') && !!svgEl.querySelector('g[data-camera-axes]'),
          noAnimates: plot.getElementsByTagName('animateTransform').length === 0,
          s0, sMid, labelMoved: y0 !== yMid,
          idempotent: before === 1 && after === 1,
        };
      }
    """ % CAMERA_SVG.replace('`', ''))
    check('camera export: static scaffold (wrap + axes), no SMIL animates',
          r['scaffolded'] and r['noAnimates'], str(r))
    check('camera export: wide scale ≈ 1, summit scale > 1 (eased push-in)',
          abs(r['s0'] - 1) < 0.01 and r['sMid'] > 1.2, str(r))
    check('camera export: anchored label position moves between frames', r['labelMoved'], str(r))
    check('camera export: setupCamera idempotent', r['idempotent'], str(r))


def test_unit_split_trace(page):
    # §2 split-draw (camera.js): one stroke, two dashoffset ramps with a freeze
    # between — body draws to the dive, holds, then the tail finishes it.
    r = page.evaluate("""
      () => {
        const NS = 'http://www.w3.org/2000/svg';
        const mkGroup = () => new DOMParser().parseFromString(
          '<svg xmlns="' + NS + '"><g id="ser">' +
          '<path style="fill: none; stroke:red" d="M0,0 L50,50 L100,20"/></g></svg>',
          'image/svg+xml').documentElement.querySelector('#ser');

        // SMIL
        const g1 = mkGroup();
        const body = { begin: 0.8, dur: 2.0, spline: '0.33 1 0.68 1' };
        const tail = { begin: 5.0, dur: 3.0, spline: '0.65 0 0.35 1' };
        injectSplitTrace(g1, 0.7, body, tail);   // hold = 0.3
        const p1 = g1.querySelector('path');
        const anims = [...p1.getElementsByTagName('animate')];

        // Export twin
        const g2 = mkGroup();
        setupSplitTrace(g2, 0.7, body, tail);
        const p2 = g2.querySelector('path');
        const at = t => { applySplitTraceAtTime(g2, t); return +p2.getAttribute('stroke-dashoffset'); };
        const before = at(0.0);   // before body → fully hidden (1)
        const held   = at(4.0);   // between runs → frozen at hold (0.3)
        const bodyEnd = at(2.8);  // body just finished → hold
        const done   = at(9.0);   // after tail → drawn (0)

        return {
          pathLength: p1.getAttribute('pathLength'),
          twoAnims: anims.length === 2,
          bodyToHold: anims[0].getAttribute('from') === '1' && anims[0].getAttribute('to') === '0.3',
          tailFromHold: anims[1].getAttribute('from') === '0.3' && anims[1].getAttribute('to') === '0',
          before, held, bodyEnd, done,
        };
      }
    """)
    check('split-trace SMIL: pathLength=1, two dashoffset animates', r['pathLength'] == '1' and r['twoAnims'], str(r))
    check('split-trace SMIL: body 1→hold(0.3), tail hold→0',
          r['bodyToHold'] and r['tailFromHold'], str(r))
    check('split-trace export: hidden before, frozen at hold between, drawn after',
          r['before'] == 1 and abs(r['held'] - 0.3) < 1e-6 and abs(r['bodyEnd'] - 0.3) < 1e-6
          and r['done'] == 0, str(r))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on('pageerror', lambda e: print(f'  [pageerror] {e}'))

        for test in (
            test_load_and_detection,
            test_unit_embed_fonts,
            test_unit_trace_preview,
            test_unit_trace_export,
            test_unit_dots_line_vs_scatter,
            test_unit_bubble_up_preview,
            test_unit_bubble_up_word_mode,
            test_unit_bubble_up_export,
            test_unit_camera_frame_math,
            test_unit_camera_extraction,
            test_unit_camera_plan,
            test_unit_camera_inject_smil,
            test_unit_camera_export,
            test_unit_split_trace,
            test_detection_per_chart,
            test_unit_translate_y,
            test_unit_positive_direct_rects,
            test_unit_has_nested_chart_root,
            test_unit_is_stacked_bar_chart,
            test_unit_cluster_rows_by_y,
            test_unit_first_rect_fill,
            test_unit_synthesize_label_association,
            test_unit_synthesize_gating_and_idempotency,
            test_unit_detect_elements_row_labels,
            test_unit_wipe_geometry,
            test_unit_wipe_inject,
            test_unit_wipe_export,
            test_detection_stacked,
            test_synthesis_stacked,
            test_synthesis_leaves_others_untouched,
            test_queue_all,
            test_camera_toggle_labels,
            test_header_queue_and_footer_hide,
            test_preview,
            test_overhang_validation,
            test_animated_svg_export_structure,
            test_bar_export_clip_geometry,
            test_bar_preview_smil_geometry,
            test_wipe_preview_smil_geometry,
            test_wipe_capture_animates,
            test_capture_frames,
            test_camera_capture_end_to_end,
            test_transparent_capture,
            test_background_rect_detection,
            test_unit_embed_fonts_partial,
        ):
            print(f'\n── {test.__name__} ──')
            try:
                test(page)
            except Exception as e:
                check(f'{test.__name__} (no exception)', False, repr(e))

        browser.close()

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print(f'\n{len(results) - n_fail}/{len(results)} checks passed')
    sys.exit(FAIL if n_fail else PASS)


if __name__ == '__main__':
    main()
