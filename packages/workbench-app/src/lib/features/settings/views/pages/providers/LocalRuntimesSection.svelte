<script lang="ts">
import type {
  AuthProviderMetadata,
  LocalRuntime,
  LocalRuntimeProbe,
} from "$lib/api";
import {
  deleteLocalRuntime,
  deleteProviderCredential,
  probeLocalRuntime,
  upsertLocalRuntime,
} from "$lib/api";
import { localRuntimeKindLabel } from "@nervekit/contracts/providers";
import { Button } from "@nervekit/ui-kit/components/ui/button";
import ConfirmDialog from "@nervekit/ui-kit/components/composites/confirm-dialog";
import { Switch } from "@nervekit/ui-kit/components/ui/switch";
import {
  SettingsInlineMessage,
  SettingsListItem,
} from "$lib/presentation/settings";
import { providerCatalogState } from "$lib/features/settings/state/provider-catalog-state.svelte";
import { refreshProviderCatalog } from "$lib/features/settings/state/provider-catalog-actions.svelte";
import { loadSettingsPanel } from "$lib/application/settings/settings-actions.svelte";
import SettingsEntityListSection from "../../shared/settings-entity-list-section.svelte";
import LocalRuntimeDialog from "./LocalRuntimeDialog.svelte";

type Props = {
  authProviders?: AuthProviderMetadata[];
};

let { authProviders = [] }: Props = $props();

let dialogOpen = $state(false);
let editing = $state<LocalRuntime | undefined>(undefined);
let pendingDelete = $state<LocalRuntime | undefined>(undefined);
let pendingTokenRemove = $state<LocalRuntime | undefined>(undefined);
let probes = $state<Record<string, LocalRuntimeProbe>>({});
let probing = $state<string | undefined>(undefined);
let busyId = $state<string | undefined>(undefined);

const runtimes = $derived(
  [...providerCatalogState.localRuntimes].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  ),
);
/** Enabled runtimes that ask for a token nobody has stored yet. */
const missingToken = $derived(
  runtimes.filter(
    (runtime) =>
      runtime.enabled && runtime.requiresApiKey && !keyConfigured(runtime.id),
  ),
);

function keyConfigured(id: string): boolean {
  const meta = authProviders.find((provider) => provider.provider === id);
  return Boolean(meta?.configured && meta.credentialType === "api_key");
}

function probeSummary(probe: LocalRuntimeProbe): string {
  if (!probe.reachable) return probe.error ?? "Not reachable.";
  const models = `${probe.modelIds.length} model${probe.modelIds.length === 1 ? "" : "s"}`;
  return probe.latencyMs === undefined
    ? `Reachable · ${models}`
    : `Reachable · ${models} · ${probe.latencyMs} ms`;
}

function openAdd(): void {
  editing = undefined;
  dialogOpen = true;
}

function openEdit(runtime: LocalRuntime): void {
  editing = runtime;
  dialogOpen = true;
}

