# SVG Animation Tool — JS

Animates a Datawrapper chart and exports it as an animated SVG, GIF, or ProRes 4444 MOV with transparency. Everything except the Datawrapper API proxy runs in the browser — no build step, no npm.

## What it does

1. Fetches a Datawrapper chart SVG via a server-side proxy (required — Datawrapper blocks browser API calls)
2. Detects animatable element groups client-side — line series, area fills, bar groups, scatter dots
3. User clicks series to build an animation queue (or hits **Queue all** to add everything at once)
4. Preview plays a SMIL-animated SVG live in the browser with configurable background
5. Export captures frames via canvas and encodes with ffmpeg.wasm, entirely in-browser

## Supported chart types

| Chart type | Container | Animation |
|---|---|---|
| Line | `lines-svg` children | Draw on |
| Area fills | `areas-svg` children | Fade in |
| Bar/column | `columns-svg` children | Grow from baseline |
| Scatter | `dots-svg` (whole group) | Pop in |

## Export formats

| Format | Notes |
|---|---|
| Animated SVG | SMIL-animated, plays in any browser |
| GIF | 30fps, two-pass palette optimisation (no colour smearing) |
| ProRes MOV — PAL 25fps | 4K / 1080p / Preview (960×540) |
| ProRes MOV — NTSC 29.97fps | 4K / 1080p / Preview (960×540) |

ProRes is exported with full alpha (transparent background) for compositing in Premiere. 29.97fps is passed to ffmpeg as `30000/1001` for standards-compliant output.

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

**ProRes 4444:** Encoded client-side via ffmpeg.wasm. First export triggers a ~31 MB one-time download; subsequent exports reuse the cached instance. 4K exports take several minutes — this is expected. The ffmpeg command mirrors the Python prototype: `prores_ks`, `yuva444p10le`, `alpha_bits 16`.

**ffmpeg.wasm files** are served through proxy routes on the Flask server (`/ffmpeg-esm/`, `/ffmpeg-core/`) so they are same-origin. This is required because COEP (`require-corp`) is needed for `SharedArrayBuffer`, but that same header blocks cross-origin Worker construction.

**Adding a new chart type:** Add one entry to `CONFIG.chartRoots` in `config.js`. Everything else — click listeners, hide logic, detection — derives from it automatically.

## File layout

| File | Purpose |
|------|---------|
| `server.py` | Flask proxy — one route (`/fetch-svg`) plus ffmpeg file proxies |
| `index.html` | UI shell and all CSS |
| `config.js` | Shared constants and `chartRoots` registry |
| `detect.js` | Client-side element detection (port of `detection.py`) |
| `animate.js` | SMIL injection for live preview (port of `animate_svg.py`) |
| `export.js` | Frame capture + ffmpeg.wasm encoding |
| `app.js` | UI logic — queue, preview, export orchestration |
| `docs/adr/` | Architecture decision records |
| `examples/` | Reference SVGs for each supported chart type |
