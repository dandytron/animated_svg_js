#!/usr/bin/env python3
"""Rasterise an animated SVG to transparent frames, then mux ProRes 4444.

The Python twin of scratch_folder/capture_frames.mjs, which is puppeteer-based
and hardcodes a macOS Chrome path. Same approach either way, and the one ADR
0003 describes: seek SMIL time per frame and screenshot with alpha, because
XMLSerializer only ever gives you frame zero.

Presets follow ADR 0002. Defaults to NTSC - 1080p: Reuters delivery is NTSC
unless someone says otherwise.

    python3 export_prores.py EDITED_chart1_china.svg china_16x9
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

_PWLIBS = os.path.expanduser("~/.pwlibs/extracted/usr/lib/x86_64-linux-gnu")
if os.path.isdir(_PWLIBS):
    os.environ["LD_LIBRARY_PATH"] = _PWLIBS + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = Path(__file__).parent
OUT_ROOT = HERE.parent / "exports"

# ADR 0002. 29.97 is carried as the exact rational, not the rounded decimal.
PRESETS = {
    "pal-4k":       (25, None, 3840),
    "pal-1080p":    (25, None, 1920),
    "pal-preview":  (25, None, 960),
    "ntsc-4k":      (30000 / 1001, "30000/1001", 3840),
    "ntsc-1080p":   (30000 / 1001, "30000/1001", 1920),
    "ntsc-preview": (30000 / 1001, "30000/1001", 960),
}


def natural_size(svg_text):
    import re
    w = float(re.search(r'<svg[^>]*\bwidth="([\d.]+)"', svg_text).group(1))
    h = float(re.search(r'<svg[^>]*\bheight="([\d.]+)"', svg_text).group(1))
    return w, h


def ensure_viewbox(svg_text, w, h):
    """Stamp a viewBox if the SVG lacks one, so CSS scaling actually scales.

    Datawrapper ships width/height and NO viewBox. Setting `svg{width:1920px}`
    on such an SVG resizes the viewport but not the coordinate space, so the
    chart renders at its intrinsic size in the top-left quadrant of the frame —
    a silent, easy-to-miss failure (it bit a live delivery this session).

    A viewBox equal to the intrinsic box makes width/height a true scale.
    Idempotent: no-op when a viewBox is already present (e.g. cinematic.py has
    already stamped it, or expanded it for 5% pad — which we must not clobber).
    """
    import re
    if re.search(r'<svg[^>]*\bviewBox=', svg_text):
        return svg_text
    print(f"  note: source has no viewBox — stamping 0 0 {w:.0f} {h:.0f} "
          "(without it the chart renders in the top-left quadrant)")
    return re.sub(r'(<svg\b)', rf'\1 viewBox="0 0 {w:.0f} {h:.0f}"', svg_text, count=1)


def capture(svg_path, out_dir, fps, out_w, duration):
    svg_text = svg_path.read_text()
    nat_w, nat_h = natural_size(svg_text)
    svg_text = ensure_viewbox(svg_text, nat_w, nat_h)
    scale = out_w / nat_w
    # Encoders need even dimensions.
    out_h = int(round(nat_h * scale / 2)) * 2

    frames = int(round(fps * duration))
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)

    html = (
        '<!doctype html><meta charset="utf-8">'
        f"<style>*{{margin:0;padding:0}}html,body{{background:transparent;"
        f"width:{out_w}px;height:{out_h}px;overflow:hidden}}"
        f"svg{{display:block;width:{out_w}px;height:{out_h}px}}</style>"
        + svg_text
    )

    print(f"  {nat_w:.0f}x{nat_h:.0f} -> {out_w}x{out_h}  {frames} frames @ {fps:.3f}fps")
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--hide-scrollbars"])
        page = browser.new_page(viewport={"width": out_w, "height": out_h},
                                device_scale_factor=1)
        page.set_content(html, wait_until="networkidle")
        page.wait_for_timeout(600)          # let the embedded font settle
        page.evaluate("document.querySelector('svg').pauseAnimations()")

        for i in range(frames):
            page.evaluate("t => document.querySelector('svg').setCurrentTime(t)", i / fps)
            page.screenshot(path=str(out_dir / f"f{i:05d}.png"), omit_background=True)
            if i % 25 == 0:
                print(f"    frame {i}/{frames}", flush=True)
        browser.close()
    return frames, out_w, out_h


def encode(frame_dir, mov_path, fps_arg):
    """ProRes 4444 with a real alpha channel — yuva444p10le is what carries it."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", fps_arg,
        "-i", str(frame_dir / "f%05d.png"),
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16",
        "-vendor", "apl0",
        "-r", fps_arg,
        str(mov_path),
    ]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svg")
    ap.add_argument("name")
    ap.add_argument("--preset", default="ntsc-1080p", choices=sorted(PRESETS))
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--width", type=int,
                    help="override the preset's canvas width. ADR 0002's widths "
                         "assume a landscape chart — on a 9:16 source, 1920 lands "
                         "on the long edge and yields 1920x3414. Pass 1080 for a "
                         "vertical so the frame comes out 1080x1920.")
    ap.add_argument("--keep-frames", action="store_true")
    a = ap.parse_args()

    fps, fps_rational, out_w = PRESETS[a.preset]
    out_w = a.width or out_w
    fps_arg = fps_rational or str(int(fps))

    svg_path = (HERE / a.svg) if not Path(a.svg).is_absolute() else Path(a.svg)
    OUT_ROOT.mkdir(exist_ok=True)
    frame_dir = OUT_ROOT / f".frames_{a.name}"
    mov = OUT_ROOT / f"{a.name}_{a.preset}.mov"

    print(f"{svg_path.name} -> {mov.name}  [{a.preset}]")
    frames, w, h = capture(svg_path, frame_dir, fps, out_w, a.duration)
    encode(frame_dir, mov, fps_arg)
    if not a.keep_frames:
        shutil.rmtree(frame_dir, ignore_errors=True)

    size = mov.stat().st_size
    print(f"  wrote {mov}  ({size/1e6:.1f} MB, {w}x{h}, {frames} frames)")


if __name__ == "__main__":
    sys.exit(main())
