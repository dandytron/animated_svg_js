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
};

// On static hosts (GitHub Pages) there is no /fetch-svg proxy — the Datawrapper
// loader is hidden and charts come in via file upload, paste, or the example.
const IS_STATIC_HOST = location.hostname.endsWith('github.io') || location.protocol === 'file:';

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chart-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadSvg();
  });
  document.getElementById('load-btn').addEventListener('click', loadSvg);
  document.getElementById('test-btn').addEventListener('click', loadTestSvg);
  document.getElementById('file-btn').addEventListener('click', () =>
    document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', loadSvgFile);
  document.addEventListener('paste', onPasteSvg);

  if (IS_STATIC_HOST) {
    document.getElementById('chart-id-input').hidden = true;
    document.getElementById('load-btn').hidden = true;
    document.getElementById('input-label').textContent = 'Open an SVG file exported from Datawrapper';
  }
  document.getElementById('total-duration').addEventListener('input', validateOverhangs);
  document.getElementById('queue-all-btn').addEventListener('click', queueAll);
  document.getElementById('preview-btn').addEventListener('click', preview);
  document.getElementById('export-btn').addEventListener('click', toggleExportMenu);
  document.getElementById('export-menu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    const opts = {};
    if (btn.dataset.fps)   opts.fps        = parseFloat(btn.dataset.fps);
    if (btn.dataset.width) opts.targetWidth = parseInt(btn.dataset.width, 10);
    exportAs(btn.dataset.fmt, opts);
  });
  document.addEventListener('click', e => {
    const menu = document.getElementById('export-menu');
    if (!menu.hidden && !e.target.closest('.export-wrap')) menu.hidden = true;
  });
  document.querySelectorAll('input[name="preview-bg"]').forEach(r => {
    r.addEventListener('change', () => setPreviewBg(r.value));
  });
});

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
  state.svg      = svg;
  state.elements = detectElements(doc.documentElement);
  state.queue    = [];
  state.hidden   = new Set();
  injectSvg();
  renderQueue();
  document.getElementById('queue-section').hidden = false;
  return true;
}

async function loadTestSvg() {
  const btn = document.getElementById('test-btn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const resp = await fetch('examples/multi_line_graph.svg');
    if (!resp.ok) {
      showInputError('examples/multi_line_graph.svg not found.');
      return;
    }
    const svg = await resp.text();
    document.getElementById('chart-id-input').value = CONFIG.testChartId;
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
  const chartId = extractChartId(document.getElementById('chart-id-input').value);
  if (!chartId) {
    showInputError("That doesn't look like a valid chart ID or Datawrapper URL.");
    return;
  }
  clearInputError();

  const btn = document.getElementById('load-btn');
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
  const el = document.getElementById('input-error');
  el.textContent = msg; el.hidden = false;
}
function clearInputError() {
  document.getElementById('input-error').hidden = true;
}

// ── SVG injection ─────────────────────────────────────────────────────────────

function injectSvg() {
  const container = document.getElementById('svg-container');
  container.innerHTML = state.svg;
  const svgEl = container.querySelector('svg');
  if (!svgEl) console.warn('app.js: injectSvg — no <svg> element found after injection');

  if (svgEl) {
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
  };

  document.getElementById('no-elements-warning').hidden = state.elements.length > 0;

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
    if (!dom) continue;
    dom.style.cursor = 'pointer';
    dom.addEventListener('click', e => { e.stopPropagation(); toggleElement(el.group_id); });
  }

  // Clicking anything else in the SVG hides/restores that element group.
  // Series group clicks call stopPropagation so they never reach this handler.
  if (svgEl) {
    svgEl.addEventListener('click', e => {
      const target = _findHideTarget(e.target, svgEl);
      if (target) toggleHidden(target.getAttribute('id'));
    });
  }

  renderHiddenList();
}

