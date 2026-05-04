"""
Thin proxy server — the only server-side component in the JS prototype.

Does one thing: proxies /fetch-svg to the Datawrapper API, which cannot be
called directly from the browser due to CORS restrictions enforced by
Datawrapper. Everything else (detection, animation, preview, export) runs
in the browser.

Reuses datawrapper_api.py from the parent directory to avoid duplication.
"""

import sys
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory, Response
from dotenv import load_dotenv
import urllib.request

# Reuse the Datawrapper fetch + sanitize logic from the Python prototype
sys.path.insert(0, str(Path(__file__).parent.parent / 'animated_svg'))
from datawrapper_api import fetch_svg

load_dotenv(Path(__file__).parent.parent / 'animated_svg' / '.env')

app = Flask(__name__, static_folder='.', static_url_path='')


@app.after_request
def _coop_headers(response):
    # Required for ffmpeg.wasm to use SharedArrayBuffer (multi-threaded encoding).
    response.headers['Cross-Origin-Opener-Policy']   = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    return response


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


# Proxy the entire @ffmpeg/ffmpeg ESM package under /ffmpeg-esm/.
# This is necessary because worker.js is an ES module with relative imports
# (./const.js, ./errors.js). Serving only worker.js from our origin means those
# relative paths resolve to localhost — which 404s. Proxying the whole directory
# keeps relative imports resolving correctly within our origin.
_proxy_cache: dict[str, bytes] = {}

def _proxy(url: str, filename: str) -> Response:
    key = url
    if key not in _proxy_cache:
        with urllib.request.urlopen(url) as r:
            _proxy_cache[key] = r.read()
    mime = 'application/wasm' if filename.endswith('.wasm') else 'text/javascript'
    return Response(_proxy_cache[key], mimetype=mime)

# Proxy @ffmpeg/ffmpeg ESM — worker.js has relative imports (./const.js, ./errors.js)
# that must resolve within our origin, not back to unpkg.
@app.route('/ffmpeg-esm/<path:filename>')
def ffmpeg_esm_proxy(filename):
    return _proxy(
        f'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/{filename}', filename)

# Proxy @ffmpeg/core ESM — needed because the worker imports the core via dynamic
# import(), which requires an ES module default export. The UMD build has no default
# export so import().default returns undefined and the core fails to load.
@app.route('/ffmpeg-core/<path:filename>')
def ffmpeg_core_proxy(filename):
    return _proxy(
        f'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/{filename}', filename)


@app.route('/fetch-svg', methods=['POST'])
def fetch_svg_route():
    data     = request.get_json(silent=True) or {}
    chart_id = (data.get('chart_id') or '').strip()
    if not chart_id:
        return jsonify(error='chart_id is required'), 400

    width = int(data.get('width') or 720)

    try:
        svg_string = fetch_svg(chart_id, width=width)
    except Exception:
        return jsonify(error="Couldn't fetch that chart — check the ID and try again."), 502

    return jsonify(svg=svg_string)


if __name__ == '__main__':
    app.run(debug=True, port=5001)
