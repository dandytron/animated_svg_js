// ── app.js — main UI logic ────────────────────────────────────────────────────
//
// Key differences from the Python prototype's static/app.js:
//   - detectElements() runs client-side (detect.js), not on the server
//   - preview() calls buildAnimatedSvg() locally (animate.js), no server round-trip
//   - exportAs() calls export.js functions directly, no SSE stream
//   - Status updates use a simple callback, not an SSE event source

'use strict';

const state = {
  svg:      null,  // raw SVG string from /fetch-svg
  elements: [],    // detected AnimatableElements (client-side)
  queue:    [],    // {group_id, label, animation_type, start_time, element_duration, color}
  hidden:   new Set(), // IDs of elements removed from preview and export
};

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chart-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadSvg();
  });
  document.getElementById('load-btn').addEventListener('click', loadSvg);
  document.getElementById('test-btn').addEventListener('click', loadTestSvg);
  document.getElementById('total-duration').addEventListener('input', validateOverhangs);
  document.getElementById('preview-btn').addEventListener('click', preview);
  document.getElementById('export-btn').addEventListener('click', toggleExportMenu);
  document.getElementById('export-menu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-fmt]');
    if (btn) exportAs(btn.dataset.fmt);
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

async function loadTestSvg() {
  const btn = document.getElementById('test-btn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const resp = await fetch('/test-svg');
    if (!resp.ok) {
      showInputError('test.svg not found on server — check server logs.');
      return;
    }
    const { svg } = await resp.json();
    document.getElementById('chart-id-input').value = CONFIG.testChartId;
    clearInputError();
    state.svg      = svg;
    const svgEl    = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    state.elements = detectElements(svgEl);
    state.queue    = [];
    state.hidden   = new Set();
    injectSvg();
    renderQueue();
    document.getElementById('queue-section').hidden = false;
  } catch {
    showInputError("Couldn't load test SVG.");
  } finally {
    btn.disabled = false; btn.textContent = 'Test';
  }
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
    state.svg = svg;

    // Detection runs client-side — no server call needed
    const parser = new DOMParser();
    const svgEl  = parser.parseFromString(svg, 'image/svg+xml').documentElement;
    state.elements = detectElements(svgEl);  // detect.js
    state.queue    = [];
    state.hidden   = new Set();

    injectSvg();
    renderQueue();
    document.getElementById('queue-section').hidden = false;
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
    for (const rootId of CONFIG.selectableRoots) {
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
// Series group IDs are also excluded (handled by the animation queue instead).
const _HIDE_SKIP = new Set([
  'exportSvg',         // SVG root
  '__svelte-dw-svg',   // Datawrapper's top-level Svelte wrapper — contains almost everything
  'lines-svg',         // series container — children handle their own clicks via stopPropagation
  'chart-svg',         // main chart container
  'group-svg',         // inner positioning group
  'svg-main-svg',      // chart drawing container
  'tooltip-layer-svg', // invisible interaction overlay
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
  const firstSegment = id.split(' ')[0];
  if (_HIDE_SKIP.has(firstSegment)) return false;
  // Datawrapper's top-level layout containers have 'container-svg' as their
  // first ID segment. Their children (header, footer) have it as second segment
  // and are meaningful hide targets — allow those through.
  if (firstSegment === 'container-svg') return false;
  if (state.elements.some(e => e.group_id === id)) return false;
  return true;
}

function toggleHidden(id) {
  const container = document.getElementById('svg-container');
  const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const all = [...container.querySelectorAll(`[id="${escaped}"]`)];
  // Prefer elements outside series containers (bare path IDs share names with label texts).
  const dom = all.find(el => !CONFIG.selectableRoots.some(r => {
    const root = _findById(container, r); return root && root.contains(el);
  })) ?? all[0] ?? null;
  if (state.hidden.has(id)) {
    state.hidden.delete(id);
    if (dom) dom.style.opacity = '';
  } else {
    state.hidden.add(id);
    if (dom) dom.style.opacity = '0.15';
  }
  renderHiddenList();
}

function renderHiddenList() {
  const panel = document.getElementById('hidden-panel');
  if (state.hidden.size === 0) { panel.hidden = true; return; }
  panel.hidden = false;
  document.getElementById('hidden-items').innerHTML = [...state.hidden].map(id => `
    <div class="hidden-row">
      <span class="hidden-label">${_esc(_labelFromHideId(id))}</span>
      <button class="restore-btn" data-id="${_esc(id)}">Restore</button>
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
  const container = document.getElementById('queue-items');
  if (state.queue.length === 0) {
    container.innerHTML = '<p class="queue-empty">Click elements in the SVG above to add them to the queue.</p>';
    return;
  }

  container.innerHTML = state.queue.map((item, i) => `
    <div class="queue-row" data-index="${i}">
      <span class="queue-color" style="background:${item.color || '#888'}"></span>
      <span class="queue-label">${_esc(item.label)}</span>
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

function _esc(s) {
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

async function exportAs(fmt) {
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
        await exportMov(state.svg, config, config.total_duration, onStatus);  // export.js
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
