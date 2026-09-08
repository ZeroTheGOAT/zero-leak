import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Api,
  ApiKeyCredential,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  LocalModelRecord,
  LocalRuntime,
} from "@nervekit/contracts/providers";
import {
  createLocalRuntimeProvider,
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  DEFAULT_LOCAL_MAX_TOKENS,
  type FetchLike,
  type LocalDiscoveredModel,
  localModels,
  localRuntimeDiscoveryUrl,
  localRuntimeEnvVarName,
  probeLocalRuntime,
} from "../../src/models/local-runtimes.js";

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
  readonly headers: Record<string, string>;
}

/** A discovery endpoint that answers with `payload` and records what it was asked. */
function respondWith(payload: unknown): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    });
  };
  return { fetchImpl, calls };
}

/** Auth resolution input, with the ambient environment under test control. */
function authInput(
  env: Record<string, string> = {},
  credential?: ApiKeyCredential,
) {
  return {
    ctx: {
      env: (name: string) => Promise.resolve(env[name]),
      fileExists: () => Promise.resolve(false),
    },
    signal: new AbortController().signal,
    ...(credential ? { credential } : {}),
  };
}

/**
 * Drive one dynamic refresh and read back the catalog the provider published.
 * `publish()` stands in for the store: persistence is discarded, but the
 * provider's synchronous catalog update has to run, which is what makes the
 * discovered models visible through `getModels()`.
 */
async function refreshCatalog(
  provider: Provider,
): Promise<readonly Model<Api>[]> {
  await provider.refreshModels?.({
    allowNetwork: true,
    force: true,
    publish: (publication) => {
      publication.update?.();
      return Promise.resolve(true);
    },
    signal: new AbortController().signal,
  });
  return provider.getModels();
}

describe("local runtime discovery urls", () => {
  it("asks an OpenAI-compatible server for its models", () => {
    assert.equal(
      localRuntimeDiscoveryUrl({
        baseUrl: "http://127.0.0.1:8080/v1/",
        discovery: "openai-models",
      }),
      "http://127.0.0.1:8080/v1/models",
    );
  });

  it("climbs back to the root for Ollama's native tag listing", () => {
    assert.equal(
      localRuntimeDiscoveryUrl({
        baseUrl: "http://127.0.0.1:11434/v1",
        discovery: "ollama-tags",
      }),
      "http://127.0.0.1:11434/api/tags",
    );
  });

  it("has no url when discovery is disabled", () => {
    assert.equal(
      localRuntimeDiscoveryUrl({
        baseUrl: "http://127.0.0.1:8080/v1",
        discovery: "none",
      }),
      undefined,
    );
  });

  it("derives a ZeroLeak-scoped environment variable per runtime", () => {
    assert.equal(
      localRuntimeEnvVarName("onprem-openai"),
      "ZEROLEAK_ONPREM_OPENAI_API_KEY",
    );
  });
});

describe("probeLocalRuntime", () => {
  it("reports the served model ids and the round trip", async () => {
    const { fetchImpl, calls } = respondWith({
      data: [{ id: "qwen3-8b" }, { id: "gemma3-4b" }],
    });
    let clock = 1_000;

    const probe = await probeLocalRuntime(llamaCpp, {
      fetchImpl,
      now: () => (clock += 12),
    });

    assert.deepEqual(probe, {
      runtimeId: "llama-cpp",
      reachable: true,
      latencyMs: 12,
      modelIds: ["qwen3-8b", "gemma3-4b"],
    });
    assert.equal(calls[0]?.url, "http://127.0.0.1:8080/v1/models");
  });

  it("reads Ollama's tag listing", async () => {
    const { fetchImpl, calls } = respondWith({
      models: [{ model: "llama3.2:3b" }, { name: "nomic-embed-text" }],
    });

    const probe = await probeLocalRuntime(
      {
        ...llamaCpp,
        id: "ollama",
        kind: "ollama",
        displayName: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        discovery: "ollama-tags",
      },
      { fetchImpl },
    );

    assert.deepEqual(probe.modelIds, ["llama3.2:3b", "nomic-embed-text"]);
    assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/tags");
  });

  it("sends the token and the configured headers", async () => {
    const { fetchImpl, calls } = respondWith({ data: [] });

    await probeLocalRuntime(
      { ...llamaCpp, requiresApiKey: true, headers: { "X-Tenant": "lab" } },
      { fetchImpl, apiKey: "token-value" },
    );

    assert.equal(calls[0]?.headers.authorization, "Bearer token-value");
    assert.equal(calls[0]?.headers["X-Tenant"], "lab");
  });

  it("sends no authorization header for a keyless runtime", async () => {
    const { fetchImpl, calls } = respondWith({ data: [] });

    await probeLocalRuntime(llamaCpp, { fetchImpl });

    assert.equal(calls[0]?.headers.authorization, undefined);
  });

  it("reports an unreachable endpoint instead of throwing", async () => {
    const probe = await probeLocalRuntime(llamaCpp, {
      fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    assert.equal(probe.reachable, false);
    assert.equal(probe.error, "connect ECONNREFUSED");
    assert.deepEqual(probe.modelIds, []);
  });

  it("reports an HTTP failure with the runtime's own name", async () => {
    const probe = await probeLocalRuntime(llamaCpp, {
      fetchImpl: () =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: () => Promise.resolve({}),
        }),
    });

    assert.equal(probe.reachable, false);
    assert.equal(probe.error, "llama.cpp responded 503 Service Unavailable");
  });

  it("says so when the runtime has discovery disabled", async () => {
    const probe = await probeLocalRuntime({ ...llamaCpp, discovery: "none" });

    assert.equal(probe.reachable, false);
    assert.equal(probe.error, "This runtime has model discovery disabled.");
    assert.deepEqual(probe.modelIds, []);
  });
});

