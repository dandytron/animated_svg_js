// ── fonts.js — embed Datawrapper's Knowledge font into the SVG ────────────────
//
// Datawrapper writes `font-family: Knowledge` but ships no font file, so text
// renders in a fallback face everywhere outside the newsroom. Per the
// line-cinematic checklist §0 that breaks three things the pipeline depends on:
//   1. headlines overflow their own rect-masks (the fallback face is wider),
//   2. the standalone export raster silently loses the font,
//   3. glyph positions measured for text-intro splits land ~27% too wide.
//
// The fix is to inline the real @font-face as data-URIs into the SVG, as the
// FIRST step of each BUILD path (preview / export) — before any measure, split,
// or camera work. Embedding here rather than at load keeps state.svg untouched
// (the raw stored string stays byte-identical) while guaranteeing the font is
// present in every rendered and rasterised copy. This module owns that step.

'use strict';

// Weights the Datawrapper exports actually use, mapped to the vendored .woff.
// Only 300 and 700 appear in real exports (audited across China, SPR, Brent,
// jobless — 0 uses of 400); weight-400 text would fall to 300 by CSS matching
// anyway. Embedding Regular was ~67KB of dead base64 in every exported SVG.
const FONT_FACES = [
  { family: 'Knowledge', weight: 300, file: 'fonts/Knowledge2017-Light.woff' },
  { family: 'Knowledge', weight: 700, file: 'fonts/Knowledge2017-Bold.woff'  },
];

// Cache the built @font-face CSS so the woff files are fetched + encoded once
// per session, not on every build. Holds a Promise<string>.
let _fontCssPromise = null;

// Encode bytes as base64 in chunks — String.fromCharCode.apply on the whole
// array blows the argument-count limit for fonts this size.
function _bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function _buildFontCss() {
  // allSettled, not all: one weight failing to fetch must not throw away the
  // others. With Promise.all a single missing/404 woff rejected the whole build
  // and NOTHING embedded — so a deploy that shipped Light but not Bold got no
  // font at all, the exact §0 failure this module exists to prevent. Now a
  // missing weight degrades that weight only.
  const settled = await Promise.allSettled(FONT_FACES.map(async ({ family, weight, file }) => {
    const resp = await fetch(new URL(file, document.baseURI).href);
    if (!resp.ok) throw new Error(`${file} → ${resp.status}`);
    const b64 = _bytesToBase64(new Uint8Array(await resp.arrayBuffer()));
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};`
         + `src:url(data:font/woff;base64,${b64}) format('woff');}`;
  }));
  const rules = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') rules.push(s.value);
    else console.warn('fonts.js: a font weight failed to embed —', s.reason && s.reason.message);
  }
  return rules.join('');
}

// Build (once, cached) the inlined @font-face CSS. Best-effort: returns '' if
// the woff files can't be fetched, so a missing font degrades to the fallback
// face rather than breaking the build.
function loadFontCss() {
  if (!_fontCssPromise) {
    _fontCssPromise = _buildFontCss().catch(err => {
      console.warn('fonts.js: could not embed fonts —', err.message);
      return '';
    });
  }
  return _fontCssPromise;
}

// True when svgEl references a family we can embed. Gates embedFonts so SVGs
// that never name Knowledge stay lean (embedding is ~147KB). Datawrapper writes
// the family into inline styles; the camera/vertical prototypes use the
// presentation attribute — accept both.
function _referencesEmbeddableFont(svgEl) {
  return FONT_FACES.some(({ family }) =>
    svgEl.querySelector(`[style*="${family}"], [font-family*="${family}"]`) !== null);
}

// Inline the Knowledge @font-face rules into svgEl's <defs> so the real font
// travels inside the SVG (export rasterises it standalone; a relative url()
// would fall back). Mutates svgEl in place and returns it. Idempotent (our
// marked <style> is only added once) and gated (no-op when nothing references
// an embeddable family). Async because the woff bytes are fetched on first use.
async function embedFonts(svgEl) {
  if (svgEl.querySelector('style[data-embedded-fonts]')) return svgEl;
  if (!_referencesEmbeddableFont(svgEl)) return svgEl;

  const css = await loadFontCss();
  if (!css) return svgEl;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let defs = svgEl.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svgEl.insertBefore(defs, svgEl.firstChild);
  }
  const style = document.createElementNS(SVG_NS, 'style');
  style.setAttribute('data-embedded-fonts', '');
  style.textContent = css;
  // First child of defs so the @font-face rules precede any use of the family.
  defs.insertBefore(style, defs.firstChild);
  return svgEl;
}
