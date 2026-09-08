import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalRuntime } from "@nervekit/contracts/providers";
import {
  loadLocalModel,
  localModelStatus,
  testLocalModel,
  unloadLocalModel,
} from "../../src/models/local-model-lifecycle.js";
import type { FetchLike } from "../../src/models/local-runtimes.js";

const ollama: LocalRuntime = {
  id: "ollama",
  kind: "ollama",
  displayName: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  discovery: "ollama-tags",
  requiresApiKey: false,
  enabled: true,
  headers: {},
};

const llamaCpp: LocalRuntime = {
  id: "llama-cpp",
  kind: "llama-cpp",
  displayName: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  api: "openai-completions",
  discovery: "openai-models",
  requiresApiKey: false,
  enabled: true,
  headers: {},
};

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * A fake local server. Each route is matched on the url it is keyed by and
 * answers with its payload, or with the status it is given; anything unrouted
 * fails the test rather than silently answering `{}`.
 */
function server(routes: Record<string, unknown>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    if (!(url in routes)) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({}),
      });
    }
    const payload = routes[url];
    if (payload instanceof Error) return Promise.reject(payload);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    });
  };
  return { fetchImpl, calls };
}

const PS_URL = "http://127.0.0.1:11434/api/ps";
const GENERATE_URL = "http://127.0.0.1:11434/api/generate";
const MODELS_URL = "http://127.0.0.1:8080/v1/models";

