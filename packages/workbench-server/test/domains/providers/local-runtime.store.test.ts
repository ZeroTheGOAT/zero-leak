import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  Credential,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import { unregisterManagedProvider } from "@nervekit/harness/models";
import {
  defaultLocalRuntimes,
  type LocalRuntime,
} from "@nervekit/contracts/providers";
import { defaultUserConfiguration } from "@nervekit/contracts/settings";
import { LocalRuntimeStore } from "../../../src/domains/providers/local-runtime.store.js";
import { ProviderCatalogStore } from "../../../src/domains/providers/provider-catalog.store.js";
import {
  storagePaths,
  type InitializedStorage,
} from "../../../src/infrastructure/storage-bootstrap/index.js";

/**
 * Records the provider mutations the store pushes into the shared pi-ai
 * collection. Only the four members `#syncRegistry` touches are implemented;
 * the cast keeps the stub honest about that.
 */
class ModelsSpy {
  readonly set: string[] = [];
  readonly providers: Provider[] = [];
  readonly deleted: string[] = [];
  readonly refreshed: string[][] = [];

  setProvider(provider: Provider): void {
    this.set.push(provider.id);
    this.providers.push(provider);
  }

  deleteProvider(id: string): void {
    this.deleted.push(id);
  }

  refresh(options?: { providers?: readonly string[] }): Promise<{
    aborted: boolean;
    errors: ReadonlyMap<string, Error>;
  }> {
    this.refreshed.push([...(options?.providers ?? [])]);
    return Promise.resolve({ aborted: false, errors: new Map() });
  }

  asModels(): MutableModels {
    return this as unknown as MutableModels;
  }
}

/** A credential store holding one api-key entry, for the token-aware probe. */
function credentialsWith(entries: Record<string, string>) {
  return {
    read: (providerId: string): Promise<Credential | undefined> =>
      Promise.resolve(
        entries[providerId]
          ? { type: "api_key" as const, key: entries[providerId] }
          : undefined,
      ),
  };
}

const homes: string[] = [];

/**
 * Runtime ids this suite installs. `#syncRegistry` registers enabled runtimes in
 * the process-wide harness registry, so they are removed again on teardown to
 * keep sibling suites in the same process clean.
 */
const registeredIds = [
  "onprem-gateway",
  "vllm",
  "vllm-enabled",
  "vllm-toggled",
  "vllm-removed",
];

