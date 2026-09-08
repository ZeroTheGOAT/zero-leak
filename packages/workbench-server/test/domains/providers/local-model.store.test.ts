import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { unregisterManagedProvider } from "@nervekit/harness/models";
import type {
  LocalModelRecord,
  LocalRuntime,
} from "@nervekit/contracts/providers";
import { defaultUserConfiguration } from "@nervekit/contracts/settings";
import { LocalModelStore } from "../../../src/domains/providers/local-model.store.js";
import { LocalRuntimeStore } from "../../../src/domains/providers/local-runtime.store.js";
import { ApplicationError } from "../../../src/core/application-error.js";
import {
  storagePaths,
  type InitializedStorage,
} from "../../../src/infrastructure/storage-bootstrap/index.js";

/**
 * Stands in for the shared pi-ai collection. `refresh` is the only member this
 * store calls; `failing` lets a test make one runtime's discovery fail, which is
 * what the store treats as "this endpoint is not serving anything".
 */
class ModelsSpy {
  readonly refreshed: string[][] = [];
  failing = new Set<string>();

  setProvider(): void {}
  deleteProvider(): void {}

  refresh(options?: { providers?: readonly string[] }): Promise<{
    aborted: boolean;
    errors: ReadonlyMap<string, Error>;
  }> {
    const providers = [...(options?.providers ?? [])];
    this.refreshed.push(providers);
    const errors = new Map<string, Error>();
    for (const id of providers) {
      if (this.failing.has(id)) errors.set(id, new Error("unreachable"));
    }
    return Promise.resolve({ aborted: false, errors });
  }

  asModels(): MutableModels {
    return this as unknown as MutableModels;
  }
}

const homes: string[] = [];

/** Runtime ids these suites install in the process-wide harness registry. */
const registeredIds = ["ollama", "llama-cpp", "vllm"];

after(async () => {
  for (const id of registeredIds) unregisterManagedProvider(id);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

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
  // Port 1 on loopback: reserved, so nothing can answer by accident.
  baseUrl: "http://127.0.0.1:1/v1",
  api: "openai-completions",
  discovery: "none",
  requiresApiKey: false,
  enabled: true,
  headers: {},
};

async function createStorage(
  providers: Partial<InitializedStorage["configuration"]["providers"]> = {},
): Promise<InitializedStorage> {
  const home = await mkdtemp(join(tmpdir(), "zeroleak-model-store-"));
  homes.push(home);
  const paths = storagePaths(home);
  await mkdir(paths.configPath, { recursive: true });
  const configuration = structuredClone(defaultUserConfiguration);
  configuration.providers = { ...configuration.providers, ...providers };
  return { paths, configuration } as InitializedStorage;
}

interface Harness {
  storage: InitializedStorage;
  runtimes: LocalRuntimeStore;
  models: LocalModelStore;
  spy: ModelsSpy;
}

/**
 * The three collaborators wired the way `server-runtime` wires them, minus the
 * providers: `noteDiscovered` is called directly instead, standing in for the
 * discovery request a real provider would make.
 */
async function harness(
  runtimes: readonly LocalRuntime[],
  records: readonly LocalModelRecord[] = [],
): Promise<Harness> {
  const storage = await createStorage({
    localRuntimes: runtimes.map(({ headers, ...runtime }) => ({
      ...runtime,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, { value }]),
      ),
    })),
    ...(records.length > 0 ? { localModels: [...records] } : {}),
  });
  const runtimeStore = new LocalRuntimeStore(storage);
  const modelStore = new LocalModelStore(storage, runtimeStore);
  runtimeStore.attachModelConfiguration(modelStore);
  const spy = new ModelsSpy();
  runtimeStore.attach(spy.asModels());
  modelStore.attach(spy.asModels());
  return { storage, runtimes: runtimeStore, models: modelStore, spy };
}

async function readPersistedModels(
  storage: InitializedStorage,
): Promise<unknown> {
  const raw = await readFile(storage.paths.providersConfigPath, "utf8");
  return (JSON.parse(raw) as { localModels?: unknown }).localModels;
}

