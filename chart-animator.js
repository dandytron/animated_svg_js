// ── chart-animator.js — the integration surface ───────────────────────────────
//
// A custom element wrapping the animation tool, so the Reuters Datawrapper
// Exporter (SvelteKit) can mount it with one tag and no build-step coupling.
// Contract: docs/integration-contract.md. Rationale: docs/frontend-integration.md.
//
// THIS IS THE STUB. It implements the whole contract — every property, every
// event, every error code, real validation — but renders a placeholder instead
// of the editor. It exists so Ben's side can wire the handoff, the events and
// the download flow *now*, in parallel with the real build, and swap the editor
// in later without touching their code.
//
// The stub is the contract's executable form: if the real component ever stops
// satisfying what this does, that is a breaking change.

'use strict';

const CONTRACT_VERSION = '0.1.0';

// Shadow DOM is deliberate (ADR 0010 / frontend-integration.md): the exporter's
// GLOBAL stylesheet — resets, base typography — would otherwise reach our
// controls. Svelte already scopes its component styles, and class-prefixing
// cannot stop element selectors, so isolation is the only thing that works.
//
// It costs us the font path: @font-face inside a shadow root is inert. Verified
// 2026-07-27 — a shadow-rooted measurement came back 303.000 against a light-DOM
// reference of 251.000, i.e. exactly the fallback face. The real component must
// therefore ALSO register the faces at document level via the FontFace API
// (see fonts.js); embedding into the SVG alone is not enough. The stub does no
// measuring, so it does not need that yet — but the note belongs here, because
// this file is where the shadow root gets created.
const USE_SHADOW = true;

const STYLE = `
  :host { display: block; container-type: inline-size; }
  .frame {
    font: 400 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1B1F26; background: #F6F7F9;
    border: 1px solid #DFE3E9; border-radius: 6px;
    padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem;
  }
  @media (prefers-color-scheme: dark) {
    .frame { color: #E6E9EE; background: #1B1F26; border-color: #2C323B; }
    .chart { background: #15181D; }
    .meta { color: #949CAB; }
  }
  .bar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
  .tag {
    font: 600 .65rem/1 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .1em; text-transform: uppercase;
    color: #0E7C86; background: #E4F1F2; border: 1px solid #0E7C8644;
    padding: .35em .55em; border-radius: 3px;
  }
  .tag.warn { color: #B45309; background: #FBF0E2; border-color: #B4530944; }
  .spacer { flex: 1 1 auto; }
  button {
    font: inherit; font-size: .875rem; cursor: pointer;
    padding: .45rem .8rem; border-radius: 4px;
    border: 1px solid currentColor; background: transparent; color: inherit;
  }
  button.primary { background: #0E7C86; border-color: #0E7C86; color: #fff; }
  button:focus-visible { outline: 2px solid #0E7C86; outline-offset: 2px; }
  .chart {
    background: #fff; border-radius: 4px; padding: .5rem;
    overflow-x: auto; min-height: 120px;
  }
  .chart svg { max-width: 100%; height: auto; display: block; }
  .meta {
    font: .78rem/1.5 ui-monospace, "SF Mono", Menlo, monospace;
    color: #6A7383; word-break: break-word;
  }
  .notice {
    border-left: 2px solid #B45309; padding: .5rem .75rem;
    background: #B4530911; border-radius: 0 4px 4px 0; font-size: .9rem;
  }
`;

// The type map is ADVISORY and the polarity matters: we enumerate what we KNOW
// we cannot animate, and treat everything else as fine.
//
// The tempting inverse — a SUPPORTED set, refuse anything outside it — quietly
// refuses charts the tool can handle. Datawrapper adds types; this list will go
// stale; a type nobody wrote down is not evidence of anything. And the refusal
// is invisible: the user is told "not supported" and never discovers it would
// have worked. So an unrecognised type proceeds to detection, which is the thing
// that actually knows (frontend-integration.md, "advisory, never a gate").
//
// Keyed by human name because "cannot handle charts of the d3-maps-choropleth
// type" is not a sentence to show a journalist.
const KNOWN_UNSUPPORTED = {
  'd3-pies': 'pie chart', 'd3-donuts': 'donut chart',
  'd3-multiple-pies': 'multiple pie chart', 'd3-multiple-donuts': 'multiple donut chart',
  'election-donut-chart': 'election donut chart',
  'd3-maps-choropleth': 'choropleth map', 'd3-maps-symbols': 'symbol map',
  'locator-map': 'locator map', 'tables': 'table',
  'd3-range-plot': 'range plot', 'd3-arrow-plot': 'arrow plot',
  'd3-bars-bullet': 'bullet bar chart',
};

const CAN_ANIMATE_BLURB =
  'it currently handles line, bar, column, area and scatter charts';

class ChartAnimator extends HTMLElement {
  static version = CONTRACT_VERSION;
  static isStub = true;

  #root;
  #svg = '';
  #chartType = '';
  #chartId = '';
  #look = '';
  #alpha = false;
  #built = false;

  constructor() {
    super();
    this.#root = USE_SHADOW ? this.attachShadow({ mode: 'open' }) : this;
  }

