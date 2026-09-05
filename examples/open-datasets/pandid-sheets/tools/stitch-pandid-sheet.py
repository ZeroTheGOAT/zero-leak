#!/usr/bin/env python3
"""Regenerate a full P&ID sheet from the tiled P&ID symbols.zip archive.

Usage: python stitch-pandid-sheet.py <path-to-archive.zip> <sheet-number>

The archive stores each Dataset-P&ID sheet (Paliwal et al. 2021,
arXiv:2109.03794) as 60 overlapping 1280 px tiles on a 640 px stride,
named <sheet>_<y>_<x>.jpg with a matching YOLO label file per tile.

Writes <sheet-dir>/pid-sheet-<n>.jpg (full 7040x4480, q90),
pid-sheet-<n>-preview.png (1600px), manifest.csv (per-class counts)
and labels/ (verbatim per-tile label files).
"""
import collections
import io
import os
import sys
import zipfile

import PIL.Image as Image

STRIDE = 640
TILE = 1280


def main(archive_path, sheet):
    a = zipfile.ZipFile(archive_path)
    names = set(a.namelist())
    rows = list(range(0, 3200 + 1, STRIDE))
    cols = list(range(0, 5760 + 1, STRIDE))
    canvas = Image.new("RGB", (cols[-1] + TILE, rows[-1] + TILE), "white")
    missing = []
    for y in rows:
        for x in cols:
            stem = f"images (3)/{sheet}_{y}_{x}"
            if stem + ".jpg" not in names:
                missing.append(stem)
                continue
            with a.open(stem + ".jpg") as f:
                im = Image.open(io.BytesIO(f.read())).convert("RGB")
            canvas.paste(im, (x, y))
    if missing:
        print("warning: missing tiles:", len(missing))
    out = f"sheet-{sheet}"
    os.makedirs(os.path.join(out, "labels"), exist_ok=True)
    canvas.save(os.path.join(out, f"pid-sheet-{sheet}.jpg"), quality=90, optimize=True)
    prev = canvas.copy()
    prev.thumbnail((1600, 1600))
    prev.save(os.path.join(out, f"pid-sheet-{sheet}-preview.png"))
    agg = collections.Counter()
    for y in rows:
        for x in cols:
            lab = f"labels (2)/{sheet}_{y}_{x}.txt"
            if lab not in names:
                continue
            with open(os.path.join(out, "labels", f"{sheet}_{y}_{x}.txt"), "wb") as lf:
                lf.write(a.read(lab))
            for line in a.read(lab).decode().strip().splitlines():
                if line.strip():
                    agg[line.split()[0]] += 1
    with open(os.path.join(out, "manifest.csv"), "w") as mf:
        mf.write("class_id,count\n")
        for cid, n in sorted(agg.items(), key=lambda kv: int(kv[0])):
            mf.write(f"{cid},{n}\n")
        mf.write(f"total,{sum(agg.values())}\n")
    print(f"sheet {sheet}: canvas {canvas.size}, objects {sum(agg.values())}, "
          f"classes {len(agg)}, missing tiles {len(missing)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
