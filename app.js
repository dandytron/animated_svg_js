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
};

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chart-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadSvg();
  });
  document.getElementById('load-btn').addEventListener('click', loadSvg);
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
  if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; svgEl.style.display = 'block'; }

  document.getElementById('no-elements-warning').hidden = state.elements.length > 0;

  for (const el of state.elements) {
    const dom = _findById(container, el.group_id);
    if (!dom) continue;
    dom.style.cursor = 'pointer';
    dom.addEventListener('click', e => { e.stopPropagation(); toggleElement(el.group_id); });
  }
}

function _findById(root, id) {
  return root.querySelector(`[id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
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
  };
}

// ── Preview — fully client-side, no server call ───────────────────────────────

async function preview() {
  if (state.queue.length === 0) return;
  const btn = document.getElementById('preview-btn');
  btn.disabled = true; btn.textContent = 'Previewing…';

  try {
    const parser   = new DOMParser();
    const svgEl    = parser.parseFromString(state.svg, 'image/svg+xml').documentElement;
    const animated = buildAnimatedSvg(svgEl, buildConfig()); // animate.js

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