async function test(runtime: LocalRuntime): Promise<void> {
  probing = runtime.id;
  try {
    probes = { ...probes, [runtime.id]: await probeLocalRuntime(runtime.id) };
  } catch (error) {
    probes = {
      ...probes,
      [runtime.id]: {
        runtimeId: runtime.id,
        reachable: false,
        modelIds: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    probing = undefined;
  }
}

async function setEnabled(
  runtime: LocalRuntime,
  enabled: boolean,
): Promise<void> {
  busyId = runtime.id;
  try {
    await upsertLocalRuntime({ ...runtime, enabled });
    await refreshProviderCatalog();
  } catch {
    // The catalog event refreshes the list, so a failed write leaves the
    // displayed state matching the server.
  } finally {
    busyId = undefined;
  }
}

async function confirmDelete(): Promise<void> {
  const runtime = pendingDelete;
  if (!runtime) return;
  try {
    await deleteLocalRuntime(runtime.id);
    await refreshProviderCatalog();
  } catch {
    // Refresh on the next catalog event keeps the UI consistent.
  } finally {
    pendingDelete = undefined;
  }
}

async function confirmTokenRemove(): Promise<void> {
  const runtime = pendingTokenRemove;
  if (!runtime) return;
  try {
    // The runtime keeps its configuration; only the stored token goes. The
    // settings panel reload is what retires the "No token" hint and any
    // key indicator derived from the auth provider list.
    await deleteProviderCredential(runtime.id);
    await loadSettingsPanel();
  } catch {
    // Errors surface through the global event refresh.
  } finally {
    pendingTokenRemove = undefined;
  }
}
</script>

<SettingsEntityListSection
  sectionId="local-runtimes"
  title="Local runtimes"
  addLabel="Add runtime"
  addTourId="setup-auth-add-local-runtime"
  emptyTitle="No local runtimes"
  emptyDescription="Add a local inference server to make models available. No model runs outside this machine or your own network."
  items={runtimes}
  listAriaLabel="Local runtimes"
  itemKey={(runtime) => runtime.id}
  onAdd={openAdd}
>
  {#snippet row(runtime)}
    {@const probe = probes[runtime.id]}
    <SettingsListItem
      variant="card"
      title={runtime.displayName}
      description={probe ? probeSummary(probe) : undefined}
    >
      {#snippet meta()}
        <span class="truncate">
          <span class="font-mono">{runtime.id}</span>
          · {localRuntimeKindLabel(runtime.kind)} ·
          <span class="font-mono">{runtime.baseUrl}</span>
          {#if runtime.discovery === "none"}
            · no discovery
          {/if}
          {#if runtime.requiresApiKey && !keyConfigured(runtime.id)}
            · <span class="text-warning">No token</span>
          {/if}
        </span>
      {/snippet}
      {#snippet actions()}
        <Button
          variant="ghost"
          size="xs"
          disabled={probing === runtime.id}
          onclick={() => void test(runtime)}
        >
          {probing === runtime.id ? "Testing…" : "Test"}
        </Button>
        <Button variant="ghost" size="xs" onclick={() => openEdit(runtime)}
          >Edit</Button
        >
        {#if keyConfigured(runtime.id)}
          <Button
            variant="ghost"
            size="xs"
            onclick={() => (pendingTokenRemove = runtime)}>Remove token</Button
          >
        {/if}
        <Button
          variant="ghost"
          size="xs"
          onclick={() => (pendingDelete = runtime)}>Delete</Button
        >
        <Switch
          size="settings"
          checked={runtime.enabled}
          disabled={busyId === runtime.id}
          aria-label={`Enable ${runtime.displayName}`}
          onCheckedChange={(checked) => void setEnabled(runtime, checked)}
        />
      {/snippet}
    </SettingsListItem>
  {/snippet}

  {#snippet below()}
    {#if missingToken.length > 0}
      <SettingsInlineMessage
        tone="warning"
        text={`${missingToken.map((runtime) => runtime.displayName).join(", ")} ${missingToken.length === 1 ? "requires a token" : "require tokens"} that is not stored yet, so no model is offered from ${missingToken.length === 1 ? "it" : "them"}.`}
      />
    {/if}
  {/snippet}
</SettingsEntityListSection>

<LocalRuntimeDialog
  bind:open={dialogOpen}
  runtime={editing}
  hasKey={editing ? keyConfigured(editing.id) : false}
/>

<ConfirmDialog
  open={!!pendingDelete}
  title="Delete local runtime?"
  description={pendingDelete
    ? `This removes “${pendingDelete.displayName}”, its stored token, and its models from every model picker. The server itself keeps running.`
    : ""}
  confirmLabel="Delete"
  destructive
  onConfirm={() => void confirmDelete()}
  onOpenChange={(open) => {
    if (!open) pendingDelete = undefined;
  }}
/>

<ConfirmDialog
  open={!!pendingTokenRemove}
  title="Remove stored token?"
  description={pendingTokenRemove
    ? `This removes the token stored for “${pendingTokenRemove.displayName}” from the orchestrator. The runtime itself is kept.`
    : ""}
  confirmLabel="Remove"
  destructive
  onConfirm={() => void confirmTokenRemove()}
  onOpenChange={(open) => {
    if (!open) pendingTokenRemove = undefined;
  }}
/>
