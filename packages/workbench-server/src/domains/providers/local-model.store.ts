import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import {
  loadLocalModel,
  type LocalDiscoveredModel,
  localModelStatus,
  resolveLocalModel,
  testLocalModel,
  unloadLocalModel,
} from "@nervekit/harness/models";
import {
  type ImportLocalModelRequest,
  type LocalModelEntry,
  type LocalModelInventory,
  type LocalModelRecord,
  localModelRecordSchema,
  type LocalModelSelectorRequest,
  type LocalModelStatus,
  type LocalModelTestResult,
  type LocalRuntime,
  type RemoveLocalModelRequest,
  type UpdateLocalModelRequest,
} from "@nervekit/contracts/providers";
import { ApplicationError } from "../../core/application-error.js";
import { writeHomeConfiguration } from "../../infrastructure/configuration/index.js";
import type { InitializedStorage } from "../../infrastructure/storage-bootstrap/index.js";
import type { LocalRuntimeStore } from "./local-runtime.store.js";

export interface LocalModelStoreOptions {
  /** Supplies the stored token when a runtime is marked `requiresApiKey`. */
  credentials?: CredentialStore;
}

/**
 * The operator's per-model configuration for the local runtimes, persisted in
 * `config/providers.json` under `localModels`, plus the residency and test
 * operations the Providers settings page drives.
 *
 * Two sources have to be reconciled to answer "what models are there". The
 * runtime reports what it is serving, and the operator's records carry the
 * overrides, the off switches, and the models that were declared by hand on a
 * runtime that cannot be asked. This store keeps the last discovery result for
 * each runtime rather than reading it back out of the published pi-ai catalog,
 * because a model the operator switched off is deliberately absent from that
 * catalog and would otherwise look like a model the runtime had dropped.
 */
export class LocalModelStore {
  #records: LocalModelRecord[];
  /** The last discovery result per runtime, in the order the runtime listed it. */
  #discovered = new Map<string, readonly LocalDiscoveredModel[]>();
  /** Runtimes asked at least once in this process, successfully or not. */
  #asked = new Set<string>();
  #models: MutableModels | undefined;

  constructor(
    private readonly storage: InitializedStorage,
    private readonly runtimes: LocalRuntimeStore,
    private readonly options: LocalModelStoreOptions = {},
  ) {
    this.#records = readLocalModels(storage.configuration.providers);
  }

  /** Every stored record, in the form the provider layer consumes. */
  records(): readonly LocalModelRecord[] {
    return this.#records;
  }

  /**
   * Records what a runtime reported. Called by the provider layer on every
   * discovery request, including the ones pi-ai schedules on its own, so the
   * inventory reflects the newest answer without this store having to ask again.
   */
  noteDiscovered(
    runtimeId: string,
    discovered: readonly LocalDiscoveredModel[],
  ): void {
    this.#discovered.set(runtimeId, [...discovered]);
    this.#asked.add(runtimeId);
  }

  /**
   * Binds the shared `Models` instance. Separate from the constructor because
   * the instance is built from this store's own records.
   */
  attach(models: MutableModels): void {
    this.#models = models;
  }

  /**
   * The reconciled inventory. Any enabled runtime that has not been asked in
   * this process is asked first, so the `discovered` flag is always the result
   * of a real request rather than an assumption carried over from a cache.
   */
  async inventory(): Promise<LocalModelInventory> {
    const pending = this.runtimes
      .runtimes()
      .filter(
        (runtime) =>
          runtime.enabled &&
          runtime.discovery !== "none" &&
          !this.#asked.has(runtime.id),
      )
      .map((runtime) => runtime.id);
    if (pending.length > 0) await this.#refresh(pending);
    return this.#build();
  }

  /** Ask one runtime again what it is serving. */
  async refresh(runtimeId: string): Promise<LocalModelInventory> {
    this.#requireRuntime(runtimeId);
    await this.#refresh([runtimeId]);
    return this.#build();
  }

