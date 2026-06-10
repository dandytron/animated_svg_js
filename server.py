"""
Thin proxy server — the only server-side component in the JS prototype.

Does one thing: proxies /fetch-svg to the Datawrapper API, which cannot be
called directly from the browser due to CORS restrictions enforced by
Datawrapper. Everything else (detection, animation, preview, export) runs
in the browser, and the static site also deploys standalone to GitHub Pages
(where Datawrapper fetch is unavailable — use file upload/paste instead).

Reuses datawrapper_api.py from the parent directory to avoid duplication.
"""

import sys
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
from dotenv import load_dotenv

# Reuse the Datawrapper fetch + sanitize logic from the Python prototype
sys.path.insert(0, str(Path(__file__).parent.parent / 'animated_svg'))
from datawrapper_api import fetch_svg

load_dotenv(Path(__file__).parent.parent / 'animated_svg' / '.env')

app = Flask(__name__, static_folder='.', static_url_path='')


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


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
