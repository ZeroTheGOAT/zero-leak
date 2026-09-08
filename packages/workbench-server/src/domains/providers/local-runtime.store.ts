import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import {
  createLocalRuntimeProvider,
  type CreateLocalRuntimeProviderOptions,
  type LocalDiscoveredModel,
  probeLocalRuntime,
  registerManagedProvider,
  unregisterManagedProvider,
} from "@nervekit/harness/models";
import {
  defaultLocalRuntimes,
  type LocalModelRecord,
  type LocalRuntime,
  type LocalRuntimeCatalog,
  localRuntimeCatalogSchema,
  type LocalRuntimeProbe,
} from "@nervekit/contracts/providers";
import type { HeaderConfig } from "@nervekit/contracts/settings";
import { writeHomeConfiguration } from "../../infrastructure/configuration/index.js";
import type { InitializedStorage } from "../../infrastructure/storage-bootstrap/index.js";

export interface LocalRuntimeStoreOptions {
  /** Supplies the stored token when a runtime is marked `requiresApiKey`. */
  credentials?: CredentialStore;
  /**
   * Resolves a `{credential: name}` header reference to the secret it names.
   * Headers configured that way reach the runtime's provider and probe
   * requests without ever being written to providers.json, so an on-premise
   * gateway token lives in the secret store like a custom provider's does.
   */
  getCredential?: (name: string) => Promise<string | undefined>;
}

/**
 * The per-model configuration a provider is built with. Supplied by
 * `LocalModelStore`, which owns those records; this store only needs them
 * whenever it rebuilds a provider, and must not hold a copy that could go stale.
 */
export interface LocalModelConfiguration {
  records(): readonly LocalModelRecord[];
  noteDiscovered(
    runtimeId: string,
    discovered: readonly LocalDiscoveredModel[],
  ): void;
}

/**
 * The configured local inference endpoints, persisted in
 * `config/providers.json` under `localRuntimes`.
 *
 * Unlike {@link ProviderCatalogStore} this reads its state in the constructor
 * rather than in a hydration step, because `server-runtime` needs the runtime
 * list before it can build the pi-ai `Models` instance the whole application
 * shares. That is safe: the home configuration is already in memory by then,
 * so no I/O is involved. It does mean `{credential}` header references cannot
 * be resolved there — the secret store is async — which is what {@link
 * LocalRuntimeStore.hydrate} is for: the daemon bootstrap awaits it before the
 * first request is served.
 */
export class LocalRuntimeStore {
  #runtimes: LocalRuntime[];
  #rawHeaders: Map<string, Record<string, HeaderConfig>>;
  #models: MutableModels | undefined;
  #registered: Set<string>;
  #modelConfiguration: LocalModelConfiguration | undefined;

