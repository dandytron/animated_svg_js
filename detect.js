// ── detect.js — JS port of detection.py ──────────────────────────────────────
//
// Two-layer model (mirrors the Python):
//   Generic Layer  — geometry signals, tool-agnostic
//   Datawrapper Adapter — id/style conventions specific to Datawrapper output
//
// All functions operate on live DOM elements (SVGElement / Element).

'use strict';

// ── Datawrapper Adapter ───────────────────────────────────────────────────────

function detectAnimationType(group) {
  const id = group.getAttribute('id') || '';

  // Signal 1 (Datawrapper): group id contains 'area-fills' → always Fade In
  if (id.includes('area-fills')) return 'fade_in';

  // Signal 2 (Datawrapper): any child path has inline 'fill: none' → Trace.
  // A stroke-only path is a real line, so draw it along its own path
  // (stroke-dashoffset) rather than the clip-wipe draw_on — truer, and correct
  // for non-monotonic lines. draw_on stays available as a manual option.
  // See checklist §1 / ADR 0008 #1.
  if (_hasStrokeOnlyPath(group)) return 'trace';

  // Signals 3 & 4: generic geometry
  return _detectGeneric(group);
}

function _hasStrokeOnlyPath(group) {
  for (const path of group.querySelectorAll('path')) {
    if ((path.getAttribute('style') || '').includes('fill: none')) return true;
  }
  return false;
}

// ── Generic Layer ─────────────────────────────────────────────────────────────

function _detectGeneric(group) {
  const tx = group.getAttribute('transform') || '';
  for (const path of group.querySelectorAll('path')) {
    const d = path.getAttribute('d') || '';

    // Signal 3a: arc commands + scale transform = dot/circle marker → Pop In
    if (/[Aa]/.test(d) && tx.includes('scale')) return 'pop_in';

    // Signal 3b: closed path (ends in Z) with a fill colour = filled area → Fade In
    const style = path.getAttribute('style') || '';
    if (/z\s*$/i.test(d.trim()) && !style.includes('fill: none')) return 'fade_in';
  }

  // Signal 3c: rect children = bar chart → Grow from Baseline
  if (group.querySelector('rect')) return 'grow_from_baseline';

  // Signal 4: nothing matched → Draw On (safest default for unknown line elements)
  return 'draw_on';
}

// ── Stacked horizontal bar (content-based) ────────────────────────────────────
//
// Datawrapper renders a horizontal stacked bar as flat, id-less <rect> siblings
// directly under the generic `chart-svg` wrapper — there is no lines/columns/
// areas container. Detection is therefore content-based, and gated so it never
// fires on a genuine line/area/scatter/column chart (all of which nest their
// real series root inside `chart-svg`). See ADR 0006.
//
// These functions are pure (they take a `chart-svg` element and return data);
// wiring into detectElements happens with row-group synthesis (a later step).

