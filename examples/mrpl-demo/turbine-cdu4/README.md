# Turbine / CDU-4 scenario — UT thickness survey, replacement, verification

SYNTHETIC DEMONSTRATION MATERIAL. Everything in this folder is invented for
Smart India Hackathon demonstration of problem statement SIH26117. It is not
an MRPL record, specification, inspection or engineering instruction, and the
radiographs named here do not exist.

A second, self-contained scenario alongside the DEMO-SOP-001 documents in the
parent folder. It exercises a wider spread of modalities: a P&ID drawing
(PNG), a gauge photograph (JPG), scanned inspection records (PNG, no text
layer), a CSV thickness log, a Python pump-curve source file and four local
knowledge documents.

## Layout

- `turbine-reports/` — the working folder to attach to a project:
  - `PID-CDU4-1102.png` — P&ID sheet; the 4-P-1102 circuit runs through it
  - `gauge-photo.jpg`, `scan-inspection-note.png`, `scan-utrecord-b.png` —
    photographs/scans without a text layer (OCR + vision exercises)
  - `thickness-log.csv` — round 1 survey, 14 March 2026 (4 test points)
  - `thickness-log-round2.csv` — round 2 survey, 19 September 2026 (added
    with this versioning; the September shutdown window)
  - `reports/tp04-note.txt` — QA leftover from an earlier run; deliberately
    kept: it only says which files mention TP-04. Do not treat it as an
    engineering record.
  - `reports/wo-2026-0771-execution.md` — spool replacement execution and
    post-replacement survey (added with this versioning)
  - `src/pump_curve.py` — small source file for coding/dashboard exercises
- `knowledge/` — index through **Knowledge** for retrieval over local sources:
  `SOP-INSP-014-ut-thickness.md`, `ENG-STD-221-corrosion-allowance.md`,
  `APPROVAL-NOTE-2026-03-20.md`, `SHUTDOWN-WINDOW-2026.md`

## Narrative (what the documents say, ground truth)

1. Round 1, 14 March 2026 (CDU-4 shutdown): TP-04 measured 7.1 mm against a
   9.8 mm retirement limit (ENG-STD-221, NPS 6 Sch 40 in CDU overhead wet H2S
   service), so the elbow spool on line 4-P-1102 is below the acceptance
   criterion.
2. Approval note, 20 March 2026: the spool is approved for replacement under
   WO-2026-0771; radiography of both new welds is mandatory before return to
   service. No owner, due date or review date is stated beyond the next
   available window.
3. Shutdown window: 12–26 September 2026.
4. Round 2, 19 September 2026: the old spool is gone; the new spool reads
   12.5 mm of its 12.7 mm nominal. TP-02 reads 9.9 mm — lowest remaining
   reading, 0.1 mm above retirement. Losses since round 1 are under the
   2.0 mm interval-halving trigger of SOP-INSP-014.
5. Execution record: both new welds radiographed on 20 September 2026 and
   accepted; radiograph IDs RT-2026-0912-A and RT-2026-0912-B are named in
   the record only.

## Evaluation key for rehearsals

- The model must not claim the cut-out spool "was 9.5 mm" — 9.5 in the round-1
  CSV is that record's nominal for TP-04, not a measurement and not the
  retirement limit. The measured value is 7.1 mm.
- TP-02 at 9.9 mm is above retirement: the model must not report it as below
  or replace it; it may flag it as the point to watch.
- The approval note and ENG-STD-221 supply no owner, cost estimate or review
  date for the spool itself beyond the commercial figure of INR 4,20,000 and
  the six-monthly review cadence. Do not accept invented dates.
- Radiography results exist only in the execution record: accepted, no
  reportable indications. The record lists radiograph IDs; the images do not
  exist in this corpus.

## Suggested run

1. Create a project, attach `turbine-reports/`, index `knowledge/`.
2. Run **Inspection approval package** or a plain agent task: "What did the
   March survey find at TP-04, what was approved, and what happened in the
   September window?"
3. Check OCR output against the round-1 log, citations against both scans,
   and the Word/Excel artifacts against this key.