describe("LocalModelStore inventory", () => {
  it("asks every discoverable runtime once before answering", async () => {
    const { models, spy } = await harness([ollama, llamaCpp]);

    const inventory = await models.inventory();

    // llama.cpp has discovery off, so asking it would be pointless.
    assert.deepEqual(spy.refreshed, [["ollama"]]);
    assert.deepEqual(inventory, { version: 1, models: [] });

    await models.inventory();
    // Already asked in this process: the second call adds no request.
    assert.deepEqual(spy.refreshed, [["ollama"]]);
  });

  it("reports what a runtime served, in the order the runtime listed it", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [
      { id: "qwen3:8b", contextWindow: 131_072 },
      { id: "llama3.2:3b" },
    ]);

    const inventory = await models.inventory();

    assert.deepEqual(
      inventory.models.map((model) => [
        model.modelId,
        model.contextWindow,
        model.discovered,
        model.configured,
      ]),
      [
        ["qwen3:8b", 131_072, true, false],
        // No reported context length, so the air-gapped default applies.
        ["llama3.2:3b", 32_768, true, false],
      ],
    );
  });

  it("resolves a discovered model against the operator's overrides", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b", contextWindow: 8_192 }]);

    const inventory = await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: {
        displayName: "Qwen3 8B",
        contextWindow: 131_072,
        reasoning: true,
      },
    });

    assert.deepEqual(inventory.models, [
      {
        runtimeId: "ollama",
        modelId: "qwen3:8b",
        displayName: "Qwen3 8B",
        discovered: true,
        imported: false,
        enabled: true,
        configured: true,
        // The override wins over the runtime's own answer.
        contextWindow: 131_072,
        maxTokens: 4_096,
        reasoning: true,
        input: ["text"],
        overrides: {
          displayName: "Qwen3 8B",
          contextWindow: 131_072,
          reasoning: true,
        },
      },
    ]);
  });

  it("keeps a disabled model in the inventory so it can be switched back on", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);

    const inventory = await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      enabled: false,
    });

    const entry = inventory.models[0];
    assert.equal(entry?.enabled, false);
    // Still discovered: the runtime serves it, the operator merely hid it.
    assert.equal(entry?.discovered, true);
    // A toggle is not an override, so nothing claims the model is configured.
    assert.equal(entry?.configured, false);
  });

  it("lists an imported model on a runtime that cannot be asked", async () => {
    const { models } = await harness([llamaCpp]);

    const inventory = await models.import({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b-q4",
      overrides: { contextWindow: 16_384 },
    });

    assert.deepEqual(
      inventory.models.map((model) => [
        model.modelId,
        model.imported,
        model.discovered,
        model.contextWindow,
      ]),
      [["qwen3-8b-q4", true, false, 16_384]],
    );
  });

  it("keeps a model's overrides when it is re-imported without them", async () => {
    const { models } = await harness([llamaCpp]);
    await models.import({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b-q4",
      overrides: { contextWindow: 16_384, displayName: "Qwen 8B" },
    });

    const inventory = await models.import({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b-q4",
    });

    const entry = inventory.models[0];
    assert.equal(entry?.contextWindow, 16_384);
    assert.equal(entry?.displayName, "Qwen 8B");
  });

  it("marks an imported model discovered once the runtime reports it", async () => {
    const { models } = await harness([ollama]);
    await models.import({ runtimeId: "ollama", modelId: "llama3.2:3b" });
    models.noteDiscovered("ollama", [{ id: "llama3.2:3b" }]);

    const inventory = await models.inventory();

    assert.equal(inventory.models.length, 1);
    assert.equal(inventory.models[0]?.discovered, true);
    assert.equal(inventory.models[0]?.imported, true);
  });

  it("keeps configuration for a model the runtime has stopped serving", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { displayName: "Qwen3 8B" },
    });

    models.noteDiscovered("ollama", []);
    const inventory = await models.inventory();

    // Reported as configured but no longer served, rather than silently gone:
    // the operator needs to see that the weights have disappeared.
    assert.deepEqual(
      inventory.models.map((model) => [model.modelId, model.discovered]),
      [["qwen3:8b", false]],
    );
  });

  it("forgets a runtime's listing when discovery fails", async () => {
    const { models, spy } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    spy.failing.add("ollama");

    const inventory = await models.refresh("ollama");

    // A runtime that cannot be reached is not serving anything, so keeping the
    // last listing would report models that are not there.
    assert.deepEqual(inventory.models, []);
  });

  it("groups models by runtime in the configured runtime order", async () => {
    const { models } = await harness([ollama, llamaCpp]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    await models.import({ runtimeId: "llama-cpp", modelId: "gemma3-4b" });

    const inventory = await models.inventory();

    assert.deepEqual(
      inventory.models.map((model) => model.runtimeId),
      ["ollama", "llama-cpp"],
    );
  });

  it("refuses to configure a model on a runtime that does not exist", async () => {
    const { models } = await harness([ollama]);

    await assert.rejects(
      () => models.import({ runtimeId: "vllm", modelId: "qwen3-8b" }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "LOCAL_RUNTIME_NOT_CONFIGURED");
        return true;
      },
    );
  });
});

