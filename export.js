// ── export.js — frame capture and encoding ────────────────────────────────────
//
// This file replaces the entire Playwright + ffmpeg pipeline from the Python
// prototype. Key difference: SMIL is NOT used here. See DESIGN_DOC for why.
//
// Instead, we drive animation state by writing SVG attributes directly at each
// timestamp. XMLSerializer then captures the correct values because they are
// real DOM attributes, not animation-engine state.
//
// ffmpeg.wasm encodes GIF and ProRes MOV entirely in-browser.
// All ffmpeg files are proxied through our Flask server (/ffmpeg-esm/, /ffmpeg-core/)
// so every resource is same-origin — no blob URLs, no COEP conflicts.

'use strict';

let _ffmpeg = null;

// ── JS-driven animation state (export only) ───────────────────────────────────
// _clipBounds is defined in animate.js (loaded first) and shared via global scope.

// How far along a given element's animation is at time t (0–1, clamped).
function _progress(elem, t) {
  if (t <= elem.start_time) return 0;
  if (t >= elem.start_time + elem.element_duration) return 1;
  return (t - elem.start_time) / elem.element_duration;
}

// Create static clip paths with no <animate> children. We mutate the rect
// attributes directly each frame so XMLSerializer captures the right values.
function _setupExportClips(svgEl, config, bounds) {
  let defs = svgEl.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  config.elements.forEach((elem, i) => {
    const group = svgEl.querySelector(`[id="${_esc(elem.group_id)}"]`);
    if (!group) {
      console.warn(`export.js: group '${elem.group_id}' not found in SVG — export clip skipped`);
      return;
    }

    if (elem.animation_type === 'draw_on' || elem.animation_type === 'grow_from_baseline') {
      const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      clip.setAttribute('id', `ecl-${i}`);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      if (elem.animation_type === 'draw_on') {
        rect.setAttribute('x',      bounds.x);
        rect.setAttribute('y',      bounds.y);
        rect.setAttribute('width',  '0');
        rect.setAttribute('height', bounds.h);
      } else {
        rect.setAttribute('x',      bounds.x);
        rect.setAttribute('y',      bounds.y + bounds.h);
        rect.setAttribute('width',  bounds.w);
        rect.setAttribute('height', '0');
      }
      clip.appendChild(rect);
      defs.appendChild(clip);
      group.setAttribute('clip-path', `url(#ecl-${i})`);
    }

    if (elem.animation_type === 'fade_in' || elem.animation_type === 'pop_in') {
      group.setAttribute('opacity', '0');
    }
  });
}

// Apply the correct visual state for timestamp t by writing attributes directly.
function _applyAtTime(svgEl, config, bounds, t) {
  config.elements.forEach((elem, i) => {
    const group = svgEl.querySelector(`[id="${_esc(elem.group_id)}"]`);
    if (!group) {
      console.warn(`export.js: group '${elem.group_id}' not found at t=${t} — frame may be incomplete`);
      return;
    }
    const p = _progress(elem, t);

    switch (elem.animation_type) {
      case 'draw_on': {
        const rect = svgEl.querySelector(`#ecl-${i} rect`);
        if (rect) rect.setAttribute('width', p * bounds.w);
        break;
      }
      case 'fade_in':
        group.setAttribute('opacity', p);
        break;
      case 'pop_in':
        group.setAttribute('opacity', t >= elem.start_time ? 1 : 0);
        break;
      case 'grow_from_baseline': {
        const rect = svgEl.querySelector(`#ecl-${i} rect`);
        if (rect) {
          const h = p * bounds.h;
          rect.setAttribute('height', h);
          rect.setAttribute('y', bounds.y + bounds.h - h);
        }
        break;
      }
    }
  });
}

// ── SVG → canvas ──────────────────────────────────────────────────────────────

// Serialise the current DOM state of svgEl and draw it to a new canvas.
// Works because we set real DOM attributes (not SMIL state), so XMLSerializer
// captures the exact values we wrote.
function _svgToCanvas(svgEl, w, h) {
  const svgStr = new XMLSerializer().serializeToString(svgEl);
  const blob   = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url    = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image(w, h);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: true });
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// ── Background rect detection ─────────────────────────────────────────────────

