# Synthetic industrial workflow rehearsal

Everything in this folder is invented for demonstration. It is not an MRPL record, specification, inspection, or engineering instruction.

1. Create a project and attach this folder. Open **Workflows → Readiness** and resolve required dependency failures.
2. Index `demo-sop.md` through Knowledge. Start **Inspection approval package**, attaching the revision A scan and the SOP.
3. Open the generated DOCX and XLSX. Check citations and unresolved fields, then export the run receipt.
4. Start **Verified internal dashboard** using the generated tracker. Inspect the actual sandbox command output and local page-check verdict.
5. For **Document revision impact**, attach revision A first and revision B second. The T1 thickness changes from 6.2 mm to 8.2 mm on page 2. Everything else remains the same.
6. For **Cross-document discrepancy review**, attach both revisions. The app should recognize a revision difference and avoid treating different revisions as unexplained simultaneous readings.

## Expected observations (human evaluation key)

- Three equipment tags: DEMO-P-101, DEMO-L-201 and DEMO-V-301.
- Staining at the pump flange; the leak source and rate are unconfirmed.
- Revision A records 6.2 mm at DEMO-L-201/T1; revision B records 8.2 mm at the same point.
- DEMO-V-301 records 18 with no unit. The unit must remain unknown.
- No retirement thickness, cost estimate, owner, due date or engineering approval was provided. None should be invented.
- Exported documents are drafts requiring human review.

Both PDF files deliberately have no text layer, so this exercises OCR. Assess extracted values, source pages, missing fields and actual exported files; a passing execution check alone is insufficient.

## Sovereignty demonstration

Use **Workflows → Network** to inspect application HTTP guard decisions and evaluate the public-destination refusal without making a connection. Pair it with an independent OS network capture covering the workbench and its child processes. Report the capture interval and interface coverage. The application log is not a packet capture and cannot establish absence of traffic from other software on the workstation.

## Measure, do not invent

Record elapsed time from each receipt, correct expected observations, incorrect claims, missing findings and citation accuracy. Rehearse repeatedly on the actual demonstration GPU. Keep a recording of a real successful run if the venue allows recorded fallback demonstrations; label recordings explicitly.

## Second scenario: turbine / CDU-4

`turbine-cdu4/` is a second, self-contained scenario with its own narrative
and evaluation key. Where this folder's documents are the DEMO-SOP-001
revision story (two image-only PDFs), `turbine-cdu4/` adds a P&ID, a gauge
photograph, scanned records, CSV thickness logs across two shutdown surveys
(14 March and 19 September 2026), a spool-replacement execution record and
four knowledge sources. See `turbine-cdu4/README.md` for ground truth. The
round-2 log and the execution record were added when the corpus was versioned
into this folder; the round-1 log and all knowledge files are copies of the
previously unversioned material.
