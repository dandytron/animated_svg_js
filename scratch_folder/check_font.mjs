// Report the actual platform font Chrome uses to render the SVG's text nodes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const svgText = fs.readFileSync(path.join(__dirname, 'EDITED_unedited_stacked_chart.svg'), 'utf8');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><body>${svgText}</body>`, { waitUntil: 'networkidle0' });

const client = await page.createCDPSession();
await client.send('DOM.enable');
await client.send('CSS.enable');
const { root } = await client.send('DOM.getDocument', { depth: -1 });

// Sample a 700-weight node (title) and a 300-weight node (a percentage value).
for (const sel of ['tspan[style*="font-weight: 700"]', 'tspan[style*="font-weight: 300"]']) {
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) { console.log(sel, '-> node not found'); continue; }
  const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
  const used = fonts.map(f => `${f.familyName} (${f.glyphCount} glyphs${f.isCustomFont ? ', custom' : ''})`).join(', ');
  console.log(`${sel}\n   -> ${used}`);
}
await browser.close();
