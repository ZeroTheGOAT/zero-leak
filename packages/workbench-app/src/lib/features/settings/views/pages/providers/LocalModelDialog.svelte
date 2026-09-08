<script lang="ts">
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import { positiveInteger } from "@nervekit/contracts/providers";
import type {
  LocalModelEntry,
  LocalModelOverrides,
  LocalRuntime,
} from "$lib/api";
import { importLocalModel, updateLocalModel } from "$lib/api";
import { Button } from "@nervekit/ui-kit/components/ui/button";
import Dialog from "@nervekit/ui-kit/components/composites/dialog-shell";
import { Input } from "@nervekit/ui-kit/components/ui/input";
import { Label } from "@nervekit/ui-kit/components/ui/label";
import SelectField, {
  type SelectItem,
} from "@nervekit/ui-kit/components/composites/select-field";
import { Switch } from "@nervekit/ui-kit/components/ui/switch";
import { providerCatalogState } from "$lib/features/settings/state/provider-catalog-state.svelte";
import { applyLocalModelInventory } from "$lib/features/settings/state/provider-catalog-actions.svelte";

type Props = {
  open?: boolean;
  /** Set when configuring an existing model; absent when importing a new one. */
  model?: LocalModelEntry;
};

let { open = $bindable(false), model }: Props = $props();

const editing = $derived(Boolean(model));

const runtimeItems = $derived<SelectItem[]>(
  providerCatalogState.localRuntimes.map((runtime) => ({
    value: runtime.id,
    label: runtime.displayName,
    detail:
      runtime.discovery === "none"
        ? `${runtime.baseUrl} · models entered by hand`
        : runtime.baseUrl,
  })),
);

let runtimeId = $state("");
let modelId = $state("");
let displayName = $state("");
let contextWindow = $state("");
let maxTokens = $state("");
let reasoning = $state(false);
let images = $state(false);
let busy = $state(false);
let error = $state<string | undefined>(undefined);

// Reset whenever the dialog opens, for this model or for a new import.
$effect(() => {
  if (!open) return;
  const overrides = model?.overrides ?? {};
  runtimeId =
    model?.runtimeId ?? providerCatalogState.localRuntimes[0]?.id ?? "";
  modelId = model?.modelId ?? "";
  displayName = overrides.displayName ?? "";
  // Only a stored override is shown, so an empty field always means "use what
  // the runtime reports" rather than "pin the value it happens to report now".
  contextWindow = overrides.contextWindow
    ? String(overrides.contextWindow)
    : "";
  maxTokens = overrides.maxTokens ? String(overrides.maxTokens) : "";
  reasoning = overrides.reasoning ?? false;
  images = (overrides.input ?? ["text"]).includes("image");
  error = undefined;
});

const runtime = $derived<LocalRuntime | undefined>(
  providerCatalogState.localRuntimes.find((item) => item.id === runtimeId),
);
const modelIdTaken = $derived(
  !editing &&
    providerCatalogState.localModels.some(
      (item) => item.runtimeId === runtimeId && item.modelId === modelId.trim(),
    ),
);
const canSubmit = $derived(
  runtimeId.length > 0 && modelId.trim().length > 0 && !modelIdTaken && !busy,
);

function collectOverrides(): LocalModelOverrides {
  const overrides: LocalModelOverrides = {};
  const name = displayName.trim();
  if (name) overrides.displayName = name;
  const context = positiveInteger(contextWindow);
  if (context) overrides.contextWindow = context;
  const tokens = positiveInteger(maxTokens);
  if (tokens) overrides.maxTokens = tokens;
  if (reasoning) overrides.reasoning = true;
  // Text alone is the default, so it is not stored as an override.
  if (images) overrides.input = ["text", "image"];
  return overrides;
}