describe("LocalModelStore persistence", () => {
  it("writes a configured model to providers.json", async () => {
    const { storage, models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);

    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { maxTokens: 2_048 },
    });

    assert.deepEqual(await readPersistedModels(storage), [
      {
        runtimeId: "ollama",
        modelId: "qwen3:8b",
        imported: false,
        enabled: true,
        overrides: { maxTokens: 2_048 },
      },
    ]);
  });

  it("preserves the persisted runtimes when a model is configured", async () => {
    const { storage, models } = await harness([ollama]);

    await models.import({ runtimeId: "ollama", modelId: "qwen3:8b" });

    const raw = await readFile(storage.paths.providersConfigPath, "utf8");
    assert.deepEqual(
      (JSON.parse(raw) as { localRuntimes: Array<{ id: string }> })
        .localRuntimes,
      [{ ...ollama, headers: {} }],
    );
  });

  it("loads the operator's records from a configured home", async () => {
    const { models } = await harness(
      [ollama],
      [
        {
          runtimeId: "ollama",
          modelId: "qwen3:8b",
          imported: true,
          enabled: false,
          overrides: { displayName: "Qwen3 8B" },
        },
      ],
    );

    assert.deepEqual(models.records(), [
      {
        runtimeId: "ollama",
        modelId: "qwen3:8b",
        imported: true,
        enabled: false,
        overrides: { displayName: "Qwen3 8B" },
      },
    ]);
  });

  it("keeps the stored toggle when only the overrides are edited", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      enabled: false,
    });

    const inventory = await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { maxTokens: 512 },
    });

    assert.equal(inventory.models[0]?.enabled, false);
    assert.equal(inventory.models[0]?.maxTokens, 512);
  });

  it("keeps the stored toggle when a model is re-imported", async () => {
    const { models } = await harness([llamaCpp]);
    await models.import({ runtimeId: "llama-cpp", modelId: "qwen3-8b" });
    await models.update({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
      enabled: false,
    });

    const inventory = await models.import({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
      overrides: { contextWindow: 4_096 },
    });

    assert.equal(inventory.models[0]?.enabled, false);
    assert.equal(inventory.models[0]?.contextWindow, 4_096);
  });

  it("drops an imported model from the inventory when its record is removed", async () => {
    const { storage, models } = await harness([llamaCpp]);
    await models.import({ runtimeId: "llama-cpp", modelId: "qwen3-8b" });

    const inventory = await models.remove({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
    });

    assert.deepEqual(inventory.models, []);
    assert.deepEqual(await readPersistedModels(storage), []);
  });

  it("returns a discovered model to the runtime's own answers when its record is removed", async () => {
    const { models } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b", contextWindow: 8_192 }]);
    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { contextWindow: 131_072 },
    });

    const inventory = await models.remove({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
    });

    assert.equal(inventory.models[0]?.contextWindow, 8_192);
    assert.equal(inventory.models[0]?.configured, false);
  });

  it("discards a deleted runtime's model configuration", async () => {
    const { storage, models, runtimes } = await harness([ollama, llamaCpp]);
    await models.import({ runtimeId: "ollama", modelId: "qwen3:8b" });
    await models.import({ runtimeId: "llama-cpp", modelId: "gemma3-4b" });

    await runtimes.remove("ollama");
    await models.forgetRuntime("ollama");

    assert.deepEqual(
      models.records().map((record) => record.runtimeId),
      ["llama-cpp"],
    );
    assert.deepEqual(
      (
        (await readPersistedModels(storage)) as Array<{ runtimeId: string }>
      ).map((record) => record.runtimeId),
      ["llama-cpp"],
    );
  });

  it("rebuilds the providers so a configuration change reaches the model pickers", async () => {
    const { models, spy } = await harness([ollama]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    spy.refreshed.length = 0;

    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { displayName: "Qwen3 8B" },
    });

    // A provider's baseline and overrides are fixed when it is built, so the
    // write has to resync rather than trusting the existing provider.
    assert.deepEqual(spy.refreshed, [["ollama"]]);
  });

  it("re-asks only the runtime whose models were edited", async () => {
    const { models, spy } = await harness([ollama, llamaCpp]);
    models.noteDiscovered("ollama", [{ id: "qwen3:8b" }]);
    spy.refreshed.length = 0;

    await models.update({
      runtimeId: "ollama",
      modelId: "qwen3:8b",
      overrides: { displayName: "Qwen3 8B" },
    });

    // Both providers are rebuilt — that is in-memory and cheap — but only the
    // edited runtime's endpoint is contacted again. The other one was rebuilt
    // from the configuration it already had.
    assert.deepEqual(spy.refreshed, [["ollama"]]);
  });
});

describe("LocalModelStore residency", () => {
  it("reports residency as unknown when the runtime cannot be asked", async () => {
    const { models } = await harness([llamaCpp]);

    const status = await models.status({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
    });

    assert.equal(status.residency, "unknown");
    assert.equal(status.controllable, false);
    assert.match(status.detail ?? "", /discovery disabled/);
  });

  it("reports a load it cannot perform instead of claiming success", async () => {
    const { models } = await harness([llamaCpp]);

    const status = await models.load({
      runtimeId: "llama-cpp",
      modelId: "qwen3-8b",
    });

    assert.equal(status.controllable, false);
    assert.match(status.detail ?? "", /cannot load or unload/);
  });

  it("fails a model test against an endpoint that is not listening", async () => {
    const { models } = await harness([
      { ...ollama, baseUrl: "http://127.0.0.1:1/v1" },
    ]);

    const result = await models.test({
      runtimeId: "ollama",
      modelId: "llama3.2:3b",
    });

    assert.equal(result.ok, false);
    assert.ok(result.error, "expected the transport failure to be reported");
  });

  it("refuses residency operations on a runtime that does not exist", async () => {
    const { models } = await harness([ollama]);

    await assert.rejects(
      () => models.status({ runtimeId: "vllm", modelId: "qwen3-8b" }),
      /No local runtime is configured with the id "vllm"/,
    );
  });
});
