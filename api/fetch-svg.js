// Vercel serverless port of the Flask /fetch-svg proxy (server.py +
// animated_svg/datawrapper_api.py). Holds the Datawrapper token server-side;
// the browser can't call the Datawrapper API directly (CORS + secret token).
//
// Flow mirrors datawrapper_api.fetch_svg: clone the chart (never modify the
// original), apply the newsletter theme, export transparent SVG at the
// requested width, always delete the clone, then embed fonts and sanitize.

const fs = require('fs');
const path = require('path');

const DW_API = 'https://api.datawrapper.de';
const THEME  = 'thomson-reuters-newsletters';

function fontWeight(filename) {
  if (filename.includes('Light')) return 300;
  if (filename.includes('Bold'))  return 700;
  return 400;
}

function buildFontCss() {
  // fonts/ ships with the deployment via vercel.json includeFiles; it is
  // licensed (Knowledge typeface) and intentionally not in the public repo.
  const dir = path.join(process.cwd(), 'fonts');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).filter(f => f.endsWith('.woff')).sort().map(f => {
    const data = fs.readFileSync(path.join(dir, f)).toString('base64');
    return `@font-face {\n  font-family: 'Knowledge';\n  font-weight: ${fontWeight(f)};\n  src: url('data:font/woff;base64,${data}') format('woff');\n}`;
  }).join('\n');
}

function embedFonts(svg) {
  const css = buildFontCss();
  if (!css) return svg;
  const style = `<defs><style>${css}</style></defs>`;
  // Insert immediately after the opening <svg ...> tag, like the Python
  // version's defs-at-front insert.
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`);
}

// Source is Datawrapper's own export, so this is defence in depth, not a
// hostile-input parser: strip script/foreignObject blocks, on* handlers,
// and javascript: hrefs — same rules as datawrapper_api.sanitize_svg.
function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject[^>]*\/>/gi, '')
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s+(xlink:)?href\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
}

async function dw(method, url, token, opts = {}) {
  const resp = await fetch(`${DW_API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  if (!resp.ok) throw new Error(`${method} ${url} → ${resp.status}`);
  return resp;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Light same-origin guard: this endpoint spends Datawrapper API quota
  // (clone + export + delete per call), so don't serve other websites.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const token = process.env.DATAWRAPPER_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'DATAWRAPPER_ACCESS_TOKEN is not configured' });
  }

  const chartId = ((req.body || {}).chart_id || '').trim();
  if (!chartId || !/^[A-Za-z0-9]{5,8}$/.test(chartId)) {
    return res.status(400).json({ error: 'chart_id is required' });
  }
  const width = parseInt((req.body || {}).width, 10) || 720;

  let cloneId;
  try {
    const copy = await dw('POST', `/v3/charts/${chartId}/copy`, token);
    cloneId = (await copy.json()).id;

    await dw('PATCH', `/v3/charts/${cloneId}`, token, { json: { theme: THEME } });
    await new Promise(r => setTimeout(r, 1000)); // theme change needs a moment to propagate

    const exp = await dw('GET',
      `/v3/charts/${cloneId}/export/svg?transparent=true&width=${width}`, token);
    const svg = sanitizeSvg(embedFonts(await exp.text()));
    return res.status(200).json({ svg });
  } catch (err) {
    console.error('fetch-svg failed:', err.message);
    return res.status(502).json({ error: "Couldn't fetch that chart — check the ID and try again." });
  } finally {
    if (cloneId) {
      await fetch(`${DW_API}/v3/charts/${cloneId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  }
};
