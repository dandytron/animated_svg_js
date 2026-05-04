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

  // Signal 2 (Datawrapper): any child path has inline 'fill: none' → Draw On
  // (Datawrapper encodes stroke-only paths this way; other tools may use fill="none")
  if (_hasStrokeOnlyPath(group)) return 'draw_on';

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
  for (const path of group.querySelectorAll('path')) {
    const d   = path.getAttribute('d') || '';
    const tx  = group.getAttribute('transform') || '';

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

// ── Element discovery ─────────────────────────────────────────────────────────

function detectElements(svgEl) {
  const elements = [];
  const seen     = new Set();

  for (const rootId of CONFIG.selectableRoots) {
    const root = svgEl.querySelector(`[id="${_esc(rootId)}"]`);
    if (!root) continue;

    if (rootId === 'area-fills-svg') {
      // The root group itself is the single animatable element for area fills
      if (!seen.has(rootId)) {
        seen.add(rootId);
        elements.push(_makeElement(rootId, root));
      }
    } else {
      // Each direct child <g> of lines-svg is one series
      for (const child of root.children) {
        const id = child.getAttribute('id');
        if (id && !seen.has(id)) {
          seen.add(id);
          elements.push(_makeElement(id, child));
        }
      }
    }
  }

  return elements;
}

function _makeElement(id, domEl) {
  return {
    group_id:       id,
    label:          _labelFromId(id),
    animation_type: detectAnimationType(domEl),
    color:          _extractColor(domEl),
  };
}

// Convert a Datawrapper-style id like "RBNZ-svg actual-svg rate-svg"
// into a readable label like "RBNZ Actual Rate".
function _labelFromId(id) {
  return id
    .replace(/-svg/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// Pull the first non-white stroke or fill colour out of child paths.
function _extractColor(group) {
  for (const el of group.querySelectorAll('path, line, circle, polyline')) {
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

// Escape double-quotes inside an id for use in attribute selectors.
function _esc(id) {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