  // ── properties ──────────────────────────────────────────────────────────────
  // svg is a property, never an attribute: a Datawrapper export is tens to
  // hundreds of KB and attribute escaping would mangle it.
  get svg() { return this.#svg; }
  set svg(v) { this.#svg = typeof v === 'string' ? v : ''; this.#ingest(); }

  get chartType() { return this.#chartType; }
  set chartType(v) { this.#chartType = v || ''; if (this.#built) this.#ingest(); }

  get chartId() { return this.#chartId; }
  set chartId(v) { this.#chartId = v || ''; if (this.#built) this.#render(); }

  get look() { return this.#look; }
  set look(v) { this.#look = v || ''; if (this.#built) this.#render(); }

  get alpha() { return this.#alpha; }
  set alpha(v) { this.#alpha = !!v; if (this.#built) this.#render(); }

  connectedCallback() {
    if (!this.#built) this.#render();
  }

  #emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  // ── ingest ──────────────────────────────────────────────────────────────────
  // Real validation, not a shrug: integrators need the error paths to fire so
  // they can build against them. Parse, check dimensions, then report.
  #ingest() {
    this.#built = true;

    if (!this.#svg.trim()) {
      this.#state = { error: 'bad-svg', message: 'No chart was provided.' };
      this.#render();
      return this.#emit('error', { code: 'bad-svg', message: this.#state.message });
    }

    let doc, root;
    try {
      doc = new DOMParser().parseFromString(this.#svg, 'image/svg+xml');
      root = doc.documentElement;
      if (!root || root.nodeName === 'parsererror' || doc.querySelector('parsererror')) {
        throw new Error('not parseable as SVG');
      }
    } catch {
      this.#state = { error: 'bad-svg', message: "That file couldn't be read as an SVG." };
      this.#render();
      return this.#emit('error', { code: 'bad-svg', message: this.#state.message });
    }

    // Datawrapper omits viewBox and puts dimensions on width/height (ADR 0004
    // stamps a viewBox from them), so absent dimensions are genuinely fatal.
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (!(w > 0 && h > 0)) {
      this.#state = {
        error: 'no-dimensions',
        message: "That SVG has no width or height, so it can't be sized for video.",
      };
      this.#render();
      return this.#emit('error', { code: 'no-dimensions', message: this.#state.message });
    }

    // The stub does not run detect.js. It reports what it can know — the type —
    // and leaves `animatable` null so nobody mistakes a stub for a real count.
    const type = this.#chartType;
    const supported = !(type in KNOWN_UNSUPPORTED);
    const message = supported ? '' : this.#unsupportedMessage(type);

    this.#state = { w, h, root, supported, message, error: '' };
    this.#render();
    this.#emit('ready', {
      animatable: null,          // stub: real component reports a count
      chartType: type || null,
      supported,
      message,
      stub: true,
    });
  }

  // Only ever called for a type we positively know about, so the name is real.
  #unsupportedMessage(type) {
    const name = KNOWN_UNSUPPORTED[type];
    const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
    return `This is ${article} ${name}. The tool can't animate ${name}s yet — `
         + `${CAN_ANIMATE_BLURB}.`;
  }

  #state = {};

  // ── render ──────────────────────────────────────────────────────────────────
  #render() {
    const s = this.#state;
    const el = document.createElement('div');
    el.className = 'frame';

    const style = document.createElement('style');
    style.textContent = STYLE;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(tag('Stub v' + CONTRACT_VERSION));
    if (this.#chartType) bar.append(tag(this.#chartType, !s.supported));
    if (this.#look) bar.append(tag(this.#look + ' look'));
    if (this.#alpha) bar.append(tag('alpha'));

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    bar.append(spacer);

    const back = document.createElement('button');
    back.textContent = '← Back';
    back.addEventListener('click', () => this.#emit('cancel'));
    bar.append(back);

    const exp = document.createElement('button');
    exp.className = 'primary';
    exp.textContent = 'Export (stub)';
    exp.disabled = !!s.error;
    exp.addEventListener('click', () => this.#fakeExport());
    bar.append(exp);

    el.append(bar);

    if (s.error) {
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = s.message;
      el.append(n);
    } else {
      if (s.message) {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = s.message;
        el.append(n);
      }
      if (s.root) {
        const holder = document.createElement('div');
        holder.className = 'chart';
        // Import the parsed node rather than re-parsing via innerHTML: keeps the
        // SVG namespace intact and avoids an HTML-parser round trip.
        holder.append(document.importNode(s.root, true));
        el.append(holder);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [
        s.w ? `${s.w}×${s.h}` : null,
        this.#chartId ? `chart ${this.#chartId}` : null,
        'placeholder — the editor mounts here',
      ].filter(Boolean).join(' · ');
      el.append(meta);
    }

    this.#root.replaceChildren(style, el);

    function tag(text, warn) {
      const t = document.createElement('span');
      t.className = warn ? 'tag warn' : 'tag';
      t.textContent = text;
      return t;
    }
  }

  // A real Blob, so the host's download flow can be built and tested end to end
  // against the stub rather than mocked.
  #fakeExport() {
    const blob = new Blob([this.#svg || '<svg xmlns="http://www.w3.org/2000/svg"/>'],
                          { type: 'image/svg+xml' });
    this.#emit('exported', {
      blob,
      filename: `${this.#chartId || 'chart'}-animated.svg`,
      format: 'svg',
      stub: true,
    });
  }
}

if (!customElements.get('chart-animator')) {
  customElements.define('chart-animator', ChartAnimator);
}

if (typeof window !== 'undefined') window.ChartAnimator = ChartAnimator;
