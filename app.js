// ── app.js — main UI logic ────────────────────────────────────────────────────
//
// Key differences from the Python prototype's static/app.js:
//   - detectElements() runs client-side (detect.js), not on the server
//   - preview() calls buildAnimatedSvg() locally (animate.js), no server round-trip
//   - exportAs() calls export.js functions directly, no SSE stream
//   - Status updates use a simple callback, not an SSE event source

'use strict';

const state = {
  svg:      null,  // raw SVG string (Datawrapper fetch, file upload, or paste)
  elements: [],    // detected AnimatableElements (client-side)
  queue:    [],    // {group_id, label, animation_type, start_time, element_duration, color}
  hidden:   new Set(), // IDs of elements removed from preview and export
  camera:   null,      // §3/§4 whole-chart camera config, or null when off
};

// On static hosts (GitHub Pages) there is no /fetch-svg proxy — the Datawrapper
// loader is hidden and charts come in via file upload, paste, or the example.
const IS_STATIC_HOST = location.hostname.endsWith('github.io') || location.protocol === 'file:';

// ── Where this UI lives ───────────────────────────────────────────────────────
//
// `document` when running as a standalone page; a shadow root when mounted as
// <chart-animator> inside the Reuters exporter. Every lookup goes through these
// helpers so one implementation serves both — and so switching between light and
// shadow DOM is a one-line change rather than a migration.
//
// Retrofitting this later would mean revisiting ~50 call sites and finding the
// misses at runtime, silently, because a missed lookup returns null rather than
// throwing.
let root = document;

// ShadowRoot inherits getElementById from DocumentFragment; a plain element host
// does not, so fall back to a selector for the light-DOM mount.
const $ = id => (root.getElementById ? root.getElementById(id)
                                     : root.querySelector('#' + CSS.escape(id)));
const $$ = sel => root.querySelectorAll(sel);
const $1 = sel => root.querySelector(sel);

// True while embedded, so we can avoid reaching outside our own subtree.
const isEmbedded = () => root !== document;

// ── Boot ──────────────────────────────────────────────────────────────────────
//
// Two entry points, one body. A standalone page calls initApp() on
// DOMContentLoaded; <chart-animator> calls mountApp(shadowRoot) instead. The
// guard stops a component that mounts before DOMContentLoaded being initialised
// twice.

// Guarded PER ROOT, not globally. A global latch looks equivalent and isn't:
// mounting into a shadow root after a standalone page had already booted would
// set the root but skip the wiring, leaving every control dead — silently,
// because the lookups still resolve.
let _mountedRoot = null;