describe("createLocalRuntimeProvider", () => {
  it("keeps a keyless loopback server configured without a credential", async () => {
    const provider = createLocalRuntimeProvider(llamaCpp);

    const resolved = await provider.auth.apiKey?.resolve(authInput());

    assert.equal(resolved?.auth.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(resolved?.auth.apiKey, undefined);
    assert.equal(
      resolved?.source,
      "http://127.0.0.1:8080/v1 (no credential required)",
    );
    // Ambient-only: a keyless runtime must not offer an interactive login.
    assert.equal(provider.auth.apiKey?.login, undefined);
  });

  it("keeps a leftover token out of a runtime whose requirement was turned off", async () => {
    const provider = createLocalRuntimeProvider(llamaCpp);

    // The store still holds a token and the environment still exports one —
    // a runtime that asks for nobody's token must send neither.
    const resolved = await provider.auth.apiKey?.resolve(
      authInput(
        { ZEROLEAK_LLAMA_CPP_API_KEY: "ambient" },
        { type: "api_key", key: "stored" },
      ),
    );

    assert.equal(resolved?.auth.apiKey, undefined);
    assert.equal(
      resolved?.source,
      "http://127.0.0.1:8080/v1 (no credential required)",
    );
  });

  it("stays unconfigured while a runtime that requires a token has none", async () => {
    const provider = createLocalRuntimeProvider({
      ...llamaCpp,
      requiresApiKey: true,
    });

    assert.equal(await provider.auth.apiKey?.resolve(authInput()), undefined);
    assert.notEqual(provider.auth.apiKey?.login, undefined);
  });

  it("prefers a stored token over the environment", async () => {
    const provider = createLocalRuntimeProvider({
      ...llamaCpp,
      requiresApiKey: true,
    });

    const resolved = await provider.auth.apiKey?.resolve(
      authInput(
        { ZEROLEAK_LLAMA_CPP_API_KEY: "ambient" },
        { type: "api_key", key: "stored" },
      ),
    );

    assert.equal(resolved?.auth.apiKey, "stored");
    assert.equal(resolved?.source, "llama.cpp token");
  });

  it("accepts a token from the runtime's environment variable", async () => {
    const provider = createLocalRuntimeProvider({
      ...llamaCpp,
      requiresApiKey: true,
    });

    const resolved = await provider.auth.apiKey?.resolve(
      authInput({ ZEROLEAK_LLAMA_CPP_API_KEY: "ambient" }),
    );

    assert.equal(resolved?.auth.apiKey, "ambient");
    assert.equal(resolved?.source, "ZEROLEAK_LLAMA_CPP_API_KEY");
  });

  it("prices discovered models at zero and honours a reported context length", async () => {
    const { fetchImpl } = respondWith({
      data: [
        { id: "qwen3-8b", meta: { n_ctx_train: 131_072 } },
        { id: "gemma3-4b" },
      ],
    });

    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, { fetchImpl }),
    );

    assert.deepEqual(
      discovered.map((model) => model.id),
      ["qwen3-8b", "gemma3-4b"],
    );
    assert.deepEqual(discovered[0]?.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(discovered[0]?.contextWindow, 131_072);
    assert.equal(discovered[0]?.provider, "llama-cpp");
    assert.equal(discovered[0]?.api, "openai-completions");
    assert.equal(discovered[0]?.reasoning, false);
    assert.equal(discovered[1]?.contextWindow, DEFAULT_LOCAL_CONTEXT_WINDOW);
    assert.equal(discovered[1]?.maxTokens, DEFAULT_LOCAL_MAX_TOKENS);
  });

  it("carries the runtime's headers onto every discovered model", async () => {
    const { fetchImpl } = respondWith({ data: [{ id: "qwen3-8b" }] });

    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(
        { ...llamaCpp, headers: { "X-Tenant": "lab" } },
        { fetchImpl },
      ),
    );

    assert.deepEqual(discovered[0]?.headers, { "X-Tenant": "lab" });
  });

  it("publishes nothing and stays empty when discovery is disabled", async () => {
    const provider = createLocalRuntimeProvider({
      ...llamaCpp,
      discovery: "none",
    });

    assert.deepEqual([...(await refreshCatalog(provider))], []);
  });
});

