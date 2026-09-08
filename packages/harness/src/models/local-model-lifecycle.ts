import type {
  LocalModelStatus,
  LocalModelTestResult,
  LocalRuntime,
} from "@nervekit/contracts/providers";
import {
  localRuntimeControlsResidency,
  positiveInteger,
} from "@nervekit/contracts/providers";
import {
  asRecord,
  describeFetchError,
  type FetchLike,
  joinUrl,
  LOCAL_COMPLETION_TIMEOUT_MS,
  LOCAL_LOAD_TIMEOUT_MS,
  nativeRootUrl,
  requestLocalJson,
} from "./local-runtime-http.js";
import { probeLocalRuntime } from "./local-runtimes.js";

/**
 * Residency control and the per-model connection test.
 *
 * Two facts about local inference shape everything here. First, only Ollama
 * keeps a pool of models and takes a residency hint per request; llama.cpp,
 * vLLM, and a Python runtime bind their weights when the process starts, so for
 * them residency is a fact to report and not a setting to change. Second, a
 * runtime being reachable says nothing about whether a particular model can
 * actually produce a token — the weights may be missing, mis-quantised, or too
 * large for the machine — so the test issues a real completion rather than
 * another metadata request.
 *
 * Nothing in this module invents an answer it cannot obtain. Where a runtime
 * cannot be asked, the result says `unknown` and explains why.
 */

export interface LocalModelLifecycleOptions {
  /** Bearer token for a runtime configured to require one. */
  apiKey?: string | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: FetchLike | undefined;
  now?: () => number;
}

/**
 * Prompt used by every model test. Short, deterministic, and answerable by an
 * instruction-tuned model of any size, because the test asks "can these weights
 * emit a token", not "is this model any good".
 */
export const LOCAL_MODEL_TEST_PROMPT = "Reply with the single word: ok";

/** Enough tokens for a one-word answer plus a little punctuation. */
const TEST_MAX_TOKENS = 24;

/**
 * How long Ollama should keep weights resident after an explicit load. Matches
 * Ollama's own default, so loading a model from ZeroLeak AI leaves the server
 * in the state a request to it would have.
 */
const KEEP_ALIVE_ON_LOAD = "5m";

function ollamaApiUrl(runtime: LocalRuntime, path: string): string {
  return joinUrl(nativeRootUrl(runtime.baseUrl), path);
}

/**
 * The entry for `modelId` in an Ollama `/api/ps` listing. Ollama reports the
 * fully qualified name in `model` and, historically, in `name`; both are matched
 * so the answer does not depend on the server's version.
 */
function findResidentModel(
  payload: unknown,
  modelId: string,
): Record<string, unknown> | undefined {
  const entries = asRecord(payload)?.models;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.model === modelId || record.name === modelId) return record;
  }
  return undefined;
}

