/**
 * Model registry, routing table, tool catalogue and defaults.
 *
 * Every number in MODEL_REGISTRY was measured on this workstation
 * (RTX 4060 Laptop 8 GiB, i7-14700HX, 32 GiB DDR5) with
 * `llama-bench -p 512 -n 128 -r 2 -ngl 99` and `llama-fit-params`,
 * and the context sizes match C:\sovereign\config\models.ini exactly.
 * Nothing here is estimated or aspirational.
 */

import type {
  AppSettings,
  ModelEntry,
  ModelRuntime,
  RouteRule,
  SandboxPolicy,
  ToolDescriptor,
} from '../types';

/**
 * Root the fallback catalogue resolves weights against — the installed layout
 * (`SOVEREIGN_HOME`, default `C:/sovereign`), same as the core's
 * `detect_models_root`. Both this and MODEL_REGISTRY are first-paint seeds
 * only: the core's own catalogue and settings replace them as soon as it
 * answers. No development-checkout path belongs here; a shipped bundle that
 * knows one machine's home directory is wrong on every other machine.
 */
export const MODELS_ROOT = 'C:/sovereign/models';

/** llama.cpp build directory, deliberately outside any syncing folder. */
export const RUNTIME_ROOT = 'C:/sovereign/runtime/llama.cpp';

/** Curated preset. The auto-generated models-dir preset over-allocates KV. */
export const PRESET_PATH = 'C:/sovereign/config/models.ini';

/**
 * Usable VRAM, not installed VRAM. The card reports 8187 MiB total but the
 * desktop compositor holds roughly 1 GiB, leaving ~7106 MiB free in practice.
 */
export const VRAM_BUDGET_MB = 7106;
export const VRAM_TOTAL_MB = 8187;

/**
 * The address the router and the application API are bound to, mirroring
 * `registry::ROUTER_BIND_HOST` in the core. Not a setting: §1 requires the
 * models be unreachable from off the machine, so there is no other value.
 */
