// ── camera.js — data-driven camera + anchored axes (checklist §3/§4) ──────────
//
// A camera move is a WHOLE-CHART effect, not a per-series animation: it pushes
// in on the data's steepest fall and pulls back to hold it, while the header,
// legend and footer stay put. So it lives in its own module and is driven from a
// single config.camera block, kept out of the per-element animation switch.
//
// This file is split in two layers:
//   Layer 1 (here now) — PURE frame math + READ-ONLY extraction. No DOM writes,
//     so every function is idempotent by construction: pure functions return the
//     same value, extractors only read. This is the layer that carries the
//     single-sample risk (can we recover good points/ticks/stage from the DOM?),
//     so it ships and is validated first.
//   Layer 2 (next) — injection into both animation systems (SMIL + per-frame).
//
// Extraction runs against a LIVE, font-embedded SVG: getScreenCTM/getBBox need a
// layout. The pilot did this headless (scratch_folder/extract_ticks.py); its own
// note says "the JS tool already lives in a browser and can call the same APIs
// directly — the extraction step disappears entirely in the port." This is that.

'use strict';

const _round2 = v => Math.round(v * 100) / 100;

// ── Pure frame math (ports of stage_camera.py) ────────────────────────────────

// A frame of width w centred on (cx, cy) in the stage's aspect, clamped so the
// camera never roams past the plot band (which would reveal header/footer from
// underneath). Returns [x, y, w, h].
function _cameraFrame(cx, cy, w, stage) {
  const [sx, sy, sw, sh] = stage;
  const h = w * sh / sw;
  const x = Math.min(Math.max(cx - w / 2, sx), sx + Math.max(sw - w, 0));
  const y = Math.min(Math.max(cy - h / 2, sy), sy + Math.max(sh - h, 0));
  return [_round2(x), _round2(y), _round2(w), _round2(h)];
}

// Steepest sustained fall: the (i, j) pair maximising y[j] − y[i] within a
// forward window (y grows downward in SVG, so a fall is an increase). `i` is the
// summit index — also the split point for the §2 split-draw. Pure.
function findDrop(points, window = 60) {
  let best = [0, 0, 0]; // [drop, i, j]
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < Math.min(i + window, points.length); j++) {
      const d = points[j][1] - points[i][1];
      if (d > best[0]) best = [d, i, j];
    }
  }
  return { i: best[1], j: best[2] };
}

