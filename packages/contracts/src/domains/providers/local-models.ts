import { z } from "zod";
import { modelInputSchema } from "../models/models.js";
import type { LocalRuntimeKind } from "./local-runtimes.js";
import { providerIdSchema } from "./providers.js";

/**
 * A number a runtime or settings field offered as a whole count, when it is
 * one at all. `minimum` picks the semantics each caller's contract already
 * documents: overrides and reported context lengths are positive — zero means
 * nothing — while a residency size of zero bytes is still an answer.
 *
 * `unknown` values (raw JSON a runtime reported) are accepted and treated as
 * not-a-number unless they are an integer.
 */
export function positiveInteger(
  value: unknown,
  minimum: 0 | 1 = 1,
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

/**
 * Per-model configuration the operator applies on top of what a local runtime
 * reports. A local server usually advertises nothing but a model id, so every
 * capability a picker needs — the real context length of the loaded weights,
 * how many tokens the server will emit, whether the build exposes reasoning
 * tokens, whether it accepts images — has to be configurable by hand.
 *
 * Every field is optional. An absent field keeps the discovered value, or the
 * air-gapped default when the runtime reported none.
 */
export const localModelOverridesSchema = z.object({
  /** Label shown in model pickers instead of the raw model id. */
  displayName: z.string().trim().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(modelInputSchema).min(1).optional(),
});
export type LocalModelOverrides = z.infer<typeof localModelOverridesSchema>;

/**
 * One model the operator has configured on a local runtime.
 *
 * A record exists for two independent reasons and the same shape covers both:
 * to carry overrides or an off switch for a model the runtime discovers, and to
 * declare a model on a runtime that cannot be asked what it serves
 * (`discovery: "none"`). `imported` distinguishes them, because a record for a
 * discovered model must never add that model to the catalog by itself — a
 * runtime that stops serving a model should stop offering it.
 */
export const localModelRecordSchema = z.object({
  runtimeId: providerIdSchema,
  modelId: z.string().trim().min(1),
  /** True when the operator typed the id in rather than the runtime reporting it. */
  imported: z.boolean().default(false),
  /** False removes the model from every model picker without discarding its configuration. */
  enabled: z.boolean().default(true),
  overrides: localModelOverridesSchema.default({}),
});
export type LocalModelRecord = z.infer<typeof localModelRecordSchema>;

export const localModelCatalogSchema = z.object({
  version: z.literal(1).default(1),
  models: z.array(localModelRecordSchema).default([]),
});
export type LocalModelCatalog = z.infer<typeof localModelCatalogSchema>;

/**
 * A stable key for one model on one runtime. Two runtimes commonly serve the
 * same model id — the same GGUF behind llama.cpp and behind Ollama — so nothing
 * may be keyed by model id alone.
 */
export function localModelKey(runtimeId: string, modelId: string): string {
  return `${runtimeId}::${modelId}`;
}

/**
 * One row of the local model inventory: the effective configuration of a model,
 * with the runtime's discovery and the operator's overrides already reconciled.
 * This is what the Providers settings page renders, so it deliberately reports
 * resolved values rather than making the client repeat the merge.
 */
export const localModelEntrySchema = z.object({
  runtimeId: providerIdSchema,
  modelId: z.string().min(1),
  /** Resolved label: the override if set, otherwise the model id. */
  displayName: z.string().min(1),
  /** Whether the runtime reported this model the last time it was asked. */
  discovered: z.boolean(),
  /** Whether the operator declared this model by hand. */
  imported: z.boolean(),
  enabled: z.boolean(),
  /** Whether the operator has stored any override for this model. */
  configured: z.boolean(),
  contextWindow: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  reasoning: z.boolean(),
  input: z.array(modelInputSchema),
  overrides: localModelOverridesSchema,
});
export type LocalModelEntry = z.infer<typeof localModelEntrySchema>;

export const localModelInventorySchema = z.object({
  version: z.literal(1).default(1),
  models: z.array(localModelEntrySchema).default([]),
});
export type LocalModelInventory = z.infer<typeof localModelInventorySchema>;

/**
 * Whether a model's weights are resident in the runtime right now.
 *
 * `unknown` is a real answer, not a placeholder: a runtime that neither reports
 * residency nor serves the model leaves the question genuinely unanswered, and
 * saying so is more honest than guessing `unloaded`.
 */
export const localModelResidencySchema = z.enum([
  "loaded",
  "unloaded",
  "unknown",
]);
export type LocalModelResidency = z.infer<typeof localModelResidencySchema>;

export const localModelStatusSchema = z.object({
  runtimeId: providerIdSchema,
  modelId: z.string().min(1),
  residency: localModelResidencySchema,
  /**
   * Whether this runtime can be told to load and unload weights. False for a
   * server that loads its model at process start, where residency is a fact to
   * report rather than a setting to change.
   */
  controllable: z.boolean().default(false),
  /** Resident size in bytes, when the runtime reports it. */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** When the runtime intends to evict the weights, ISO-8601. */
  expiresAt: z.string().optional(),
  /** Why the answer is what it is; always set when residency is `unknown`. */
  detail: z.string().optional(),
  error: z.string().optional(),
});
export type LocalModelStatus = z.infer<typeof localModelStatusSchema>;

/**
 * Result of asking a model to complete a fixed one-line prompt. This is the
 * only check that exercises the whole path — endpoint, credential, headers,
 * api dialect, and the weights themselves — so a runtime probe that passes and
 * a model test that fails is a meaningful distinction rather than a
 * contradiction.
 */
export const localModelTestResultSchema = z.object({
  runtimeId: providerIdSchema,
  modelId: z.string().min(1),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  /** The beginning of what the model produced, so a pass is visibly a completion. */
  sample: z.string().optional(),
  error: z.string().optional(),
});
export type LocalModelTestResult = z.infer<typeof localModelTestResultSchema>;

/**
 * Runtime kinds that can load and unload weights on request.
 *
 * Ollama keeps a model pool and takes a `keep_alive` per request, so residency
 * is controllable. llama.cpp, vLLM, and a Python runtime load their weights
 * when the process starts: residency is reportable but not settable, and the
 * settings page hides the load controls rather than offering a button that
 * cannot work.
 */
export function localRuntimeControlsResidency(kind: LocalRuntimeKind): boolean {
  return kind === "ollama";
}

const modelSelectorSchema = z.object({
  runtimeId: providerIdSchema,
  modelId: z.string().trim().min(1),
});

export const importLocalModelRequestSchema = modelSelectorSchema.extend({
  /**
   * Optional for the same reason `update`'s is: an absent field leaves the
   * stored value alone, so re-importing a model that is already configured
   * does not wipe its overrides.
   */
  overrides: localModelOverridesSchema.optional(),
});
export type ImportLocalModelRequest = z.infer<
  typeof importLocalModelRequestSchema
>;

/**
 * Configuring a model. `enabled` and `overrides` are both optional so a toggle
 * does not have to resend the overrides and an override edit does not have to
 * resend the toggle; an absent field leaves the stored value alone.
 */
export const updateLocalModelRequestSchema = modelSelectorSchema.extend({
  enabled: z.boolean().optional(),
  overrides: localModelOverridesSchema.optional(),
});
export type UpdateLocalModelRequest = z.infer<
  typeof updateLocalModelRequestSchema
>;

export const removeLocalModelRequestSchema = modelSelectorSchema;
export type RemoveLocalModelRequest = z.infer<
  typeof removeLocalModelRequestSchema
>;

export const localModelSelectorRequestSchema = modelSelectorSchema;
export type LocalModelSelectorRequest = z.infer<
  typeof localModelSelectorRequestSchema
>;

export const refreshLocalModelsRequestSchema = z.object({
  runtimeId: providerIdSchema,
});
export type RefreshLocalModelsRequest = z.infer<
  typeof refreshLocalModelsRequestSchema
>;
