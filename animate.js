// ── animate.js — JS port of animate_svg.py ───────────────────────────────────
//
// Injects SMIL <animate> elements into a cloned SVG for LIVE PREVIEW only.
//
// Export uses a separate JS-driven system in export.js. See DESIGN_DOC for why:
// SMIL animation state lives in the browser's rendering engine, not the DOM.
// XMLSerializer always captures the static (frame-zero) attribute values,
// so SMIL-animated SVGs cannot be serialised frame-by-frame for canvas capture.

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Same hover CSS as the Python prototype — :has() lets us dim non-hovered
// series in one rule with no JS event listeners.
const HOVER_CSS = `
.series-group {
  cursor: pointer;
  transition: opacity 0.25s ease, filter 0.25s ease;
}
#lines-svg:has(.series-group:hover) .series-group:not(:hover) {
  opacity: 0.12;
  filter: grayscale(50%);
}
.series-group:hover {
  filter: drop-shadow(0 0 5px rgba(0,0,0,0.4));
}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _el(tag) {
  return document.createElementNS(SVG_NS, tag);
}

// Read the SVG viewBox and return clip bounds with generous vertical padding
// so dots at series endpoints are never clipped.
function _clipBounds(svgEl) {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [x, y, w, h] = vb.trim().split(/\s+/).map(Number);
    return { x, y: y - 60, w, h: h + 60 };
  }
  // Datawrapper SVGs have no viewBox — coordinate space equals pixel space,
  // so width/height attributes give the correct clip dimensions.
  const w = parseFloat(svgEl.getAttribute('width'));
  const h = parseFloat(svgEl.getAttribute('height'));
  if (Number.isFinite(w) && Number.isFinite(h)) {
    return { x: 0, y: -60, w, h: h + 60 };
  }
  console.warn('animate.js: SVG has no viewBox and no width/height — using hardcoded clip bounds. Animation will likely be clipped incorrectly.');
  return { x: 0, y: -60, w: 1290, h: 460 };
}

// Append a SMIL <animateTransform type="translate"> to parent. Companion to
// _animate for the one animation (bubble-up) that moves rather than clips/fades.
function _animateTranslate(parent, from, to, dur, begin) {
  const a = _el('animateTransform');
  a.setAttribute('attributeName', 'transform');
  a.setAttribute('type',  'translate');
  a.setAttribute('from',  from);
  a.setAttribute('to',    to);
  a.setAttribute('dur',   dur);
  a.setAttribute('begin', begin);
  a.setAttribute('fill',  'freeze');
  parent.appendChild(a);
  return a;
}

// Append a SMIL <animate> to parent and return it.
function _animate(parent, attr, from, to, dur, begin) {
  const a = _el('animate');
  a.setAttribute('attributeName', attr);
  a.setAttribute('from',  String(from));
  a.setAttribute('to',    String(to));
  a.setAttribute('dur',   dur);
  a.setAttribute('begin', begin);
  a.setAttribute('fill',  'freeze'); // hold final value after animation ends
  parent.appendChild(a);
  return a;
}

// ── Injection functions (mirror animate_svg.py) ───────────────────────────────

function injectClipPath(defs, clipId, begin, dur, bounds) {
  const clip = _el('clipPath');
  clip.setAttribute('id', clipId);
  const rect = _el('rect');
  rect.setAttribute('x',      bounds.x);
  rect.setAttribute('y',      bounds.y);
  rect.setAttribute('width',  '0');
  rect.setAttribute('height', bounds.h);
  _animate(rect, 'width', 0, bounds.w, dur, begin);
  clip.appendChild(rect);
  defs.appendChild(clip);
}

// Stroke-only paths in a group (Datawrapper encodes a line as fill:none). A line
// series is usually one, but a group may hold several. Includes the group itself
// when it is a bare <path> (some chart roots resolve to one).
function _strokePaths(group) {
  const cands = group.tagName.toLowerCase() === 'path'
    ? [group] : [...group.querySelectorAll('path')];
  return cands.filter(p =>
    (p.getAttribute('style') || '').includes('fill: none') ||
    p.getAttribute('fill') === 'none');
}

// Radius of a Datawrapper dot mark. Dots render as an arc "M<r>,0A<r>,<r>…" (or,
// rarely, a <circle r>). Used to pad the dots-line wipe and to judge dot spacing.
function _dotRadius(dot) {
  const p = dot.tagName.toLowerCase() === 'path' ? dot : dot.querySelector('path, circle');
  if (!p) return null;
  if (p.tagName.toLowerCase() === 'circle') return parseFloat(p.getAttribute('r')) || null;
  const m = (p.getAttribute('d') || '').match(/^M\s*[\d.]+\s*,\s*0\s*A\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// Trace draw-on (checklist §1 / ADR 0008 #1): draw a stroked line along its own
// path by animating stroke-dashoffset 1→0. pathLength="1" renormalises each path
// to unit length so the dash values are fractions — no getTotalLength(), which
// matters because export.js runs on detached DOM with no layout. Truer than the
// clip-wipe draw_on: a non-monotonic line draws in real point order instead of
// having its backtracks revealed left-to-right. Operates on the path(s), not a
// clip, so it needs no defs entry.
function injectTrace(group, begin, dur) {
  for (const path of _strokePaths(group)) {
    path.setAttribute('pathLength', '1');
    path.setAttribute('stroke-dasharray', '1 1');
    path.setAttribute('stroke-dashoffset', '1');
    _animate(path, 'stroke-dashoffset', 1, 0, dur, begin);
  }
}

function injectFadeIn(group, begin, dur) {
  group.setAttribute('opacity', '0');
  _animate(group, 'opacity', 0, 1, dur, begin);
}

function injectPopIn(group, begin) {
  // dur="0s" makes the group appear instantaneously at the given beat.
  group.setAttribute('opacity', '0');
  _animate(group, 'opacity', 0, 1, '0s', begin);
}

// ── Bar geometry (grow_from_baseline) ─────────────────────────────────────────

// Parse the translate(x[, y]) component of an element's transform attribute.
function _parseTranslate(el) {
  const m = ((el.getAttribute && el.getAttribute('transform')) || '')
    .match(/translate\(\s*(-?[\d.eE+]+)(?:[,\s]+(-?[\d.eE+]+))?/);
  return { x: m ? parseFloat(m[1]) : 0, y: m && m[2] !== undefined ? parseFloat(m[2]) : 0 };
}

// Union bounding box of all <rect> descendants of group, in the group's own
// coordinate space. Attribute-based (x/y/width/height + translate transforms)
// rather than getBBox so it works on detached DOM (DOMParser output).
function _rectUnionBounds(group) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
  for (const r of group.querySelectorAll('rect')) {
    const w = parseFloat(r.getAttribute('width')  || '0');
    const h = parseFloat(r.getAttribute('height') || '0');
    if (!(w > 0) || !(h > 0)) continue;
    let x = parseFloat(r.getAttribute('x') || '0');
    let y = parseFloat(r.getAttribute('y') || '0');
    for (let node = r; node && node !== group; node = node.parentElement) {
      const t = _parseTranslate(node);
      x += t.x; y += t.y;
    }
    found = true;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  return found ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

// Find the chart's zero line in the bar group's local space: the y value most
// often shared by sibling bar edges. Positive bars sit ON the baseline and
// negative bars hang FROM it, so it's the most repeated top/bottom edge across
// the group's siblings. Returns null when fewer than two edges coincide
// (single bar, or no shared zero line to infer).
function _detectBaseline(group) {
  const parent = group.parentElement;
  if (!parent) return null;
  const counts = new Map();
  for (const sib of parent.children) {
    const b = _rectUnionBounds(sib);
    if (!b) continue;
    const ty = _parseTranslate(sib).y;
    for (const edge of [b.y + ty, b.y + b.h + ty]) {
      const key = Math.round(edge * 10) / 10;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return bestN >= 2 ? best - _parseTranslate(group).y : null;
}

// Geometry for one bar's grow clip: where the bar is, and whether it grows
// upward (sits on the baseline) or downward (hangs below it — negative value).
// Returns null when the group contains no rects; callers fall back to the
// whole-chart clip so grow applied to non-bar elements still works.
function _growGeometry(group) {
  const b = _rectUnionBounds(group);
  if (!b) return null;
  const baseline = _detectBaseline(group);
  const down = baseline !== null &&
    Math.abs(b.y - baseline) < Math.abs(b.y + b.h - baseline);
  const pad = 2; // antialias headroom so bar edges are never shaved
  return { x: b.x - pad, w: b.w + pad * 2, h: b.h, top: b.y, bottom: b.y + b.h, down };
}

// Geometry for one stacked row's left-to-right wipe. Mirrors _growGeometry's
// element-measuring path (_rectUnionBounds + antialias pad), but the growth axis
// is WIDTH, not height — so the pad goes on the fixed (vertical) axis. A
// 100%-stacked row has no zero line; its "baseline" is simply the left edge, so
// there is no baseline detection here. Returns null when the group has no rects
// (caller falls back to a whole-chart wipe). See ADR 0006 §2.
function _wipeGeometry(group) {
  const b = _rectUnionBounds(group);
  if (!b) return null;
  const pad = 2; // antialias headroom so row top/bottom edges are never shaved
  return { x: b.x, y: b.y - pad, w: b.w, h: b.h + pad * 2 };
}

// Wipe geometry for a line rendered as thousands of tightly-packed dots (SPR
// chart): dots carry no width/height, so _rectUnionBounds can't see them. Measure
// the dot marks' translated centres and pad by the dot radius so the first and
// last dots aren't shaved. Mirrors _wipeGeometry's {x,y,w,h} output shape.
// Returns null when the group has no positioned dot marks (caller falls back to
// _wipeGeometry's rect path, then whole-chart). See checklist §1.
function _dotsWipeGeometry(group) {
  const dots = [...group.children].filter(c =>
    c.tagName.toLowerCase() === 'g' && /translate/.test(c.getAttribute('transform') || ''));
  if (!dots.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of dots) {
    const t = _parseTranslate(d);
    minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
    minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y);
  }
  const r = _dotRadius(dots[0]) || 2.5;
  return { x: minX - r, y: minY - r, w: (maxX - minX) + 2 * r, h: (maxY - minY) + 2 * r };
}

function injectGrowFromBaseline(defs, clipId, group, begin, dur, bounds) {
  const geo  = _growGeometry(group);
  const clip = _el('clipPath');
  clip.setAttribute('id', clipId);
  const rect = _el('rect');
  if (geo) {
    // Per-bar clip in the group's own space, anchored at the chart's zero line.
    // Positive bars: top edge slides up as height grows (bottom edge pinned).
    // Negative bars: top edge pinned at the zero line, height grows downward.
    rect.setAttribute('x',      geo.x);
    rect.setAttribute('width',  geo.w);
    rect.setAttribute('height', '0');
    if (geo.down) {
      rect.setAttribute('y', geo.top);
      _animate(rect, 'height', 0, geo.h, dur, begin);
    } else {
      rect.setAttribute('y', geo.bottom);
      _animate(rect, 'height', 0,          geo.h,   dur, begin);
      _animate(rect, 'y',      geo.bottom, geo.top, dur, begin);
    }
  } else {
    // No rects to measure (grow applied to a line or area) — whole-chart clip
    // growing up from the bottom edge.
    rect.setAttribute('x',      bounds.x);
    rect.setAttribute('y',      bounds.y + bounds.h);
    rect.setAttribute('width',  bounds.w);
    rect.setAttribute('height', '0');
    _animate(rect, 'height', 0,                   bounds.h, dur, begin);
    _animate(rect, 'y',      bounds.y + bounds.h, bounds.y, dur, begin);
  }
  clip.appendChild(rect);
  defs.appendChild(clip);
  group.setAttribute('clip-path', `url(#${clipId})`);
}