export const ROUTER_BIND_HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/* §1  Model registry                                                 */
/* ------------------------------------------------------------------ */

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'qwen3.5-9b', displayName: 'Qwen 3.5 9B', backend: 'llama.cpp',
    location: 'this_device', source: `${MODELS_ROOT}/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf`,
    architecture: 'qwen35', quantization: 'Q4_K_M', contextSize: 8192,
    trainedContext: 262144, kvCacheType: 'f16', capabilities: ['general', 'reasoning', 'coding', 'tools'],
    estimatedVramMb: 6900, fileSizeBytes: 6169341984, priority: 'primary',
    note: 'Local coding model; conservative 8K text-only profile. VRAM is estimated. Gemma E4B is the coding fallback.',
  },
  {
    id: 'gemma-4-e4b',
    displayName: 'Gemma 4 E4B',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf`,
    projector: `${MODELS_ROOT}/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf`,
    architecture: 'gemma4',
    quantization: 'Q4_0',
    contextSize: 16384,
    trainedContext: 131072,
    kvCacheType: 'q8_0',
    capabilities: ['general', 'reasoning', 'coding', 'vision', 'drawings', 'documents', 'tools'],
    estimatedVramMb: 4373,
    fileSizeBytes: 5154941280 + 991552256,
    priority: 'primary',
    promptTokensPerSec: 3704.5,
    genTokensPerSec: 70.7,
    note: 'Google Gemma 4 E4B instruction-tuned QAT model. The 16K local profile was verified with the matching multimodal projector; Extended Thinking enables its native reasoning mode.',
  },
  {
    id: 'nemotron-3-nano-4b',
    displayName: 'Nemotron 3 Nano 4B',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/nemotron-3-nano-4b/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf`,
    architecture: 'nemotron_h',
    quantization: 'Q4_K_M',
    contextSize: 65536,
    trainedContext: 1048576,
    kvCacheType: 'f16',
    capabilities: ['general', 'reasoning', 'long_context', 'tools'],
    estimatedVramMb: 2939,
    fileSizeBytes: 2837072864,
    priority: 'primary',
    promptTokensPerSec: 3678,
    genTokensPerSec: 81.3,
    note: 'Hybrid Mamba/Transformer: KV cache grows sub-linearly, so it fits 195k tokens at f16 where the 9B fits 12.5k. Long-document work routes here.',
  },
  {
    id: 'nemotron-cascade-8b',
    displayName: 'Nemotron Cascade 8B',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/nemotron-cascade-8b/nvidia_Nemotron-Cascade-8B-Q4_K_M.gguf`,
    architecture: 'qwen3',
    quantization: 'Q4_K_M',
    contextSize: 16384,
    trainedContext: 32768,
    kvCacheType: 'q8_0',
    capabilities: ['general', 'reasoning', 'coding', 'tools'],
    estimatedVramMb: 4945,
    fileSizeBytes: 5027784704,
    priority: 'fallback',
    promptTokensPerSec: 2479,
    genTokensPerSec: 50.3,
  },
  {
    id: 'olmocr-2',
    displayName: 'olmOCR 2 (7B)',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/olmocr-2/allenai_olmOCR-2-7B-1025-Q4_K_M.gguf`,
    projector: `${MODELS_ROOT}/olmocr-2/mmproj-allenai_olmOCR-2-7B-1025-f16.gguf`,
    architecture: 'qwen2vl',
    quantization: 'Q4_K_M',
    contextSize: 16384,
    trainedContext: 128000,
    kvCacheType: 'f16',
    capabilities: ['ocr', 'handwriting', 'documents', 'vision'],
    estimatedVramMb: 7387,
    fileSizeBytes: 4683072672 + 1354163296,
    priority: 'specialist',
    promptTokensPerSec: 2633,
    genTokensPerSec: 54.0,
    note: 'Best on handwriting, and the only model that emits real HTML table markup. Peaks at 7387 MiB — at the edge of the 7106 MiB budget, so nothing else may be resident.',
  },
  {
    id: 'paddleocr-vl-1.6',
    displayName: 'PaddleOCR-VL 1.6',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/paddleocr-vl-1.6/PaddleOCR-VL-1.6-GGUF.gguf`,
    projector: `${MODELS_ROOT}/paddleocr-vl-1.6/PaddleOCR-VL-1.6-GGUF-mmproj.gguf`,
    architecture: 'paddleocr',
    quantization: 'Q4_K_M',
    contextSize: 16384,
    trainedContext: 131072,
    kvCacheType: 'f16',
    capabilities: ['ocr', 'documents'],
    estimatedVramMb: 2071,
    fileSizeBytes: 935769056 + 881770560,
    priority: 'specialist',
    promptTokensPerSec: 21305,
    genTokensPerSec: 280.2,
    note: 'A 0.47B OCR specialist, not a chat model — a text-only prompt returns garbage. Transcribed a full 7-row inspection table in 5.2 s.',
  },
  {
    id: 'bge-m3',
    displayName: 'BGE-M3 (embeddings)',
    backend: 'python',
    location: 'this_device',
    source: `${MODELS_ROOT}/bge-m3/pytorch_model.bin`,
    architecture: 'xlm-roberta',
    quantization: 'fp32',
    contextSize: 8192,
    trainedContext: 8192,
    capabilities: ['embeddings'],
    estimatedVramMb: 1300,
    fileSizeBytes: 2271145830,
    priority: 'primary',
    note: 'Ships only as a PyTorch pickle — no GGUF, no safetensors. Runs in the Python sidecar; torch is not yet installed on this machine.',
  },
  {
    id: 'minicpm-v-4.5',
    displayName: 'MiniCPM-V 4.5',
    backend: 'llama.cpp',
    location: 'this_device',
    source: `${MODELS_ROOT}/minicpm-v-4.5/MiniCPM-V-4_5-Q4_K_M.gguf`,
    projector: `${MODELS_ROOT}/minicpm-v-4.5/mmproj-model-f16.gguf`,
    architecture: 'qwen3',
    quantization: 'Q4_K_M',
    contextSize: 8192,
    trainedContext: 40960,
    kvCacheType: 'f16',
    capabilities: ['vision', 'documents'],
    estimatedVramMb: 4945,
    fileSizeBytes: 5026714304 + 1095113184,
    priority: 'disabled',
    promptTokensPerSec: 2390.5,
    genTokensPerSec: 50.4,
    note: 'Not routed to. On the P&ID it produced no answer at all — an unclosed reasoning block consumed the whole budget. Gemma 4 E4B covers the general vision path correctly. Kept in the registry so the decision stays visible and reversible.',
  },
];

/** Runtime state starts unloaded for everything; the core reports the truth. */
export const INITIAL_RUNTIME: Record<string, ModelRuntime> = Object.fromEntries(
  MODEL_REGISTRY.map((m) => [m.id, { id: m.id, state: 'unloaded' as const }]),
);

export const modelById = (id: string | null | undefined): ModelEntry | undefined =>
  MODEL_REGISTRY.find((m) => m.id === id);

/* ------------------------------------------------------------------ */
/* §3  Deterministic routing table                                    */
/* ------------------------------------------------------------------ */

/**
 * Ordered rules. File type and extension decide almost everything;
 * a classifier model is only consulted when nothing else can decide.
 */
export const ROUTING_RULES: RouteRule[] = [
  {
    kind: 'digital_document',
    label: 'Digital PDF / DOCX / XLSX / PPTX',
    basis: 'file_type',
    modelId: null,
    deterministic: true,
    detail: 'Native text extraction. No model is loaded and no OCR is run.',
  },
  {
    kind: 'scanned_document',
    label: 'Scanned or photographed page',
    basis: 'file_type',
    modelId: 'paddleocr-vl-1.6',
    fallbackModelId: 'olmocr-2',
    detail: 'Printed text with no embedded text layer. 0.87 GiB and 280 tok/s.',
  },
  {
    kind: 'handwriting',
    label: 'Handwritten notes / poor-quality scan',
    basis: 'rule',
    modelId: 'olmocr-2',
    fallbackModelId: 'gemma-4-e4b',
    detail: 'Chosen when OCR confidence falls below threshold or the user marks the file as handwritten.',
  },
  {
    kind: 'engineering_drawing',
    label: 'Engineering drawing / P&ID',
    basis: 'rule',
    modelId: 'gemma-4-e4b',
    fallbackModelId: 'olmocr-2',
    detail: 'OCR tag extraction plus vision reasoning over topology, in one pass.',
  },
  {
    kind: 'photograph',
    label: 'Equipment photograph',
    basis: 'file_type',
    modelId: 'gemma-4-e4b',
    detail: 'Uses the model\u2019s own f16 projector.',
  },
  {
    kind: 'code',
    label: 'Source code',
    basis: 'file_type',
    modelId: 'qwen3.5-9b',
    fallbackModelId: 'gemma-4-e4b',
    detail: 'Coding uses local Qwen 3.5 9B when installed, with Gemma 4 E4B as fallback.',
  },
  {
    kind: 'long_context',
    label: 'Input over 14k tokens',
    basis: 'token_budget',
    modelId: 'nemotron-3-nano-4b',
    detail: 'Gemma E4B fits the 16k local profile; this fits 65k in the same preset and 195k at f16.',
  },
  {
    kind: 'knowledge_query',
    label: 'Question against indexed knowledge',
    basis: 'rule',
    modelId: 'gemma-4-e4b',
    detail: 'BGE-M3 retrieval, then reasoning over the retrieved passages with citations.',
  },
  {
    kind: 'reasoning',
    label: 'General reasoning / mixed task',
    basis: 'classifier',
    modelId: 'gemma-4-e4b',
    fallbackModelId: 'nemotron-cascade-8b',
    detail: 'The only path that may consult a lightweight classifier, and only when rules cannot decide.',
  },
  {
    kind: 'embedding',
    label: 'Indexing / embedding',
    basis: 'rule',
    modelId: 'bge-m3',
    detail: 'Runs in the Python sidecar, bound to localhost.',
  },
];

/* ------------------------------------------------------------------ */
/* §7  Tool catalogue                                                 */
/* ------------------------------------------------------------------ */

export const TOOL_CATALOGUE: ToolDescriptor[] = [
  { name: 'list_files', label: 'List files', risk: 'read', requiresApproval: false, summary: 'Enumerate a directory inside an approved workspace.' },
  { name: 'read_file', label: 'Read file', risk: 'read', requiresApproval: false, summary: 'Read a file inside an approved workspace.' },
  { name: 'search_files', label: 'Search files', risk: 'read', requiresApproval: false, summary: 'Content and filename search across a workspace.' },
  { name: 'query_knowledge', label: 'Query knowledge base', risk: 'read', requiresApproval: false, summary: 'Hybrid retrieval over the local index, returning citations.' },
  { name: 'update_plan', label: 'Plan', risk: 'read', requiresApproval: false, summary: 'Publish and keep current the step checklist the operator watches.' },
  { name: 'ask_operator', label: 'Ask the operator', risk: 'read', requiresApproval: false, summary: 'Pause the run and ask the operator one free-text question.' },
  { name: 'ocr_document', label: 'OCR document', risk: 'read', requiresApproval: false, summary: 'Extract text, tables and bounding boxes from a scan.' },
  { name: 'analyze_image', label: 'Analyse image', risk: 'read', requiresApproval: false, summary: 'Vision analysis of a photograph or drawing.' },
  { name: 'read_spreadsheet', label: 'Read spreadsheet', risk: 'read', requiresApproval: false, summary: 'Read cells, formulas and sheet structure.' },
  { name: 'analyze_data', label: 'Analyse data', risk: 'read', requiresApproval: false, summary: 'Deterministic calculation over extracted tables.' },
  { name: 'inspect_artifact', label: 'Inspect artifact', risk: 'read', requiresApproval: false, summary: 'Reopen a generated file to confirm it parses.' },
  { name: 'web_search', label: 'Search the web', risk: 'read', requiresApproval: false, summary: 'Use only the explicitly selected public search method.' },
  { name: 'web_fetch', label: 'Fetch web page', risk: 'read', requiresApproval: false, summary: 'Read one public page found by search or named by the operator, behind the same Settings switch.' },
  { name: 'mcp_list_tools', label: 'Inspect MCP server', risk: 'execute', requiresApproval: true, summary: 'Launch a configured local MCP executable and list its tools.' },
  { name: 'mcp_call', label: 'Call MCP tool', risk: 'execute', requiresApproval: true, summary: 'Launch a configured local MCP executable and call one advertised tool.' },
  { name: 'create_directory', label: 'Create directory', risk: 'write', requiresApproval: true, summary: 'Create a folder inside an approved workspace.' },
  { name: 'write_file', label: 'Write file', risk: 'write', requiresApproval: true, summary: 'Create or overwrite a file. Overwrites show a diff first.' },
  { name: 'edit_file', label: 'Edit file', risk: 'write', requiresApproval: true, summary: 'Apply a reviewed diff to an existing file.' },
  { name: 'write_spreadsheet', label: 'Write spreadsheet', risk: 'write', requiresApproval: true, summary: 'Write cells into an XLSX workbook.' },
  { name: 'generate_docx', label: 'Generate DOCX', risk: 'write', requiresApproval: true, summary: 'Produce a Word document, then verify it opens.' },
  { name: 'generate_xlsx', label: 'Generate XLSX', risk: 'write', requiresApproval: true, summary: 'Produce a workbook, then verify it opens.' },
  { name: 'generate_pptx', label: 'Generate PPTX', risk: 'write', requiresApproval: true, summary: 'Produce a deck, then verify it opens.' },
  { name: 'generate_pdf', label: 'Generate PDF', risk: 'write', requiresApproval: true, summary: 'Produce a PDF, then verify page count and text.' },
  { name: 'generate_text', label: 'Generate text file', risk: 'write', requiresApproval: true, summary: 'Write a script, note or Markdown file into the artifacts folder.' },
  { name: 'execute_python', label: 'Run Python', risk: 'execute', requiresApproval: true, summary: 'Run a script in the sandbox. No network, memory-capped, timed out.' },
  { name: 'run_command', label: 'Run command', risk: 'execute', requiresApproval: true, summary: 'Run an allow-listed command in the sandbox working directory.' },
  { name: 'start_dev_server', label: 'Start dev server', risk: 'execute', requiresApproval: true, summary: 'Run the workspace’s dev script as a persistent process and return its verified localhost URL. Outlives the run that started it.' },
  { name: 'serve_folder', label: 'Host folder', risk: 'read', requiresApproval: false, summary: 'Serve a workspace folder on a loopback URL in the operator’s browser. Read-only; loopback only.' },
  { name: 'check_page', label: 'Check page', risk: 'read', requiresApproval: false, summary: 'Fetch, render and visually inspect the workspace’s served page. Loopback only; verifies the build instead of trusting a URL.' },
];

export const toolByName = (name: string): ToolDescriptor | undefined =>
  TOOL_CATALOGUE.find((t) => t.name === name);

/* ------------------------------------------------------------------ */
/* §8  Sandbox policy                                                 */
/* ------------------------------------------------------------------ */

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  workingDir: 'C:/sovereign/sandbox',
  // Egress follows the operator's Settings choice — default on. Mirrors
  // registry.rs; shown only until the core answers `sandbox_policy`.
  networkEnabled: true,
  timeoutSec: 1800,
  maxMemoryMb: 4096,
  maxProcesses: 8,
  allowedCommands: [
    'python', 'pip', 'git', 'node', 'npm', 'npx', 'cargo', 'curl', 'wget',
    'findstr', 'where', 'tree',
  ],
  deniedCommands: [
    'del', 'rmdir', 'rd', 'rm', 'Remove-Item', 'format', 'diskpart', 'vssadmin',
    'reg', 'schtasks', 'sc', 'net', 'netsh', 'bcdedit',
    'takeown', 'icacls', 'cipher', 'wmic', 'powershell -enc',
    'Invoke-Expression',
  ],
};

/* ------------------------------------------------------------------ */
/* Default settings                                                   */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: AppSettings = {
  llamaServerPath: `${RUNTIME_ROOT}/llama-server.exe`,
  modelPresetPath: PRESET_PATH,
  modelsDirectory: MODELS_ROOT,
  routerPort: 18080,
  maxResidentModels: 2,
  modelIdleEvictSec: 180,
  extendedThinking: false,

  allowPrivateServer: false,
  privateServerUrl: '',
  privateServerName: '',
  blockPublicInternet: false,
  allowReplicatedStore: false,

  webSearchMode: 'direct',
  webSearchProvider: 'brave',
  webSearchApiKeyEnv: 'BRAVE_SEARCH_API_KEY',
  mcpServers: [],

  defaultMode: 'plan',
  approvalPolicy: 'ask_always',
  guardRules: [],

  sandboxRoot: DEFAULT_SANDBOX_POLICY.workingDir,
  sandboxNetwork: true,
  sandboxTimeoutSec: 1800,
  sandboxMaxMemoryMb: 4096,

  knowledgeRoot: 'C:/sovereign/knowledge',
  watchKnowledgeFolder: false,
  retrievalTopK: 8,
  hybridRetrieval: true,

  memoryRoot: 'C:/sovereign/memories',
  useGlobalMemories: true,
  useProjectMemories: true,
  captureMemories: true,

  artifactRoot: 'C:/sovereign/artifacts',
  verifyArtifacts: true,

  showRightPanel: false,
};

/* ------------------------------------------------------------------ */
/* Presentation helpers                                               */
/* ------------------------------------------------------------------ */

export const CAPABILITY_LABELS: Record<string, string> = {
  general: 'General',
  reasoning: 'Reasoning',
  coding: 'Code',
  vision: 'Vision',
  ocr: 'OCR',
  handwriting: 'Handwriting',
  documents: 'Documents',
  drawings: 'Drawings',
  embeddings: 'Embeddings',
  long_context: 'Long context',
  tools: 'Tool calling',
};

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
};

export const formatContext = (n: number): string =>
  n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