function _findById(root, id) {
  return root.querySelector(`[id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
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
  const container = document.getElementById('svg-container');
  const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const all = [...container.querySelectorAll(`[id="${escaped}"]`)];
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
  const panel = document.getElementById('hidden-panel');
  if (state.hidden.size === 0) { panel.hidden = true; return; }
  panel.hidden = false;
  document.getElementById('hidden-items').innerHTML = [...state.hidden].map(id => `
    <div class="hidden-row">
      <span class="hidden-label">${_escHtml(_labelFromHideId(id))}</span>
      <button class="restore-btn" data-id="${_escHtml(id)}">Restore</button>
    </div>
  `).join('');
  document.querySelectorAll('.restore-btn').forEach(btn =>
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
    const dom = _findById(document.getElementById('svg-container'), el.group_id);
    if (dom) dom.classList.add(CONFIG.selectedClass);
  }
  renderQueue();
}

function toggleElement(groupId) {
  const idx   = state.queue.findIndex(q => q.group_id === groupId);
  const domEl = _findById(document.getElementById('svg-container'), groupId);

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
  const btn = document.getElementById('queue-all-btn');
  btn.disabled = state.elements.length === 0 || allQueued;

  const container = document.getElementById('queue-items');
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
      const dom  = _findById(document.getElementById('svg-container'), item.group_id);
      if (dom) dom.classList.remove(CONFIG.selectedClass);
      renderQueue();
    }));

  validateOverhangs();
}

function _animOpts(selected) {
  return [
    ['draw_on',            'Draw On'],
    ['fade_in',            'Fade In'],
    ['pop_in',             'Pop In'],
    ['grow_from_baseline', 'Grow from Baseline'],
    ['radial_sweep',       'Radial Sweep'],
  ].map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join('');
}

// HTML-escape for innerHTML interpolation. Named _escHtml (not _esc) because
// detect.js / animate.js / export.js define a global _esc for CSS attribute
// selectors — a same-named declaration here would silently overwrite theirs.
function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Overhang validation ───────────────────────────────────────────────────────

function validateOverhangs() {
  const total = +document.getElementById('total-duration').value;
  state.queue.forEach((item, i) => {
    const end  = +(item.start_time + item.element_duration).toFixed(3);
    const row  = document.querySelector(`.queue-row[data-index="${i}"]`);
    if (!row) return;
    const warn = row.querySelector('.overhang-warning');
    if (end > total) {
      warn.hidden = false;
      warn.innerHTML = `This element extends past the total duration. <button class="extend-btn">Extend to ${end}s</button>`;
      warn.querySelector('.extend-btn').addEventListener('click', () => {
        document.getElementById('total-duration').value = end;
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
    total_duration: +document.getElementById('total-duration').value,
    elements: state.queue.map(item => ({
      group_id:         item.group_id,
      animation_type:   item.animation_type,
      start_time:       item.start_time,
      element_duration: item.element_duration,
    })),
    hidden_ids: [...state.hidden],
  };
}

// ── Preview — fully client-side, no server call ───────────────────────────────

async function preview() {
  if (state.queue.length === 0) return;
  const btn = document.getElementById('preview-btn');
  btn.disabled = true; btn.textContent = 'Previewing…';

  try {
    const config = buildConfig();
    const parser = new DOMParser();
    const svgEl  = parser.parseFromString(state.svg, 'image/svg+xml').documentElement;
    config.hidden_ids.forEach(id => {
      const el = _findById(svgEl, id);
      if (el) el.remove();
    });
    // Hide the Datawrapper background rect so the preview container CSS background
    // shows through. _findBackgroundRect (export.js) matches by full-canvas size,
    // so charts whose first <rect> is real content are handled correctly.
    const bgRect = _findBackgroundRect(svgEl);
    if (bgRect) bgRect.style.display = 'none';
    const animated = buildAnimatedSvg(svgEl, config); // animate.js

    const pc = document.getElementById('preview-container');
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
  const menu = document.getElementById('export-menu');
  menu.hidden = !menu.hidden;
}

async function exportAs(fmt, opts = {}) {
  document.getElementById('export-menu').hidden = true;
  if (state.queue.length === 0) return;

  const panel = document.getElementById('status-panel');
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
  document.getElementById('preview-container').className = `bg-${value}`;
}
