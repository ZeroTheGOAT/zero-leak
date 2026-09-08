import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalRuntime } from "@nervekit/contracts/providers";
import { createLocalRuntimeProvider } from "../../src/models/local-runtimes.js";
import {
  getModelRegistry,
  registerManagedProvider,
  unregisterManagedProvider,
} from "../../src/models/model-registry.js";
import {
  listAvailableModels,
  resolveAgentModel,
} from "../../src/models/resolution.js";

const runtime: LocalRuntime = {
  id: "resolution-test-runtime",
  kind: "llama-cpp",
  displayName: "Resolution Test Runtime",
  baseUrl: "http://127.0.0.1:65535/v1",
  api: "openai-completions",
  discovery: "openai-models",
  requiresApiKey: false,
  enabled: true,
  headers: {},
};

/** Twelve models, so a catalog clipped at eight entries is detectable. */
const served = Array.from({ length: 12 }, (_, index) => ({
  id: `served-model-${index}`,
}));

function servedModelsFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({ data: served }),
  });
}

describe("model resolution", () => {
  it("lists complete provider catalogs without silently truncating them", async () => {
    registerManagedProvider(
      createLocalRuntimeProvider(runtime, { fetchImpl: servedModelsFetch }),
    );
    try {
      const refreshed = await getModelRegistry().refresh({
        providers: [runtime.id],
        allowNetwork: true,
        force: true,
      });
      assert.deepEqual([...refreshed.errors], []);

      const runtimeModels = listAvailableModels().filter(
        (model) => model.provider === runtime.id,
      );

      assert.equal(
        runtimeModels.length,
        served.length,
        "expected the whole discovered catalog beyond its first eight models",
      );
      assert.ok(runtimeModels[8]);
      assert.equal(
        new Set(runtimeModels.map((model) => model.modelId)).size,
        runtimeModels.length,
      );
    } finally {
      unregisterManagedProvider(runtime.id);
    }
  });

  it("registers no public cloud provider", () => {
    const providers = new Set(
      listAvailableModels().map((model) => model.provider),
    );

    assert.deepEqual([...providers], ["nerve-faux"]);
  });

  it("preserves advanced pi model configuration", () => {
    const model = resolveAgentModel(
      { provider: "test-pi-json", modelId: "tiered" },
      [
        {
          provider: "test-pi-json",
          modelId: "tiered",
          name: "Tiered",
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          reasoning: false,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.1,
            cacheWrite: 0.2,
            tiers: [
              {
                inputTokensAbove: 272_000,
                input: 2,
                output: 3,
                cacheRead: 0.2,
                cacheWrite: 0.4,
              },
            ],
          },
          samplingParams: { temperature: 0.4, top_k: 20 },
        },
      ],
    );

    assert.deepEqual(model.samplingParams, {
      temperature: 0.4,
      top_k: 20,
    });
    assert.equal(model.cost.tiers?.[0]?.inputTokensAbove, 272_000);
  });
});
