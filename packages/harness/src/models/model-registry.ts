import {
  type Api,
  createModels,
  createProvider,
  envApiKeyAuth,
  type FauxProviderHandle,
  fauxProvider,
  type Model,
  type Provider,
  type ProviderStreams,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";

/**
 * The registry starts empty. Upstream seeded it from pi-ai's `builtinModels()`,
 * which installs the complete public cloud catalogue; ZeroLeak AI is
 * air-gapped, so that catalogue is never imported and no provider exists until
 * the application registers one it owns. `builtinProviderIds` therefore means
 * "provider registered with the harness" rather than "provider pi-ai ships".
 */
const models = createModels();
const builtinProviderIds = new Set<string>();
const customProviderModels = new Map<string, Map<string, Model<Api>>>();

/**
 * pi-ai API implementations the harness can stream through. Exported so that
 * application-owned providers (custom endpoints, local runtimes) are built
 * against exactly the same dispatch table as registry-owned ones.
 */
export const apiStreams: Partial<Record<Api, ProviderStreams>> = {
  "anthropic-messages": anthropicMessagesApi(),
  "azure-openai-responses": azureOpenAIResponsesApi(),
  "bedrock-converse-stream": bedrockConverseStreamApi(),
  "google-generative-ai": googleGenerativeAIApi(),
  "google-vertex": googleVertexApi(),
  "mistral-conversations": mistralConversationsApi(),
  "openai-codex-responses": openAICodexResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "pi-messages": piMessagesApi(),
};

export type ManagedFauxProviderHandle = FauxProviderHandle & {
  unregister: () => void;
};

let nerveFaux: ManagedFauxProviderHandle | undefined;

export function registerManagedFauxProvider(
  options: RegisterFauxProviderOptions = {},
): ManagedFauxProviderHandle {
  const provider = fauxProvider(options);
  models.setProvider(provider.provider);
  return {
    ...provider,
    unregister: () => {
      models.deleteProvider(provider.provider.id);
    },
  };
}

export function getNerveFauxProvider(): ManagedFauxProviderHandle {
  if (!nerveFaux) {
    nerveFaux = registerManagedFauxProvider({
      provider: "nerve-faux",
      models: [{ id: "faux-fast", name: "ZeroLeak AI Faux Fast" }],
      tokensPerSecond: 80,
      tokenSize: { min: 10, max: 22 },
    });
  }
  return nerveFaux;
}

export function isBuiltinProvider(provider: string): boolean {
  return builtinProviderIds.has(provider);
}

export function getBuiltinProviderIds(): string[] {
  return Array.from(builtinProviderIds);
}

/**
 * Installs an application-owned provider object into the harness runtime.
 * Dynamic provider model state is shared, while request credentials remain
 * resolved by the application and passed explicitly to streams.
 */
export function registerManagedProvider(provider: Provider): void {
  models.setProvider(provider);
  builtinProviderIds.add(provider.id);
}

/**
 * Removes a provider the application previously registered, so that disabling a
 * local runtime takes its models out of the picker without a restart.
 */
export function unregisterManagedProvider(providerId: string): void {
  models.deleteProvider(providerId);
  builtinProviderIds.delete(providerId);
}

export function getRegisteredModel(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  return models.getModel(provider, modelId);
}

export function getRegisteredModels(provider: string): readonly Model<Api>[] {
  return models.getModels(provider);
}

function registerCustomProvider(providerId: string): void {
  const byModelId = customProviderModels.get(providerId);
  if (!byModelId) return;
  const providerModels = Array.from(byModelId.values());
  models.setProvider(
    createProvider({
      id: providerId,
      name: providerId,
      auth: { apiKey: envApiKeyAuth(`${providerId} API key`, []) },
      models: providerModels,
      api: apiStreams,
    }),
  );
}

export function ensureProviderForModel(model: Model<Api>): void {
  if (isBuiltinProvider(model.provider) || model.provider === "nerve-faux") {
    return;
  }
  if (models.getModel(model.provider, model.id)) {
    return;
  }
  if (!apiStreams[model.api]) {
    throw new Error(`Unsupported pi-ai API for custom provider: ${model.api}`);
  }
  let byModelId = customProviderModels.get(model.provider);
  if (!byModelId) {
    byModelId = new Map();
    customProviderModels.set(model.provider, byModelId);
  }
  const existing = byModelId.get(model.id);
  if (existing === model) return;
  byModelId.set(model.id, model);
  registerCustomProvider(model.provider);
}

export function getModelRegistry() {
  return models;
}
