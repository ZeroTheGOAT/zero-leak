# Open-dataset samples for multimodal demonstration

Curated samples from the two public archives that accompany this project,
for problem statement SIH26117. These are **not** part of the synthetic MRPL
narrative (`../mrpl-demo/`). They are included so vision/OCR demonstrations
run on genuinely public "sample P&IDs and drawings" material, per the
dataset line of the problem statement. No proprietary data is used.

Source archives (kept outside this repository, next to it under
`Documents/ocr/`, not versioned — they are 1.5 GB + 73 MB):
`P&ID symbols.zip` and `uml class diagrams.zip`.

## pid-sheet-175 and pid-sheet-399 (reconstructed P&ID sheets)

The `P&ID symbols.zip` archive is a **tiled derivative of Dataset-P&ID** from
the paper:

> Paliwal, Jain, Sharma, Vig, *Digitize-PID: Automatic Digitization of
> Piping and Instrumentation Diagrams*, 2021 — arXiv:2109.03794
> (https://arxiv.org/abs/2109.03794)

The dataset is 500 synthetic P&IDs annotated with 32 symbol classes (valves
and small equipment only — the sheets carry **symbols, not connecting
lines**). The archive splits every sheet into 30,000 overlapping 1280 px
tiles (640 px stride; 60 tiles per sheet), each with a YOLO-format label
file (`class_id cx cy w h`, normalized, 0-indexed per the paper). Tiles are
named `<sheet>_<y>_<x>.jpg`, sheet prefixes 0–499, grids 100 % complete.

`tools/stitch-pandid-sheet.py` reconstructs a sheet by pasting its 60 tiles
at grid positions. Both included sheets were stitched with **zero seam
mismatch** (overlap regions pixel-identical), producing 7040 x 4480 px
drawings at quality 90 (~1.5 MB each). A 1600 px PNG preview accompanies
each sheet for fast in-app viewing.

Per sheet, `labels/` keeps the 60 original per-tile label files and
`manifest.csv` aggregates symbol-class counts (class ids are numeric; the
id-to-name table lives in the paper, not in the archive — do not invent
names for ids). License terms are not restated in the archive or the
mirrors checked; treat as research data and cite the paper.

## uml-class-diagrams (annotated UML class-diagram pages)

70 annotated pages (image + Pascal-VOC XML each) from a public UML
class-diagram recognition dataset. Families: computer-rendered `Document`
pages, `classes` diagram sets, and phone photographs of handwritten
diagrams (`IMG_2021*`). Ten pages spanning all families are included with
their XML files; `manifest.csv` lists per-page object-type counts
(`class attributes`, `simple class`, `association`, `inheritance`).
License terms are not restated in the archive.

The XML boxes record diagram **structure** (region types), not the text
drawn inside boxes. Reading class names and attributes out of the images is
therefore the OCR/vision task — no text ground truth exists in this corpus,
so a model's claimed readings must be judged by eye, not by the XML.

## Suggested rehearsal uses

- Attach a `pid-sheet-*` folder to a project and ask a vision/OCR task such
  as "describe the symbols on this drawing and count them" — check counts
  against `manifest.csv` (ids are opaque; per-id counts are checkable by
  sheet totals). The sheets carry no plant tag narrative: never ask for
  line numbers or plant story that the dataset does not contain.
- Attach `uml-class-diagrams` and ask for the class diagram structure
  (how many classes, what relations) and then a coding task ("draft class
  skeletons from this diagram") — the handwritten `IMG_2021*` pages are a
  genuine handwriting+drawing exercise from public data.
- Keep the synthetic `../mrpl-demo/` story separate: open-dataset sheets
  must not be described as MRPL records.