// Stacked-row wipe: a clip rect spanning the row's height, growing in WIDTH
// 0→full so the whole stack fills left-to-right as one unit with segment
// boundaries fixed (segments are pinned by absolute translate-x; animating their
// widths directly would leave right-hand segments floating over gaps). Modeled
// on injectGrowFromBaseline with the axis swapped. See ADR 0006 §2.
function injectWipeRight(defs, clipId, group, begin, dur, bounds) {
  // Rects (stacked-bar rows) first; dots-as-line (SPR) second; whole-chart last.
  const geo  = _wipeGeometry(group) || _dotsWipeGeometry(group);
  const clip = _el('clipPath');
  clip.setAttribute('id', clipId);
  const rect = _el('rect');
  if (geo) {
    rect.setAttribute('x',      geo.x);
    rect.setAttribute('y',      geo.y);
    rect.setAttribute('width',  '0');
    rect.setAttribute('height', geo.h);
    _animate(rect, 'width', 0, geo.w, dur, begin);
  } else {
    // No rects to measure — whole-chart wipe from the left edge (like draw_on).
    rect.setAttribute('x',      bounds.x);
    rect.setAttribute('y',      bounds.y);
    rect.setAttribute('width',  '0');
    rect.setAttribute('height', bounds.h);
    _animate(rect, 'width', 0, bounds.w, dur, begin);
  }
  clip.appendChild(rect);
  defs.appendChild(clip);
  group.setAttribute('clip-path', `url(#${clipId})`);
}

