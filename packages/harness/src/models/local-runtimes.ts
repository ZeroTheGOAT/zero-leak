import {
  type Api,
  type ApiKeyCredential,
  type AuthContext,
  type AuthResult,
  createModels,
  type CreateModelsOptions,
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
  type LocalModelOverrides,
  type LocalModelRecord,
  type LocalRuntime,
  type LocalRuntimeProbe,
  positiveInteger,
} from "@nervekit/contracts/providers";
import {
  asRecord,
  describeFetchError,
  type FetchLike,
  joinUrl,
  nativeRootUrl,
  requestLocalJson,
} from "./local-runtime-http.js";
import { apiStreams } from "./model-registry.js";

export type { FetchLike };

/**
 * Fallbacks for a discovered local model. A local server's model list carries
 * no pricing and usually no context length, so the values are conservative and
 * overridable per model from the Local models settings section. Cost is zero
 * because local inference has no per-token price.
 */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768;
export const DEFAULT_LOCAL_MAX_TOKENS = 4_096;

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

/** Environment variable that supplies a runtime's token without the UI. */
export function localRuntimeEnvVarName(runtimeId: string): string {
  return `ZEROLEAK_${runtimeId.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

export function localRuntimeDiscoveryUrl(
  runtime: Pick<LocalRuntime, "baseUrl" | "discovery">,
): string | undefined {
  if (runtime.discovery === "openai-models")
    return joinUrl(runtime.baseUrl, "models");
  if (runtime.discovery === "ollama-tags")
    return joinUrl(nativeRootUrl(runtime.baseUrl), "api/tags");
  return undefined;
}

/**
 * Context length as reported by llama.cpp's `/v1/models` (`meta.n_ctx_train`)
 * or by a server that mirrors the field at the top level. Absent elsewhere.
 */
function reportedContextWindow(
  entry: Record<string, unknown>,
): number | undefined {
  const meta = asRecord(entry.meta);
  return (
    positiveInteger(meta?.n_ctx_train) ??
    positiveInteger(entry.n_ctx_train) ??
    positiveInteger(entry.context_length)
  );
}

/**
 * One model a runtime reported, as read from its own listing. Exported because
 * the workbench keeps the last discovery result to distinguish a model that is
 * being served from one that is only configured, and needs the reported context
 * length to resolve a model it has switched off and therefore withheld from the
 * published catalog.
 */
export interface LocalDiscoveredModel {
  readonly id: string;
  readonly contextWindow?: number;
}

function parseOpenAIModels(payload: unknown): LocalDiscoveredModel[] {
  const entries = asRecord(payload)?.data;
  if (!Array.isArray(entries)) return [];
  const discovered: LocalDiscoveredModel[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const contextWindow = reportedContextWindow(record);
    discovered.push(contextWindow ? { id, contextWindow } : { id });
  }
  return discovered;
}

function parseOllamaTags(payload: unknown): LocalDiscoveredModel[] {
  const entries = asRecord(payload)?.models;
  if (!Array.isArray(entries)) return [];
  const discovered: LocalDiscoveredModel[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = record.model ?? record.name;
    if (typeof id !== "string" || id.length === 0) continue;
    discovered.push({ id });
  }
  return discovered;
}

function parseDiscovery(
  discovery: LocalRuntime["discovery"],
  payload: unknown,
): LocalDiscoveredModel[] {
  return discovery === "ollama-tags"
    ? parseOllamaTags(payload)
    : parseOpenAIModels(payload);
}

/** A local model's capabilities once discovery and overrides are reconciled. */
export interface ResolvedLocalModel {
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: Model<Api>["input"];
}

/**
 * Precedence for every capability: the operator's override, then what the
 * runtime reported, then the air-gapped default. An override wins because a
 * local server's model list is frequently wrong about the loaded weights — it
 * reports the training context length, not the `--ctx-size` the process was
 * started with.
 *
 * Exported because the settings page shows the same resolved values it will get
 * at inference time, and one rule stated in one place is the only way those two
 * can be guaranteed to agree.
 */
export function resolveLocalModel(
  discovered: LocalDiscoveredModel,
  overrides?: LocalModelOverrides,
): ResolvedLocalModel {
  return {
    displayName: overrides?.displayName ?? discovered.id,
    contextWindow:
      overrides?.contextWindow ??
      discovered.contextWindow ??
      DEFAULT_LOCAL_CONTEXT_WINDOW,
    maxTokens: overrides?.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS,
    reasoning: overrides?.reasoning ?? false,
    input: [...(overrides?.input ?? ["text"])],
  };
}

function toLocalModel(
  runtime: LocalRuntime,
  discovered: LocalDiscoveredModel,
  overrides?: LocalModelOverrides,
): Model<Api> {
  const resolved = resolveLocalModel(discovered, overrides);
  const model: Model<Api> = {
    id: discovered.id,
    name: resolved.displayName,
    api: runtime.api,
    provider: runtime.id,
    baseUrl: runtime.baseUrl,
    reasoning: resolved.reasoning,
    input: resolved.input,
    cost: { ...ZERO_COST },
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
  };
  if (Object.keys(runtime.headers).length > 0) model.headers = runtime.headers;
  if (runtime.compat) model.compat = runtime.compat as never;
  return model;
}

async function requestDiscovery(
  runtime: LocalRuntime,
  options: {
    apiKey?: string | undefined;
    signal?: AbortSignal | undefined;
    fetchImpl?: FetchLike | undefined;
  },
): Promise<LocalDiscoveredModel[]> {
  const url = localRuntimeDiscoveryUrl(runtime);
  if (!url) return [];
  const payload = await requestLocalJson(url, {
    label: runtime.displayName,
    headers: runtime.headers,
    apiKey: options.apiKey,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  return parseDiscovery(runtime.discovery, payload);
}

/**
 * Contact a runtime and report what it is serving. Used both by the Providers
 * settings page's connection test and by local model discovery, so a passing
 * test and a populated model list always agree.
 */
export async function probeLocalRuntime(
  runtime: LocalRuntime,
  options: {
    apiKey?: string | undefined;
    signal?: AbortSignal | undefined;
    fetchImpl?: FetchLike | undefined;
    now?: () => number;
  } = {},
): Promise<LocalRuntimeProbe> {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  if (runtime.discovery === "none") {
    return {
      runtimeId: runtime.id,
      reachable: false,
      modelIds: [],
      error: "This runtime has model discovery disabled.",
    };
  }
  try {
    const discovered = await requestDiscovery(runtime, options);
    return {
      runtimeId: runtime.id,
      reachable: true,
      latencyMs: Math.max(0, Math.round(clock() - startedAt)),
      modelIds: discovered.map((model) => model.id),
    };
  } catch (error) {
    return {
      runtimeId: runtime.id,
      reachable: false,
      latencyMs: Math.max(0, Math.round(clock() - startedAt)),
      modelIds: [],
      error: describeFetchError(error),
    };
  }
}

/**
 * Auth for a local endpoint. A loopback llama.cpp or Ollama server
 * authenticates nobody, so `resolve()` still returns a result — pi-ai treats a
 * defined result as "configured", which is what makes a keyless runtime usable
 * without the operator entering anything. A runtime marked `requiresApiKey`
 * stays unconfigured until a token is stored or exported.
 */
function localRuntimeAuth(runtime: LocalRuntime): ProviderAuth {
  const envVar = localRuntimeEnvVarName(runtime.id);
  const resolve = async (input: {
    ctx: AuthContext;
    credential?: ApiKeyCredential | undefined;
  }): Promise<AuthResult | undefined> => {
    if (!runtime.requiresApiKey) {
      // A runtime that asks for nobody's token gets nobody's token — not even
      // one left over in the store from before the requirement was switched
      // off. Sending it anyway would leak a stale secret to an endpoint the
      // operator just said does not authenticate.
      return {
        auth: {
          baseUrl: runtime.baseUrl,
          ...(Object.keys(runtime.headers).length > 0
            ? { headers: runtime.headers }
            : {}),
        },
        source: `${runtime.baseUrl} (no credential required)`,
      };
    }
    const stored = input.credential?.key;
    const ambient = stored ? undefined : await input.ctx.env(envVar);
    const key = stored ?? ambient;
    if (!key) return undefined;
    return {
      auth: {
        baseUrl: runtime.baseUrl,
        apiKey: key,
        ...(Object.keys(runtime.headers).length > 0
          ? { headers: runtime.headers }
          : {}),
      },
      source: stored
        ? `${runtime.displayName} token`
        : envVar,
    };
  };
  return {
    apiKey: {
      name: `${runtime.displayName} API key`,
      login: runtime.requiresApiKey
        ? async (interaction) => ({
            type: "api_key" as const,
            key: await interaction.prompt({
              type: "secret",
              message: `Token for ${runtime.displayName} (${runtime.baseUrl})`,
            }),
          })
        : undefined,
      resolve,
    },
  };
}

/**
 * Providers built from a configured local runtime. Membership lets a caller that
 * only holds a pi-ai `Provider` — the auth metadata builder, for one — report the
 * runtime's own `ZEROLEAK_*` variable instead of a generic provider env name.
 */
const localRuntimeProviders = new WeakSet<Provider>();

/** Whether `provider` was built from a configured local runtime. */
export function isLocalRuntimeProvider(provider: Provider): boolean {
  return localRuntimeProviders.has(provider);
}

export interface CreateLocalRuntimeProviderOptions {
  fetchImpl?: FetchLike | undefined;
  /**
   * Per-model configuration for this runtime. Records for other runtimes are
   * ignored, so a caller can hand over the whole catalog.
   */
  models?: readonly LocalModelRecord[] | undefined;
  /**
   * Called with everything a discovery request returned, before disabled models
   * are filtered out. Lets the caller keep an accurate picture of what the
   * runtime serves, which the published catalog can no longer supply once models
   * can be switched off.
   */
  onDiscovered?:
    | ((discovered: readonly LocalDiscoveredModel[]) => void)
    | undefined;
}

/** The records that apply to one runtime, indexed by model id. */
function indexModelRecords(
  runtimeId: string,
  records: readonly LocalModelRecord[] | undefined,
): Map<string, LocalModelRecord> {
  const index = new Map<string, LocalModelRecord>();
  for (const record of records ?? []) {
    if (record.runtimeId === runtimeId) index.set(record.modelId, record);
  }
  return index;
}

/**
 * Build the pi-ai provider for one configured local runtime. Model discovery is
 * dynamic: `createProvider` restores the persisted catalog first and only then
 * contacts the endpoint, so a runtime that is currently switched off still
 * offers its last-known models instead of vanishing from the model picker.
 */
export function createLocalRuntimeProvider(
  runtime: LocalRuntime,
  options: CreateLocalRuntimeProviderOptions = {},
): Provider {
  const records = indexModelRecords(runtime.id, options.models);
  /**
   * Hand-imported models form the provider's static baseline, which is what
   * makes a runtime with `discovery: "none"` offer anything at all. pi-ai merges
   * a refresh over the baseline by model id, so an imported model the runtime
   * later reports keeps whatever the runtime says about it.
   */
  const baseline = [...records.values()]
    .filter((record) => record.imported && record.enabled)
    .map((record) =>
      toLocalModel(runtime, { id: record.modelId }, record.overrides),
    );
  const fetchModels =
    runtime.discovery === "none"
      ? undefined
      : async (context: RefreshModelsContext) => {
          const credential = context.credential;
          const apiKey =
            credential?.type === "api_key" ? credential.key : undefined;
          const discovered = await requestDiscovery(runtime, {
            apiKey,
            signal: context.signal,
            fetchImpl: options.fetchImpl,
          });
          options.onDiscovered?.(discovered);
          return discovered
            .filter((model) => records.get(model.id)?.enabled !== false)
            .map((model) =>
              toLocalModel(runtime, model, records.get(model.id)?.overrides),
            );
        };
  const provider = createProvider({
    id: runtime.id,
    name: runtime.displayName,
    baseUrl: runtime.baseUrl,
    ...(Object.keys(runtime.headers).length > 0
      ? { headers: runtime.headers }
      : {}),
    auth: localRuntimeAuth(runtime),
    models: baseline,
    ...(fetchModels ? { fetchModels } : {}),
    api: apiStreams,
  });
  localRuntimeProviders.add(provider);
  return provider;
}

export interface LocalModelsOptions extends CreateModelsOptions {
  /** Configured runtimes; disabled entries are skipped. */
  runtimes: readonly LocalRuntime[];
  /** Per-model configuration across every runtime. */
  models?: readonly LocalModelRecord[] | undefined;
  /** Notified whenever any runtime reports what it is serving. */
  onDiscovered?:
    | ((runtimeId: string, discovered: readonly LocalDiscoveredModel[]) => void)
    | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * The ZeroLeak AI replacement for pi-ai's `builtinModels()`. Only endpoints the
 * operator runs are installed, so no public cloud provider is reachable,
 * listed, or selectable anywhere in the product.
 */
export function localModels(options: LocalModelsOptions): MutableModels {
  const models = createModels(options);
  for (const runtime of options.runtimes) {
    if (!runtime.enabled) continue;
    models.setProvider(
      createLocalRuntimeProvider(runtime, {
        fetchImpl: options.fetchImpl,
        models: options.models,
        ...(options.onDiscovered
          ? {
              onDiscovered: (discovered) =>
                options.onDiscovered?.(runtime.id, discovered),
            }
          : {}),
      }),
    );
  }
  return models;
}