// Find the SVG's opaque background rect — the full-viewBox-spanning white rect
// that Datawrapper places behind the chart content. Used by transparent export
// to hide it so the alpha channel survives into the ProRes output.
//
// Searches only direct children of the SVG root and one level into non-<defs>
// groups. Never descends into <defs> — clip path rects live there and must not
// be hidden.
//
// Returns the matching Element, or null if none is found.
function _findBackgroundRect(svgEl) {
  // Determine reference dimensions. Real Datawrapper SVGs have no viewBox —
  // they use width/height attributes instead. Fall back to those.
  let vx = 0, vy = 0, vw, vh;
  const vbStr = svgEl.getAttribute('viewBox');
  if (vbStr) {
    const vb = vbStr.trim().split(/\s+/).map(Number);
    if (vb.length < 4 || vb.some(isNaN)) return null;
    [vx, vy, vw, vh] = vb;
  } else {
    vw = parseFloat(svgEl.getAttribute('width'));
    vh = parseFloat(svgEl.getAttribute('height'));
    if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null;
  }

  const isBackground = r => {
    const w = parseFloat(r.getAttribute('width'));
    const h = parseFloat(r.getAttribute('height'));
    const x = parseFloat(r.getAttribute('x') || '0');
    const y = parseFloat(r.getAttribute('y') || '0');
    return Math.abs(w - vw) < 2 && Math.abs(h - vh) < 2 && x <= vx + 1 && y <= vy + 1;
  };

  for (const child of svgEl.children) {
    if (child.tagName.toLowerCase() === 'defs') continue;
    if (child.tagName.toLowerCase() === 'rect' && isBackground(child)) return child;
    for (const grandchild of child.children) {
      if (grandchild.tagName.toLowerCase() === 'rect' && isBackground(grandchild)) return grandchild;
    }
  }
  return null;
}

// ── Frame capture ─────────────────────────────────────────────────────────────

async function captureFrames(svgString, config, totalDuration, onProgress, { transparent = false, fps = 30, targetWidth = null } = {}) {
  const totalFrames = Math.ceil(totalDuration * fps);

  const parser = new DOMParser();
  const svgEl  = parser.parseFromString(svgString, 'image/svg+xml').documentElement;

  // Datawrapper SVGs have no viewBox — read width/height attributes directly.
  // For SVGs with a viewBox, the viewBox dimensions define the coordinate space.
  const vbStr = svgEl.getAttribute('viewBox');
  const vw = vbStr ? parseFloat(vbStr.trim().split(/\s+/)[2]) : parseFloat(svgEl.getAttribute('width'));
  const vh = vbStr ? parseFloat(vbStr.trim().split(/\s+/)[3]) : parseFloat(svgEl.getAttribute('height'));

  // SVG content (footer notes, captions) often extends below the declared height.
  // Take the larger of declared height and explicit height attribute, plus a buffer.
  const attrH    = parseFloat(svgEl.getAttribute('height'));
  const naturalW = vw;
  const naturalH = (Number.isFinite(attrH) && attrH > vh ? attrH : vh) + 40;

  // Scale canvas to targetWidth (maintaining aspect ratio). The +40 footer buffer
  // scales with the image so it remains proportionally the same size at any resolution.
  const scale   = targetWidth ? targetWidth / naturalW : 1;
  const canvasW = Math.round(naturalW * scale);
  const canvasH = Math.round(naturalH * scale);

  const bounds = _clipBounds(svgEl);

  (config.hidden_ids || []).forEach(id => {
    const el = svgEl.querySelector(`[id="${_esc(id)}"]`);
    if (el) el.remove();
  });

  _setupExportClips(svgEl, config, bounds);

  // The SVG must be in the live DOM for fonts and styles to resolve correctly.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none';
  host.innerHTML = new XMLSerializer().serializeToString(svgEl);
  document.body.appendChild(host);
  const live = host.querySelector('svg');
  // Without a viewBox, setting width=3840 expands the canvas but leaves the internal
  // coordinate space at the original size — content draws tiny in the top-left corner.
  // Stamp a viewBox matching the natural dimensions so the renderer scales content to fill.
  if (!live.getAttribute('viewBox')) {
    live.setAttribute('viewBox', `0 0 ${naturalW} ${naturalH}`);
  }
  live.setAttribute('width',  canvasW);
  live.setAttribute('height', canvasH);
  live.style.overflow = 'visible';

  // For transparent export (MOV), hide the Datawrapper background rect.
  // Without this, the opaque white rect is baked into every frame and the
  // alpha channel in the ProRes output has no effect.
  if (transparent) {
    const bg = _findBackgroundRect(live);
    if (bg) bg.style.opacity = '0';
  }

  const frames = [];
  try {
    for (let i = 0; i < totalFrames; i++) {
      _applyAtTime(live, config, bounds, i / fps);
      const canvas = await _svgToCanvas(live, canvasW, canvasH);
      frames.push(await new Promise(res => canvas.toBlob(res, 'image/png')));
      if (onProgress) onProgress(i + 1, totalFrames);
    }
  } finally {
    document.body.removeChild(host);
  }

  return { frames, width: canvasW, height: canvasH, fps };
}

// ── ffmpeg.wasm ───────────────────────────────────────────────────────────────