async function cleanUp(): Promise<void> {
  for (const id of registeredIds) unregisterManagedProvider(id);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * A real storage home on disk: the store writes through
 * `writeHomeConfiguration`, which replaces files atomically and does not create
 * the config directory itself.
 */
async function createStorage(
  providers: Partial<InitializedStorage["configuration"]["providers"]> = {},
): Promise<InitializedStorage> {
  const home = await mkdtemp(join(tmpdir(), "zeroleak-runtime-store-"));
  homes.push(home);
  const paths = storagePaths(home);
  await mkdir(paths.configPath, { recursive: true });
  const configuration = structuredClone(defaultUserConfiguration);
  configuration.providers = { ...configuration.providers, ...providers };
  return { paths, configuration } as InitializedStorage;
}

async function readPersistedRuntimes(
  storage: InitializedStorage,
): Promise<unknown> {
  const raw = await readFile(storage.paths.providersConfigPath, "utf8");
  return (JSON.parse(raw) as { localRuntimes?: unknown }).localRuntimes;
}

const onpremGateway: LocalRuntime = {
  id: "onprem-gateway",
  kind: "onprem-openai",
  displayName: "On-premise gateway",
  baseUrl: "http://10.0.0.4:9000/v1",
  api: "openai-completions",
  discovery: "openai-models",
  requiresApiKey: true,
  enabled: true,
  headers: { "X-Tenant": "lab" },
};

/** A persisted runtime whose gateway token is a secret-store reference. */
const vllmWithSecretHeader = {
  id: "vllm",
  kind: "vllm",
  displayName: "vLLM",
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  discovery: "openai-models",
  requiresApiKey: false,
  enabled: true,
  headers: {
    "X-Tenant": { value: "lab" },
    "X-Gateway-Token": { credential: "gateway-token" },
  },
};

describe("LocalRuntimeStore", () => {
  after(cleanUp);

  it("seeds the preset runtimes for a home that has never been configured", async () => {
    const store = new LocalRuntimeStore(await createStorage());

    assert.deepEqual(
      store.runtimes().map((runtime) => runtime.id),
      defaultLocalRuntimes().map((runtime) => runtime.id),
    );
    assert.equal(store.catalog.version, 1);
  });

  it("keeps an explicitly emptied runtime list empty", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );

    assert.deepEqual([...store.runtimes()], []);
  });

  it("restores literal header values from the persisted credential form", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({
        localRuntimes: [
          {
            id: "vllm",
            kind: "vllm",
            displayName: "vLLM",
            baseUrl: "http://127.0.0.1:8000/v1",
            api: "openai-completions",
            discovery: "openai-models",
            requiresApiKey: false,
            enabled: true,
            headers: { "X-Tenant": { value: "lab" } },
          },
        ],
      }),
    );

    assert.deepEqual(store.get("vllm")?.headers, { "X-Tenant": "lab" });
  });

  it("resolves credential-referenced headers once hydrated", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [vllmWithSecretHeader] }),
      {
        getCredential: (name) =>
          Promise.resolve(name === "gateway-token" ? "s3cret-token" : undefined),
      },
    );
    const models = new ModelsSpy();
    store.attach(models.asModels());

    await store.hydrate();

    // The runtime the providers are built from carries the resolved secret…
    assert.deepEqual(store.get("vllm")?.headers, {
      "X-Tenant": "lab",
      "X-Gateway-Token": "s3cret-token",
    });
    assert.deepEqual(models.set, ["vllm"]);
    assert.equal(
      models.providers[0]?.headers?.["X-Gateway-Token"],
      "s3cret-token",
    );
    // …while the catalog the settings page sees keeps showing only literals.
    assert.deepEqual(store.catalog.runtimes[0]?.headers, { "X-Tenant": "lab" });
  });

  it("leaves a credential-referenced header unset when the secret is missing", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [vllmWithSecretHeader] }),
      { getCredential: () => Promise.resolve(undefined) },
    );

    await store.hydrate();

    assert.deepEqual(store.get("vllm")?.headers, { "X-Tenant": "lab" });
  });

  it("keeps another runtime's credential references when one is edited", async () => {
    const storage = await createStorage({
      localRuntimes: [vllmWithSecretHeader],
    });
    const store = new LocalRuntimeStore(storage, {
      getCredential: (name) =>
        Promise.resolve(name === "gateway-token" ? "s3cret-token" : undefined),
    });
    await store.hydrate();

    await store.upsert({ ...onpremGateway, displayName: "Renamed gateway" });

    // Regression: every write used to re-serialize the in-memory runtimes,
    // which had silently dropped the credential references of any runtime the
    // edit did not touch.
    assert.deepEqual(
      (await readPersistedRuntimes(storage)) as Array<{
        headers: Record<string, unknown>;
      }>,
      [
        {
          ...vllmWithSecretHeader,
          headers: {
            "X-Tenant": { value: "lab" },
            "X-Gateway-Token": { credential: "gateway-token" },
          },
        },
        {
          ...onpremGateway,
          displayName: "Renamed gateway",
          headers: { "X-Tenant": { value: "lab" } },
        },
      ],
    );
  });

  it("replaces a runtime's credential reference when it is edited in the UI", async () => {
    const storage = await createStorage({
      localRuntimes: [vllmWithSecretHeader],
    });
    const store = new LocalRuntimeStore(storage);

    await store.upsert({
      id: "vllm",
      kind: "vllm",
      displayName: "vLLM",
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      discovery: "openai-models",
      requiresApiKey: false,
      enabled: true,
      headers: { "X-Tenant": "lab-2" },
    });

    // The dialog only ever produces literal headers, so an edit replaces the
    // reference — the same lifecycle a custom provider's headers have.
    assert.deepEqual(
      (await readPersistedRuntimes(storage)) as Array<{
        headers: Record<string, unknown>;
      }>,
      [
        {
          ...vllmWithSecretHeader,
          headers: { "X-Tenant": { value: "lab-2" } },
        },
      ],
    );
  });

  it("persists an added runtime with its headers in credential-reference form", async () => {
    const storage = await createStorage({ localRuntimes: [] });
    const store = new LocalRuntimeStore(storage);

    const catalog = await store.upsert(onpremGateway);

    assert.deepEqual(
      catalog.runtimes.map((runtime) => runtime.id),
      ["onprem-gateway"],
    );
    assert.deepEqual(await readPersistedRuntimes(storage), [
      {
        id: "onprem-gateway",
        kind: "onprem-openai",
        displayName: "On-premise gateway",
        baseUrl: "http://10.0.0.4:9000/v1",
        api: "openai-completions",
        discovery: "openai-models",
        requiresApiKey: true,
        enabled: true,
        headers: { "X-Tenant": { value: "lab" } },
      },
    ]);
  });

  it("replaces a runtime with the same id rather than duplicating it", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );
    await store.upsert(onpremGateway);

    const catalog = await store.upsert({
      ...onpremGateway,
      displayName: "Renamed gateway",
    });

    assert.equal(catalog.runtimes.length, 1);
    assert.equal(store.get("onprem-gateway")?.displayName, "Renamed gateway");
  });

  it("installs a runtime in the shared model collection when it is enabled", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );
    const models = new ModelsSpy();
    store.attach(models.asModels());

    await store.upsert({ ...onpremGateway, id: "vllm-enabled" });

    assert.deepEqual(models.set, ["vllm-enabled"]);
    assert.deepEqual(models.deleted, []);
    assert.deepEqual(models.refreshed, [["vllm-enabled"]]);
  });

  it("removes a disabled runtime from the shared model collection", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );
    const models = new ModelsSpy();
    store.attach(models.asModels());
    await store.upsert({ ...onpremGateway, id: "vllm-toggled" });

    await store.upsert({
      ...onpremGateway,
      id: "vllm-toggled",
      enabled: false,
    });

    assert.deepEqual(models.deleted, ["vllm-toggled"]);
    // Nothing is enabled any more, so no discovery request is scheduled.
    assert.deepEqual(models.refreshed, [["vllm-toggled"]]);
  });

  it("removes a deleted runtime from the shared model collection", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );
    const models = new ModelsSpy();
    store.attach(models.asModels());
    await store.upsert({ ...onpremGateway, id: "vllm-removed" });

    const catalog = await store.remove("vllm-removed");

    assert.deepEqual([...catalog.runtimes], []);
    assert.deepEqual(models.deleted, ["vllm-removed"]);
  });

  it("reports an unknown runtime instead of contacting anything", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
    );

    assert.deepEqual(await store.probe("not-configured"), {
      runtimeId: "not-configured",
      reachable: false,
      modelIds: [],
      error: "This runtime is not configured.",
    });
  });

  it("probes a configured runtime and reports it unreachable when nothing answers", async () => {
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
      { credentials: credentialsWith({ "onprem-gateway": "token" }) as never },
    );
    await store.upsert({
      ...onpremGateway,
      // Port 1 on loopback: reserved, never listening.
      baseUrl: "http://127.0.0.1:1/v1",
    });

    const probe = await store.probe("onprem-gateway");

    assert.equal(probe.runtimeId, "onprem-gateway");
    assert.equal(probe.reachable, false);
    assert.ok(probe.error, "expected the transport failure to be reported");
    assert.deepEqual(probe.modelIds, []);
  });

  it("never offers the stored token to a runtime that does not require one", async () => {
    const reads: string[] = [];
    const credentials = {
      read: (providerId: string): Promise<Credential | undefined> => {
        reads.push(providerId);
        return Promise.resolve({ type: "api_key" as const, key: "token" });
      },
    };
    const store = new LocalRuntimeStore(
      await createStorage({ localRuntimes: [] }),
      { credentials: credentials as never },
    );
    await store.upsert({
      ...onpremGateway,
      // Port 1 on loopback: reserved, never listening.
      baseUrl: "http://127.0.0.1:1/v1",
      requiresApiKey: false,
    });

    await store.probe("onprem-gateway");

    assert.deepEqual(reads, [], "a keyless runtime reads no credential");
  });
});

describe("ProviderCatalogStore alongside local runtimes", () => {
  after(cleanUp);

  it("preserves the persisted runtimes when a custom provider is written", async () => {
    const storage = await createStorage({ localRuntimes: [] });
    const runtimeStore = new LocalRuntimeStore(storage);
    await runtimeStore.upsert(onpremGateway);

    const catalogStore = new ProviderCatalogStore(storage);
    await catalogStore.upsertProvider({
      id: "custom-provider",
      displayName: "Custom provider",
      baseUrl: "http://127.0.0.1:7000/v1",
      api: "openai-completions",
      headers: {},
    });

    // Regression: the catalog write used to drop `localRuntimes` from
    // providers.json, silently removing every configured local endpoint.
    assert.deepEqual(
      ((await readPersistedRuntimes(storage)) as Array<{ id: string }>).map(
        (runtime) => runtime.id,
      ),
      ["onprem-gateway"],
    );
    assert.deepEqual(
      storage.configuration.providers.localRuntimes?.map(
        (runtime) => runtime.id,
      ),
      ["onprem-gateway"],
    );
  });
});