// Wide → in tight on the summit → back out far enough to hold the whole fall.
// Six frames (each held for two keytimes: wide, wide, summit, summit, held,
// held) plus the drop index. The pull-back is sized to the fall then clamped to
// the stage — on a fall spanning most of the band the clamp returns the default
// view, the honest answer (no framing both tighter and still holding the drop).
// Pure. See stage_camera.build_frames.
function buildCameraFrames(points, stage, tight = 2.8) {
  const [sx, sy, sw, sh] = stage;
  const wide = [sx, sy, sw, sh];
  const { i } = findDrop(points);
  const peak = points[i];
  const dip  = points.slice(i);

  const w = sw / tight;
  const h = w * sh / sw;
  // Peak set left-of-centre and high in frame: the fall runs down and to the
  // right, so that is where the empty space is wanted.
  const summit = _cameraFrame(peak[0] + w * 0.15, peak[1] + h * 0.30, w, stage);

  const ys = dip.map(p => p[1]), xs = dip.map(p => p[0]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const need = Math.max((x1 - x0) * 1.24, (y1 - y0) * 1.16 * sw / sh);
  const held = _cameraFrame((x0 + x1) / 2, (y0 + y1) / 2, Math.min(need, sw), stage);

  return { frames: [wide, wide, summit, summit, held, held], drop: i };
}

// Fraction of a polyline's length lying before point i — the §2 split-draw pause
// point, measured off the series' own segment lengths (no getTotalLength, so it
// survives export's detached DOM the way pathLength="1" does). Pure.
function splitFraction(points, i) {
  let total = 0, before = 0;
  for (let k = 0; k < points.length - 1; k++) {
    const dx = points[k + 1][0] - points[k][0];
    const dy = points[k + 1][1] - points[k][1];
    const seg = Math.hypot(dx, dy);
    total += seg;
    if (k < i) before += seg;
  }
  return total ? before / total : 0;
}

// ── Read-only extraction (live SVG required) ──────────────────────────────────

// First element whose id STARTS WITH prefix (Datawrapper ids are compound, e.g.
// "svg-main-svg …"). Read-only.
function _findByIdPrefix(svgEl, prefix) {
  return [...svgEl.querySelectorAll('g[id]')]
    .find(el => (el.getAttribute('id') || '').startsWith(prefix)) || null;
}

// element-local → SVG-root matrix (needs live layout). Falls back to getCTM when
// getScreenCTM is unavailable (e.g. detached — then coordinates are best-effort).
function _rootMatrix(svgEl, el) {
  const root = svgEl.getScreenCTM && svgEl.getScreenCTM();
  if (root && el.getScreenCTM && el.getScreenCTM()) return root.inverse().multiply(el.getScreenCTM());
  return el.getCTM ? el.getCTM() : null;
}

function _apply(m, x, y) {
  return m ? [_round2(m.a * x + m.c * y + m.e), _round2(m.b * x + m.d * y + m.f)] : [_round2(x), _round2(y)];
}

// Parse a stroked line path's M/L points into SVG-root user space. Datawrapper
// line paths are all absolute M/L. Read-only.
function extractLinePoints(svgEl, pathEl) {
  const d = pathEl.getAttribute('d') || '';
  const m = _rootMatrix(svgEl, pathEl);
  const pts = [];
  const re = /[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g;
  let mt;
  while ((mt = re.exec(d))) pts.push(_apply(m, parseFloat(mt[1]), parseFloat(mt[2])));
  return pts;
}

// Dot-rendered line (SPR): each dot's translated centre → root user space. All
// dots share the container's matrix, so it's resolved once. Read-only.
function extractDotPoints(svgEl, dotsRoot) {
  const dots = [...dotsRoot.children].filter(c =>
    c.tagName.toLowerCase() === 'g' && /translate/.test(c.getAttribute('transform') || ''));
  if (!dots.length) return [];
  const m = _rootMatrix(svgEl, dotsRoot);
  return dots.map(dot => {
    const t = (dot.getAttribute('transform') || '').match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
    return _apply(m, t ? parseFloat(t[1]) : 0, t ? parseFloat(t[2]) : 0);
  });
}

// Axis tick labels — text, root-space anchor, authored font size, text-anchor —
// for the x and y axes. Port of scratch_folder/extract_ticks.py's browser probe.
// Glued month+year ("April2025") is re-split. Read-only; needs live layout.
function extractTicks(svgEl) {
  const rootCTM = svgEl.getScreenCTM && svgEl.getScreenCTM();
  const inv = rootCTM ? rootCTM.inverse() : null;
  const read = prefix => {
    const g = _findByIdPrefix(svgEl, prefix);
    if (!g) return [];
    return [...g.querySelectorAll('text')].map(t => {
      let x = 0, y = 0;
      if (inv && t.getScreenCTM && t.getScreenCTM()) {
        const m = inv.multiply(t.getScreenCTM());
        x = _round2(m.e); y = _round2(m.f); // the text's own origin (0,0) → root
      }
      const span = t.querySelector('tspan');
      const fs = span ? parseFloat(getComputedStyle(span).fontSize) : 12;
      const text = (t.textContent || '').trim().replace(/([A-Za-z.])(\d{4})$/, '$1 $2');
      const anchor = (getComputedStyle(t).textAnchor) || 'start';
      return { text, x, y, fontSize: _round2(fs || 12), anchor };
    }).filter(d => d.text);
  };
  return { y: read('y-tick-labels-svg'), x: read('x-tick-labels-svg') };
}

// Root-space bounding box of a live element (getBBox × root matrix, over the 4
// corners). Read-only. Returns {x, y, w, h} or null.
function _rootBBox(svgEl, el) {
  let b;
  try { b = el.getBBox(); } catch { return null; }
  if (!b || !(b.width > 0)) return null;
  const m = _rootMatrix(svgEl, el);
  const corners = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([x, y]) => _apply(m, x, y));
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ── Camera plan (pure) + SMIL injection (checklist §3/§4) ─────────────────────

// Axis-anchoring constants (ports of stage_camera.py).
const CAM = {
  gutter:     24,    // stage-left strip the y labels live in (px)
  gutterGap:   6,    // gap between a y label and where its gridline starts
  labelSize:  13,
  labelLag:  0.10,   // seconds the labels trail the plot ("scrolly" feel)
  xLabelHalf: 23,    // half a date label's width, for edge fade tests
  yLabelHalf:  8,    // half a number label's height
};

// Default camera timing — the China pilot's proven curve: hold wide, ease in to
// the summit, then ease back out borrowing the fall's acceleration.
const CAM_KEYTIMES = [0, 0.32, 0.46, 0.50, 0.80, 1];
const CAM_SPLINES  = ['0.33 1 0.68 1', '0.33 1 0.68 1', '0.5 0 0.5 1', '0.65 0 0.35 1', '0.5 0 0.5 1'];

// Opacity from how far a label has pushed past a stage edge: fully inside → 1
// (so the wide shot matches the original chart), dissolving in proportion to how
// much of it has crossed out of frame. Pure.
function _fade(lo, hi, edgeLo, edgeHi) {
  const out = Math.max(0, edgeLo - lo, hi - edgeHi);
  return _round2(1 - Math.max(0, Math.min(1, out / (hi - lo))));
}

// Everything the camera needs, computed from extracted geometry — PURE, no DOM.
// Returns per-frame plot transforms (tx/ty/scale), the anchored axis-label
// tracks (screen position + fade per keyframe), and the gridline trim starts.
// ox/oy/gx are the plot- and grid-group own translates (read from the DOM by the
// caller and passed in, to keep this pure). See stage_camera.inject.
function buildCameraPlan(points, stage, ticks, duration, opts = {}) {
  const tight    = opts.tight    ?? 2.8;
  const keytimes = opts.keytimes ?? CAM_KEYTIMES;
  const splines  = opts.splines  ?? CAM_SPLINES;
  const ox = opts.ox ?? 0, oy = opts.oy ?? 0, gx = opts.gx ?? 0;
  const [sx, sy, sw, sh] = stage;

  const { frames, drop } = buildCameraFrames(points, stage, tight);
  const scales = frames.map(f => sw / f[2]);
  // The plot group's own translate is folded in because the animated transform
  // replaces it: at the wide frame this reproduces the original position.
  const tx = frames.map((f, k) => _round2((ox - f[0]) * scales[k] + sx));
  const ty = frames.map((f, k) => _round2((oy - f[1]) * scales[k] + sy));

  const toScreenY = (q, k) => (q - frames[k][1]) * scales[k] + sy;
  const toScreenX = (q, k) => (q - frames[k][0]) * scales[k] + sx;

  // Y labels: pinned to the left gutter, tracking their own gridline.
  const yLabels = (ticks.y || []).map(t => {
    const ys  = frames.map((_, k) => _round2(toScreenY(t.y, k)));
    const ops = ys.map(y => _fade(y - CAM.yLabelHalf, y + CAM.yLabelHalf, sy, sy + sh));
    return { x: _round2(sx + CAM.gutter - CAM.gutterGap), ys, ops, text: t.text };
  });
  // X labels: fixed on the axis line, tracking their own tick across the stage.
  const axisY = (ticks.x && ticks.x[0]) ? ticks.x[0].y : sy + sh;
  const xLabels = (ticks.x || []).map(t => {
    const xs  = frames.map((_, k) => _round2(toScreenX(t.x, k)));
    const ops = xs.map(x => _fade(x - CAM.xLabelHalf, x + CAM.xLabelHalf, sx, sx + sw));
    return { xs, y: _round2(axisY), ops, text: t.text };
  });
  // Gridlines start clear of the y-label gutter rather than under the numbers.
  const gridStarts = frames.map((f, k) => _round2(Math.max(0, f[0] + CAM.gutter / scales[k] - gx)));

  return { frames, drop, scales, tx, ty, keytimes, splines, duration, stage,
           yLabels, xLabels, gridStarts, tight, splitFraction: splitFraction(points, drop) };
}

// ── SMIL injection ────────────────────────────────────────────────────────────

const _CAM_NS = 'http://www.w3.org/2000/svg';
const _cel = tag => document.createElementNS(_CAM_NS, tag);

// A spline-eased, values-based <animate>/<animateTransform>.
function _camAnim(attr, values, plan, { tag = 'animate', type = null, additive = false, begin = 0 } = {}) {
  const a = _cel(tag);
  a.setAttribute('attributeName', attr);
  if (type) a.setAttribute('type', type);
  if (additive) a.setAttribute('additive', 'sum');
  a.setAttribute('dur',   `${plan.duration}s`);
  a.setAttribute('begin', `${begin}s`);
  a.setAttribute('fill',  'freeze');
  a.setAttribute('calcMode',   'spline');
  a.setAttribute('keyTimes',   plan.keytimes.join(';'));
  a.setAttribute('keySplines', plan.splines.join(';'));
  a.setAttribute('values',     values.join(';'));
  return a;
}

// Inject the camera as SMIL: clip the plot to a static stage band, animate a
// transform on the plot group (translate + additive scale), hide the original
// tick labels and rebuild anchored ones that hold their size and only move, and
// pin gridline weight while trimming them clear of the gutter. Mutates svgEl in
// place. IDEMPOTENT — re-running is a no-op once the camera wrapper exists.
// The clip lives on a WRAPPER <g>, never the transformed group: an element's own
// transform defines the space its clip resolves in, so a clip on the moving group
// would be dragged by the very animation it must contain. See stage_camera.inject.
function injectCameraSMIL(svgEl, plan, opts = {}) {
  if (!plan) return;
  if (svgEl.querySelector('[data-camera]')) return; // idempotency guard
  const clipId = opts.clipId || 'stage-clip';
  const [sx, sy, sw, sh] = plan.stage;

  let defs = svgEl.querySelector('defs');
  if (!defs) { defs = _cel('defs'); svgEl.insertBefore(defs, svgEl.firstChild); }

  const clip = _cel('clipPath');
  clip.setAttribute('id', clipId);
  const band = _cel('rect');
  band.setAttribute('x', _round2(sx)); band.setAttribute('y', _round2(sy));
  band.setAttribute('width', _round2(sw)); band.setAttribute('height', _round2(sh));
  clip.appendChild(band); defs.appendChild(clip);

  const plot = _findByIdPrefix(svgEl, opts.plotPrefix || 'svg-main-svg');
  if (!plot) return;

  // Wrap, then animate the inner group.
  const wrap = _cel('g');
  wrap.setAttribute('clip-path', `url(#${clipId})`);
  wrap.setAttribute('data-camera', '');
  plot.parentNode.insertBefore(wrap, plot);
  wrap.appendChild(plot);

  plot.setAttribute('transform',
    `translate(${plan.tx[0]},${plan.ty[0]}) scale(${plan.scales[0]})`);
  plot.appendChild(_camAnim('transform',
    plan.tx.map((v, k) => `${v} ${plan.ty[k]}`), plan, { tag: 'animateTransform', type: 'translate' }));
  plot.appendChild(_camAnim('transform',
    plan.scales.map(_round2), plan, { tag: 'animateTransform', type: 'scale', additive: true }));

  // Original tick labels ride with the plot; ours replace them.
  for (const prefix of ['y-tick-labels-svg', 'x-tick-labels-svg']) {
    const g = _findByIdPrefix(svgEl, prefix);
    if (g) g.setAttribute('opacity', '0');
  }

  // Gridlines: hold their weight (non-scaling-stroke), trim to the gutter. Skip
  // vertical rules (x2="0"); scope to the plot subtree so the legend swatch line
  // isn't stretched across the chart.
  for (const line of plot.querySelectorAll('line')) {
    if (line.getAttribute('x2') === '0') continue;
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.appendChild(_camAnim('x1', plan.gridStarts.map(_round2), plan));
  }

  // Anchored axis labels — outside the transformed group, so they hold their
  // size for free; only position + opacity animate, trailing the plot slightly.
  const labels = _cel('g');
  labels.setAttribute('clip-path', `url(#${clipId})`);
  labels.setAttribute('data-camera-axes', '');
  const common = t => {
    t.setAttribute('fill', 'rgb(255,255,255)');
    t.setAttribute('font-family', 'Knowledge');
    t.setAttribute('font-weight', '300');
    t.setAttribute('font-size', String(CAM.labelSize));
  };
  for (const yl of plan.yLabels) {
    const t = _cel('text');
    t.setAttribute('x', yl.x); t.setAttribute('y', yl.ys[0]);
    t.setAttribute('opacity', yl.ops[0]);
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('style', 'text-anchor: end;');
    common(t);
    t.appendChild(_camAnim('y', yl.ys, plan, { begin: CAM.labelLag }));
    t.appendChild(_camAnim('opacity', yl.ops, plan, { begin: CAM.labelLag }));
    t.appendChild(document.createTextNode(yl.text));
    labels.appendChild(t);
  }
  for (const xl of plan.xLabels) {
    const t = _cel('text');
    t.setAttribute('x', xl.xs[0]); t.setAttribute('y', xl.y);
    t.setAttribute('opacity', xl.ops[0]);
    t.setAttribute('style', 'text-anchor: middle;');
    common(t);
    t.appendChild(_camAnim('x', xl.xs, plan, { begin: CAM.labelLag }));
    t.appendChild(_camAnim('opacity', xl.ops, plan, { begin: CAM.labelLag }));
    t.appendChild(document.createTextNode(xl.text));
    labels.appendChild(t);
  }
  svgEl.appendChild(labels);

  if (plan.split) {  // §2 split-draw on the followed line, timed to the move
    const g = svgEl.querySelector(`[id="${_esc(plan.split.lineId)}"]`);
    if (g) injectSplitTrace(g, plan.split.fraction, plan.split.body, plan.split.tail);
  }
}

// ── Export twin (ADR 0003): per-frame camera, matching the eased SMIL ─────────
//
// SMIL interpolates the 6 keyframes with keySplines; the frame-capture export
// has no SMIL, so it must reproduce the SAME cubic-bezier easing per segment and
// write the interpolated transform/positions as plain attributes each frame.

// Cubic-bezier easing solver (as CSS/SMIL keySplines): maps elapsed-time x∈[0,1]
// to eased progress y, for control points (x1,y1)(x2,y2). Newton-Raphson.
function _bezierEase(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t;
  const sy = t => ((ay * t + by) * t + cy) * t;
  const dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(t);
  };
}

// Value of a 6-keyframe numeric track at normalised time u∈[0,1], easing each
// segment by its keySpline — the export twin of one SMIL <animate values=…>.
function _sampleTrack(values, keytimes, splines, u) {
  if (u <= keytimes[0]) return values[0];
  const last = keytimes.length - 1;
  if (u >= keytimes[last]) return values[last];
  let i = 0;
  while (i < last && u > keytimes[i + 1]) i++;
  const span = keytimes[i + 1] - keytimes[i] || 1;
  const local = (u - keytimes[i]) / span;
  const s = splines[i].split(/[ ,]+/).map(Number);
  const eased = _bezierEase(s[0], s[1], s[2], s[3])(local);
  return values[i] + (values[i + 1] - values[i]) * eased;
}

// Export static setup: identical clip/wrap/hidden-ticks/gridline structure to
// injectCameraSMIL, but WITHOUT SMIL — the plot's transform and the labels are
// left at their frame-0 state and tagged with plan indices, so applyCameraAtTime
// can drive them per frame from the plan's numeric tracks. Idempotent (mirrors
// the SMIL guard). Kept parallel to injectCameraSMIL on purpose; the shared unit
// tests catch any divergence.
function setupCamera(svgEl, plan, opts = {}) {
  if (!plan) return;
  if (svgEl.querySelector('[data-camera]')) return;
  const clipId = opts.clipId || 'stage-clip';
  const [sx, sy, sw, sh] = plan.stage;

  let defs = svgEl.querySelector('defs');
  if (!defs) { defs = _cel('defs'); svgEl.insertBefore(defs, svgEl.firstChild); }
  const clip = _cel('clipPath');
  clip.setAttribute('id', clipId);
  const band = _cel('rect');
  band.setAttribute('x', _round2(sx)); band.setAttribute('y', _round2(sy));
  band.setAttribute('width', _round2(sw)); band.setAttribute('height', _round2(sh));
  clip.appendChild(band); defs.appendChild(clip);

  const plot = _findByIdPrefix(svgEl, opts.plotPrefix || 'svg-main-svg');
  if (!plot) return;
  const wrap = _cel('g');
  wrap.setAttribute('clip-path', `url(#${clipId})`);
  wrap.setAttribute('data-camera', '');
  plot.parentNode.insertBefore(wrap, plot);
  wrap.appendChild(plot);
  plot.setAttribute('transform',
    `translate(${plan.tx[0]},${plan.ty[0]}) scale(${plan.scales[0]})`);

  for (const prefix of ['y-tick-labels-svg', 'x-tick-labels-svg']) {
    const g = _findByIdPrefix(svgEl, prefix);
    if (g) g.setAttribute('opacity', '0');
  }
  for (const line of plot.querySelectorAll('line')) {
    if (line.getAttribute('x2') === '0') continue;
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('x1', plan.gridStarts[0]);
    line.setAttribute('data-cam-grid', '');
  }

  const labels = _cel('g');
  labels.setAttribute('clip-path', `url(#${clipId})`);
  labels.setAttribute('data-camera-axes', '');
  const common = t => {
    t.setAttribute('fill', 'rgb(255,255,255)');
    t.setAttribute('font-family', 'Knowledge');
    t.setAttribute('font-weight', '300');
    t.setAttribute('font-size', String(CAM.labelSize));
  };
  plan.yLabels.forEach((yl, k) => {
    const t = _cel('text');
    t.setAttribute('x', yl.x); t.setAttribute('y', yl.ys[0]); t.setAttribute('opacity', yl.ops[0]);
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('style', 'text-anchor: end;');
    t.setAttribute('data-cam-yi', k);
    common(t); t.appendChild(document.createTextNode(yl.text)); labels.appendChild(t);
  });
  plan.xLabels.forEach((xl, k) => {
    const t = _cel('text');
    t.setAttribute('x', xl.xs[0]); t.setAttribute('y', xl.y); t.setAttribute('opacity', xl.ops[0]);
    t.setAttribute('style', 'text-anchor: middle;');
    t.setAttribute('data-cam-xi', k);
    common(t); t.appendChild(document.createTextNode(xl.text)); labels.appendChild(t);
  });
  svgEl.appendChild(labels);

  if (plan.split) {  // §2 split-draw static scaffold (applyCameraAtTime drives it)
    const g = svgEl.querySelector(`[id="${_esc(plan.split.lineId)}"]`);
    if (g) setupSplitTrace(g, plan.split.fraction, plan.split.body, plan.split.tail);
  }
}

// Per-frame camera: write the interpolated plot transform, gridline trim, and
// anchored-label positions/opacity for timestamp t. Labels trail the plot by
// CAM.labelLag (the "scrolly" feel), so their tracks sample at t − lag.
function applyCameraAtTime(svgEl, plan, t) {
  if (!plan) return;
  const dur = plan.duration || 1;
  const u  = Math.max(0, Math.min(1, t / dur));
  const uL = Math.max(0, Math.min(1, (t - CAM.labelLag) / dur));
  const S = (vals, uu) => _sampleTrack(vals, plan.keytimes, plan.splines, uu);

  const plot = _findByIdPrefix(svgEl, 'svg-main-svg');
  if (plot && plot.parentNode && plot.parentNode.getAttribute('data-camera') !== null) {
    plot.setAttribute('transform',
      `translate(${_round2(S(plan.tx, u))},${_round2(S(plan.ty, u))}) scale(${_round2(S(plan.scales, u))})`);
    const gx1 = _round2(S(plan.gridStarts, u));
    for (const line of plot.querySelectorAll('line[data-cam-grid]')) line.setAttribute('x1', gx1);
  }
  const axes = svgEl.querySelector('g[data-camera-axes]');
  if (!axes) return;
  for (const t2 of axes.querySelectorAll('text[data-cam-yi]')) {
    const yl = plan.yLabels[+t2.getAttribute('data-cam-yi')];
    t2.setAttribute('y', _round2(S(yl.ys, uL)));
    t2.setAttribute('opacity', _round2(S(yl.ops, uL)));
  }
  for (const t2 of axes.querySelectorAll('text[data-cam-xi]')) {
    const xl = plan.xLabels[+t2.getAttribute('data-cam-xi')];
    t2.setAttribute('x', _round2(S(xl.xs, uL)));
    t2.setAttribute('opacity', _round2(S(xl.ops, uL)));
  }
  if (plan.split) {  // §2 split-draw per-frame
    const g = svgEl.querySelector(`[id="${_esc(plan.split.lineId)}"]`);
    if (g) applySplitTraceAtTime(g, t);
  }
}

// ── §2 split-draw: pause the line at the drop until the camera arrives ────────
//
// Two stroke-dashoffset runs on ONE stroke: the body draws up to the dive and
// freezes, then the tail draws the dive itself after the camera has settled on
// it. One continuous stroke, so the join can't seam (port of draw_split). Both
// systems (ADR 0003). body/tail = { begin, dur, spline } in seconds. The split
// fraction comes from the camera plan (splitFraction at the drop index), so §2
// reuses §3's math rather than re-measuring.

function _splineFromTo(parent, attr, from, to, spec) {
  const a = _cel('animate');
  a.setAttribute('attributeName', attr);
  a.setAttribute('from', String(from)); a.setAttribute('to', String(to));
  a.setAttribute('dur', `${spec.dur}s`); a.setAttribute('begin', `${spec.begin}s`);
  a.setAttribute('fill', 'freeze');
  a.setAttribute('calcMode', 'spline'); a.setAttribute('keyTimes', '0;1');
  a.setAttribute('keySplines', spec.spline);
  parent.appendChild(a);
}

// SMIL split-trace on every stroke-only path in the group.
function injectSplitTrace(group, fraction, body, tail) {
  const hold = _round2(1 - fraction);
  for (const path of _strokePaths(group)) {  // _strokePaths from animate.js
    path.setAttribute('pathLength', '1');
    path.setAttribute('stroke-dasharray', '1 1');
    path.setAttribute('stroke-dashoffset', '1');
    _splineFromTo(path, 'stroke-dashoffset', 1, hold, body);   // draw to the dive, hold
    _splineFromTo(path, 'stroke-dashoffset', hold, 0, tail);   // the dive, once settled
  }
}

// Export static setup: dash attrs + the split schedule stashed for per-frame drive.
function setupSplitTrace(group, fraction, body, tail) {
  const schedule = JSON.stringify({ hold: _round2(1 - fraction), body, tail });
  for (const path of _strokePaths(group)) {
    path.setAttribute('pathLength', '1');
    path.setAttribute('stroke-dasharray', '1 1');
    path.setAttribute('stroke-dashoffset', '1');
    path.setAttribute('data-split', schedule);
  }
}

// Per-frame split-trace: two eased ramps with a freeze between them.
function applySplitTraceAtTime(group, t) {
  const ease = (spec, x) => {
    const s = spec.spline.split(/[ ,]+/).map(Number);
    return _bezierEase(s[0], s[1], s[2], s[3])(Math.max(0, Math.min(1, x)));
  };
  for (const path of _strokePaths(group)) {
    const raw = path.getAttribute('data-split');
    if (!raw) continue;
    const { hold, body, tail } = JSON.parse(raw);
    let off;
    if (t <= body.begin) off = 1;
    else if (t < body.begin + body.dur) off = 1 + (hold - 1) * ease(body, (t - body.begin) / body.dur);
    else if (t <= tail.begin) off = hold;
    else if (t < tail.begin + tail.dur) off = hold + (0 - hold) * ease(tail, (t - tail.begin) / tail.dur);
    else off = 0;
    path.setAttribute('stroke-dashoffset', _round2(off));
  }
}

// Read a group's own translate(x, y) — the offsets buildCameraPlan folds in.
function cameraGroupTranslate(svgEl, prefix) {
  const g = _findByIdPrefix(svgEl, prefix);
  const m = g && (g.getAttribute('transform') || '').match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

// Orchestrator (live-probe): extract geometry from a font-embedded clone and
// return a full camera plan, or null if the chart has no line to follow. Async
// and DOM-reading; call once per build (like measureBubbleUnits), before the
// synchronous injection. No-op unless config.camera is enabled.
async function computeCameraPlan(svgEl, config) {
  if (!config || !config.camera || !config.camera.enabled) return null;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:900px;overflow:hidden;pointer-events:none';
  host.innerHTML = new XMLSerializer().serializeToString(svgEl);
  document.body.appendChild(host);
  const live = host.querySelector('svg');
  try {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }
    // Follow an explicit line, else the first stroked line, else a dots-line.
    let points = [], splitLineId = null;
    const linePath = config.camera.line_id
      ? live.querySelector(`[id="${_esc(config.camera.line_id)}"] path, [id="${_esc(config.camera.line_id)}"]`)
      : live.querySelector('[id="lines-svg"] path');
    if (linePath && linePath.tagName.toLowerCase() === 'path') {
      points = extractLinePoints(live, linePath);
      const g = linePath.closest('g[id]');
      splitLineId = g ? g.getAttribute('id') : null;
    } else {
      const dots = live.querySelector('[id="dots-svg"]');
      if (dots) points = extractDotPoints(live, dots);
    }
    if (points.length < 3) return null;

    const stage = config.camera.stage || detectStage(live);
    const ticks = extractTicks(live);
    const plot  = cameraGroupTranslate(live, config.camera.plotPrefix || 'svg-main-svg');
    const grid  = cameraGroupTranslate(live, config.camera.gridPrefix || 'group-svg');
    const duration = config.camera.duration || config.total_duration || 10;

    const plan = buildCameraPlan(points, stage, ticks, duration, {
      tight: config.camera.tight, keytimes: config.camera.keytimes, splines: config.camera.splines,
      ox: plot.x, oy: plot.y, gx: grid.x,
    });

    // §2 split-draw: pause the followed line at the drop until the camera lands,
    // then draw the dive during the pull-back. Timing derives from the camera's
    // own keytimes (body done before the push; tail across the pull-back), so it
    // stays in lockstep with the move. Opt-in via config.camera.split_draw.
    if (config.camera.split_draw && splitLineId) {
      const kt = plan.keytimes, D = duration;
      plan.split = {
        lineId: splitLineId,
        fraction: plan.splitFraction,
        body: { begin: _round2(0.08 * D), dur: _round2(Math.max(0.2, kt[1] * D - 0.08 * D)),
                spline: '0.33 1 0.68 1' },
        tail: { begin: _round2(kt[3] * D), dur: _round2(Math.max(0.2, (kt[4] - kt[3]) * D)),
                spline: '0.65 0 0.35 1' },
      };
    }
    return plan;
  } finally {
    document.body.removeChild(host);
  }
}

// The plot band the camera roams inside: full chart width, from just above the
// plot down through the x-axis labels. Derived from svg-main-svg's root bbox
// (which spans gridlines → axis labels) with a little padding. Read-only.
// First-cut heuristic (checklist: "harden later"); callers may override with an
// explicit stage. Returns [sx, sy, sw, sh].
function detectStage(svgEl) {
  const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  const width  = parseFloat(svgEl.getAttribute('width'))  || (vb.length === 4 ? vb[2] : NaN);
  const height = parseFloat(svgEl.getAttribute('height')) || (vb.length === 4 ? vb[3] : NaN);
  const main = _findByIdPrefix(svgEl, 'svg-main-svg');
  const bb = main && _rootBBox(svgEl, main);
  if (!bb) return [0, 0, _round2(width || 0), _round2(height || 0)];
  const pad = 8;
  const top = Math.max(0, bb.y - pad);
  const bottom = Math.min(Number.isFinite(height) ? height : bb.y + bb.h + pad, bb.y + bb.h + pad);
  return [0, _round2(top), _round2(Number.isFinite(width) ? width : bb.w), _round2(bottom - top)];
}
