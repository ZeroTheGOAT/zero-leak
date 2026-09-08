import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const { SKILL_DIR, TMP_DIR, WORKSPACE_DIR, OUTPUT_DIR, RUNTIME_PYTHON } = process.env;
for (const [name, value] of Object.entries({ SKILL_DIR, TMP_DIR, WORKSPACE_DIR, OUTPUT_DIR, RUNTIME_PYTHON })) {
  if (!path.isAbsolute(value ?? "")) throw new Error(`${name} must be an absolute path`);
}

const { resolvePresentationFont, finalizePresentation } = await import(
  pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href,
);

await fs.mkdir(TMP_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const family = resolvePresentationFont();
const W = 1280;
const H = 720;
const presentation = Presentation.create({ slideSize: { width: W, height: H } });

const C = {
  navy: "#172738",
  navy2: "#243B4D",
  ink: "#1F2A35",
  muted: "#66717B",
  warm: "#F7F3EA",
  warm2: "#EEE7D9",
  line: "#D6CEC0",
  white: "#FFFFFF",
  orange: "#E8753B",
  saffron: "#F29A48",
  teal: "#2E8B84",
  tealSoft: "#DDEEEB",
  green: "#2E7D5B",
  greenSoft: "#E2F1E8",
  red: "#B94A48",
  redSoft: "#F6E4E1",
  blueSoft: "#E6EEF5",
};

const ASSET = {
  pid: path.join(WORKSPACE_DIR, "zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/PID-CDU4-1102.png"),
  scan: path.join(WORKSPACE_DIR, "zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/scan-inspection-note.png"),
  gauge: path.join(WORKSPACE_DIR, "zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/gauge-photo.jpg"),
};

const pidBytes = await fs.readFile(ASSET.pid);
const scanBytes = await fs.readFile(ASSET.scan);
const gaugeBytes = await fs.readFile(ASSET.gauge);

function addShape(slide, geometry, position, fill = "none", lineFill = "none", lineWidth = 0, extra = {}) {
  return slide.shapes.add({
    geometry,
    position,
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
    ...extra,
  });
}

function addText(slide, text, position, style = {}) {
  const shape = addShape(slide, "textbox", position);
  shape.text = text;
  shape.text.style = {
    typeface: family,
    fontSize: style.fontSize ?? 22,
    color: style.color ?? C.ink,
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    alignment: style.alignment ?? "left",
  };
  return shape;
}

function addRule(slide, left, top, width, color = C.line, height = 1) {
  return addShape(slide, "rect", { left, top, width, height }, color);
}

function addImage(slide, blob, contentType, alt, position, fit = "cover", extra = {}) {
  return slide.images.add({ blob, contentType, alt, position, fit, ...extra });
}

function addFooter(slide, page, dark = false) {
  const color = dark ? "#AFC0CA" : C.muted;
  const lineColor = dark ? "#365062" : C.line;
  addRule(slide, 64, 676, 1152, lineColor, 1);
  addText(slide, `SIH 2026  •  SIH26117`, { left: 64, top: 687, width: 240, height: 18 }, { fontSize: 14, color });
  addText(slide, `ZeroLeak AI  •  ${String(page).padStart(2, "0")}`, { left: 1010, top: 687, width: 206, height: 18 }, { fontSize: 14, color, alignment: "right" });
}

function addKicker(slide, text, dark = false) {
  addText(slide, text.toUpperCase(), { left: 64, top: 42, width: 600, height: 22 }, {
    fontSize: 14,
    color: dark ? C.saffron : C.orange,
    bold: true,
  });
}

function addSlideTitle(slide, title, subtitle = "", dark = false) {
  addText(slide, title, { left: 64, top: 72, width: 900, height: 92 }, {
    fontSize: 42,
    color: dark ? C.white : C.ink,
    bold: true,
  });
  if (subtitle) {
    addText(slide, subtitle, { left: 66, top: 170, width: 1100, height: 30 }, {
      fontSize: 20,
      color: dark ? "#C8D3D8" : C.muted,
    });
  }
}

function addNumberRow(slide, number, label, body, top, options = {}) {
  const dark = options.dark ?? false;
  const labelColor = dark ? C.white : C.ink;
  const bodyColor = dark ? "#C8D3D8" : C.muted;
  const markerFill = options.markerFill ?? C.orange;
  addShape(slide, "ellipse", { left: 66, top: top + 2, width: 27, height: 27 }, markerFill);
  addText(slide, number, { left: 66, top: top + 5, width: 27, height: 18 }, { fontSize: 14, bold: true, color: C.white, alignment: "center" });
  addText(slide, label, { left: 110, top, width: options.labelWidth ?? 280, height: 25 }, { fontSize: options.labelFontSize ?? 21, bold: true, color: labelColor });
  addText(slide, body, { left: 110, top: top + 27, width: options.bodyWidth ?? 520, height: options.bodyHeight ?? 44 }, { fontSize: 18, color: bodyColor });
}

function addStatusRow(slide, label, body, top, status = "pass") {
  const tone = status === "pass" ? C.green : status === "watch" ? C.orange : C.red;
  const soft = status === "pass" ? C.greenSoft : status === "watch" ? C.warm2 : C.redSoft;
  addShape(slide, "ellipse", { left: 68, top: top + 4, width: 18, height: 18 }, soft, tone, 1);
  addText(slide, status === "pass" ? "✓" : status === "watch" ? "!" : "×", { left: 68, top: top + 4, width: 18, height: 17 }, { fontSize: 12, bold: true, color: tone, alignment: "center" });
  addText(slide, label, { left: 102, top, width: 260, height: 23 }, { fontSize: 19, bold: true, color: C.ink });
  addText(slide, body, { left: 102, top: top + 25, width: 460, height: 38 }, { fontSize: 17, color: C.muted });
}

function addRiskRow(slide, risk, mitigation, top) {
  addText(slide, risk, { left: 710, top, width: 190, height: 23 }, { fontSize: 19, bold: true, color: C.ink });
  addText(slide, mitigation, { left: 910, top, width: 295, height: 40 }, { fontSize: 17, color: C.muted });
  addRule(slide, 710, top + 47, 495, C.line, 1);
}

// Slide 1: title page
{
  const slide = presentation.slides.add();
  slide.background.fill = C.navy;
  addRule(slide, 64, 60, 116, C.orange, 5);
  addText(slide, "SMART INDIA HACKATHON 2026", { left: 64, top: 80, width: 520, height: 24 }, { fontSize: 18, bold: true, color: "#D9E3E7" });
  addText(slide, "117", { left: 872, top: 48, width: 304, height: 155 }, { fontSize: 128, bold: true, color: C.orange, alignment: "right" });
  addText(slide, "SOVEREIGN\nON-PREMISE\nAGENTIC AI", { left: 944, top: 224, width: 240, height: 116 }, { fontSize: 18, bold: true, color: "#C8D3D8", alignment: "right" });
  addText(slide, "ZeroLeak AI", { left: 64, top: 214, width: 800, height: 76 }, { fontSize: 58, bold: true, color: C.white });
  addText(slide, "A local workbench for confidential industrial work", { left: 68, top: 300, width: 720, height: 40 }, { fontSize: 26, color: "#D0D9DD" });
  addRule(slide, 68, 366, 720, "#3C5566", 1);
  addText(slide, "Problem Statement", { left: 68, top: 397, width: 220, height: 22 }, { fontSize: 16, color: C.saffron, bold: true });
  addText(slide, "SIH26117  |  Sovereign On-Premise Agentic AI Workbench using Open-Weight Multimodal LLMs for Confidential Industrial Work", { left: 68, top: 423, width: 730, height: 58 }, { fontSize: 20, color: C.white });
  addText(slide, "Mangalore Refinery and Petrochemicals Limited (MRPL)  •  Smart Automation  •  Software", { left: 68, top: 523, width: 820, height: 25 }, { fontSize: 18, color: "#B9C7CE" });
  addText(slide, "Team: [TEAM NAME]   •   Team ID: [TEAM ID]", { left: 68, top: 589, width: 520, height: 25 }, { fontSize: 18, bold: true, color: C.white });
  addText(slide, "Idea submission deck", { left: 68, top: 625, width: 240, height: 20 }, { fontSize: 15, color: "#94A9B5" });
  addText(slide, "Prototype evidence from a local ZeroLeak AI workstation", { left: 690, top: 625, width: 520, height: 20 }, { fontSize: 15, color: "#94A9B5", alignment: "right" });
  slide.speakerNotes.textFrame.setText([
    "Problem statement metadata: SIH26117, S.No. 117, title, MRPL, category Software and theme Smart Automation.",
    "Primary source: https://sih.gov.in/sih2026PS",
    "Cross-check: https://github.com/jeevansai-hub/SIH-2026-/blob/main/ps_2026/SIH26117.md",
    "Project source: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/README.md",
    "Replace [TEAM NAME] and [TEAM ID] with portal-registered values before submission.",
  ].join("\n"));
}

// Slide 2: proposed solution
{
  const slide = presentation.slides.add();
  slide.background.fill = C.warm;
  addKicker(slide, "01  /  Proposed solution");
  addSlideTitle(slide, "A private agent for work that cannot leave the site", "The workbench keeps documents local while still acting like a useful task partner.");
  addNumberRow(slide, "1", "Self-hosted", "Runs on the organization’s own workstation or GPU server. Public cloud assistants never sit in the workflow.", 208, { bodyWidth: 520 });
  addNumberRow(slide, "2", "Task-aware", "Routes coding, long-document, OCR and vision work to the right local model on demand.", 309, { bodyWidth: 520, markerFill: C.teal });
  addNumberRow(slide, "3", "Actionable", "Reads files, searches local knowledge, runs sandboxed tools and creates reviewable deliverables.", 410, { bodyWidth: 520, markerFill: C.navy2 });
  addShape(slide, "roundRect", { left: 66, top: 548, width: 550, height: 74 }, C.navy, "none", 0, { borderRadius: "rounded-2xl" });
  addText(slide, "The output is a work package", { left: 88, top: 566, width: 480, height: 23 }, { fontSize: 21, bold: true, color: C.white });
  addText(slide, "Source citations  +  approval note  +  action tracker", { left: 88, top: 595, width: 460, height: 22 }, { fontSize: 17, color: "#C8D3D8" });
  addShape(slide, "roundRect", { left: 694, top: 205, width: 512, height: 419 }, C.white, C.line, 1, { borderRadius: "rounded-2xl", shadow: "shadow-sm" });
  addImage(slide, scanBytes, "image/png", "Synthetic inspection note used to demonstrate local OCR", { left: 726, top: 230, width: 448, height: 325 }, "contain", { geometry: "roundRect", borderRadius: "rounded-xl" });
  addShape(slide, "roundRect", { left: 726, top: 575, width: 448, height: 30 }, C.tealSoft, "none", 0, { borderRadius: "rounded-full" });
  addText(slide, "IMAGE-ONLY PAGE  •  OCR + EVIDENCE EXTRACTION", { left: 742, top: 582, width: 416, height: 16 }, { fontSize: 13, bold: true, color: C.teal, alignment: "center" });
  addFooter(slide, 2);
  slide.speakerNotes.textFrame.setText([
    "Solution claims are based on the SIH26117 description, which calls for a self-hosted, air-gapped workbench that supports multiple open-weight models, local tools, multimodal inputs and real deliverables.",
    "Product evidence: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/README.md and MRPL_WORKFLOWS.md.",
    "Visual asset: synthetic inspection note at C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/scan-inspection-note.png.",
    "The sample corpus is synthetic and contains no proprietary MRPL record.",
  ].join("\n"));
}

// Slide 3: technical approach
{
  const slide = presentation.slides.add();
  slide.background.fill = C.navy;
  addKicker(slide, "02  /  Technical approach", true);
  addSlideTitle(slide, "Local models, one controlled path", "Route the task, ground it in local evidence, act through tools and verify the result.", true);

  const input = addShape(slide, "roundRect", { left: 64, top: 222, width: 180, height: 200 }, C.navy2, "#4A6373", 1, { borderRadius: "rounded-2xl" });
  addText(slide, "INPUTS", { left: 84, top: 242, width: 140, height: 20 }, { fontSize: 14, bold: true, color: C.saffron });
  addText(slide, "Scanned PDFs\nP&IDs\nCode and spreadsheets\nSOPs and manuals", { left: 84, top: 275, width: 140, height: 90 }, { fontSize: 18, color: C.white });

  const router = addShape(slide, "roundRect", { left: 290, top: 206, width: 190, height: 200 }, C.orange, "none", 0, { borderRadius: "rounded-2xl" });
  addText(slide, "ROUTER", { left: 312, top: 228, width: 145, height: 22 }, { fontSize: 14, bold: true, color: C.navy, alignment: "center" });
  addText(slide, "Task-aware\nmodel\nselection", { left: 312, top: 264, width: 145, height: 78 }, { fontSize: 23, bold: true, color: C.navy, alignment: "center" });
  addText(slide, "127.0.0.1\nload on demand", { left: 312, top: 350, width: 145, height: 36 }, { fontSize: 16, color: C.navy, alignment: "center" });

  const toolsBox = addShape(slide, "roundRect", { left: 530, top: 222, width: 185, height: 200 }, C.navy2, "#4A6373", 1, { borderRadius: "rounded-2xl" });
  addText(slide, "LOCAL TOOLS", { left: 550, top: 242, width: 145, height: 20 }, { fontSize: 14, bold: true, color: C.saffron });
  addText(slide, "OCR + vision\nKnowledge + citations\nSandbox\nDocument generators", { left: 550, top: 275, width: 150, height: 90 }, { fontSize: 16, color: C.white });

  const outputs = addShape(slide, "roundRect", { left: 765, top: 222, width: 160, height: 200 }, C.teal, "none", 0, { borderRadius: "rounded-2xl" });
  addText(slide, "OUTPUTS", { left: 784, top: 242, width: 122, height: 20 }, { fontSize: 14, bold: true, color: C.white });
  addText(slide, "DOCX\nXLSX\nPPTX / PDF\nWorking code", { left: 784, top: 275, width: 122, height: 90 }, { fontSize: 20, bold: true, color: C.white });

  slide.shapes.connect(input, router, { kind: "straight", fromSide: "right", toSide: "left", line: { style: "solid", fill: C.saffron, width: 3 }, tail: { type: "arrow", width: "med", length: "med" } });
  slide.shapes.connect(router, toolsBox, { kind: "straight", fromSide: "right", toSide: "left", line: { style: "solid", fill: C.saffron, width: 3 }, tail: { type: "arrow", width: "med", length: "med" } });
  slide.shapes.connect(toolsBox, outputs, { kind: "straight", fromSide: "right", toSide: "left", line: { style: "solid", fill: C.saffron, width: 3 }, tail: { type: "arrow", width: "med", length: "med" } });

  addText(slide, "MODEL ROLES", { left: 64, top: 434, width: 220, height: 22 }, { fontSize: 15, bold: true, color: C.saffron });
  addText(slide, "Gemma 4 E4B", { left: 64, top: 468, width: 185, height: 21 }, { fontSize: 16, bold: true, color: C.white });
  addText(slide, "Reasoning and vision", { left: 252, top: 468, width: 200, height: 21 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "PaddleOCR-VL 1.6", { left: 64, top: 501, width: 185, height: 21 }, { fontSize: 16, bold: true, color: C.white });
  addText(slide, "Printed scan specialist", { left: 252, top: 501, width: 200, height: 21 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "olmOCR 2", { left: 64, top: 534, width: 185, height: 21 }, { fontSize: 16, bold: true, color: C.white });
  addText(slide, "Handwriting fallback", { left: 252, top: 534, width: 200, height: 21 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "Nemotron 3 Nano 4B", { left: 64, top: 567, width: 185, height: 21 }, { fontSize: 16, bold: true, color: C.white });
  addText(slide, "Long-document context", { left: 252, top: 567, width: 200, height: 21 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "BGE-M3", { left: 64, top: 600, width: 185, height: 21 }, { fontSize: 16, bold: true, color: C.white });
  addText(slide, "Local embeddings", { left: 252, top: 600, width: 200, height: 21 }, { fontSize: 15, color: "#C8D3D8" });

  addShape(slide, "roundRect", { left: 970, top: 424, width: 236, height: 206 }, C.white, "none", 0, { borderRadius: "rounded-2xl" });
  addImage(slide, pidBytes, "image/png", "Synthetic P&ID used to demonstrate local multimodal analysis", { left: 986, top: 440, width: 204, height: 154 }, "contain", { geometry: "roundRect", borderRadius: "rounded-xl" });
  addText(slide, "Vision input\nP&ID-CDU4-1102", { left: 986, top: 603, width: 204, height: 37 }, { fontSize: 15, bold: true, color: C.navy, alignment: "center" });
  addFooter(slide, 3, true);
  slide.speakerNotes.textFrame.setText([
    "Technical approach reflects the local model registry and router implementation.",
    "Source: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/src/services/registry.ts",
    "Source: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/src-tauri/src/router.rs",
    "The workbench binds the model router to 127.0.0.1 and routes OCR, vision, embeddings, reasoning and coding to different local model roles.",
    "Visual asset: synthetic P&ID at C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/PID-CDU4-1102.png.",
  ].join("\n"));
}

// Slide 4: feasibility and viability
{
  const slide = presentation.slides.add();
  slide.background.fill = C.warm;
  addKicker(slide, "03  /  Feasibility and viability");
  addSlideTitle(slide, "Feasibility on one workstation", "The prototype closes the core demo loop while keeping remaining deployment gates visible.");
  addText(slide, "PROTOTYPE PROOF POINTS", { left: 66, top: 208, width: 340, height: 22 }, { fontSize: 15, bold: true, color: C.orange });
  addStatusRow(slide, "Local runtime", "llama.cpp, Python, Node and pdftoppm are available locally.", 245, "pass");
  addStatusRow(slide, "GPU profile", "RTX 4060 Laptop GPU with 7,107 MiB usable and up to 2 resident models.", 331, "pass");
  addStatusRow(slide, "Real exporters", "Word, Excel and PowerPoint packages are generated and reopened for checks.", 417, "pass");
  addStatusRow(slide, "Demo corpus", "Synthetic and open-dataset scans and P&IDs keep the rehearsal non-proprietary.", 503, "pass");

  addText(slide, "RISKS AND MITIGATIONS", { left: 710, top: 208, width: 330, height: 22 }, { fontSize: 15, bold: true, color: C.orange });
  addRiskRow(slide, "GPU contention", "On-demand loading plus idle eviction keeps the memory budget visible.", 245);
  addRiskRow(slide, "Scanned pages", "OCR specialist first, then vision fallback when confidence or handwriting requires it.", 331);
  addRiskRow(slide, "Unknown fields", "Preserve missing units, limits, owners and dates for human review.", 417);
  addRiskRow(slide, "Sovereignty proof", "Pair the application guard with independent OS-level packet capture.", 503);
  addShape(slide, "roundRect", { left: 66, top: 590, width: 1139, height: 46 }, C.blueSoft, "none", 0, { borderRadius: "rounded-full" });
  addText(slide, "Deployment gate: warm up the target models and rehearse the capture interval on the venue machine before making a final sovereignty claim.", { left: 90, top: 603, width: 1090, height: 20 }, { fontSize: 16, bold: true, color: C.navy, alignment: "center" });
  addFooter(slide, 4);
  slide.speakerNotes.textFrame.setText([
    "Readiness proof points come from the live local Workflows → Readiness screen and the project workflow guide.",
    "Sources: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/MRPL_WORKFLOWS.md and C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/.uifix/readiness-result.json.",
    "The GPU number is a development-machine measurement from the local app UI, not a universal deployment requirement.",
    "The project documentation explicitly says application network decisions are not a packet capture, so the deck preserves the independent OS capture step.",
  ].join("\n"));
}

// Slide 5: impact and benefits
{
  const slide = presentation.slides.add();
  slide.background.fill = C.navy;
  addKicker(slide, "04  /  Impact and benefits", true);
  addSlideTitle(slide, "Impact and benefits", "Confidential work stays local while the workbench handles the task.", true);
  addText(slide, "EXPECTED VALUE", { left: 66, top: 194, width: 260, height: 22 }, { fontSize: 15, bold: true, color: C.saffron });
  addNumberRow(slide, "1", "Engineers and inspectors", "Extract findings from scans and P&IDs while retaining the exact source page.", 230, { dark: true, bodyWidth: 510 });
  addNumberRow(slide, "2", "Approvers", "Receive a draft note and action tracker with unresolved fields visible before a human decision.", 322, { dark: true, bodyWidth: 510, markerFill: C.teal });
  addNumberRow(slide, "3", "Knowledge teams", "Search manuals and SOPs locally with citations that point back to the retrieved evidence.", 414, { dark: true, bodyWidth: 510, markerFill: C.orange });
  addNumberRow(slide, "4", "IT and security", "Inspect model routing, tool calls, artifacts and network decisions in one workbench.", 506, { dark: true, bodyWidth: 510, markerFill: C.navy2 });
  addShape(slide, "roundRect", { left: 780, top: 196, width: 426, height: 336 }, C.white, "none", 0, { borderRadius: "rounded-2xl" });
  addImage(slide, gaugeBytes, "image/jpeg", "Synthetic gauge photograph used to represent industrial operator context", { left: 806, top: 222, width: 374, height: 220 }, "cover", { geometry: "roundRect", borderRadius: "rounded-xl" });
  addText(slide, "Operator context", { left: 806, top: 458, width: 180, height: 20 }, { fontSize: 16, bold: true, color: C.navy });
  addText(slide, "The value is a verified work package, not a chat reply.", { left: 806, top: 484, width: 350, height: 42 }, { fontSize: 17, color: C.muted });
  addRule(slide, 66, 610, 1140, "#365062", 1);
  addText(slide, "1", { left: 84, top: 626, width: 45, height: 32 }, { fontSize: 30, bold: true, color: C.saffron });
  addText(slide, "workstation-ready demo", { left: 132, top: 631, width: 190, height: 18 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "5", { left: 420, top: 626, width: 45, height: 32 }, { fontSize: 30, bold: true, color: C.saffron });
  addText(slide, "model roles", { left: 468, top: 631, width: 130, height: 18 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "7", { left: 730, top: 626, width: 45, height: 32 }, { fontSize: 30, bold: true, color: C.saffron });
  addText(slide, "artifact types", { left: 778, top: 631, width: 150, height: 18 }, { fontSize: 15, color: "#C8D3D8" });
  addText(slide, "prototype catalog", { left: 1030, top: 632, width: 150, height: 18 }, { fontSize: 14, color: "#94A9B5", alignment: "right" });
  addFooter(slide, 5, true);
  slide.speakerNotes.textFrame.setText([
    "Expected impact is derived from the SIH26117 expected solution and from the implemented workflow surfaces.",
    "Product sources: C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/README.md, MRPL_WORKFLOWS.md and the live Artifacts, Audit and Knowledge panels.",
    "The counts shown are prototype catalog facts: five named model roles in the registry and seven supported artifact kinds in the local types and artifact implementation.",
    "Visual asset: synthetic gauge photograph at C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/examples/mrpl-demo/turbine-cdu4/turbine-reports/gauge-photo.jpg.",
  ].join("\n"));
}

// Slide 6: research and references
{
  const slide = presentation.slides.add();
  slide.background.fill = C.warm;
  addKicker(slide, "05  /  Research and references");
  addSlideTitle(slide, "Research and references", "The deck follows the SIH idea-submission order and separates public sources from local product evidence.");
  addText(slide, "FORMAT FOLLOWED", { left: 66, top: 196, width: 260, height: 22 }, { fontSize: 15, bold: true, color: C.orange });
  const labels = ["Title page", "Proposed solution", "Technical approach", "Feasibility and viability", "Impact and benefits", "Research and references"];
  labels.forEach((label, index) => {
    const top = 232 + index * 47;
    addShape(slide, "ellipse", { left: 68, top: top + 2, width: 23, height: 23 }, index === 5 ? C.teal : C.navy2);
    addText(slide, String(index + 1), { left: 68, top: top + 5, width: 23, height: 16 }, { fontSize: 12, bold: true, color: C.white, alignment: "center" });
    addText(slide, label, { left: 108, top, width: 360, height: 22 }, { fontSize: 18, color: C.ink, bold: index === 5 });
  });
  addRule(slide, 560, 198, 1, C.line, 410);
  addText(slide, "PUBLIC SOURCES", { left: 612, top: 196, width: 300, height: 22 }, { fontSize: 15, bold: true, color: C.orange });
  addText(slide, "SIH 2026 problem statement", { left: 612, top: 232, width: 350, height: 22 }, { fontSize: 19, bold: true, color: C.ink });
  addText(slide, "sih.gov.in/sih2026PS\nSIH26117 metadata and expected solution", { left: 612, top: 258, width: 510, height: 42 }, { fontSize: 17, color: C.muted });
  addText(slide, "SIH idea presentation format", { left: 612, top: 322, width: 350, height: 22 }, { fontSize: 19, bold: true, color: C.ink });
  addText(slide, "cmrit.ac.in/.../SIH2024_IDEA_Presentation_Format.pdf\nSix-slide order and content pointers", { left: 612, top: 348, width: 510, height: 42 }, { fontSize: 17, color: C.muted });
  addText(slide, "LOCAL PRODUCT EVIDENCE", { left: 612, top: 412, width: 340, height: 22 }, { fontSize: 15, bold: true, color: C.orange });
  addText(slide, "README.md  •  MRPL_WORKFLOWS.md\nScoped Models, Readiness, Network, Artifacts and Audit panels\nSynthetic inspection scans and open-dataset P&ID samples", { left: 612, top: 448, width: 540, height: 72 }, { fontSize: 17, color: C.ink });
  addShape(slide, "roundRect", { left: 612, top: 562, width: 540, height: 60 }, C.navy, "none", 0, { borderRadius: "rounded-2xl" });
  addText(slide, "Submission note", { left: 634, top: 577, width: 150, height: 20 }, { fontSize: 16, bold: true, color: C.saffron });
  addText(slide, "Replace [TEAM NAME] and [TEAM ID] before upload. Export to PDF if the portal requires it.", { left: 790, top: 577, width: 334, height: 30 }, { fontSize: 15, color: C.white });
  addFooter(slide, 6);
  slide.speakerNotes.textFrame.setText([
    "Public sources used in the deck:",
    "1) https://sih.gov.in/sih2026PS",
    "2) https://github.com/jeevansai-hub/SIH-2026-/blob/main/ps_2026/SIH26117.md",
    "3) https://www.cmrit.ac.in/wp-content/uploads/2024/10/SIH2024_IDEA_Presentation_Format.pdf",
    "Local sources used in the deck:",
    "C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/README.md",
    "C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/MRPL_WORKFLOWS.md",
    "C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/src/services/registry.ts",
    "C:/Users/harih/OneDrive/Documents/ocr/zero-leak-app/examples/mrpl-demo/README.md",
    "The local demo corpus is synthetic/open-dataset material, not proprietary industrial data.",
  ].join("\n"));
}

const candidatePath = path.join(TMP_DIR, "candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);

for (let i = 0; i < presentation.slides.items.length; i += 1) {
  const slide = presentation.slides.items[i];
  const preview = await presentation.export({ slide, format: "png", scale: 1 });
  await fs.writeFile(path.join(TMP_DIR, `slide-${i + 1}.png`), new Uint8Array(await preview.arrayBuffer()));
}
const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
await fs.writeFile(path.join(TMP_DIR, "montage.webp"), new Uint8Array(await montage.arrayBuffer()));
await fs.writeFile(path.join(TMP_DIR, "snapshot.ndjson"), (await presentation.inspect({ kind: "slide,textbox,shape,image,notes,layout", maxChars: 40000 })).ndjson);

const FINAL_PPTX = path.join(OUTPUT_DIR, "SIH26117_ZeroLeak_AI_Idea_Submission_v4.pptx");
const receiptPath = path.join(TMP_DIR, "SIH26117_ZeroLeak_AI_Idea_Submission_v4.validation.json");
const requirements = {
  explicitTotalSlideCount: 6,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
};
const finalResult = await finalizePresentation({
  ...requirements,
  workspaceDir: WORKSPACE_DIR,
  candidatePath,
  finalPath: FINAL_PPTX,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: ["--expected-slide-size-emu", "12192000,6858000", "--expected-aspect", "16:9", "--validate-bullet-geometry", "--validate-heading-fit"],
  fontPolicy: { basis: "design", families: [family] },
  verifyArtifactToolImport: true,
  receiptPath,
});

console.log(JSON.stringify({
  finalPath: finalResult.finalPath,
  receiptPath: finalResult.receiptPath,
  family,
  slideCount: presentation.slides.items.length,
  candidatePath,
  montagePath: path.join(TMP_DIR, "montage.webp"),
}, null, 2));
