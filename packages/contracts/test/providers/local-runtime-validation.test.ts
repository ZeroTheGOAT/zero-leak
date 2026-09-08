import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultLocalRuntimeCatalog,
  defaultLocalRuntimes,
  isLocalRuntimeHost,
  isLocalRuntimeUrl,
  localRuntimeCatalogSchema,
  localRuntimeKindLabel,
  localRuntimeKindSchema,
  localRuntimePresets,
  localRuntimeProbeSchema,
  localRuntimeSchema,
} from "../../src/domains/providers/local-runtimes.js";
import { localRuntimeConfigSchema } from "../../src/domains/settings/home-configuration.js";

const minimal = {
  id: "llama-cpp",
  kind: "llama-cpp",
  displayName: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
} as const;

describe("localRuntimeSchema", () => {
  it("fills in the air-gapped defaults for a minimal entry", () => {
    const runtime = localRuntimeSchema.parse(minimal);

    assert.equal(runtime.api, "openai-completions");
    assert.equal(runtime.discovery, "openai-models");
    assert.equal(runtime.requiresApiKey, false);
    assert.equal(runtime.enabled, true);
    assert.deepEqual(runtime.headers, {});
    assert.equal(runtime.compat, undefined);
  });

  it("rejects an id that is not a provider id", () => {
    assert.equal(
      localRuntimeSchema.safeParse({ ...minimal, id: "Llama CPP" }).success,
      false,
    );
  });

  it("rejects a base url that is not a url", () => {
    assert.equal(
      localRuntimeSchema.safeParse({ ...minimal, baseUrl: "127.0.0.1:8080" })
        .success,
      false,
    );
  });

  it("rejects a public base url", () => {
    assert.equal(
      localRuntimeSchema.safeParse({
        ...minimal,
        baseUrl: "https://api.openai.com/v1",
      }).success,
      false,
    );
  });

  it("rejects a dns name, which could resolve anywhere", () => {
    assert.equal(
      localRuntimeSchema.safeParse({
        ...minimal,
        baseUrl: "http://gpu-cluster.internal:9000/v1",
      }).success,
      false,
    );
  });

  it("accepts every private-network address family", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.255",
      "192.168.0.4",
      "fc00::5",
      "fdab:cd::1",
      "fe80::1",
    ]) {
      assert.equal(isLocalRuntimeHost(host), true, host);
    }
  });

  it("rejects public and out-of-range addresses", () => {
    for (const host of [
      "8.8.8.8",
      "172.32.0.1",
      "172.15.0.1",
      "172.1.2.3",
      "192.169.0.1",
      "2001:db8::1",
      "::ffff:8.8.8.8",
      "api.openai.com",
      "gpu-cluster.internal",
    ]) {
      assert.equal(isLocalRuntimeHost(host), false, host);
    }
  });

  it("checks the host of a complete url", () => {
    assert.equal(isLocalRuntimeUrl("http://10.0.0.4:9000/v1"), true);
    assert.equal(isLocalRuntimeUrl("http://[::1]:8080/v1"), true);
    assert.equal(isLocalRuntimeUrl("https://example.com/v1"), false);
    assert.equal(isLocalRuntimeUrl("not a url"), false);
  });

  it("rejects an empty display name", () => {
    assert.equal(
      localRuntimeSchema.safeParse({ ...minimal, displayName: "" }).success,
      false,
    );
  });

  it("rejects a runtime kind that is not a local runtime", () => {
    assert.equal(
      localRuntimeSchema.safeParse({ ...minimal, kind: "openai" }).success,
      false,
    );
  });

  it("keeps only local runtime kinds in the enum", () => {
    assert.deepEqual(localRuntimeKindSchema.options, [
      "llama-cpp",
      "ollama",
      "vllm",
      "python",
      "onprem-openai",
    ]);
  });

  it("preserves configured headers and compat overrides", () => {
    const runtime = localRuntimeSchema.parse({
      ...minimal,
      headers: { "X-Tenant": "lab" },
      compat: { maxTokensField: "max_tokens" },
    });

    assert.deepEqual(runtime.headers, { "X-Tenant": "lab" });
    assert.equal(runtime.compat?.maxTokensField, "max_tokens");
  });
});

