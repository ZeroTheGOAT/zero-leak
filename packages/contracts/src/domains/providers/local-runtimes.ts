import { z } from "zod";
import {
  piApiSchema,
  providerCompatSchema,
  providerIdSchema,
} from "./providers.js";

/**
 * Local inference runtimes ZeroLeak AI is allowed to talk to. Every entry is a
 * server the operator runs themselves — either on the workstation or on an
 * explicitly configured private on-premise host. No public cloud provider is
 * representable here, which is what keeps the product air-gapped by
 * construction rather than by configuration discipline.
 *
 * All five speak an OpenAI-compatible HTTP surface, so they share one pi-ai API
 * implementation (`openai-completions`).
 */
export const localRuntimeKindSchema = z.enum([
  "llama-cpp",
  "ollama",
  "vllm",
  "python",
  "onprem-openai",
]);
export type LocalRuntimeKind = z.infer<typeof localRuntimeKindSchema>;

/** How a runtime enumerates the models it is currently serving. */
export const localModelDiscoverySchema = z.enum([
  "openai-models",
  "ollama-tags",
  "none",
]);
export type LocalModelDiscovery = z.infer<typeof localModelDiscoverySchema>;

/**
 * Whether a host names an address an operator runs themselves: loopback, a
 * private IPv4 range, or IPv6 loopback / unique-local / link-local. DNS names
 * are rejected because a name can resolve anywhere — only a literal address
 * proves the endpoint is not public, which is what keeps ZeroLeak AI
 * air-gapped by construction rather than by configuration discipline.
 */
export function isLocalRuntimeHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  // IPv4-mapped IPv6 addresses carry the verdict of the IPv4 half.
  if (normalized.startsWith("::ffff:")) {
    return isLocalRuntimeHost(normalized.slice("::ffff:".length));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) never route off
  // the local network.
  return /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
}

/** Whether a URL addresses the loopback or a private-network host. */
export function isLocalRuntimeUrl(url: string): boolean {
  try {
    return isLocalRuntimeHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * A configured local runtime endpoint. `enabled` gates registration with the
 * harness model registry, so disabling a runtime removes its models from every
 * model picker without discarding the endpoint configuration.
 */
export const localRuntimeSchema = z.object({
  id: providerIdSchema,
  kind: localRuntimeKindSchema,
  displayName: z.string().min(1),
  baseUrl: z
    .string()
    .url()
    .refine(isLocalRuntimeUrl, {
      message:
        "Local runtime urls must address loopback or a private network; ZeroLeak AI never contacts a public endpoint.",
    }),
  api: piApiSchema.default("openai-completions"),
  discovery: localModelDiscoverySchema.default("openai-models"),
  /**
   * Keyless by default: a loopback llama.cpp or Ollama server authenticates
   * nobody. On-premise gateways commonly do require a token, so the field is
   * configurable rather than fixed per kind.
   */
  requiresApiKey: z.boolean().default(false),
  enabled: z.boolean().default(true),
  headers: z.record(z.string(), z.string()).default({}),
  compat: providerCompatSchema.optional(),
});
export type LocalRuntime = z.infer<typeof localRuntimeSchema>;

/** Result of probing a runtime's discovery endpoint. */
export const localRuntimeProbeSchema = z.object({
  runtimeId: providerIdSchema,
  reachable: z.boolean(),
  /** Round-trip time of the probe request, milliseconds. */
  latencyMs: z.number().int().nonnegative().optional(),
  /** Model ids the runtime reported serving. Empty for `discovery: "none"`. */
  modelIds: z.array(z.string().min(1)).default([]),
  error: z.string().optional(),
});
export type LocalRuntimeProbe = z.infer<typeof localRuntimeProbeSchema>;

/**
 * Seed configuration for a runtime kind. These are the conventional default
 * ports of each server, so a runtime already listening on its documented port
 * is reachable with no configuration at all.
 */
export interface LocalRuntimePreset {
  readonly kind: LocalRuntimeKind;
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly discovery: LocalModelDiscovery;
  readonly description: string;
  readonly requiresApiKey: boolean;
  readonly enabled: boolean;
}

export const localRuntimePresets: readonly LocalRuntimePreset[] = [
  {
    kind: "llama-cpp",
    id: "llama-cpp",
    displayName: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    discovery: "openai-models",
    description:
      "llama-server from llama.cpp, serving GGUF weights on the local host.",
    requiresApiKey: false,
    enabled: true,
  },
  {
    kind: "ollama",
    id: "ollama",
    displayName: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    discovery: "ollama-tags",
    description:
      "Ollama's local daemon. Pulled models are discovered automatically and can be loaded and unloaded from ZeroLeak AI.",
    requiresApiKey: false,
    enabled: true,
  },
  {
    kind: "vllm",
    id: "vllm",
    displayName: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    discovery: "openai-models",
    description:
      "vLLM's OpenAI-compatible server, for batched local or on-premise GPU inference.",
    requiresApiKey: false,
    enabled: true,
  },
  {
    kind: "python",
    id: "local-python",
    displayName: "Local Python runtime",
    baseUrl: "http://127.0.0.1:8081/v1",
    discovery: "openai-models",
    description:
      "An approved local Python inference server exposing an OpenAI-compatible endpoint.",
    requiresApiKey: false,
    enabled: true,
  },
  {
    kind: "onprem-openai",
    id: "onprem-openai",
    displayName: "On-premise OpenAI-compatible endpoint",
    baseUrl: "http://127.0.0.1:9000/v1",
    discovery: "openai-models",
    description:
      "A private OpenAI-compatible gateway inside your own network. Set its address and token before enabling it.",
    requiresApiKey: true,
    enabled: false,
  },
];

export function localRuntimeKindLabel(kind: LocalRuntimeKind): string {
  return (
    localRuntimePresets.find((preset) => preset.kind === kind)?.displayName ??
    kind
  );
}

/**
 * The runtime set a home starts with. Nothing is contacted until a runtime is
 * probed or a model is selected, so seeding all five costs nothing.
 */
export function defaultLocalRuntimes(): LocalRuntime[] {
  return localRuntimePresets.map((preset) => ({
    id: preset.id,
    kind: preset.kind,
    displayName: preset.displayName,
    baseUrl: preset.baseUrl,
    api: "openai-completions" as const,
    discovery: preset.discovery,
    requiresApiKey: preset.requiresApiKey,
    enabled: preset.enabled,
    headers: {},
  }));
}

/**
 * The persisted local runtime set, returned by every local runtime operation so
 * the client always reflects server state after a mutation — the same
 * convention `providerCatalogSchema` uses.
 */
export const localRuntimeCatalogSchema = z.object({
  version: z.literal(1).default(1),
  runtimes: z.array(localRuntimeSchema).default([]),
});
export type LocalRuntimeCatalog = z.infer<typeof localRuntimeCatalogSchema>;

export const defaultLocalRuntimeCatalog: LocalRuntimeCatalog = {
  version: 1,
  runtimes: defaultLocalRuntimes(),
};

export const upsertLocalRuntimeRequestSchema = localRuntimeSchema;
export type UpsertLocalRuntimeRequest = z.infer<
  typeof upsertLocalRuntimeRequestSchema
>;

export const deleteLocalRuntimeRequestSchema = z.object({
  id: providerIdSchema,
});
export type DeleteLocalRuntimeRequest = z.infer<
  typeof deleteLocalRuntimeRequestSchema
>;

export const probeLocalRuntimeRequestSchema = z.object({
  id: providerIdSchema,
});
export type ProbeLocalRuntimeRequest = z.infer<
  typeof probeLocalRuntimeRequestSchema
>;