// ── Text-intro: bubble-up (ADR 0007 / checklist §5) ───────────────────────────
//
// Datawrapper writes the header as one <text>/<tspan> run, so a per-unit stagger
// is impossible inside it — the run must be split into one <text> per unit, each
// starting low + transparent and floating up on a stagger. The split needs the
// real glyph positions (getStartPositionOfChar), which needs a live layout AND
// the real font (checklist §0 — a fallback face measures ~27% wider). So the
// measure step (measureBubbleUnits) runs on a live, font-embedded probe up front;
// the split step (_splitBubbleRuns) then builds from those stored coords and
// needs no layout, so it works in both the SMIL preview and the detached-DOM
// export. Per-unit timing is the shared data across the two systems (ADR 0003).

const BUBBLE = {
  rise:       10,     // px each unit floats up from
  unitDur:    0.32,   // one unit's arrival time (capped to fit the element window)
  staggerCap: 0.045,  // max gap between consecutive units
  runGapCap:  0.18,   // max head-start of run r+1 behind run r (title → subtitle)
};

// Group measured characters into the units that animate together (ADR 0007's
// per-letter | per-word toggle). Spaces are dropped; a word keeps its first
// glyph's position as its anchor.
function _groupUnits(chars, mode) {
  if (mode === 'word') {
    const words = [];
    let cur = null;
    for (const c of chars) {
      if (c.c === ' ') { cur = null; continue; }
      if (!cur) { cur = { text: c.c, x: c.x, y: c.y }; words.push(cur); }
      else cur.text += c.c;
    }
    return words;
  }
  return chars.filter(c => c.c !== ' ').map(c => ({ text: c.c, x: c.x, y: c.y }));
}

