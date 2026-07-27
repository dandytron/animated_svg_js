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

// Cache the raw woff bytes too. Both consumers need them and they must not be
// fetched twice: the inline @font-face (export portability) and the
// document-level FontFace registration (live measurement) are the same bytes
// serving different masters. Holds a Promise<Array<{weight, buf}>>.
let _fontBytesPromise = null;

// Guards document.fonts.add — FontFaceSet is a set of objects, not of families,
// so adding twice really does register two faces.
let _facesRegistered = false;

async function _loadFontBytes() {
  const settled = await Promise.allSettled(FONT_FACES.map(async ({ weight, file }) => {
    const resp = await fetch(new URL(file, document.baseURI).href);
    if (!resp.ok) throw new Error(`${file} → ${resp.status}`);
    return { weight, buf: await resp.arrayBuffer() };
  }));
  const out = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') out.push(s.value);
    else console.warn('fonts.js: a font weight failed to fetch —', s.reason && s.reason.message);
  }
  return out;
}

function _fontBytes() {
  if (!_fontBytesPromise) _fontBytesPromise = _loadFontBytes().catch(() => []);
  return _fontBytesPromise;
}

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
  // A missing weight degrades that weight only — never the whole build. With
  // Promise.all a single 404 rejected everything and NOTHING embedded, so a
  // deploy that shipped Light but not Bold got no font at all: the exact §0
  // failure this module exists to prevent. _loadFontBytes keeps that property.
  const FAMILY = FONT_FACES[0].family;
  const bytes = await _fontBytes();
  return bytes.map(({ weight, buf }) =>
    `@font-face{font-family:'${FAMILY}';font-style:normal;font-weight:${weight};`
    + `src:url(data:font/woff;base64,${_bytesToBase64(new Uint8Array(buf))}) format('woff');}`
  ).join('');
}

// Register the faces on document.fonts.
//
// Required because an @font-face rule inside a SHADOW ROOT is inert. Font faces
// resolve at document level, so the rule embedFonts writes into the SVG's <defs>
// never registers when that SVG lives in a shadow root — document.fonts stays
// empty, ensureFontsLoaded has nothing to load, and `ready` resolves against the
// fallback face.
//
// Measured 2026-07-27 on `Knowledge 300 @ 21px`, each case in its own context:
//
//   light DOM,  embedded   251.000   document.fonts: Knowledge 300/700 loaded
//   shadow root, embedded  303.000   document.fonts: (empty)
//   light DOM,  no font    303.000   document.fonts: (empty)
//
// The shadow case measured EXACTLY as the fallback — 20.7% wide, the §0
// signature. With this registration it returns 251.000, identical to light DOM.
//
// The inline embed stays: export rasterises the SVG standalone and needs the
// bytes travelling inside it. The two paths serve different masters and both are
// required.
async function registerFontsAtDocument() {
  if (_facesRegistered) return;
  if (typeof FontFace === 'undefined' || !document.fonts || !document.fonts.add) return;
  const FAMILY = FONT_FACES[0].family;
  const bytes = await _fontBytes();
  if (!bytes.length) return;
  _facesRegistered = true;   // set before awaiting loads so concurrent calls don't double-add
  await Promise.all(bytes.map(async ({ weight, buf }) => {
    try {
      const face = new FontFace(FAMILY, buf, { weight: String(weight), style: 'normal' });
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      console.warn('fonts.js: could not register weight', weight, '—', err && err.message);
    }
  }));
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

// Force the embedded faces to actually load before any glyph measurement.
// `document.fonts.ready` alone is not enough: it resolves when *pending* loads
// settle, but inserting an @font-face starts no load until something lays out
// text in it — and nothing forces layout between appending the measurement host
// and the await. On a cold font cache the await then resolves against the
// FALLBACK face, getStartPositionOfChar measures ~27% too wide, and every
// bubble-up letter is pinned to the wrong spot (§0 failure mode #3). Requesting
// the faces explicitly makes the load pending, so the subsequent ready await is
// real. Harmless when fonts aren't present (load rejects; we swallow it).
async function ensureFontsLoaded() {
  if (!document.fonts || !document.fonts.load) return;
  try {
    // Register first: document.fonts.load can only load a face the document
    // already knows about. Inside a shadow root nothing else registers one, so
    // without this the load is a no-op and `ready` resolves against the fallback.
    await registerFontsAtDocument();
    await Promise.all(FONT_FACES.map(({ weight, family }) =>
      document.fonts.load(`${weight} 21px ${family}`).catch(() => {})));
    if (document.fonts.ready) await document.fonts.ready;
  } catch { /* best-effort — never block a build on font loading */ }
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