function initApp() {
  if (_mountedRoot === root) return;
  _mountedRoot = root;
  $('chart-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadSvg();
  });
  $('load-btn').addEventListener('click', loadSvg);
  $('test-btn').addEventListener('click', loadTestSvg);
  $('file-btn').addEventListener('click', () =>
    $('file-input').click());
  $('file-input').addEventListener('change', loadSvgFile);
  // Scoped when embedded: a component that hijacks the host page's paste
  // would swallow pastes meant for the exporter's own inputs.
  (isEmbedded() ? root : document).addEventListener('paste', onPasteSvg);

  if (IS_STATIC_HOST) {
    $('chart-id-input').hidden = true;
    $('load-btn').hidden = true;
    $('input-label').textContent = 'Open an SVG file exported from Datawrapper';
  }
  $('total-duration').addEventListener('input', validateOverhangs);
  // §3/§4 camera toggle (opt-in whole-chart effect). split-draw only applies with
  // the camera on, so it's disabled until then.
  const camToggle   = $('camera-toggle');
  const splitToggle = $('camera-split-toggle');
  const syncCamera = () => {
    splitToggle.disabled = !camToggle.checked;
    state.camera = camToggle.checked
      ? { enabled: true, split_draw: splitToggle.checked, duration: +$('total-duration').value }
      : null;
  };
  camToggle.addEventListener('change', syncCamera);
  splitToggle.addEventListener('change', syncCamera);
  $('total-duration').addEventListener('input', syncCamera);
  // Sync state to the actual DOM at init: browsers restore checkbox state across
  // a soft reload, so a page that loads with Camera already ticked must not leave
  // state.camera null (and split-draw must be enabled to match). Replaces a bare
  // `splitToggle.disabled = true` that assumed Camera always starts unchecked.
  syncCamera();
  $('queue-all-btn').addEventListener('click', queueAll);
  $('preview-btn').addEventListener('click', preview);
  $('export-btn').addEventListener('click', toggleExportMenu);
  $('export-menu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    const opts = {};
    if (btn.dataset.fps)   opts.fps        = parseFloat(btn.dataset.fps);
    if (btn.dataset.width) opts.targetWidth = parseInt(btn.dataset.width, 10);
    exportAs(btn.dataset.fmt, opts);
  });
  // Stays on document even when embedded — closing the menu means noticing a
  // click anywhere, including outside our subtree. Shadow events are composed,
  // so they reach document; `composedPath` sees through the boundary.
  document.addEventListener('click', e => {
    const menu = $('export-menu');
    if (!menu || menu.hidden) return;
    // composedPath, not e.target.closest: at document level a click inside a
    // shadow root is RETARGETED to the host element, so closest('.export-wrap')
    // would never match and the menu would close on its own buttons.
    const path = e.composedPath ? e.composedPath() : [e.target];
    const inside = path.some(n => n && n.classList && n.classList.contains('export-wrap'));
    if (!inside) menu.hidden = true;
  });
  $$('input[name="preview-bg"]').forEach(r => {
    r.addEventListener('change', () => setPreviewBg(r.value));
  });
}

// Mount into a shadow root (or any container). Called by chart-animator.js.
function mountApp(newRoot) {
  root = newRoot;
  initApp();
}

// Standalone boot. Skipped when a component already mounted us.
document.addEventListener('DOMContentLoaded', () => initApp());

// ── Chart ID extraction ───────────────────────────────────────────────────────

const DW_URL_RE = /\/chart\/([A-Za-z0-9]+)\//;
const DW_ID_RE  = /^[A-Za-z0-9]{5,8}$/;

function extractChartId(raw) {
  const s = raw.trim();
  const m = s.match(DW_URL_RE);
  return m ? m[1] : DW_ID_RE.test(s) ? s : null;
}

// ── Load SVG ──────────────────────────────────────────────────────────────────

// Shared tail of every load path: parse, detect, reset queue state, render.
// Returns false (with an input error shown) if the string isn't a parseable SVG.
function loadSvgString(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.tagName.toLowerCase() !== 'svg') {
    showInputError("That doesn't look like a valid SVG.");
    return false;
  }
  clearInputError();
  // Stacked bars: bake synthesized row groups into the stored SVG so every
  // downstream re-parse (preview, export) sees real row-N-svg nodes to bind to.
  // Non-stacked charts are untouched — state.svg stays the exact original string.
  const svgEl = doc.documentElement;
  const rows  = synthesizeStackedRows(svgEl);
  state.svg      = rows.length ? new XMLSerializer().serializeToString(svgEl) : svg;
  state.elements = detectElements(svgEl);
  state.queue    = [];
  state.hidden   = new Set();
  injectSvg();
  renderQueue();
  $('queue-section').hidden = false;
  return true;
}

async function loadTestSvg() {
  const btn = $('test-btn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const resp = await fetch('examples/multi_line_graph.svg');
    if (!resp.ok) {
      showInputError('examples/multi_line_graph.svg not found.');
      return;
    }
    const svg = await resp.text();
    $('chart-id-input').value = CONFIG.testChartId;
    loadSvgString(svg);
  } catch {
    showInputError("Couldn't load test SVG.");
  } finally {
    btn.disabled = false; btn.textContent = 'Test';
  }
}

async function loadSvgFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  loadSvgString(await file.text());
  e.target.value = '';  // allow re-selecting the same file
}

function onPasteSvg(e) {
  // Ignore pastes aimed at form fields (chart IDs, durations, labels).
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  const text = (e.clipboardData.getData('text/plain') || '').trim();
  if (text.startsWith('<?xml') || text.startsWith('<svg')) loadSvgString(text);
}

