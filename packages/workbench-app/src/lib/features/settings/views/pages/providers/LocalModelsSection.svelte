<script lang="ts">
import type {
  LocalModelEntry,
  LocalModelStatus,
  LocalModelTestResult,
  LocalRuntime,
} from "$lib/api";
import {
  getLocalModelStatus,
  loadLocalModel,
  refreshLocalModels,
  removeLocalModel,
  testLocalModel,
  unloadLocalModel,
  updateLocalModel,
} from "$lib/api";
import {
  localModelKey,
  localRuntimeControlsResidency,
} from "@nervekit/contracts/providers";
import { Button } from "@nervekit/ui-kit/components/ui/button";
import ConfirmDialog from "@nervekit/ui-kit/components/composites/confirm-dialog";
import { Switch } from "@nervekit/ui-kit/components/ui/switch";
import {
  SettingsEmptyState,
  SettingsInlineMessage,
  SettingsList,
  SettingsListItem,
  SettingsSection,
} from "$lib/presentation/settings";
import { providerCatalogState } from "$lib/features/settings/state/provider-catalog-state.svelte";
import { applyLocalModelInventory } from "$lib/features/settings/state/provider-catalog-actions.svelte";
import LocalModelDialog from "./LocalModelDialog.svelte";

let dialogOpen = $state(false);
let editing = $state<LocalModelEntry | undefined>(undefined);
let pendingRemove = $state<LocalModelEntry | undefined>(undefined);
/** Last test result and residency reading per model, keyed by runtime + model. */
let tests = $state<Record<string, LocalModelTestResult>>({});
let statuses = $state<Record<string, LocalModelStatus>>({});
let busyKey = $state<string | undefined>(undefined);
let busyLabel = $state<string | undefined>(undefined);
let refreshing = $state<string | undefined>(undefined);
let error = $state<string | undefined>(undefined);

const runtimes = $derived(providerCatalogState.localRuntimes);
/**
 * The inventory as the server ordered it: each runtime's own listing first, then
 * the models it is configured for but no longer serving. Only the runtime label
 * is added here, so a row can name where the model lives.
 */
const models = $derived(
  providerCatalogState.localModels.map((model) => ({
    model,
    runtime: runtimes.find((runtime) => runtime.id === model.runtimeId),
  })),
);
/** Runtimes that can be asked what they serve. */
const discoverable = $derived(
  runtimes.filter((runtime) => runtime.enabled && runtime.discovery !== "none"),
);
const disabledCount = $derived(
  providerCatalogState.localModels.filter((model) => !model.enabled).length,
);

function keyOf(model: LocalModelEntry): string {
  return localModelKey(model.runtimeId, model.modelId);
}

function busy(model: LocalModelEntry, label: string): boolean {
  return busyKey === keyOf(model) && busyLabel === label;
}

function controllable(runtime: LocalRuntime | undefined): boolean {
  return runtime ? localRuntimeControlsResidency(runtime.kind) : false;
}

/** What the row says under the model id: the newest reading, most recent first. */
function summary(model: LocalModelEntry): string | undefined {
  const key = keyOf(model);
  const test = tests[key];
  if (test) {
    if (!test.ok) return `Test failed · ${test.error ?? "No reason reported."}`;
    const latency =
      test.latencyMs === undefined ? "" : ` · ${test.latencyMs} ms`;
    return `Test passed${latency}${test.sample ? ` · “${test.sample}”` : ""}`;
  }
  const status = statuses[key];
  if (status) return residencySummary(status);
  if (!model.discovered) {
    return model.imported
      ? "Entered by hand; the runtime has not reported it."
      : "Configured, but the runtime is no longer serving it.";
  }
  return undefined;
}

