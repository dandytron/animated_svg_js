"""
Browser test harness — drives the real app at http://localhost:5001 with Playwright.

Covers the automatable parts of the smoke-test checklist (issue #16) plus
regression tests for detection, hiding, preview, frame capture, and the
per-bar grow_from_baseline geometry.

Run:  python3 tests/browser_test.py
Requires the Flask server to be running (python3 server.py).
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5001'

PASS, FAIL = 0, 1
results = []


def check(name, cond, detail=''):
    ok = bool(cond)
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ''))
    return ok


# Load an example SVG through the app's own pipeline (same path as loadTestSvg,
# minus the network fetch to Datawrapper).
LOAD_EXAMPLE_JS = """
async (path) => {
  const resp = await fetch(path);
  const svg  = await resp.text();
  state.svg      = svg;
  const svgEl    = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  state.elements = detectElements(svgEl);
  state.queue    = [];
  state.hidden   = new Set();
  injectSvg();
  renderQueue();
  document.getElementById('queue-section').hidden = false;
  return state.elements.map(e => ({ id: e.group_id, label: e.label, type: e.animation_type }));
}
"""


# Click the Test button and wait until the multi-line graph has actually been
# loaded and detected. #queue-section visibility is NOT a safe signal — it stays
# visible from a previous load, so a bare wait races against the async fetch.
def load_via_test_button(page):
    page.click('#test-btn')
    page.wait_for_function('state.elements.length === 5 && state.queue.length === 0')


def test_load_and_detection(page):
    # ── Test button: loads multi_line_graph via /test-svg ──
    page.goto(BASE)
    load_via_test_button(page)

    warning_hidden = page.eval_on_selector('#no-elements-warning', 'el => el.hidden')
    check('Test button: no "no elements" warning', warning_hidden)

    elements = page.evaluate('state.elements.map(e => ({id: e.group_id, label: e.label, type: e.animation_type}))')
    check('Test button: 5 elements detected (4 lines + area fills)', len(elements) == 5,
          f'got {len(elements)}: {[e["id"] for e in elements]}')

    labels = {e['label'] for e in elements}
    check('Labels are human-readable (WORKDAY CLASS A, not raw id)',
          'WORKDAY CLASS A' in labels, f'labels: {labels}')

    types = {e['id']: e['type'] for e in elements}
    check('Lines detected as draw_on',
          all(t == 'draw_on' for i, t in types.items() if i != 'area-fills-svg'), str(types))
    check('Area fills detected as fade_in', types.get('area-fills-svg') == 'fade_in', str(types))


def test_detection_per_chart(page):
    expectations = {
        '/examples/area_graph_bv.svg':    (10, {'fade_in'}),
        '/examples/bar_chart_iphone.svg': (10, {'grow_from_baseline'}),
        '/examples/scatter_plot.svg':     (1,  {'pop_in'}),
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


def test_queue_all(page):
    page.evaluate(LOAD_EXAMPLE_JS, '/examples/bar_chart_iphone.svg')
    page.click('#queue-all-btn')
    queue_len = page.evaluate('state.queue.length')
    check('Queue all: queue fills with all detected series', queue_len == 10, f'queue={queue_len}')
    check('Queue all: button greys out after',
          page.eval_on_selector('#queue-all-btn', 'el => el.disabled'))

    # Removing one re-enables the button
    page.evaluate('document.querySelector(".remove-btn").click()')
    check('Queue all: re-enabled after removing an item',
          not page.eval_on_selector('#queue-all-btn', 'el => el.disabled'))


def test_title_footer_hiding(page):
    load_via_test_button(page)

    page.eval_on_selector('#svg-container [id*="container-header-svg"] text',
                          'el => el.dispatchEvent(new MouseEvent("click", {bubbles: true}))')
    check('Click title: appears in Hidden elements panel',
          not page.eval_on_selector('#hidden-panel', 'el => el.hidden'))
    check('Click title: dims in stage',
          page.eval_on_selector('#svg-container [id*="container-header-svg"]',
                                'el => el.style.opacity === "0.15"'))

    page.eval_on_selector('#svg-container [id*="container-footer-svg"] text',
                          'el => el.dispatchEvent(new MouseEvent("click", {bubbles: true}))')
    check('Click footer: also hidden', page.evaluate('state.hidden.size') == 2)

    page.click('.restore-btn')
    page.click('.restore-btn')
    check('Restore both: panel empties and hides',
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
        const svg   = await (await fetch('/test-svg')).json().then(j => j.svg);
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


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on('pageerror', lambda e: print(f'  [pageerror] {e}'))

        for test in (
            test_load_and_detection,
            test_detection_per_chart,
            test_queue_all,
            test_title_footer_hiding,
            test_preview,
            test_overhang_validation,
            test_animated_svg_export_structure,
            test_bar_export_clip_geometry,
            test_bar_preview_smil_geometry,
            test_capture_frames,
            test_transparent_capture,
            test_background_rect_detection,
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