// Local translate-y parser. Kept here rather than borrowing animate.js's
// _parseTranslate so detect.js stays free of any forward dependency on animate.js.
function _translateY(el) {
  const m = ((el.getAttribute && el.getAttribute('transform')) || '')
    .match(/translate\(\s*-?[\d.eE+]+[,\s]+(-?[\d.eE+]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function _translateX(el) {
  const m = ((el.getAttribute && el.getAttribute('transform')) || '')
    .match(/translate\(\s*(-?[\d.eE+]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// A dots-svg container is EITHER a scatter plot (discrete points → pop_in) or a
// line rendered as thousands of tightly-packed dots (→ wipe). The discriminator
// is spacing, not count: a dots-line's adjacent dots sit far below their own
// diameter so they read as continuous, whereas scatter points stand apart.
// (SPR line: median x-gap 0.24px vs 5px dot ø; scatter: 4.6px.) See checklist §1.
//
// Local dot-radius parse rather than borrowing animate.js's _dotRadius — keeps
// detect.js free of any forward dependency on animate.js (same reason _translateY
// is duplicated here).
function _dotArcRadius(dot) {
  const p = dot.querySelector && dot.querySelector('path, circle');
  if (!p) return null;
  if (p.tagName.toLowerCase() === 'circle') return parseFloat(p.getAttribute('r')) || null;
  const m = (p.getAttribute('d') || '').match(/^M\s*[\d.]+\s*,\s*0\s*A\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function _dotsFormLine(dotsRoot) {
  const dots = [...dotsRoot.children].filter(c => c.tagName.toLowerCase() === 'g');
  if (dots.length < 50) return false; // too few marks to read as a rendered line
  const xs = dots.map(_translateX).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < 2) return false;
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[gaps.length >> 1];
  const r = _dotArcRadius(dots[0]) || 2.5;
  return medianGap < r; // sub-radius spacing ⇒ dots overlap ⇒ a continuous line
}

// Clause 1: positive-area direct-child rects. Same guard as _rectUnionBounds
// (animate.js:111), so the 0-width segment Datawrapper emits for a 0% category
// is correctly dropped.
function _positiveDirectRects(chartSvg) {
  return [...chartSvg.children].filter(c =>
    c.tagName.toLowerCase() === 'rect' &&
    parseFloat(c.getAttribute('width')  || '0') > 0 &&
    parseFloat(c.getAttribute('height') || '0') > 0);
}

// Clause 2 gate: a real line/area/scatter/column chart still nests its series
// container under chart-svg, so the presence of ANY known root excludes the
// stacked case. This is the robust discriminator — Clause 1 alone false-positives
// on charts that place a stray rect directly under chart-svg (e.g. test.svg).
function _hasNestedChartRoot(chartSvg) {
  return CONFIG.chartRoots.some(({ rootId }) =>
    chartSvg.querySelector(`[id="${_esc(rootId)}"]`) !== null);
}

// True when chartSvg is a horizontal stacked bar: has positive-area direct-child
// rects (clause 1) AND no nested chartRoots container (clause 2).
function isStackedBarChart(chartSvg) {
  return !!chartSvg &&
    _positiveDirectRects(chartSvg).length > 0 &&
    !_hasNestedChartRoot(chartSvg);
}

// Cluster rects into rows by rounded translate-y — conceptually the modal-edge
// trick _detectBaseline uses (animate.js:130), but grouping rather than
// collapsing. Returns rows sorted top→bottom, each an array of rects in
// document order.
function clusterRowsByY(rects) {
  const byY = new Map();
  for (const r of rects) {
    const y = Math.round(_translateY(r));
    (byY.get(y) || byY.set(y, []).get(y)).push(r);
  }
  return [...byY.keys()].sort((a, b) => a - b).map(y => byY.get(y));
}

// Tolerance (px) around a row's rect band when deciding whether a value label
// belongs to that row. Small on purpose: in the sample, the nearest non-label
// text (a row's title) sits ~11px outside the band, so a modest pad captures
// value labels without swallowing titles.
const LABEL_BAND_PAD = 4;

// First non-white segment fill in a group, for the queue colour swatch. Reads
// rects (which _extractColor deliberately ignores) so a stacked row gets a real
// colour instead of the grey default. Reuses _isWhite; leaves _extractColor
// untouched.
function _firstRectFill(group) {
  for (const r of group.querySelectorAll('rect')) {
    const m = (r.getAttribute('style') || r.getAttribute('fill') || '')
      .match(/(rgb\([^)]+\)|#[0-9a-fA-F]{3,6})/);
    if (m && !_isWhite(m[1])) return m[1];
  }
  return '';
}

// Wrap each row of a stacked horizontal bar in a synthesized <g id="row-N-svg">
// so the animation pipeline — which resolves each element to a SINGLE node via
// querySelector and sets one clip-path on it — can bind one wipe per row.
//
// Mutates svgEl in place. Gated (no-op unless chart-svg is a stacked bar) and
// idempotent (returns the existing groups if already synthesized), so re-running
// on the same DOM never double-wraps. Returns the row <g> elements top→bottom.
//
// Value labels are moved in AFTER the rects (label-on-top z-order) and associated
// to a row by y-band containment, NOT by count or document order: rows have
// unequal label counts and every label is dumped after both rows' rects. Legend
// and title texts fall outside every band and stay as static siblings. See ADR 0006.
function synthesizeStackedRows(svgEl) {
  const chart = svgEl.querySelector('[id="chart-svg"]');
  if (!chart) return [];

  // Idempotency check FIRST: once synthesized, the rects live inside the row
  // groups, so isStackedBarChart (which tests direct-child rects) would report
  // false and we'd skip the already-wrapped rows.
  const existing = [...chart.querySelectorAll('[data-row-wipe]')];
  if (existing.length) return existing;

  if (!isStackedBarChart(chart)) return [];

  const rows     = clusterRowsByY(_positiveDirectRects(chart)); // top→bottom, positive rects
  const allRects = [...chart.children].filter(c => c.tagName.toLowerCase() === 'rect');
  const texts    = [...chart.children].filter(c => c.tagName.toLowerCase() === 'text');

  return rows.map((posRects, i) => {
    const yKey = Math.round(_translateY(posRects[0]));
    const h    = Math.max(...posRects.map(r => parseFloat(r.getAttribute('height') || '0')));

    // Members: every direct-child rect on this row's y — including the 0-width
    // 0% segment (a no-op under the wipe, ADR §4) — then the value labels whose
    // baseline y falls inside the padded row band.
    const memberRects  = allRects.filter(r => Math.round(_translateY(r)) === yKey);
    const memberLabels = texts.filter(t => {
      const y = _translateY(t);
      return y >= yKey - LABEL_BAND_PAD && y <= yKey + h + LABEL_BAND_PAD;
    });

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', `row-${i + 1}-svg`);
    g.setAttribute('data-row-wipe', '');
    chart.insertBefore(g, memberRects[0]);          // keep the row in place
    memberRects.forEach(r => g.appendChild(r));     // rects first…
    memberLabels.forEach(t => g.appendChild(t));    // …labels on top
    return g;
  });
}

// ── Element discovery ─────────────────────────────────────────────────────────

function detectElements(svgEl) {
  const elements = [];
  const seen     = new Set();

  for (const entry of CONFIG.chartRoots) {
    const { rootId, select, childTag, defaultAnimation } = entry;
    const root = svgEl.querySelector(`[id="${_esc(rootId)}"]`);
    if (!root) continue;

    if (select === 'root') {
      if (!seen.has(rootId)) {
        seen.add(rootId);
        // A dense dots-svg is a line rendered as dots → wipe it left-to-right
        // instead of popping every point in at once. Sparse dots stay pop_in.
        const anim = (rootId === 'dots-svg' && _dotsFormLine(root))
          ? 'wipe_right' : defaultAnimation;
        elements.push(_makeElement(rootId, root, anim));
      }
    } else {
      for (const child of root.children) {
        if (childTag && child.tagName.toLowerCase() !== childTag) continue;
        const id = child.getAttribute('id');
        if (id && !seen.has(id)) {
          seen.add(id);
          elements.push(_makeElement(id, child, defaultAnimation));
        }
      }
    }
  }

  // Synthesized stacked-bar row groups (see synthesizeStackedRows). Emitted with
  // an explicit "Row N" label — NOT via _labelFromId, which strips the trailing
  // digit and would collapse every row to "Row".
  for (const rowG of svgEl.querySelectorAll('[data-row-wipe]')) {
    const id = rowG.getAttribute('id');
    if (seen.has(id)) continue;
    seen.add(id);
    elements.push({
      group_id:       id,
      label:          `Row ${(id.match(/(\d+)/) || [, '?'])[1]}`,
      animation_type: 'wipe_right',
      color:          _firstRectFill(rowG),
    });
  }

  // Header text-intro (ADR 0007 / checklist §5): the title+subtitle container is a
  // bubble-up candidate, emitted as ONE element — injectBubbleUp splits every text
  // run inside it. Matched by the container-header-svg segment of the compound id.
  const header = svgEl.querySelector('[id*="container-header-svg"]');
  if (header && header.querySelector('text')) {
    const id = header.getAttribute('id');
    if (id && !seen.has(id)) {
      seen.add(id);
      elements.push({ group_id: id, label: 'Header', animation_type: 'bubble_up', color: '' });
    }
  }

  return elements;
}

function _makeElement(id, domEl, defaultAnimation) {
  return {
    group_id:       id,
    label:          _labelFromId(id),
    animation_type: defaultAnimation ?? detectAnimationType(domEl),
    color:          _extractColor(domEl),
  };
}

// Convert a Datawrapper-style id like "RBNZ-svg actual-svg rate-svg"
// into a readable label like "RBNZ Actual Rate".
// Strips trailing numeric-only tokens — bar chart IDs end in a positional index
// (e.g. "Q1-svg 2024-0-svg") that has no display value.
function _labelFromId(id) {
  return id
    .replace(/-svg/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+\d+$/, '')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Pull the first non-white stroke or fill colour out of the element or its children.
// Checks the element itself first so bare <path> elements (e.g. areas-svg children)
// are handled without needing child traversal.
function _extractColor(group) {
  for (const el of [group, ...group.querySelectorAll('path, line, circle, polyline')]) {
    const style = el.getAttribute('style') || '';
    const stroke = style.match(/stroke:\s*(rgb\([^)]+\)|#[0-9a-fA-F]{3,6})/);
    if (stroke && !_isWhite(stroke[1])) return stroke[1];
    const fill = style.match(/fill:\s*(rgb\([^)]+\)|#[0-9a-fA-F]{3,6})/);
    if (fill && fill[1] !== 'none' && !_isWhite(fill[1])) return fill[1];
  }
  return '';
}

function _isWhite(color) {
  return /rgb\(\s*25[0-5],\s*25[0-5],\s*25[0-5]\s*\)/.test(color) ||
         /^#f{3,6}$/i.test(color) ||
         /^#fff/i.test(color);
}