  /**
   * Declare a model by hand. This is what makes a runtime with discovery
   * switched off usable at all, and it is not verified against the runtime:
   * such a runtime cannot be asked, so the operator confirms the model with the
   * connection test instead. Omitted overrides keep whatever the model already
   * had — the same rule `update` applies.
   */
  async import(request: ImportLocalModelRequest): Promise<LocalModelInventory> {
    this.#requireRuntime(request.runtimeId);
    const existing = this.#find(request.runtimeId, request.modelId);
    return this.#write([
      ...this.#without(request.runtimeId, request.modelId),
      {
        runtimeId: request.runtimeId,
        modelId: request.modelId,
        imported: true,
        enabled: existing?.enabled ?? true,
        overrides: request.overrides ?? existing?.overrides ?? {},
      },
    ], request.runtimeId);
  }

  /**
   * Configure a model. A discovered model has no record until it is first
   * configured, so one is created here; an absent field in the request leaves
   * the stored value alone.
   */
  async update(request: UpdateLocalModelRequest): Promise<LocalModelInventory> {
    this.#requireRuntime(request.runtimeId);
    const existing = this.#find(request.runtimeId, request.modelId);
    return this.#write([
      ...this.#without(request.runtimeId, request.modelId),
      {
        runtimeId: request.runtimeId,
        modelId: request.modelId,
        imported: existing?.imported ?? false,
        enabled: request.enabled ?? existing?.enabled ?? true,
        overrides: request.overrides ?? existing?.overrides ?? {},
      },
    ], request.runtimeId);
  }

  /**
   * Forget a model's configuration. An imported model disappears from the model
   * pickers with it; a discovered model stays, with the runtime's own answers
   * back in force.
   */
  async remove(request: RemoveLocalModelRequest): Promise<LocalModelInventory> {
    this.#requireRuntime(request.runtimeId);
    return this.#write(
      this.#without(request.runtimeId, request.modelId),
      request.runtimeId,
    );
  }

  /**
   * Drop every record for a runtime that no longer exists. Called when a runtime
   * is deleted, so its model configuration does not outlive it in
   * `providers.json`.
   */
  async forgetRuntime(runtimeId: string): Promise<void> {
    this.#discovered.delete(runtimeId);
    this.#asked.delete(runtimeId);
    if (!this.#records.some((record) => record.runtimeId === runtimeId)) return;
    await this.#write(
      this.#records.filter((record) => record.runtimeId !== runtimeId),
      runtimeId,
    );
  }

  async status(request: LocalModelSelectorRequest): Promise<LocalModelStatus> {
    const { runtime, apiKey } = await this.#resolve(request.runtimeId);
    return localModelStatus(runtime, request.modelId, { apiKey });
  }

  async load(request: LocalModelSelectorRequest): Promise<LocalModelStatus> {
    const { runtime, apiKey } = await this.#resolve(request.runtimeId);
    return loadLocalModel(runtime, request.modelId, { apiKey });
  }

  async unload(request: LocalModelSelectorRequest): Promise<LocalModelStatus> {
    const { runtime, apiKey } = await this.#resolve(request.runtimeId);
    return unloadLocalModel(runtime, request.modelId, { apiKey });
  }

  async test(
    request: LocalModelSelectorRequest,
  ): Promise<LocalModelTestResult> {
    const { runtime, apiKey } = await this.#resolve(request.runtimeId);
    return testLocalModel(runtime, request.modelId, { apiKey });
  }

  #find(runtimeId: string, modelId: string): LocalModelRecord | undefined {
    return this.#records.find(
      (record) => record.runtimeId === runtimeId && record.modelId === modelId,
    );
  }

  #without(runtimeId: string, modelId: string): LocalModelRecord[] {
    return this.#records.filter(
      (record) => record.runtimeId !== runtimeId || record.modelId !== modelId,
    );
  }

  #requireRuntime(runtimeId: string): LocalRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new ApplicationError(
        404,
        "LOCAL_RUNTIME_NOT_CONFIGURED",
        `No local runtime is configured with the id "${runtimeId}".`,
      );
    }
    return runtime;
  }

  async #resolve(
    runtimeId: string,
  ): Promise<{ runtime: LocalRuntime; apiKey: string | undefined }> {
    const runtime = this.#requireRuntime(runtimeId);
    const credential = await this.options.credentials?.read(runtime.id);
    return {
      runtime,
      apiKey: credential?.type === "api_key" ? credential.key : undefined,
    };
  }

  /**
   * Ask the named runtimes what they are serving, through the shared model
   * collection so the model pickers see the same answer. A runtime that fails
   * loses its remembered listing rather than keeping a stale one: an endpoint
   * that is switched off is not serving anything.
   */
  async #refresh(runtimeIds: readonly string[]): Promise<void> {
    for (const id of runtimeIds) this.#asked.add(id);
    const models = this.#models;
    if (!models) return;
    // Discovery is best effort: `refresh` reports failures in its result rather
    // than rejecting, and a runtime that is currently down must not fail the
    // request that listed it.
    const result = await models.refresh({
      providers: [...runtimeIds],
      force: true,
    });
    for (const id of runtimeIds) {
      if (result.errors.has(id)) this.#discovered.delete(id);
    }
  }

  async #write(
    next: LocalModelRecord[],
    runtimeId: string,
  ): Promise<LocalModelInventory> {
    const validated = next.map((record) =>
      localModelRecordSchema.parse(record),
    );
    this.storage.configuration = await writeHomeConfiguration(
      this.storage.paths,
      {
        ...this.storage.configuration,
        providers: {
          ...this.storage.configuration.providers,
          localModels: validated,
        },
      },
    );
    this.#records = validated;
    // The provider for each runtime carries the baseline and the overrides, so
    // rebuilding them is what makes a configuration change reach the pickers.
    // Only the runtime whose records changed is re-asked: the others are
    // rebuilt from the same configuration they already had.
    this.runtimes.resync([runtimeId]);
    return this.#build();
  }

  /**
   * Every model of every configured runtime: what the runtime last reported,
   * in the order it reported it, followed by the configured models it is not
   * serving — an imported model, or one that has gone away.
   */
  #build(): LocalModelInventory {
    const models: LocalModelEntry[] = [];
    for (const runtime of this.runtimes.runtimes()) {
      const records = new Map(
        this.#records
          .filter((record) => record.runtimeId === runtime.id)
          .map((record) => [record.modelId, record] as const),
      );
      const discovered = this.#discovered.get(runtime.id) ?? [];
      for (const model of discovered) {
        models.push(toEntry(runtime.id, model, records.get(model.id), true));
      }
      const served = new Set(discovered.map((model) => model.id));
      const unserved = [...records.values()]
        .filter((record) => !served.has(record.modelId))
        .sort((left, right) => left.modelId.localeCompare(right.modelId));
      for (const record of unserved) {
        models.push(toEntry(runtime.id, { id: record.modelId }, record, false));
      }
    }
    return { version: 1, models };
  }
}

function toEntry(
  runtimeId: string,
  discovered: LocalDiscoveredModel,
  record: LocalModelRecord | undefined,
  served: boolean,
): LocalModelEntry {
  const overrides = record?.overrides ?? {};
  const resolved = resolveLocalModel(discovered, overrides);
  return {
    runtimeId,
    modelId: discovered.id,
    displayName: resolved.displayName,
    discovered: served,
    imported: record?.imported ?? false,
    enabled: record?.enabled ?? true,
    configured: Object.keys(overrides).length > 0,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    reasoning: resolved.reasoning,
    input: [...resolved.input],
    overrides,
  };
}

/**
 * Absent and empty mean the same thing here, unlike the runtime list: a model
 * needs no configuration to be usable, so there is nothing to seed.
 */
function readLocalModels(
  config: InitializedStorage["configuration"]["providers"],
): LocalModelRecord[] {
  return (config.localModels ?? []).map((record) =>
    localModelRecordSchema.parse(record),
  );
}