  constructor(
    private readonly storage: InitializedStorage,
    private readonly options: LocalRuntimeStoreOptions = {},
  ) {
    const read = readLocalRuntimes(storage.configuration.providers);
    this.#runtimes = read.runtimes;
    // Every runtime gets an entry so `#write` never has to guess which form a
    // header is persisted in.
    this.#rawHeaders = new Map(
      read.runtimes.map((runtime) => [
        runtime.id,
        read.rawHeaders.get(runtime.id) ?? mapLiteralHeaders(runtime.headers),
      ]),
    );
    this.#registered = new Set(
      this.#runtimes.filter((runtime) => runtime.enabled).map((r) => r.id),
    );
  }

  get catalog(): LocalRuntimeCatalog {
    // The app gets the literal view: resolved secret values stay server-side,
    // and credential references are invisible to the settings page, exactly
    // like a custom provider's catalog.
    return {
      version: 1,
      runtimes: this.#runtimes.map((runtime) => ({
        ...runtime,
        headers: literalHeaders(this.#rawHeaders.get(runtime.id) ?? {}),
      })),
    };
  }

  runtimes(): readonly LocalRuntime[] {
    return this.#runtimes;
  }

  get(id: string): LocalRuntime | undefined {
    return this.#runtimes.find((runtime) => runtime.id === id);
  }

  /**
   * Binds the shared `Models` instance so later edits reach it. Called once
   * after `localModels()` has installed the initially enabled runtimes, which
   * is why this is separate from the constructor.
   */
  attach(models: MutableModels): void {
    this.#models = models;
  }

  /**
   * Binds the per-model configuration so every provider this store builds later
   * carries the operator's overrides. Deliberately does not reconcile: the
   * providers `localModels()` has just built already have it, and a forced
   * discovery request at startup is not this store's to make.
   */
  attachModelConfiguration(configuration: LocalModelConfiguration): void {
    this.#modelConfiguration = configuration;
  }

  /**
   * Resolves `{credential: name}` header references from the secret store and
   * rebuilds the affected providers. Called once from the daemon bootstrap,
   * after `attach()`. A rotated secret needs a restart or a re-save of the
   * runtime — the same freshness rule the providers `#syncRegistry` builds
   * already follow.
   */
  async hydrate(): Promise<void> {
    if (await this.#resolveCredentialHeaders()) this.#syncRegistry();
  }

  /**
   * Rebuild every provider from the current runtime and model configuration,
   * re-discovering only the runtimes named by the caller. Called by
   * `LocalModelStore` after a model record changes, because a provider's
   * baseline catalog and overrides are fixed when it is created; the other
   * runtimes' providers are rebuilt identically, so re-asking their endpoints
   * would be pure network noise.
   */
  resync(runtimeIds?: readonly string[]): void {
    this.#syncRegistry(runtimeIds);
  }

  async upsert(runtime: LocalRuntime): Promise<LocalRuntimeCatalog> {
    const rawHeaders = new Map(this.#rawHeaders);
    // An edit from the UI carries literal headers, so a credential reference
    // on this runtime is replaced by whatever the dialog produced — the same
    // lifecycle a custom provider's headers have. References on other
    // runtimes survive the edit.
    rawHeaders.set(runtime.id, mapLiteralHeaders(runtime.headers));
    return this.#write(
      [...this.#runtimes.filter((item) => item.id !== runtime.id), runtime],
      rawHeaders,
      // Only this runtime changed; the others are rebuilt from the same
      // configuration they already had, so they are not re-asked.
      [runtime.id],
    );
  }

  async remove(id: string): Promise<LocalRuntimeCatalog> {
    const rawHeaders = new Map(this.#rawHeaders);
    rawHeaders.delete(id);
    // The runtime is gone, so there is nothing left to re-ask.
    return this.#write(
      this.#runtimes.filter((runtime) => runtime.id !== id),
      rawHeaders,
      [],
    );
  }

  /** Contacts a runtime and reports reachability and the models it serves. */
  async probe(id: string): Promise<LocalRuntimeProbe> {
    const runtime = this.get(id);
    if (!runtime) {
      return {
        runtimeId: id,
        reachable: false,
        modelIds: [],
        error: "This runtime is not configured.",
      };
    }
    // A stored token is offered only when the runtime asks for one, so turning
    // the requirement off stops a stale secret from being sent.
    const apiKey = runtime.requiresApiKey
      ? await this.#apiKeyFor(runtime)
      : undefined;
    return probeLocalRuntime(await this.#resolvedRuntime(runtime), { apiKey });
  }

  async #apiKeyFor(runtime: LocalRuntime): Promise<string | undefined> {
    const credential = await this.options.credentials?.read(runtime.id);
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  /**
   * The runtime as requests see it: literal headers plus freshly resolved
   * credential references. A missing secret leaves the header unset rather
   * than failing the call — the connection test then simply reports whatever
   * the gateway answers.
   */
  async #resolvedRuntime(runtime: LocalRuntime): Promise<LocalRuntime> {
    const getCredential = this.options.getCredential;
    const raw = this.#rawHeaders.get(runtime.id);
    if (!getCredential || !raw) return runtime;
    const references = Object.entries(raw).filter(
      (entry): entry is [string, { credential: string }] =>
        "credential" in entry[1],
    );
    if (references.length === 0) return runtime;
    const headers = literalHeaders(raw);
    for (const [name, source] of references) {
      const secret = await getCredential(source.credential);
      if (secret !== undefined) headers[name] = secret;
    }
    return { ...runtime, headers };
  }

  /**
   * Recomputes every runtime's headers from the persisted form plus the
   * current secret values, replacing a previously resolved value that a
   * rotated secret has invalidated.
   */
  async #resolveCredentialHeaders(): Promise<boolean> {
    if (!this.options.getCredential) return false;
    const next = await Promise.all(
      this.#runtimes.map((runtime) => this.#resolvedRuntime(runtime)),
    );
    const changed = next.some(
      (runtime, index) => runtime !== this.#runtimes[index],
    );
    if (changed) this.#runtimes = next;
    return changed;
  }

  async #write(
    next: LocalRuntime[],
    rawHeaders: Map<string, Record<string, HeaderConfig>>,
    refreshIds?: readonly string[],
  ): Promise<LocalRuntimeCatalog> {
    const validated = localRuntimeCatalogSchema.parse({
      version: 1,
      runtimes: next,
    });
    this.storage.configuration = await writeHomeConfiguration(
      this.storage.paths,
      {
        ...this.storage.configuration,
        providers: {
          ...this.storage.configuration.providers,
          localRuntimes: validated.runtimes.map((runtime) => ({
            ...runtime,
            headers:
              rawHeaders.get(runtime.id) ?? mapLiteralHeaders(runtime.headers),
          })),
        },
      },
    );
    this.#runtimes = [...validated.runtimes];
    this.#rawHeaders = rawHeaders;
    this.#syncRegistry(refreshIds);
    return this.catalog;
  }

  /**
   * Reconciles the pi-ai registries with the configured runtimes so enabling,
   * disabling, editing, or deleting one takes effect without a restart.
   * Rebuilds every enabled runtime's provider — that is in-memory work and the
   * provider's catalog is fixed at creation — but asks only the runtimes in
   * `refreshIds` what they are serving; with no scope given, every enabled
   * runtime (the startup reconcile).
   */
  #syncRegistry(refreshIds?: readonly string[]): void {
    const models = this.#models;
    if (!models) return;
    const enabled = new Set<string>();
    for (const runtime of this.#runtimes) {
      if (!runtime.enabled) continue;
      const provider = createLocalRuntimeProvider(
        runtime,
        this.#providerOptions(runtime.id),
      );
      models.setProvider(provider);
      registerManagedProvider(provider);
      enabled.add(runtime.id);
    }
    for (const id of this.#registered) {
      if (enabled.has(id)) continue;
      models.deleteProvider(id);
      unregisterManagedProvider(id);
    }
    this.#registered = enabled;
    const targets = refreshIds
      ? [...enabled].filter((id) => refreshIds.includes(id))
      : [...enabled];
    if (targets.length === 0) return;
    // Discovery is best effort: an endpoint that is currently switched off must
    // not fail the edit that just enabled it. `refresh` reports errors in its
    // result rather than rejecting.
    void models.refresh({ providers: targets, force: true });
  }

  #providerOptions(runtimeId: string): CreateLocalRuntimeProviderOptions {
    const configuration = this.#modelConfiguration;
    if (!configuration) return {};
    return {
      models: configuration.records(),
      onDiscovered: (discovered) =>
        configuration.noteDiscovered(runtimeId, discovered),
    };
  }
}