async function _loadFfmpeg(onStatus) {
  if (_ffmpeg) return _ffmpeg;
  onStatus('Loading ffmpeg…');

  // All files served from our own origin via proxy routes — no blob URLs needed.
  // This avoids two problems: (1) COEP blocking cross-origin Worker construction,
  // (2) ESM relative imports inside worker.js and ffmpeg-core.js failing from blob context.
  const base           = window.location.origin;
  const classWorkerURL = `${base}/ffmpeg-esm/worker.js`;
  const coreURL        = `${base}/ffmpeg-core/ffmpeg-core.js`;
  const wasmURL        = `${base}/ffmpeg-core/ffmpeg-core.wasm`;

  const { FFmpeg } = await import(`${base}/ffmpeg-esm/index.js`);

  onStatus('Initialising ffmpeg…');
  const ff = new FFmpeg();
  ff.on('log',      ({ message })  => onStatus(`[ffmpeg] ${message}`));
  ff.on('progress', ({ progress }) => onStatus(`[ffmpeg] progress ${Math.round(progress * 100)}%`));

  const loadResult = await ff.load({ classWorkerURL, coreURL, wasmURL });
  if (!loadResult) throw new Error('ff.load() returned false — core failed to initialise');

  _ffmpeg = ff;
  onStatus('ffmpeg ready.');
  return ff;
}

async function _writeFrames(ff, frames, onStatus) {
  onStatus(`Writing ${frames.length} frames…`);
  for (let i = 0; i < frames.length; i++) {
    const buf = new Uint8Array(await frames[i].arrayBuffer());
    await ff.writeFile(`frame_${String(i).padStart(4, '0')}.png`, buf);
  }
}

async function _cleanFrames(ff, count) {
  for (let i = 0; i < count; i++) {
    await ff.deleteFile(`frame_${String(i).padStart(4, '0')}.png`).catch(() => {});
  }
}

// ── Public export functions ───────────────────────────────────────────────────

// SVG export: build a SMIL-animated SVG (for download, not for canvas).
// Uses animate.js because the output is played in a browser, not serialised.
async function exportSvg(svgString, config) {
  const svgEl = new DOMParser().parseFromString(svgString, 'image/svg+xml').documentElement;
  (config.hidden_ids || []).forEach(id => {
    const el = svgEl.querySelector(`[id="${_esc(id)}"]`);
    if (el) el.remove();
  });
  const animated = buildAnimatedSvg(svgEl, config); // from animate.js
  const out      = new XMLSerializer().serializeToString(animated);
  _download(new Blob([out], { type: 'image/svg+xml' }), 'animated.svg');
}

async function exportGif(svgString, config, totalDuration, onStatus) {
  onStatus('Capturing frames…');
  const { frames, width, height, fps } = await captureFrames(
    svgString, config, totalDuration,
    (i, n) => onStatus(`Capturing frame ${i} of ${n}…`),
  );

  const ff = await _loadFfmpeg(onStatus);
  await _writeFrames(ff, frames, onStatus);

  // Two-pass palette approach: pass 1 builds an optimal 256-colour palette from
  // the actual frame content; pass 2 encodes with that palette.
  // Without this, ffmpeg uses a generic palette that cannot faithfully represent
  // chart colours and produces visible dithering/smearing (especially yellows).
  const scaleFilter = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const inputArgs   = ['-framerate', String(fps), '-i', 'frame_%04d.png'];

  onStatus('Building GIF palette…');
  await ff.exec([
    ...inputArgs,
    '-vf', `${scaleFilter},palettegen=stats_mode=diff`,
    'palette.png',
  ]);

  onStatus('Encoding GIF…');
  await ff.exec([
    ...inputArgs,
    '-i',              'palette.png',
    '-filter_complex', `${scaleFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    'out.gif',
  ]);

  const data = await ff.readFile('out.gif');
  await _cleanFrames(ff, frames.length);
  await ff.deleteFile('palette.png').catch(() => {});
  await ff.deleteFile('out.gif').catch(() => {});

  _download(new Blob([data.buffer], { type: 'image/gif' }), 'animated.gif');
  onStatus('Done.');
}

async function exportMov(svgString, config, totalDuration, onStatus, { fps = 30, targetWidth = null } = {}) {
  // 29.97fps must be passed as the exact rational 30000/1001 for standards-compliant output.
  const fpsArg = Math.abs(fps - 29.97) < 0.01 ? '30000/1001' : String(fps);

  onStatus('Capturing frames…');
  const { frames, width, height } = await captureFrames(
    svgString, config, totalDuration,
    (i, n) => onStatus(`Capturing frame ${i} of ${n}…`),
    { transparent: true, fps, targetWidth },
  );

  const ff = await _loadFfmpeg(onStatus);
  await _writeFrames(ff, frames, onStatus);

  onStatus(`Encoding ProRes 4444 (${fps}fps, ${width}×${height})…`);
  await ff.exec([
    '-framerate',  fpsArg,
    '-i',          'frame_%04d.png',
    '-vcodec',     'prores_ks',
    '-pix_fmt',    'yuva444p10le',
    '-alpha_bits', '16',
    '-profile:v',  '4444',
    '-r',          fpsArg,
    'out.mov',
  ]);

  const data = await ff.readFile('out.mov');
  await _cleanFrames(ff, frames.length);
  await ff.deleteFile('out.mov').catch(() => {});

  _download(new Blob([data.buffer], { type: 'video/quicktime' }), 'animated.mov');
  onStatus('Done. Download started.');
}

function _download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function _esc(id) {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
