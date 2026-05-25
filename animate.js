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

function injectGrowFromBaseline(defs, clipId, group, begin, dur, bounds) {
  // Two synchronised animations move the clip rect's top edge upward while its
  // height grows — keeping the bottom edge anchored at the chart baseline.
  const clip = _el('clipPath');
  clip.setAttribute('id', clipId);
  const rect = _el('rect');
  rect.setAttribute('x',      bounds.x);
  rect.setAttribute('y',      bounds.y + bounds.h); // start at baseline
  rect.setAttribute('width',  bounds.w);
  rect.setAttribute('height', '0');
  _animate(rect, 'height', 0,               bounds.h,            dur, begin);
  _animate(rect, 'y',      bounds.y + bounds.h, bounds.y,        dur, begin);
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

function _esc(id) {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
