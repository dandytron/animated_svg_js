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

function injectHoverCss(defs) {
  const style = _el('style');
  style.textContent = HOVER_CSS;
  defs.appendChild(style);
}

// ── Top-level builder ─────────────────────────────────────────────────────────

// Returns a new SVG *Element* (not a string) with SMIL animations injected.
// The original svgEl is not modified — this works on a deep clone.
function buildAnimatedSvg(svgEl, config) {
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
      case 'fade_in':
        injectFadeIn(group, begin, dur);
        break;
      case 'pop_in':
        injectPopIn(group, begin);
        break;
      case 'grow_from_baseline':
        injectGrowFromBaseline(defs, clipId, group, begin, dur, bounds);
        break;
      case 'radial_sweep':
        console.warn(`Radial Sweep not yet implemented — skipping "${elem.group_id}"`);
        break;
    }
  });

  injectHoverCss(defs);
  return clone;
}