async function ollamaResidency(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions,
): Promise<LocalModelStatus> {
  try {
    const payload = await requestLocalJson(ollamaApiUrl(runtime, "api/ps"), {
      label: runtime.displayName,
      headers: runtime.headers,
      apiKey: options.apiKey,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    const resident = findResidentModel(payload, modelId);
    if (!resident) {
      return {
        runtimeId: runtime.id,
        modelId,
        residency: "unloaded",
        controllable: true,
      };
    }
    // A resident size of zero bytes is still an answer, so the floor is 0 —
    // the contract's `sizeBytes` is nonnegative, not positive.
    const sizeBytes = positiveInteger(resident.size, 0);
    const expiresAt =
      typeof resident.expires_at === "string" ? resident.expires_at : undefined;
    return {
      runtimeId: runtime.id,
      modelId,
      residency: "loaded",
      controllable: true,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  } catch (error) {
    return {
      runtimeId: runtime.id,
      modelId,
      residency: "unknown",
      controllable: true,
      detail: `${runtime.displayName} could not be asked which models are resident.`,
      error: describeFetchError(error),
    };
  }
}

/**
 * Residency for a runtime that binds its weights at startup: a model it serves
 * is loaded, and a model it does not serve is not. That is a real reading of the
 * runtime's state rather than a guess, which is why it is reported as `loaded`
 * or `unloaded` and not as `unknown`.
 */
async function servedResidency(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions,
): Promise<LocalModelStatus> {
  const startupDetail = `${runtime.displayName} binds its weights when the server starts, so a served model is resident.`;
  if (runtime.discovery === "none") {
    return {
      runtimeId: runtime.id,
      modelId,
      residency: "unknown",
      controllable: false,
      detail: `${runtime.displayName} has model discovery disabled, so it cannot be asked what it is serving.`,
    };
  }
  const probe = await probeLocalRuntime(runtime, options);
  if (!probe.reachable) {
    return {
      runtimeId: runtime.id,
      modelId,
      residency: "unknown",
      controllable: false,
      detail: startupDetail,
      ...(probe.error === undefined ? {} : { error: probe.error }),
    };
  }
  return {
    runtimeId: runtime.id,
    modelId,
    residency: probe.modelIds.includes(modelId) ? "loaded" : "unloaded",
    controllable: false,
    detail: startupDetail,
  };
}

/** Whether `modelId`'s weights are resident in `runtime` right now. */
export async function localModelStatus(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions = {},
): Promise<LocalModelStatus> {
  return localRuntimeControlsResidency(runtime.kind)
    ? ollamaResidency(runtime, modelId, options)
    : servedResidency(runtime, modelId, options);
}

/**
 * Ask Ollama to change a model's residency. A `/api/generate` request carrying
 * only a model and a `keep_alive` loads the weights (non-zero) or evicts them
 * (zero) without generating anything, which is Ollama's documented way to
 * manage its pool.
 */
async function setOllamaResidency(
  runtime: LocalRuntime,
  modelId: string,
  keepAlive: string | number,
  options: LocalModelLifecycleOptions,
): Promise<LocalModelStatus | undefined> {
  try {
    await requestLocalJson(ollamaApiUrl(runtime, "api/generate"), {
      label: runtime.displayName,
      method: "POST",
      headers: runtime.headers,
      apiKey: options.apiKey,
      body: { model: modelId, keep_alive: keepAlive },
      timeoutMs: LOCAL_LOAD_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    return undefined;
  } catch (error) {
    return {
      runtimeId: runtime.id,
      modelId,
      residency: "unknown",
      controllable: true,
      error: describeFetchError(error),
    };
  }
}

/**
 * The honest answer for a runtime that cannot change residency: report where the
 * weights actually are, and say plainly that the request changed nothing.
 */
async function uncontrollable(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions,
): Promise<LocalModelStatus> {
  return {
    ...(await servedResidency(runtime, modelId, options)),
    detail: `${runtime.displayName} binds its weights when the server starts. ZeroLeak AI cannot load or unload them; restart the server with the model you want.`,
  };
}

/**
 * Load a model's weights. The reported status is read back from the runtime
 * afterwards rather than assumed from a successful request, so a load that the
 * server accepted and then dropped is visible.
 */
export async function loadLocalModel(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions = {},
): Promise<LocalModelStatus> {
  if (!localRuntimeControlsResidency(runtime.kind)) {
    return uncontrollable(runtime, modelId, options);
  }
  const failure = await setOllamaResidency(
    runtime,
    modelId,
    KEEP_ALIVE_ON_LOAD,
    options,
  );
  return failure ?? localModelStatus(runtime, modelId, options);
}

/** Evict a model's weights, freeing the memory it holds. */
export async function unloadLocalModel(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions = {},
): Promise<LocalModelStatus> {
  if (!localRuntimeControlsResidency(runtime.kind)) {
    return uncontrollable(runtime, modelId, options);
  }
  const failure = await setOllamaResidency(runtime, modelId, 0, options);
  return failure ?? localModelStatus(runtime, modelId, options);
}

function textFromContentParts(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (typeof record?.text === "string") parts.push(record.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function readChatCompletion(payload: unknown): string | undefined {
  const choices = asRecord(payload)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const message = asRecord(asRecord(choices[0])?.message);
  return textFromContentParts(message?.content);
}

function readResponse(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (typeof record?.output_text === "string") return record.output_text;
  const output = record?.output;
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const entry of output) {
    const text = textFromContentParts(asRecord(entry)?.content);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function readAnthropicMessage(payload: unknown): string | undefined {
  return textFromContentParts(asRecord(payload)?.content);
}

interface CompletionAttempt {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly readText: (payload: unknown) => string | undefined;
}

/**
 * The smallest real completion for the dialect this runtime speaks. Only the
 * three APIs a local runtime can be configured with are distinguished; anything
 * else is an OpenAI-compatible chat surface, which is what every local server
 * exposes by default.
 */
function completionAttempt(
  runtime: LocalRuntime,
  modelId: string,
): CompletionAttempt {
  if (runtime.api === "anthropic-messages") {
    return {
      url: joinUrl(runtime.baseUrl, "messages"),
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: modelId,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: "user", content: LOCAL_MODEL_TEST_PROMPT }],
      },
      readText: readAnthropicMessage,
    };
  }
  if (runtime.api === "openai-responses") {
    return {
      url: joinUrl(runtime.baseUrl, "responses"),
      headers: {},
      body: {
        model: modelId,
        input: LOCAL_MODEL_TEST_PROMPT,
        max_output_tokens: TEST_MAX_TOKENS,
        stream: false,
      },
      readText: readResponse,
    };
  }
  return {
    url: joinUrl(runtime.baseUrl, "chat/completions"),
    headers: {},
    body: {
      model: modelId,
      max_tokens: TEST_MAX_TOKENS,
      stream: false,
      messages: [{ role: "user", content: LOCAL_MODEL_TEST_PROMPT }],
    },
    readText: readChatCompletion,
  };
}

/** First line of what the model produced, bounded so a runaway answer cannot fill the UI. */
function sampleOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed;
}

/**
 * Ask a model to complete {@link LOCAL_MODEL_TEST_PROMPT}. This is the only
 * check that exercises the endpoint, the credential, the headers, the api
 * dialect, and the weights at once, so it is what the settings page means by
 * "Test".
 */
export async function testLocalModel(
  runtime: LocalRuntime,
  modelId: string,
  options: LocalModelLifecycleOptions = {},
): Promise<LocalModelTestResult> {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  const attempt = completionAttempt(runtime, modelId);
  const elapsed = () => Math.max(0, Math.round(clock() - startedAt));
  try {
    const payload = await requestLocalJson(attempt.url, {
      label: runtime.displayName,
      method: "POST",
      headers: { ...runtime.headers, ...attempt.headers },
      apiKey: options.apiKey,
      body: attempt.body,
      timeoutMs: LOCAL_COMPLETION_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    const text = attempt.readText(payload);
    const latencyMs = elapsed();
    if (!text || sampleOf(text).length === 0) {
      return {
        runtimeId: runtime.id,
        modelId,
        ok: false,
        latencyMs,
        error: "The runtime answered but the model produced no text.",
      };
    }
    return {
      runtimeId: runtime.id,
      modelId,
      ok: true,
      latencyMs,
      sample: sampleOf(text),
    };
  } catch (error) {
    return {
      runtimeId: runtime.id,
      modelId,
      ok: false,
      latencyMs: elapsed(),
      error: describeFetchError(error),
    };
  }
}