// Measure every text run in a header group: per-glyph local positions (real
// font), plus the run's transform/style/fill needed to rebuild it. The group
// MUST be laid out live — getStartPositionOfChar returns zeros on detached DOM.
function _measureRuns(group, mode) {
  const runs = [];
  for (const text of group.querySelectorAll('text')) {
    const span = text.querySelector('tspan');
    const s = (span || text).textContent || '';
    if (!s.trim()) continue;
    const chars = [];
    for (let i = 0; i < s.length; i++) {
      let p = null;
      try { p = text.getStartPositionOfChar(i); } catch { /* unrenderable index */ }
      chars.push({ c: s[i], x: p ? +p.x.toFixed(2) : 0, y: p ? +p.y.toFixed(2) : 0 });
    }
    runs.push({
      transform: text.getAttribute('transform') || '',
      style:     (span || text).getAttribute('style') || '',
      fill:      (span || text).getAttribute('fill')  || '#000',
      units:     _groupUnits(chars, mode),
    });
  }
  return runs;
}

// Live-probe measurement pass: for every bubble_up element in the config, mount a
// font-embedded clone offscreen, wait for the font, and measure its runs. Returns
// { group_id: [run, …] }. Async and DOM-touching; call once per build, before the
// (synchronous, possibly detached) split. Callers must have run embedFonts first.
async function measureBubbleUnits(svgEl, config) {
  const targets = (config.elements || []).filter(e => e.animation_type === 'bubble_up');
  if (!targets.length) return {};

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;height:1400px;overflow:hidden;pointer-events:none';
  host.innerHTML = new XMLSerializer().serializeToString(svgEl);
  document.body.appendChild(host);
  const live = host.querySelector('svg');
  try {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }
    const out = {};
    for (const elem of targets) {
      const group = live.querySelector(`[id="${_esc(elem.group_id)}"]`);
      if (group) out[elem.group_id] = _measureRuns(group, elem.bubble_mode || 'letter');
    }
    return out;
  } finally {
    document.body.removeChild(host);
  }
}