async function submit(): Promise<void> {
  if (!canSubmit) return;
  busy = true;
  error = undefined;
  try {
    const request = {
      runtimeId,
      modelId: modelId.trim(),
      overrides: collectOverrides(),
    };
    applyLocalModelInventory(
      editing
        ? await updateLocalModel(request)
        : await importLocalModel(request),
    );
    open = false;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
}
</script>

<Dialog
  bind:open
  title={editing ? `Configure ${model?.displayName}` : "Import local model"}
  description={editing
    ? "An empty field falls back to what the runtime reports, or to the local default."
    : "Name a model the runtime serves. A runtime with discovery switched off offers only the models entered here."}
  size="sm"
>
  <div class="grid gap-3">
    <div class="grid gap-1.5">
      <Label>Runtime</Label>
      <SelectField
        items={runtimeItems}
        value={runtimeId}
        onValueChange={(value) => (runtimeId = value)}
        disabled={busy || editing}
        ariaLabel="Runtime"
      />
    </div>

    <div class="grid gap-1.5">
      <Label for="local-model-id">Model id</Label>
      <Input
        size="xs"
        id="local-model-id"
        bind:value={modelId}
        placeholder={runtime?.discovery === "ollama-tags"
          ? "llama3.2:3b"
          : "qwen3-8b-q4_k_m"}
        disabled={busy || editing}
        aria-invalid={modelIdTaken}
      />
      {#if modelIdTaken}
        <p class="flex items-center gap-1.5 text-xs text-destructive">
          This runtime already offers that model.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">
          Exactly as the runtime names it; this is the id sent with every
          request.
        </p>
      {/if}
    </div>

    <div class="grid gap-1.5">
      <Label for="local-model-display-name">Display name (optional)</Label>
      <Input
        size="xs"
        id="local-model-display-name"
        bind:value={displayName}
        placeholder={modelId.trim() || "Shown in model pickers"}
        disabled={busy}
      />
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label for="local-model-context">Context window (optional)</Label>
        <Input
          size="xs"
          id="local-model-context"
          inputmode="numeric"
          bind:value={contextWindow}
          placeholder={model?.discovered
            ? String(model.contextWindow)
            : "32768"}
          disabled={busy}
        />
        <p class="text-xs text-muted-foreground">
          Match the server's <code class="font-mono">--ctx-size</code>, not the
          model's training length.
        </p>
      </div>
      <div class="grid gap-1.5">
        <Label for="local-model-max-tokens">Max output tokens (optional)</Label>
        <Input
          size="xs"
          id="local-model-max-tokens"
          inputmode="numeric"
          bind:value={maxTokens}
          placeholder="4096"
          disabled={busy}
        />
      </div>
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="grid gap-1">
        <Label for="local-model-reasoning">Reasoning model</Label>
        <p class="text-xs text-muted-foreground">
          Turn on for a model that emits thinking blocks, so they are rendered
          rather than shown as output.
        </p>
      </div>
      <Switch
        id="local-model-reasoning"
        size="settings"
        checked={reasoning}
        disabled={busy}
        aria-label="Reasoning model"
        onCheckedChange={(checked) => (reasoning = checked)}
      />
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="grid gap-1">
        <Label for="local-model-images">Accepts images</Label>
        <p class="text-xs text-muted-foreground">
          Text is always accepted. Turn this on only for vision weights,
          otherwise the composer offers an attachment the model cannot read.
        </p>
      </div>
      <Switch
        id="local-model-images"
        size="settings"
        checked={images}
        disabled={busy}
        aria-label="Accepts images"
        onCheckedChange={(checked) => (images = checked)}
      />
    </div>

    {#if error}
      <p class="flex items-center gap-1.5 text-xs text-destructive">
        <TriangleAlert size={14} strokeWidth={2} />
        {error}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <Button size="sm" variant="ghost" onclick={() => (open = false)}
      >Cancel</Button
    >
    <Button size="sm" onclick={() => void submit()} disabled={!canSubmit}>
      {busy ? "Saving…" : editing ? "Save model" : "Import model"}
    </Button>
  {/snippet}
</Dialog>