async function loadSvg() {
  const chartId = extractChartId($('chart-id-input').value);
  if (!chartId) {
    showInputError("That doesn't look like a valid chart ID or Datawrapper URL.");
    return;
  }
  clearInputError();

  const btn = $('load-btn');
  btn.disabled = true; btn.textContent = 'Loading…';

  try {
    const resp = await fetch('/fetch-svg', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chart_id: chartId, width: CONFIG.defaultFetchWidth }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showInputError(err.error || "Couldn't fetch that chart — check the ID and try again.");
      return;
    }
    const { svg } = await resp.json();
    loadSvgString(svg);
  } catch {
    showInputError("Couldn't fetch that chart — check the ID and try again.");
  } finally {
    btn.disabled = false; btn.textContent = 'Load →';
  }
}

function showInputError(msg) {
  const el = $('input-error');
  el.textContent = msg; el.hidden = false;
}
function clearInputError() {
  $('input-error').hidden = true;
}

// ── SVG injection ─────────────────────────────────────────────────────────────

function injectSvg() {
  const container = $('svg-container');
  container.innerHTML = state.svg;
  $('no-elements-warning').hidden = state.elements.length > 0;

  const svgEl = container.querySelector('svg');
  if (!svgEl) {
    console.warn('app.js: injectSvg — no <svg> element found after injection');
    renderHiddenList();
    return;
  }

  // Datawrapper SVGs have no viewBox. Without it, height:auto can't derive
  // the aspect ratio when max-width:100% scales the SVG down — height collapses.
  // Stamp one from the width/height attributes for display only.
  if (!svgEl.getAttribute('viewBox')) {
    const w = svgEl.getAttribute('width');
    const h = svgEl.getAttribute('height');
    if (w && h) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  // Allow content that extends slightly past the declared SVG bounds to show.
  svgEl.style.overflow = 'visible';

  for (const el of state.elements) {
    // Scope to selectable roots: duplicate IDs in value-label groups must not get stopPropagation.
    let dom = null;
    for (const rootId of CONFIG.chartRoots.map(r => r.rootId)) {
      const root = _findById(container, rootId);
      if (root) {
        dom = root.getAttribute('id') === el.group_id ? root : _findById(root, el.group_id);
        if (dom) break;
      }
    }
    // Elements not nested under a chartRoot — synthesized stacked rows and the
    // header text-intro group — still need a click-to-queue handler. Without the
    // stopPropagation binding, a header click would fall through to the hide
    // handler instead of queueing it.
    if (!dom) dom = _findById(container, el.group_id);
    if (!dom) continue;
    dom.style.cursor = 'pointer';
    dom.addEventListener('click', e => { e.stopPropagation(); toggleElement(el.group_id); });
  }

  // Clicking anything else in the SVG hides/restores that element group.
  // Series group clicks call stopPropagation so they never reach this handler.
  svgEl.addEventListener('click', e => {
    const target = _findHideTarget(e.target, svgEl);
    if (target) toggleHidden(target.getAttribute('id'));
  });

  renderHiddenList();
}

function _findById(root, id) {
  return root.querySelector(`[id="${_esc(id)}"]`);
}

// ── Element hiding ────────────────────────────────────────────────────────────

// Datawrapper structural wrapper IDs — too broad to be useful hide targets.
// Chart root IDs are added automatically from CONFIG.chartRoots (their children
// handle their own clicks via stopPropagation, so the container should be skipped).
const _HIDE_SKIP = new Set([
  'exportSvg',
  '__svelte-dw-svg',
  'chart-svg',
  'group-svg',
  'svg-main-svg',
  'tooltip-layer-svg',
  'front-svg',  // scatter plot axis overlay — contains axes, too broad to hide directly
  ...CONFIG.chartRoots.map(r => r.rootId),
]);

// Datawrapper compound IDs starting with 'container-svg': the second segment
// determines whether the element is structural (skip) or meaningful (allow).
// container-body/bodyTop/bodyCenter are layout scaffolding; header/footer/footerLeft/Right
// are visible content that the user may want to hide.
const _CONTAINER_STRUCTURAL = new Set([
  'container-body-svg',
  'container-bodyTop-svg',
  'container-bodyCenter-svg',
]);

// Walk up from a clicked element to find the nearest ID'd ancestor that is a
// meaningful hide target. Series groups call stopPropagation so they never
// reach this; structural Datawrapper wrappers are filtered by _HIDE_SKIP.
//
// STUB: fine-grained hide (individual <text> nodes within a group) would require
// targeting elements without IDs. For now, granularity is whole-group only.
function _findHideTarget(el, svgRoot) {
  let node = el;
  while (node && node !== svgRoot) {
    const id = node.getAttribute && node.getAttribute('id');
    if (id && _isHideableId(id)) return node;
    node = node.parentElement;
  }
  return null;
}

function _isHideableId(id) {
  const segments = id.split(' ');
  const firstSegment = segments[0];
  if (_HIDE_SKIP.has(firstSegment)) return false;
  if (firstSegment === 'container-svg') {
    // Bare 'container-svg' (no second segment) is the layout root — skip.
    // For compound container IDs, skip structural body wrappers but allow
    // header and footer groups (those contain visible, hideable content).
    const second = segments[1];
    return second !== undefined && !_CONTAINER_STRUCTURAL.has(second);
  }
  if (state.elements.some(e => e.group_id === id)) return false;
  return true;
}

function toggleHidden(id) {
  const container = $('svg-container');
  const all = [...container.querySelectorAll(`[id="${_esc(id)}"]`)];
  const outsideRoots = all.filter(el => !CONFIG.chartRoots.map(r => r.rootId).some(r => {
    const root = _findById(container, r); return root && root.contains(el);
  }));
  // Prefer <text> elements — connect-line <path>s share the same bare ID and appear
  // earlier in the DOM, so without this filter they'd be dimmed instead of the labels.
  // Dim ALL matching texts so name + value percentage hide together.
  const texts = outsideRoots.filter(el => el.tagName.toLowerCase() === 'text');
  const doms  = texts.length > 0 ? texts : outsideRoots.slice(0, 1);
  if (state.hidden.has(id)) {
    state.hidden.delete(id);
    doms.forEach(el => { el.style.opacity = ''; });
  } else {
    state.hidden.add(id);
    doms.forEach(el => { el.style.opacity = '0.15'; });
  }
  renderHiddenList();
}

function renderHiddenList() {
  const panel = $('hidden-panel');
  if (state.hidden.size === 0) { panel.hidden = true; return; }
  panel.hidden = false;
  $('hidden-items').innerHTML = [...state.hidden].map(id => `
    <div class="hidden-row">
      <span class="hidden-label">${_escHtml(_labelFromHideId(id))}</span>
      <button class="restore-btn" data-id="${_escHtml(id)}">Restore</button>
    </div>
  `).join('');
  $$('.restore-btn').forEach(btn =>
    btn.addEventListener('click', () => toggleHidden(btn.dataset.id)));
}

// Produce a readable label from a Datawrapper compound ID like
// "container-svg container-header-svg datawrapper-eIILe-abc123-svg".
// Takes the most specific segment (skipping pure structural markers and hashes).
function _labelFromHideId(id) {
  const meaningful = id.split(' ').find(s =>
    s !== 'container-svg' &&
    !s.startsWith('datawrapper-') &&
    !s.startsWith('svelte-') &&
    !s.startsWith('grid-')
  ) || id.split(' ')[0];
  return meaningful
    .replace(/^container-/, '')
    .replace(/-svg$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// ── Queue ─────────────────────────────────────────────────────────────────────

function queueAll() {
  for (const el of state.elements) {
    if (state.queue.some(q => q.group_id === el.group_id)) continue;
    state.queue.push({
      group_id:         el.group_id,
      label:            el.label,
      animation_type:   el.animation_type,
      start_time:       0,
      element_duration: CONFIG.defaultElementDuration,
      color:            el.color,
    });
    const dom = _findById($('svg-container'), el.group_id);
    if (dom) dom.classList.add(CONFIG.selectedClass);
  }
  renderQueue();
}

function toggleElement(groupId) {
  const idx   = state.queue.findIndex(q => q.group_id === groupId);
  const domEl = _findById($('svg-container'), groupId);

  if (idx >= 0) {
    state.queue.splice(idx, 1);
    if (domEl) domEl.classList.remove(CONFIG.selectedClass);
  } else {
    const det = state.elements.find(e => e.group_id === groupId);
    state.queue.push({
      group_id:         groupId,
      label:            det?.label            ?? groupId,
      animation_type:   det?.animation_type   ?? 'draw_on',
      start_time:       0,
      element_duration: CONFIG.defaultElementDuration,
      color:            det?.color            ?? '',
    });
    if (domEl) domEl.classList.add(CONFIG.selectedClass);
  }
  renderQueue();
}

function renderQueue() {
  const allQueued = state.elements.length > 0 &&
    state.elements.every(e => state.queue.some(q => q.group_id === e.group_id));
  const btn = $('queue-all-btn');
  btn.disabled = state.elements.length === 0 || allQueued;

  const container = $('queue-items');
  if (state.queue.length === 0) {
    container.innerHTML = '<p class="queue-empty">Click elements in the SVG above to add them to the queue.</p>';
    return;
  }

  container.innerHTML = state.queue.map((item, i) => `
    <div class="queue-row" data-index="${i}">
      <span class="queue-color" style="background:${item.color || '#888'}"></span>
      <span class="queue-label">${_escHtml(item.label)}</span>
      <select class="anim-type" data-index="${i}">${_animOpts(item.animation_type)}</select>
      <label class="timing-label">Start <input type="number" class="timing-input start-time" value="${item.start_time}" min="0" step="0.1" data-index="${i}"> s</label>
      <label class="timing-label">Dur <input type="number" class="timing-input elem-dur" value="${item.element_duration}" min="0.1" step="0.1" data-index="${i}"> s</label>
      <button class="remove-btn" data-index="${i}" title="Remove">✕</button>
      <span class="overhang-warning" hidden></span>
    </div>
  `).join('');

  container.querySelectorAll('.anim-type').forEach(s =>
    s.addEventListener('change', () => { state.queue[+s.dataset.index].animation_type = s.value; validateOverhangs(); }));
  container.querySelectorAll('.start-time').forEach(inp =>
    inp.addEventListener('input', () => { state.queue[+inp.dataset.index].start_time = +inp.value; validateOverhangs(); }));
  container.querySelectorAll('.elem-dur').forEach(inp =>
    inp.addEventListener('input', () => { state.queue[+inp.dataset.index].element_duration = +inp.value; validateOverhangs(); }));
  container.querySelectorAll('.remove-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const item = state.queue.splice(+btn.dataset.index, 1)[0];
      const dom  = _findById($('svg-container'), item.group_id);
      if (dom) dom.classList.remove(CONFIG.selectedClass);
      renderQueue();
    }));

  validateOverhangs();
}

function _animOpts(selected) {
  return [
    ['trace',              'Trace (draw along path)'],
    ['draw_on',            'Draw On'],
    ['fade_in',            'Fade In'],
    ['pop_in',             'Pop In'],
    ['grow_from_baseline', 'Grow from Baseline'],
    ['wipe_right',         'Wipe Right'],
    ['bubble_up',          'Bubble Up (text intro)'],
    ['radial_sweep',       'Radial Sweep'],
  ].map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join('');
}

// HTML-escape for innerHTML interpolation. Named _escHtml (not _esc) because
// the global _esc (config.js) escapes ids for CSS attribute selectors —
// a same-named declaration here would shadow it.
function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Overhang validation ───────────────────────────────────────────────────────

function validateOverhangs() {
  const total = +$('total-duration').value;
  state.queue.forEach((item, i) => {
    const end  = +(item.start_time + item.element_duration).toFixed(3);
    const row  = $1(`.queue-row[data-index="${i}"]`);
    if (!row) return;
    const warn = row.querySelector('.overhang-warning');
    if (end > total) {
      warn.hidden = false;
      warn.innerHTML = `This element extends past the total duration. <button class="extend-btn">Extend to ${end}s</button>`;
      warn.querySelector('.extend-btn').addEventListener('click', () => {
        $('total-duration').value = end;
        validateOverhangs();
      });
    } else {
      warn.hidden = true;
    }
  });
}

// ── Config assembly ───────────────────────────────────────────────────────────

function buildConfig() {
  return {
    total_duration: +$('total-duration').value,
    elements: state.queue.map(item => ({
      group_id:         item.group_id,
      animation_type:   item.animation_type,
      start_time:       item.start_time,
      element_duration: item.element_duration,
    })),
    hidden_ids: [...state.hidden],
    camera:     state.camera || null,   // §3/§4 whole-chart camera (opt-in)
  };
}

// ── Preview — fully client-side, no server call ───────────────────────────────

async function preview() {
  if (state.queue.length === 0) return;
  const btn = $('preview-btn');
  btn.disabled = true; btn.textContent = 'Previewing…';

  try {
    const config = buildConfig();
    const parser = new DOMParser();
    const svgEl  = parser.parseFromString(state.svg, 'image/svg+xml').documentElement;
    // Font-first (checklist §0): embed the real Knowledge face before anything
    // measures, splits, or renders. buildAnimatedSvg clones svgEl, so the font
    // must be present here for the clone to inherit it.
    await embedFonts(svgEl); // fonts.js
    config.hidden_ids.forEach(id => {
      const el = _findById(svgEl, id);
      if (el) el.remove();
    });
    // Hide the Datawrapper background rect so the preview container CSS background
    // shows through. _findBackgroundRect (export.js) matches by full-canvas size,
    // so charts whose first <rect> is real content are handled correctly.
    const bgRect = _findBackgroundRect(svgEl);
    if (bgRect) bgRect.style.display = 'none';
    // Bubble-up glyph measurement (live probe, real font) before the split.
    // No-op unless a queued element is bubble_up. See measureBubbleUnits.
    const measurements = await measureBubbleUnits(svgEl, config); // animate.js
    const cameraPlan   = await computeCameraPlan(svgEl, config);   // camera.js (§3/§4)
    const animated = buildAnimatedSvg(svgEl, config, measurements, cameraPlan); // animate.js

    const pc = $('preview-container');
    pc.innerHTML = '';
    pc.appendChild(animated);
    animated.style.maxWidth = '100%';
    animated.style.height   = 'auto';
    animated.style.display  = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Preview';
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

function toggleExportMenu() {
  const menu = $('export-menu');
  menu.hidden = !menu.hidden;
}

async function exportAs(fmt, opts = {}) {
  $('export-menu').hidden = true;
  if (state.queue.length === 0) return;

  const panel = $('status-panel');
  panel.hidden   = false;
  panel.innerHTML = '';

  const config = buildConfig();

  const onStatus = (msg, type = 'info') => {
    const el = document.createElement('div');
    el.className   = `status-msg status-${type}`;
    el.textContent = msg;
    panel.appendChild(el);
    el.scrollIntoView({ block: 'nearest' });
  };

  try {
    switch (fmt) {
      case 'svg':
        onStatus('Building animated SVG…');
        await exportSvg(state.svg, config);        // export.js
        onStatus('Done.', 'done');
        break;
      case 'gif':
        await exportGif(state.svg, config, config.total_duration, onStatus);  // export.js
        onStatus('Done.', 'done');
        break;
      case 'mov':
        await exportMov(state.svg, config, config.total_duration, onStatus, opts);  // export.js
        onStatus('Done.', 'done');
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : (JSON.stringify(e) ?? String(e));
    onStatus(`Export failed: ${msg}`, 'error');
    console.error('Export error (full):', e);
  }
}

// ── Preview background ────────────────────────────────────────────────────────

function setPreviewBg(value) {
  $('preview-container').className = `bg-${value}`;
}
