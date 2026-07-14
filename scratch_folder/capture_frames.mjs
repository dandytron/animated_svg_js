// Rasterize the animated SVG to transparent PNG frames via headless Chrome.
// Mirrors the tool's export approach: seek SMIL time per frame, screenshot with alpha.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SVG_PATH = path.join(__dirname, 'EDITED_unedited_stacked_chart.svg');
const OUT_DIR = path.join(__dirname, 'frames');

// --- Preset: NTSC 1080p ---
const FPS = 30000 / 1001;          // 29.97
const DURATION = 18;               // seconds
const NATURAL_W = 600, NATURAL_H = 238;
const OUT_W = 1920, OUT_H = 762;   // 600->1920 scale 3.2 ; 238*3.2 = 761.6 -> 762
const FRAMES = Math.round(FPS * DURATION); // 300

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const svgText = fs.readFileSync(SVG_PATH, 'utf8');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: OUT_W, height: OUT_H, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><head><meta charset="utf-8">
   <style>*{margin:0;padding:0}html,body{background:transparent;width:${OUT_W}px;height:${OUT_H}px;overflow:hidden}</style>
   </head><body>${svgText}</body></html>`,
  { waitUntil: 'networkidle0' }
);

// ADR 0004: stamp a viewBox (Datawrapper SVGs have none) so width/height scale content.
await page.evaluate((w, h, vw, vh) => {
  const svg = document.querySelector('svg');
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.pauseAnimations();
}, OUT_W, OUT_H, NATURAL_W, NATURAL_H);

const pad = (n) => String(n).padStart(4, '0');
for (let i = 0; i < FRAMES; i++) {
  const t = i / FPS;
  await page.evaluate((tt) => document.querySelector('svg').setCurrentTime(tt), t);
  await page.screenshot({
    path: path.join(OUT_DIR, `frame_${pad(i)}.png`),
    omitBackground: true,
    clip: { x: 0, y: 0, width: OUT_W, height: OUT_H },
  });
  if (i % 30 === 0) process.stdout.write(`  frame ${i}/${FRAMES} (t=${t.toFixed(3)}s)\n`);
}

await browser.close();
console.log(`DONE: ${FRAMES} frames -> ${OUT_DIR}`);
