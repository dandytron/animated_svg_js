#!/usr/bin/env python3
"""Split a transparent ProRes master into a Hive-ready FILL + KEY pair.

Hive rejects the .mov wrapper that ProRes 4444's alpha needs, and DNxHR-in-MXF
(which Hive does take) carries no alpha channel. So transparency is split into
two ordinary DNxHR/MXF videos — the broadcast fill+key idiom:

    FILL  the picture, colour composited over black
    KEY   the matte, white = opaque, black = transparent

FILL alone is the opaque-black deliverable; FILL + KEY recombined (Premiere
Track Matte Key, Composite Using = Luma) is the transparent one.

Spec matches the validated china pair (ffprobe'd): DNxHR HQX, yuv422p10le, MXF,
29.97 = 30000/1001.

    python3 export_fillkey.py ../exports/jobless_claims_alpha_ntsc-1080p.mov jobless_claims
"""

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT_ROOT = HERE.parent / "exports"
FPS = "30000/1001"                 # NTSC, as the exact rational
PROFILE = "dnxhr_hqx"              # 10-bit 422 in MXF, Premiere- and Sony-native


def _run(cmd):
    subprocess.run(cmd, check=True)


def encode_fill(master, out):
    """Colour over black. overlay flattens the alpha; result is fully opaque."""
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(master),
        "-filter_complex",
        "color=c=black:s=1920x1338:r=30000/1001[bg];"
        "[bg][0:v]overlay=shortest=1,format=yuv422p10le",
        "-c:v", "dnxhd", "-profile:v", PROFILE, "-r", FPS,
        str(out),
    ])


def encode_key(master, out):
    """The alpha channel as a luma matte — white opaque, black transparent."""
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(master),
        "-vf", "alphaextract,format=yuv422p10le",
        "-c:v", "dnxhd", "-profile:v", PROFILE, "-r", FPS,
        str(out),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("master", help="transparent ProRes 4444 .mov (yuva)")
    ap.add_argument("name", help="output basename, e.g. jobless_claims")
    a = ap.parse_args()

    master = Path(a.master)
    if not master.is_absolute():
        master = (HERE / master).resolve()
    OUT_ROOT.mkdir(exist_ok=True)
    fill = OUT_ROOT / f"{a.name}_FILL.mxf"
    key = OUT_ROOT / f"{a.name}_KEY.mxf"

    print(f"{master.name} -> {fill.name} + {key.name}  [{PROFILE}, {FPS}]")
    encode_fill(master, fill)
    encode_key(master, key)
    for f in (fill, key):
        print(f"  wrote {f}  ({f.stat().st_size/1e6:.1f} MB)")
    print("  FILL alone = opaque black; FILL + KEY (Track Matte Key, Luma) = transparent.")


if __name__ == "__main__":
    sys.exit(main())