/**
 * Absent means the home has never been seeded, so the preset runtimes are
 * offered. An explicit empty array means the operator removed every runtime and
 * must not have them restored.
 */
function readLocalRuntimes(
  config: InitializedStorage["configuration"]["providers"],
): {
  runtimes: LocalRuntime[];
  rawHeaders: Map<string, Record<string, HeaderConfig>>;
} {
  if (!config.localRuntimes) {
    return { runtimes: defaultLocalRuntimes(), rawHeaders: new Map() };
  }
  const rawHeaders = new Map(
    config.localRuntimes.map((runtime) => [runtime.id, runtime.headers]),
  );
  const runtimes = localRuntimeCatalogSchema.parse({
    version: 1,
    runtimes: config.localRuntimes.map((runtime) => ({
      ...runtime,
      headers: literalHeaders(runtime.headers),
    })),
  }).runtimes;
  return { runtimes, rawHeaders };
}

/**
 * The literal half of a persisted header set. Credential references are
 * resolved separately, by {@link LocalRuntimeStore.hydrate} and the probe, so
 * secret values never sit in the catalog the settings page sees.
 */
function literalHeaders(
  headers: Record<string, HeaderConfig>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      "value" in value ? [[name, value.value]] : [],
    ),
  );
}

function mapLiteralHeaders(
  headers: Record<string, string>,
): Record<string, { value: string }> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, { value }]),
  );
}
