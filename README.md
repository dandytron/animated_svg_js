# SVG Animation Tool — JS

Animates a Datawrapper chart and exports it as an animated SVG, GIF, or ProRes 4444 MOV with transparency. Everything except the Datawrapper API proxy runs in the browser — no build step, no npm.

## What it does

1. Fetches a Datawrapper chart SVG via a server-side proxy (required — Datawrapper blocks browser API calls)
2. Detects animatable element groups client-side
3. User clicks series to build an animation queue, sets timing
4. Preview plays a SMIL-animated SVG live in the browser
5. Export captures frames via canvas and encodes with ffmpeg.wasm, entirely in-browser

## Dependencies

- Python 3 (for the proxy server only)
- `pip install -r requirements.txt`
- A Datawrapper API token
- Reuters Knowledge `.woff` font files in `fonts/` (contact the graphics team)

No Node.js. No npm. No build step.

## Setup

```bash
pip install -r requirements.txt

# Create .env with your Datawrapper token
echo "DATAWRAPPER_ACCESS_TOKEN=your_token_here" > .env

# Place Reuters Knowledge .woff files in fonts/
```

## Run

```bash
python3 server.py
# Open http://localhost:5001
```

## Architecture notes

**Why is there a Python server?** Datawrapper's API cannot be called from the browser (CORS). A one-route proxy is the minimum required server. `server.py` does nothing else — detection, animation, preview, and export all run in the browser.

**Two animation systems:** Preview uses SMIL `<animate>` elements (browser plays them natively). Export uses JS-driven direct attribute writes, because `XMLSerializer` captures static DOM attribute values, not SMIL animation engine state — so frame-by-frame capture requires real attribute mutations.

**ProRes 4444:** Encoded client-side via ffmpeg.wasm. First export triggers a ~31 MB one-time download; subsequent exports reuse the cached instance. The ffmpeg command is identical to a server-side encode: `prores_ks`, `yuva444p10le`, `alpha_bits 16`.

**ffmpeg.wasm files** are served through proxy routes on the Flask server (`/ffmpeg-esm/`, `/ffmpeg-core/`) so they are same-origin. This is required because COEP (`require-corp`) is needed for `SharedArrayBuffer`, but that same header blocks cross-origin Worker construction.

## File layout

| File | Purpose |
|------|---------|
| `server.py` | Flask proxy — one route (`/fetch-svg`) plus ffmpeg file proxies |
| `index.html` | UI shell |
| `config.js` | Shared constants |
| `detect.js` | Client-side element detection (port of `detection.py`) |
| `animate.js` | SMIL injection for live preview (port of `animate_svg.py`) |
| `export.js` | Frame capture + ffmpeg.wasm encoding |
| `app.js` | UI logic — queue, preview, export orchestration |