describe("localModelStatus", () => {
  it("reads Ollama's resident model pool", async () => {
    const { fetchImpl, calls } = server({
      [PS_URL]: {
        models: [
          {
            name: "llama3.2:3b",
            model: "llama3.2:3b",
            size: 4_100_000_000,
            expires_at: "2026-09-02T10:15:00Z",
          },
        ],
      },
    });

    const status = await localModelStatus(ollama, "llama3.2:3b", { fetchImpl });

    assert.deepEqual(status, {
      runtimeId: "ollama",
      modelId: "llama3.2:3b",
      residency: "loaded",
      controllable: true,
      sizeBytes: 4_100_000_000,
      expiresAt: "2026-09-02T10:15:00Z",
    });
    assert.equal(calls[0]?.url, PS_URL);
  });

  it("reports a model Ollama is not holding as unloaded", async () => {
    const { fetchImpl } = server({
      [PS_URL]: { models: [{ model: "qwen3:8b" }] },
    });

    const status = await localModelStatus(ollama, "llama3.2:3b", { fetchImpl });

    assert.equal(status.residency, "unloaded");
    assert.equal(status.controllable, true);
    assert.equal(status.error, undefined);
  });

  it("matches a legacy listing that reports only a name", async () => {
    const { fetchImpl } = server({
      [PS_URL]: { models: [{ name: "llama3.2:3b" }] },
    });

    assert.equal(
      (await localModelStatus(ollama, "llama3.2:3b", { fetchImpl })).residency,
      "loaded",
    );
  });

  it("says the pool could not be read rather than guessing", async () => {
    const { fetchImpl } = server({
      [PS_URL]: new Error("connect ECONNREFUSED"),
    });

    const status = await localModelStatus(ollama, "llama3.2:3b", { fetchImpl });

    assert.equal(status.residency, "unknown");
    assert.equal(status.error, "connect ECONNREFUSED");
    assert.ok(status.detail);
  });

  it("treats a model a startup-loaded runtime serves as resident", async () => {
    const { fetchImpl, calls } = server({
      [MODELS_URL]: { data: [{ id: "qwen3-8b" }] },
    });

    const status = await localModelStatus(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(status.residency, "loaded");
    assert.equal(status.controllable, false);
    assert.match(
      status.detail ?? "",
      /binds its weights when the server starts/,
    );
    assert.equal(calls[0]?.url, MODELS_URL);
  });

  it("treats a model a startup-loaded runtime does not serve as unloaded", async () => {
    const { fetchImpl } = server({ [MODELS_URL]: { data: [] } });

    const status = await localModelStatus(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(status.residency, "unloaded");
    assert.equal(status.controllable, false);
  });

  it("leaves residency unknown when the runtime cannot be reached", async () => {
    const { fetchImpl } = server({ [MODELS_URL]: new Error("socket hang up") });

    const status = await localModelStatus(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(status.residency, "unknown");
    assert.equal(status.error, "socket hang up");
  });

  it("leaves residency unknown when discovery is switched off", async () => {
    const status = await localModelStatus(
      { ...llamaCpp, discovery: "none" },
      "qwen3-8b",
      { fetchImpl: () => assert.fail("nothing should be contacted") },
    );

    assert.equal(status.residency, "unknown");
    assert.equal(status.controllable, false);
    assert.match(status.detail ?? "", /discovery disabled/);
  });
});

describe("loadLocalModel", () => {
  it("asks Ollama to hold the weights and reads the result back", async () => {
    const { fetchImpl, calls } = server({
      [GENERATE_URL]: {},
      [PS_URL]: { models: [{ model: "llama3.2:3b", size: 10 }] },
    });

    const status = await loadLocalModel(ollama, "llama3.2:3b", { fetchImpl });

    assert.deepEqual(calls[0], {
      url: GENERATE_URL,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: { model: "llama3.2:3b", keep_alive: "5m" },
    });
    // The reported state is measured afterwards, not assumed from the 200.
    assert.equal(calls[1]?.url, PS_URL);
    assert.equal(status.residency, "loaded");
  });

  it("reports a load that the runtime refused", async () => {
    const { fetchImpl } = server({});

    const status = await loadLocalModel(ollama, "llama3.2:3b", { fetchImpl });

    assert.equal(status.residency, "unknown");
    assert.equal(status.error, "Ollama responded 404 Not Found");
  });

  it("changes nothing on a runtime that loads its weights at startup", async () => {
    const { fetchImpl, calls } = server({
      [MODELS_URL]: { data: [{ id: "qwen3-8b" }] },
    });

    const status = await loadLocalModel(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(status.controllable, false);
    assert.equal(status.residency, "loaded");
    assert.match(status.detail ?? "", /cannot load or unload/);
    // Only the discovery read: no request pretends to change residency.
    assert.deepEqual(
      calls.map((call) => call.url),
      [MODELS_URL],
    );
  });

  it("sends the runtime's token and headers", async () => {
    const { fetchImpl, calls } = server({ [GENERATE_URL]: {}, [PS_URL]: {} });

    await loadLocalModel(
      { ...ollama, requiresApiKey: true, headers: { "X-Tenant": "lab" } },
      "llama3.2:3b",
      { fetchImpl, apiKey: "token-value" },
    );

    assert.equal(calls[0]?.headers.authorization, "Bearer token-value");
    assert.equal(calls[0]?.headers["X-Tenant"], "lab");
  });
});

describe("unloadLocalModel", () => {
  it("evicts the weights and confirms the pool no longer holds them", async () => {
    const { fetchImpl, calls } = server({
      [GENERATE_URL]: {},
      [PS_URL]: { models: [] },
    });

    const status = await unloadLocalModel(ollama, "llama3.2:3b", { fetchImpl });

    assert.deepEqual(calls[0]?.body, {
      model: "llama3.2:3b",
      keep_alive: 0,
    });
    assert.equal(status.residency, "unloaded");
    assert.equal(status.controllable, true);
  });

  it("changes nothing on a runtime that loads its weights at startup", async () => {
    const { fetchImpl, calls } = server({ [MODELS_URL]: { data: [] } });

    const status = await unloadLocalModel(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(status.controllable, false);
    assert.match(status.detail ?? "", /restart the server with the model/);
    assert.deepEqual(
      calls.map((call) => call.url),
      [MODELS_URL],
    );
  });
});

describe("testLocalModel", () => {
  const CHAT_URL = "http://127.0.0.1:8080/v1/chat/completions";

  it("completes a one-line prompt and reports what came back", async () => {
    const { fetchImpl, calls } = server({
      [CHAT_URL]: { choices: [{ message: { content: " ok\n" } }] },
    });
    let clock = 5_000;

    const result = await testLocalModel(llamaCpp, "qwen3-8b", {
      fetchImpl,
      now: () => (clock += 84),
    });

    assert.deepEqual(result, {
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
      ok: true,
      latencyMs: 84,
      sample: "ok",
    });
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      model: "qwen3-8b",
      max_tokens: 24,
      stream: false,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
  });

  it("reads a chat response delivered as content parts", async () => {
    const { fetchImpl } = server({
      [CHAT_URL]: {
        choices: [{ message: { content: [{ type: "text", text: "ok" }] } }],
      },
    });

    assert.equal(
      (await testLocalModel(llamaCpp, "qwen3-8b", { fetchImpl })).sample,
      "ok",
    );
  });

  it("speaks the Responses dialect when the runtime is configured for it", async () => {
    const { fetchImpl, calls } = server({
      "http://127.0.0.1:8080/v1/responses": { output_text: "ok" },
    });

    const result = await testLocalModel(
      { ...llamaCpp, api: "openai-responses" },
      "qwen3-8b",
      { fetchImpl },
    );

    assert.equal(result.ok, true);
    assert.equal(result.sample, "ok");
    assert.deepEqual(calls[0]?.body, {
      model: "qwen3-8b",
      input: "Reply with the single word: ok",
      max_output_tokens: 24,
      stream: false,
    });
  });

  it("reads a Responses payload that only carries output items", async () => {
    const { fetchImpl } = server({
      "http://127.0.0.1:8080/v1/responses": {
        output: [{ content: [{ type: "output_text", text: "ok" }] }],
      },
    });

    assert.equal(
      (
        await testLocalModel(
          { ...llamaCpp, api: "openai-responses" },
          "qwen3-8b",
          { fetchImpl },
        )
      ).sample,
      "ok",
    );
  });

  it("speaks the Anthropic dialect with its required version header", async () => {
    const { fetchImpl, calls } = server({
      "http://127.0.0.1:8080/v1/messages": {
        content: [{ type: "text", text: "ok" }],
      },
    });

    const result = await testLocalModel(
      { ...llamaCpp, api: "anthropic-messages" },
      "qwen3-8b",
      { fetchImpl },
    );

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(calls[0]?.body, {
      model: "qwen3-8b",
      max_tokens: 24,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
  });

  it("fails a runtime that answers without producing any text", async () => {
    const { fetchImpl } = server({
      [CHAT_URL]: { choices: [{ message: { content: "   " } }] },
    });

    const result = await testLocalModel(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      "The runtime answered but the model produced no text.",
    );
  });

  it("names the runtime in an HTTP failure", async () => {
    const { fetchImpl } = server({});

    const result = await testLocalModel(llamaCpp, "missing-model", {
      fetchImpl,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "llama.cpp responded 404 Not Found");
  });

  it("reports a timeout in the operator's terms", async () => {
    const timeout = new Error("The operation was aborted");
    timeout.name = "TimeoutError";
    const { fetchImpl } = server({ [CHAT_URL]: timeout });

    const result = await testLocalModel(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(result.ok, false);
    assert.equal(result.error, "No response before the timeout elapsed.");
  });

  it("truncates a model that will not stop talking", async () => {
    const { fetchImpl } = server({
      [CHAT_URL]: { choices: [{ message: { content: "ok ".repeat(200) } }] },
    });

    const result = await testLocalModel(llamaCpp, "qwen3-8b", { fetchImpl });

    assert.equal(result.ok, true);
    assert.equal(result.sample?.length, 160);
    assert.ok(result.sample?.endsWith("…"));
  });
});
