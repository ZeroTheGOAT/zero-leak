#!/usr/bin/env python3
"""Score a headless vision-probe run against curated open-dataset ground truth.

The agent turn is asked to write one report file per image, each carrying
machine-readable lines of the form `METRIC <name>: <int>`, or the marker
`READ_FAILED` when the image could not actually be read. This script:

  * locates every *-report.md next to the input images (pid/, uml/),
  * compares their METRIC lines against ground truth,
  * P&ID ground truth = per-sheet symbol totals in manifest.csv (class ids in
    the source corpus are numeric and unknown to the model, so only the
    aggregate object count is comparable);
  * UML ground truth = per-object-type counts from the VOC XML files.
  * Text drawn inside UML boxes has no ground truth in this corpus (the XML
    records structure only) - readings are collected, not machine-scored.

Usage: score-report.py <input-dir> <gt-pid-dir> <gt-uml-dir>
"""
import csv
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

METRIC_RE = re.compile(r"METRIC\s+([A-Za-z0-9_]+)\s*:\s*(\d+)")
FAIL_RE = re.compile(r"READ_FAILED")


def pid_gt(gt_pid):
    """sheet stem -> total objects"""
    out = {}
    for f in glob.glob(os.path.join(gt_pid, "*.csv")):
        stem = os.path.basename(f).replace("manifest-sheet-", "").replace(".csv", "")
        total = 0
        for row in csv.reader(open(f)):
            if row and row[0] == "total":
                total = int(row[1])
        out[stem] = total
    return out


def uml_gt(gt_uml):
    """xml stem -> {object_type: count}"""
    out = {}
    for f in glob.glob(os.path.join(gt_uml, "*.xml")):
        root = ET.parse(f).getroot()
        counts = {}
        for o in root.iter("object"):
            nm = (o.findtext("name") or "?").strip()
            counts[nm] = counts.get(nm, 0) + 1
        out[os.path.basename(f).replace(".xml", "")] = counts
    return out


def load_reports(input_dir):
    """image stem -> (metrics dict, failed bool, raw text)"""
    out = {}
    for sub in ("pid", "uml"):
        d = os.path.join(input_dir, sub)
        for rep in sorted(glob.glob(os.path.join(d, "*-report.md"))):
            stem = os.path.basename(rep)[: -len("-report.md")]
            text = open(rep, encoding="utf-8", errors="replace").read()
            metrics = {m: int(v) for m, v in METRIC_RE.findall(text)}
            out[f"{sub}/{stem}"] = (metrics, bool(FAIL_RE.search(text)), text)
    return out


def pct_err(got, want):
    if want == 0:
        return None
    return 100.0 * abs(got - want) / want


def main():
    inp, gt_pid, gt_uml = sys.argv[1:4]
    pid_gt_d = pid_gt(gt_pid)
    uml_gt_d = uml_gt(gt_uml)
    reports = load_reports(inp)

    print(f"reports found: {len(reports)}/20")
    rows = []
    for key, (metrics, failed, _text) in sorted(reports.items()):
        sub, stem = key.split("/", 1)
        if failed:
            rows.append((key, "READ_FAILED", "-", "-"))
            continue
        if sub == "pid":
            want = pid_gt_d.get(stem)
            got = metrics.get("total_objects")
            if want is None or got is None:
                rows.append((key, "NO_SCORE", str(got), str(want)))
                continue
            rows.append((key, "SCORED", got, want))
        else:
            gt = uml_gt_d.get(stem, {})
            row = ("SCORED", {}, {})
            for name, g in (("class_boxes", "simple class"),
                            ("associations", "association"),
                            ("inheritances", "inheritance")):
                if name in metrics:
                    want = gt.get(g, 0)
                    row[1][name] = metrics[name]
                    row[2][name] = want
            rows.append((key, *row[1:]))

    scored, failed = [], []
    for r in rows:
        (failed if r[1] == "READ_FAILED" else scored).append(r)
    print(f"readable: {len(scored)}  read-failed: {len(failed)}")
    for key, status, *_ in failed:
        print(f"  FAILED  {key}")

    print("\n--- P&ID sheets (METRIC total_objects vs manifest total) ---")
    errs = []
    for key, status, got, want in scored:
        if key.startswith("pid/") and status != "NO_SCORE":
            e = pct_err(got, want)
            if e is not None:
                errs.append(e)
            mark = "ok" if (e is not None and e <= 15.0) else "WIDE" if e is not None else "?"
            print(f"  {key:18s} got {got:4d}  want {want:4d}  err {'' if e is None else f'{e:5.1f}%'}  {mark}")
        elif key.startswith("pid/"):
            print(f"  {key:18s} {status} (got {got}, want {want})")
    if errs:
        print(f"  mean |err| over scored sheets: {sum(errs) / len(errs):.1f}%")

    print("\n--- UML pages (structure counts vs VOC XML) ---")
    for key, status, got, want in scored:
        if not key.startswith("uml/"):
            continue
        if status != "SCORED" or not got:
            print(f"  {key:18s} no METRIC structure lines")
            continue
        bits = []
        for name in ("class_boxes", "associations", "inheritances"):
            if name in got:
                g, w = got[name], want.get(name, 0)
                bits.append(f"{name} {g}/{w}" + ("!" if g != w else ""))
        print(f"  {key:18s} " + ", ".join(bits))

    # Text readings (no ground truth): just count how many reports claim names.
    claimed = sum(1 for _, _, t in reports.values() if re.search(r"(?i)class name|reads?[: ]", t))
    print(f"\ntext-reading claims across reports (not machine-scored): {claimed}")


if __name__ == "__main__":
    main()