// Replace a header group's text runs with staggered, rising per-unit <text>.
// Shared by both systems: `smil` true adds <animate>/<animateTransform> for the
// preview; false leaves each unit at its start state and stamps data-bubble-*
// timing so export.js can drive opacity/translate per frame. `begin`/`dur` are
// the element's start_time/element_duration (seconds); the whole intro lands
// inside that window. Wrapping each run in a <g> carrying its transform keeps
// the split units from drifting (ADR 0007).
function _splitBubbleRuns(group, runs, begin, dur, smil) {
  for (const t of [...group.querySelectorAll('text')]) t.remove();

  runs.forEach((run, ri) => {
    const g = _el('g');
    if (run.transform) g.setAttribute('transform', run.transform);

    const n       = run.units.length;
    const unitDur = Math.min(BUBBLE.unitDur, dur * 0.5);
    const window  = Math.max(0, dur - unitDur);
    const stagger = n > 1 ? Math.min(BUBBLE.staggerCap, window / (n - 1)) : 0;
    const runGap  = Math.min(BUBBLE.runGapCap, window * 0.2) * ri;

    run.units.forEach((u, k) => {
      const t0   = +(begin + runGap + k * stagger).toFixed(3);
      const text = _el('text');
      text.setAttribute('x', u.x);
      text.setAttribute('y', u.y);
      text.setAttribute('fill', run.fill);
      if (run.style) text.setAttribute('style', run.style);
      text.setAttribute('opacity', '0');
      text.setAttribute('transform', `translate(0,${BUBBLE.rise})`);

      const span = _el('tspan');
      span.setAttribute('fill', run.fill);
      span.textContent = u.text;
      text.appendChild(span);

      if (smil) {
        _animate(text, 'opacity', 0, 1, `${unitDur}s`, `${t0}s`);
        _animateTranslate(text, `0 ${BUBBLE.rise}`, '0 0', `${unitDur}s`, `${t0}s`);
      } else {
        text.setAttribute('data-bubble-begin', t0);
        text.setAttribute('data-bubble-dur',   unitDur);
        text.setAttribute('data-bubble-rise',  BUBBLE.rise);
      }
      g.appendChild(text);
    });
    group.appendChild(g);
  });
}

// SMIL bubble-up for the preview. `runs` are the measured runs for this group
// (measureBubbleUnits); begin/dur are the element's start_time/element_duration.
function injectBubbleUp(group, runs, begin, dur) {
  if (runs && runs.length) _splitBubbleRuns(group, runs, begin, dur, true);
}

function injectHoverCss(defs) {
  const style = _el('style');
  style.textContent = HOVER_CSS;
  defs.appendChild(style);
}

// ── Top-level builder ─────────────────────────────────────────────────────────

// Returns a new SVG *Element* (not a string) with SMIL animations injected.
// The original svgEl is not modified — this works on a deep clone.
//
// `measurements` is the optional bubble_up glyph-measurement map from
// measureBubbleUnits (keyed by group_id); required only when the config contains
// a bubble_up element, since split positions can't be measured on this clone.
function buildAnimatedSvg(svgEl, config, measurements = {}, cameraPlan = null) {
  const clone  = svgEl.cloneNode(true);
  const bounds = _clipBounds(clone);

  let defs = clone.querySelector('defs');
  if (!defs) {
    defs = _el('defs');
    clone.insertBefore(defs, clone.firstChild);
  }

  config.elements.forEach((elem, i) => {
    const group = clone.querySelector(`[id="${_esc(elem.group_id)}"]`);
    if (!group) {
      console.warn(`animate.js: group '${elem.group_id}' not found in SVG — element skipped`);
      return;
    }

    const clipId = `clip-${i}`;
    const begin  = `${elem.start_time}s`;
    const dur    = `${elem.element_duration}s`;

    group.classList.add('series-group');

    switch (elem.animation_type) {
      case 'draw_on':
        injectClipPath(defs, clipId, begin, dur, bounds);
        group.setAttribute('clip-path', `url(#${clipId})`);
        break;
      case 'trace':
        injectTrace(group, begin, dur);
        break;
      case 'fade_in':
        injectFadeIn(group, begin, dur);
        break;
      case 'pop_in':
        injectPopIn(group, begin);
        break;
      case 'grow_from_baseline':
        injectGrowFromBaseline(defs, clipId, group, begin, dur, bounds);
        break;
      case 'wipe_right':
        injectWipeRight(defs, clipId, group, begin, dur, bounds);
        break;
      case 'bubble_up':
        injectBubbleUp(group, measurements[elem.group_id], elem.start_time, elem.element_duration);
        break;
      case 'radial_sweep':
        console.warn(`Radial Sweep not yet implemented — skipping "${elem.group_id}"`);
        break;
    }
  });

  // Camera is a whole-chart effect (checklist §3/§4), applied after the per-series
  // animations and driven by a separate config.camera block (camera.js) — kept
  // out of the per-element switch above. No-op unless a plan was computed.
  if (cameraPlan) injectCameraSMIL(clone, cameraPlan, (config.camera || {}));

  injectHoverCss(defs);
  return clone;
}