describe("localModels", () => {
  it("installs the enabled runtimes and nothing else", () => {
    const models = localModels({
      runtimes: [
        llamaCpp,
        { ...llamaCpp, id: "vllm", displayName: "vLLM", enabled: false },
      ],
    });

    assert.deepEqual(
      models.getProviders().map((provider) => provider.id),
      ["llama-cpp"],
    );
  });

  it("installs no provider at all for an empty runtime list", () => {
    assert.deepEqual([...localModels({ runtimes: [] }).getProviders()], []);
  });
});

describe("configured local models", () => {
  /** A stored record with the defaults the contract applies when parsing. */
  function record(
    partial: Partial<LocalModelRecord> & { modelId: string },
  ): LocalModelRecord {
    return {
      runtimeId: "llama-cpp",
      imported: false,
      enabled: true,
      overrides: {},
      ...partial,
    };
  }

  it("applies the operator's overrides to a discovered model", async () => {
    const { fetchImpl } = respondWith({
      data: [{ id: "qwen3-8b", meta: { n_ctx_train: 131_072 } }],
    });

    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, {
        fetchImpl,
        models: [
          record({
            modelId: "qwen3-8b",
            overrides: {
              displayName: "Qwen3 8B (Q4)",
              contextWindow: 8_192,
              maxTokens: 2_048,
              reasoning: true,
              input: ["text", "image"],
            },
          }),
        ],
      }),
    );

    const model = discovered[0];
    assert.equal(model?.name, "Qwen3 8B (Q4)");
    // The override wins over the server's own claim: it reports the training
    // context length, not the --ctx-size the process was started with.
    assert.equal(model?.contextWindow, 8_192);
    assert.equal(model?.maxTokens, 2_048);
    assert.equal(model?.reasoning, true);
    assert.deepEqual(model?.input, ["text", "image"]);
  });

  it("withholds a disabled model from the published catalog", async () => {
    const { fetchImpl } = respondWith({
      data: [{ id: "qwen3-8b" }, { id: "gemma3-4b" }],
    });

    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, {
        fetchImpl,
        models: [record({ modelId: "gemma3-4b", enabled: false })],
      }),
    );

    assert.deepEqual(
      discovered.map((model) => model.id),
      ["qwen3-8b"],
    );
  });

  it("offers an imported model on a runtime that cannot be asked what it serves", () => {
    const provider = createLocalRuntimeProvider(
      { ...llamaCpp, discovery: "none" },
      { models: [record({ modelId: "mistral-7b-instruct", imported: true })] },
    );

    assert.deepEqual(
      provider.getModels().map((model) => model.id),
      ["mistral-7b-instruct"],
    );
  });

  it("keeps an imported model after a discovery refresh replaces the catalog", async () => {
    const { fetchImpl } = respondWith({ data: [{ id: "qwen3-8b" }] });

    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, {
        fetchImpl,
        models: [record({ modelId: "hand-imported", imported: true })],
      }),
    );

    assert.deepEqual(discovered.map((model) => model.id).sort(), [
      "hand-imported",
      "qwen3-8b",
    ]);
  });

  it("leaves a discovered model out of the catalog once it stops being served", async () => {
    const { fetchImpl } = respondWith({ data: [] });

    // A record exists for this model, but it was never imported by hand: the
    // configuration must not keep offering a model the runtime dropped.
    const discovered = await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, {
        fetchImpl,
        models: [record({ modelId: "qwen3-8b" })],
      }),
    );

    assert.deepEqual([...discovered], []);
  });

  it("withholds an imported model that is switched off", () => {
    const provider = createLocalRuntimeProvider(
      { ...llamaCpp, discovery: "none" },
      {
        models: [
          record({ modelId: "mistral-7b", imported: true, enabled: false }),
        ],
      },
    );

    assert.deepEqual([...provider.getModels()], []);
  });

  it("ignores records that belong to another runtime", () => {
    const provider = createLocalRuntimeProvider(
      { ...llamaCpp, discovery: "none" },
      {
        models: [
          record({
            runtimeId: "ollama",
            modelId: "llama3.2:3b",
            imported: true,
          }),
        ],
      },
    );

    assert.deepEqual([...provider.getModels()], []);
  });

  it("reports what the runtime actually served", async () => {
    const { fetchImpl } = respondWith({
      data: [
        { id: "qwen3-8b", meta: { n_ctx_train: 131_072 } },
        { id: "gemma3-4b" },
      ],
    });
    const seen: LocalDiscoveredModel[][] = [];

    await refreshCatalog(
      createLocalRuntimeProvider(llamaCpp, {
        fetchImpl,
        models: [record({ modelId: "gemma3-4b", enabled: false })],
        onDiscovered: (discovered) => seen.push([...discovered]),
      }),
    );

    // Everything served, including the model that was switched off: the caller
    // needs the true served set, which the published catalog no longer carries.
    assert.deepEqual(seen, [
      [{ id: "qwen3-8b", contextWindow: 131_072 }, { id: "gemma3-4b" }],
    ]);
  });
});