function residencySummary(status: LocalModelStatus): string {
  const parts: string[] = [];
  if (status.residency === "loaded") parts.push("Loaded");
  else if (status.residency === "unloaded") parts.push("Not loaded");
  else parts.push("Residency unknown");
  if (status.sizeBytes !== undefined) parts.push(gigabytes(status.sizeBytes));
  if (status.expiresAt) parts.push(`until ${expiryLabel(status.expiresAt)}`);
  if (status.detail) parts.push(status.detail);
  if (status.error) parts.push(status.error);
  return parts.join(" · ");
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB resident`;
}

/**
 * Ollama reports an eviction time; an unparsable value is shown as sent rather
 * than dropped, so a runtime with an unexpected format is still legible.
 */
function expiryLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}

function contextLabel(model: LocalModelEntry): string {
  return `${Math.round(model.contextWindow / 1_024)}k ctx`;
}

async function run(
  model: LocalModelEntry,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  busyKey = keyOf(model);
  busyLabel = label;
  error = undefined;
  try {
    await action();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busyKey = undefined;
    busyLabel = undefined;
  }
}

async function refresh(runtimeId: string): Promise<void> {
  refreshing = runtimeId;
  error = undefined;
  try {
    applyLocalModelInventory(await refreshLocalModels(runtimeId));
    // A refresh replaces what the runtime serves, so stale readings would
    // describe models that may no longer be there.
    tests = {};
    statuses = {};
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    refreshing = undefined;
  }
}

async function test(model: LocalModelEntry): Promise<void> {
  await run(model, "test", async () => {
    const request = { runtimeId: model.runtimeId, modelId: model.modelId };
    tests[keyOf(model)] = await testLocalModel(request);
  });
}

async function readStatus(model: LocalModelEntry): Promise<void> {
  await run(model, "status", async () => {
    const request = { runtimeId: model.runtimeId, modelId: model.modelId };
    statuses[keyOf(model)] = await getLocalModelStatus(request);
    // A residency reading supersedes an older test result in the row summary.
    delete tests[keyOf(model)];
  });
}

async function setResidency(
  model: LocalModelEntry,
  resident: boolean,
): Promise<void> {
  await run(model, resident ? "load" : "unload", async () => {
    const request = { runtimeId: model.runtimeId, modelId: model.modelId };
    statuses[keyOf(model)] = resident
      ? await loadLocalModel(request)
      : await unloadLocalModel(request);
    delete tests[keyOf(model)];
  });
}

async function setEnabled(
  model: LocalModelEntry,
  enabled: boolean,
): Promise<void> {
  await run(model, "enabled", async () => {
    applyLocalModelInventory(
      await updateLocalModel({
        runtimeId: model.runtimeId,
        modelId: model.modelId,
        enabled,
      }),
    );
  });
}

async function confirmRemove(): Promise<void> {
  const model = pendingRemove;
  if (!model) return;
  try {
    applyLocalModelInventory(
      await removeLocalModel({
        runtimeId: model.runtimeId,
        modelId: model.modelId,
      }),
    );
    delete tests[keyOf(model)];
    delete statuses[keyOf(model)];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    pendingRemove = undefined;
  }
}

function openImport(): void {
  editing = undefined;
  dialogOpen = true;
}

function openEdit(model: LocalModelEntry): void {
  editing = model;
  dialogOpen = true;
}
</script>

<SettingsSection id="local-models" title="Local models">
  {#snippet actions()}
    {#each discoverable as runtime (runtime.id)}
      <Button
        variant="ghost"
        size="xs"
        disabled={refreshing === runtime.id}
        onclick={() => void refresh(runtime.id)}
      >
        {refreshing === runtime.id
          ? "Refreshing…"
          : `Refresh ${runtime.displayName}`}
      </Button>
    {/each}
    <Button
      size="xs"
      onclick={openImport}
      disabled={runtimes.length === 0}
      data-tour-id="setup-auth-import-local-model">Import model</Button
    >
  {/snippet}

  {#if models.length === 0}
    <SettingsEmptyState
      variant="card"
      title="No local models"
      description={runtimes.length === 0
        ? "Add a local runtime first, then its models appear here."
        : "Refresh a runtime to list what it is serving, or import a model by name for a runtime that cannot be asked."}
    />
  {:else}
    <SettingsList ariaLabel="Local models" divided={false} gap="sm">
      {#each models as { model, runtime } (keyOf(model))}
        <SettingsListItem
          variant="card"
          title={model.displayName}
          description={summary(model)}
        >
          {#snippet meta()}
            <span class="truncate">
              <span class="font-mono">{model.modelId}</span>
              · {runtime?.displayName ?? model.runtimeId}
              · {contextLabel(model)}
              {#if model.reasoning}
                · reasoning
              {/if}
              {#if model.imported}
                · imported
              {:else if !model.discovered}
                · <span class="text-warning">not served</span>
              {/if}
              {#if model.configured}
                · configured
              {/if}
            </span>
          {/snippet}
          {#snippet actions()}
            <Button
              variant="ghost"
              size="xs"
              disabled={busy(model, "test")}
              onclick={() => void test(model)}
            >
              {busy(model, "test") ? "Testing…" : "Test"}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy(model, "status")}
              onclick={() => void readStatus(model)}
            >
              {busy(model, "status") ? "Checking…" : "Status"}
            </Button>
            {#if controllable(runtime)}
              <Button
                variant="ghost"
                size="xs"
                disabled={busy(model, "load")}
                onclick={() => void setResidency(model, true)}
              >
                {busy(model, "load") ? "Loading…" : "Load"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy(model, "unload")}
                onclick={() => void setResidency(model, false)}
              >
                {busy(model, "unload") ? "Unloading…" : "Unload"}
              </Button>
            {/if}
            <Button variant="ghost" size="xs" onclick={() => openEdit(model)}
              >Edit</Button
            >
            {#if model.imported || model.configured || !model.enabled}
              <Button
                variant="ghost"
                size="xs"
                onclick={() => (pendingRemove = model)}
                >{model.imported ? "Remove" : "Reset"}</Button
              >
            {/if}
            <Switch
              size="settings"
              checked={model.enabled}
              disabled={busy(model, "enabled")}
              aria-label={`Enable ${model.displayName}`}
              onCheckedChange={(checked) => void setEnabled(model, checked)}
            />
          {/snippet}
        </SettingsListItem>
      {/each}
    </SettingsList>
  {/if}

  {#if error}
    <SettingsInlineMessage tone="warning" text={error} />
  {/if}
  {#if disabledCount > 0}
    <SettingsInlineMessage
      tone="info"
      text={`${disabledCount} model${disabledCount === 1 ? " is" : "s are"} switched off and offered nowhere in the composer. Their configuration is kept.`}
    />
  {/if}
</SettingsSection>

<LocalModelDialog bind:open={dialogOpen} model={editing} />

<ConfirmDialog
  open={!!pendingRemove}
  title={pendingRemove?.imported ? "Remove model?" : "Reset model?"}
  description={pendingRemove
    ? pendingRemove.imported
      ? `This removes “${pendingRemove.displayName}” from every model picker. The weights on disk are untouched.`
      : `This discards the stored configuration for “${pendingRemove.displayName}”. The runtime keeps serving it with its own values.`
    : ""}
  confirmLabel={pendingRemove?.imported ? "Remove" : "Reset"}
  destructive={pendingRemove?.imported ?? false}
  onConfirm={() => void confirmRemove()}
  onOpenChange={(open) => {
    if (!open) pendingRemove = undefined;
  }}
/>