describe("localRuntimeConfigSchema (persisted form)", () => {
  const persisted = {
    id: "vllm",
    kind: "vllm",
    displayName: "vLLM",
    baseUrl: "http://10.0.0.4:9000/v1",
    api: "openai-completions",
    discovery: "openai-models",
    requiresApiKey: false,
    enabled: true,
    headers: {},
  } as const;

  it("accepts a private on-premise endpoint", () => {
    assert.equal(localRuntimeConfigSchema.safeParse(persisted).success, true);
  });

  it("rejects a hand-edited public endpoint at load time", () => {
    assert.equal(
      localRuntimeConfigSchema.safeParse({
        ...persisted,
        baseUrl: "https://api.openai.com/v1",
      }).success,
      false,
    );
  });
});

describe("localRuntimeProbeSchema", () => {
  it("defaults an absent model list to empty", () => {
    const probe = localRuntimeProbeSchema.parse({
      runtimeId: "llama-cpp",
      reachable: false,
      error: "Not reachable.",
    });

    assert.deepEqual(probe.modelIds, []);
    assert.equal(probe.latencyMs, undefined);
  });

  it("rejects a negative latency", () => {
    assert.equal(
      localRuntimeProbeSchema.safeParse({
        runtimeId: "llama-cpp",
        reachable: true,
        latencyMs: -1,
      }).success,
      false,
    );
  });
});

describe("local runtime presets", () => {
  it("covers every runtime kind exactly once", () => {
    assert.deepEqual(
      localRuntimePresets.map((preset) => preset.kind),
      localRuntimeKindSchema.options,
    );
  });

  it("addresses only the local host", () => {
    for (const preset of localRuntimePresets) {
      assert.match(
        preset.baseUrl,
        /^http:\/\/127\.0\.0\.1:\d+\/v1$/,
        `${preset.id} must point at the loopback interface`,
      );
    }
  });

  it("uses a distinct port and id per runtime", () => {
    assert.equal(
      new Set(localRuntimePresets.map((preset) => preset.baseUrl)).size,
      localRuntimePresets.length,
    );
    assert.equal(
      new Set(localRuntimePresets.map((preset) => preset.id)).size,
      localRuntimePresets.length,
    );
  });

  it("labels a kind by its preset display name", () => {
    assert.equal(localRuntimeKindLabel("ollama"), "Ollama");
    assert.equal(
      localRuntimeKindLabel("onprem-openai"),
      "On-premise OpenAI-compatible endpoint",
    );
  });

  it("leaves the runtime that needs a token switched off", () => {
    for (const preset of localRuntimePresets) {
      if (!preset.requiresApiKey) continue;
      assert.equal(
        preset.enabled,
        false,
        `${preset.id} requires a token, so it must not be enabled before one is stored`,
      );
    }
  });
});

describe("defaultLocalRuntimes", () => {
  it("produces entries the runtime schema accepts unchanged", () => {
    for (const runtime of defaultLocalRuntimes()) {
      assert.deepEqual(localRuntimeSchema.parse(runtime), runtime);
    }
  });

  it("discovers Ollama through its native tag endpoint", () => {
    const ollama = defaultLocalRuntimes().find(
      (runtime) => runtime.kind === "ollama",
    );

    assert.equal(ollama?.discovery, "ollama-tags");
  });

  it("returns a fresh array each call so callers cannot alias the presets", () => {
    const first = defaultLocalRuntimes();
    first[0]!.displayName = "mutated";

    assert.notEqual(defaultLocalRuntimes()[0]?.displayName, "mutated");
  });
});

describe("localRuntimeCatalogSchema", () => {
  it("defaults an empty catalog", () => {
    assert.deepEqual(localRuntimeCatalogSchema.parse({}), {
      version: 1,
      runtimes: [],
    });
  });

  it("accepts the seeded catalog", () => {
    assert.deepEqual(
      localRuntimeCatalogSchema.parse(defaultLocalRuntimeCatalog),
      defaultLocalRuntimeCatalog,
    );
  });

  it("rejects a version it does not understand", () => {
    assert.equal(
      localRuntimeCatalogSchema.safeParse({ version: 2, runtimes: [] }).success,
      false,
    );
  });
});
