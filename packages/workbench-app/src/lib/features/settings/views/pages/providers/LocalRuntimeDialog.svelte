<script lang="ts" module>
import type { SelectItem } from "@nervekit/ui-kit/components/composites/select-field";

/**
 * The API surfaces a local runtime can actually speak. This is deliberately
 * narrower than pi-ai's full `piApiSchema`: ZeroLeak AI is air-gapped, so the
 * hosted-only surfaces (Azure, Vertex, Bedrock, Codex) are never offered even
 * though the stored contract can still represent them.
 */
export const LOCAL_API_ITEMS: SelectItem[] = [
  {
    value: "openai-completions",
    label: "OpenAI Chat Completions",
    detail: "llama.cpp, Ollama, vLLM, and most local servers",
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses",
    detail: "On-premise gateway speaking the OpenAI Responses API",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages",
    detail: "On-premise gateway speaking the Anthropic Messages API",
  },
];

export const DISCOVERY_ITEMS: SelectItem[] = [
  {
    value: "openai-models",
    label: "OpenAI /models",
    detail: "Asks the base URL for /models",
  },
  {
    value: "ollama-tags",
    label: "Ollama tags",
    detail: "Asks the host for /api/tags",
  },
  {
    value: "none",
    label: "No discovery",
    detail: "Models are entered by hand in Scoped Models",
  },
];
</script>

<script lang="ts">
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import type {
  LocalModelDiscovery,
  LocalRuntime,
  LocalRuntimeKind,
  PiApi,
} from "$lib/api";
import {
  getCredentialKey,
  refreshLocalModels,
  setProviderApiKey,
  upsertLocalRuntime,
} from "$lib/api";
import {
  isLocalRuntimeUrl,
  isReservedProviderId,
  type LocalRuntimePreset,
  localRuntimePresets,
} from "@nervekit/contracts/providers";
import { Button } from "@nervekit/ui-kit/components/ui/button";
import Dialog from "@nervekit/ui-kit/components/composites/dialog-shell";
import { Input } from "@nervekit/ui-kit/components/ui/input";
import { Label } from "@nervekit/ui-kit/components/ui/label";
import SelectField from "@nervekit/ui-kit/components/composites/select-field";
import { Switch } from "@nervekit/ui-kit/components/ui/switch";
import { Textarea } from "@nervekit/ui-kit/components/ui/textarea";
import { encryptApiKey } from "$lib/platform/crypto/credential-crypto";
import { providerCatalogState } from "$lib/features/settings/state/provider-catalog-state.svelte";
import { refreshProviderCatalog } from "$lib/features/settings/state/provider-catalog-actions.svelte";

type Props = {
  open?: boolean;
  runtime?: LocalRuntime;
  hasKey?: boolean;
};

let { open = $bindable(false), runtime, hasKey = false }: Props = $props();

const editing = $derived(Boolean(runtime));

const KIND_ITEMS: SelectItem[] = localRuntimePresets.map((preset) => ({
  value: preset.kind,
  label: preset.displayName,
  detail: preset.description,
}));

let displayName = $state("");
let id = $state("");
let kind = $state<LocalRuntimeKind>("llama-cpp");
let baseUrl = $state("");
let api = $state<PiApi>("openai-completions");
let discovery = $state<LocalModelDiscovery>("openai-models");
let requiresApiKey = $state(false);
let enabled = $state(true);
let headersText = $state("");
let compatText = $state("");
let apiKey = $state("");
let idTouched = $state(false);
let busy = $state(false);
let error = $state<string | undefined>(undefined);

// Reset form state whenever the dialog opens for a (possibly new) runtime.
$effect(() => {
  if (!open) return;
  const preset = presetFor(runtime?.kind ?? "llama-cpp");
  displayName = runtime?.displayName ?? preset.displayName;
  id = runtime?.id ?? preset.id;
  kind = runtime?.kind ?? preset.kind;
  baseUrl = runtime?.baseUrl ?? preset.baseUrl;
  api = runtime?.api ?? "openai-completions";
  discovery = runtime?.discovery ?? preset.discovery;
  requiresApiKey = runtime?.requiresApiKey ?? preset.requiresApiKey;
  enabled = runtime?.enabled ?? preset.enabled;
  headersText = headersToText(runtime?.headers);
  compatText = runtime?.compat ? JSON.stringify(runtime.compat, null, 2) : "";
  apiKey = "";
  idTouched = false;
  error = undefined;
});

/** Every kind in the enum has a preset, so the fallback is unreachable. */
function presetFor(value: LocalRuntimeKind): LocalRuntimePreset {
  return (
    localRuntimePresets.find((preset) => preset.kind === value) ??
    localRuntimePresets[0]!
  );
}

/**
 * Switching kind while adding re-seeds the endpoint fields, because they are
 * properties of the runtime kind rather than of this particular entry. Name and
 * id follow only while the operator has not typed their own.
 */
function onKindChange(value: string): void {
  kind = value as LocalRuntimeKind;
  if (editing) return;
  const preset = presetFor(kind);
  baseUrl = preset.baseUrl;
  discovery = preset.discovery;
  requiresApiKey = preset.requiresApiKey;
  enabled = preset.enabled;
  if (!idTouched) {
    displayName = preset.displayName;
    id = preset.id;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function onDisplayNameInput(value: string): void {
  displayName = value;
  if (!editing && !idTouched) id = slugify(value);
}

const idValid = $derived(/^[a-z0-9][a-z0-9-]*$/.test(id));
/**
 * The URL is validated here rather than left to the server's Zod error: a raw
 * schema rejection reads as "Invalid URL" at best, while this can say what the
 * operator should do about it. The same rule the server applies — a parseable
 * http(s) URL addressing loopback or a private network — is checked as the
 * operator types, so a submit never depends on a round trip to be told no.
 */
const urlError = $derived.by(() => {
  const trimmed = baseUrl.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, for example http://127.0.0.1:8080/v1.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http and https URLs can be used.";
  }
  if (!isLocalRuntimeUrl(trimmed)) {
    return "Only loopback or private-network addresses can be used; ZeroLeak AI never contacts a public endpoint.";
  }
  return undefined;
});
/**
 * Runtimes share the provider id namespace with custom providers and the
 * providers the harness registers itself, so an unnoticed collision would
 * replace the other entry in the model registry.
 */
const idTaken = $derived(
  !editing &&
    (isReservedProviderId(id) ||
      providerCatalogState.localRuntimes.some((item) => item.id === id) ||
      providerCatalogState.customProviders.some((item) => item.id === id)),
);
const canSubmit = $derived(
  displayName.trim().length > 0 &&
    idValid &&
    !idTaken &&
    baseUrl.trim().length > 0 &&
    !urlError &&
    !busy,
);

async function submit(): Promise<void> {
  if (!canSubmit) return;
  busy = true;
  error = undefined;
  try {
    let compat: Record<string, unknown> | undefined;
    if (compatText.trim()) {
      try {
        compat = JSON.parse(compatText) as Record<string, unknown>;
      } catch {
        throw new Error("Compatibility overrides must be valid JSON.");
      }
    }
    const trimmedKey = apiKey.trim();
    if (requiresApiKey && !trimmedKey && !hasKey) {
      throw new Error(
        "This runtime requires a token. Paste one, or turn the requirement off.",
      );
    }
    const next: LocalRuntime = {
      id,
      kind,
      displayName: displayName.trim(),
      baseUrl: baseUrl.trim(),
      api,
      discovery,
      requiresApiKey,
      enabled,
      headers: parseHeaders(headersText),
      ...(compat ? { compat } : {}),
    };
    if (trimmedKey && !requiresApiKey) {
      throw new Error(
        "A token was pasted but this runtime is set not to require one. Turn the requirement on, or clear the token field.",
      );
    }
    // The runtime is registered before the token is stored: a rejected upsert
    // (a malformed URL, a taken id) then leaves no orphaned secret behind.
    await upsertLocalRuntime(next);
    if (trimmedKey) {
      const credentialKey = await getCredentialKey();
      const envelope = await encryptApiKey(trimmedKey, credentialKey);
      await setProviderApiKey(id, envelope);
      // The upsert's own discovery ran before the token existed; ask again so
      // the model list is the one the authenticated runtime reports.
      if (discovery !== "none") await refreshLocalModels(id);
    }
    await refreshProviderCatalog();
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
  title={editing ? `Edit ${runtime?.displayName}` : "Add local runtime"}
  description="Connect a local inference server or a private on-premise OpenAI-compatible endpoint."
  size="sm"
>
  <div class="grid gap-3">
    <div class="grid gap-1.5">
      <Label>Runtime</Label>
      <SelectField
        items={KIND_ITEMS}
        value={kind}
        onValueChange={onKindChange}
        ariaLabel="Runtime"
      />
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label for="local-runtime-name">Display name</Label>
        <Input
          size="xs"
          id="local-runtime-name"
          value={displayName}
          oninput={(event) => onDisplayNameInput(event.currentTarget.value)}
          placeholder="llama.cpp"
          disabled={busy}
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="local-runtime-id">Runtime id</Label>
        <Input
          size="xs"
          id="local-runtime-id"
          bind:value={id}
          oninput={() => (idTouched = true)}
          placeholder="llama-cpp"
          disabled={busy || editing}
          aria-invalid={(!idValid && id.length > 0) || idTaken}
        />
        {#if id.length > 0 && !idValid}
          <p class="flex items-center gap-1.5 text-xs text-destructive">
            Use lowercase letters, numbers, and dashes.
          </p>
        {:else if idTaken}
          <p class="flex items-center gap-1.5 text-xs text-destructive">
            This id is already in use.
          </p>
        {/if}
      </div>
    </div>

    <div class="grid gap-1.5">
      <Label for="local-runtime-base-url">Base URL</Label>
      <Input
        size="xs"
        id="local-runtime-base-url"
        bind:value={baseUrl}
        placeholder="http://127.0.0.1:8080/v1"
        disabled={busy}
        aria-invalid={Boolean(urlError)}
      />
      {#if urlError}
        <p class="flex items-center gap-1.5 text-xs text-destructive">
          {urlError}
        </p>
      {/if}
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label>API type</Label>
        <SelectField
          items={LOCAL_API_ITEMS}
          value={api}
          onValueChange={(value) => (api = value as PiApi)}
          ariaLabel="API type"
        />
      </div>
      <div class="grid gap-1.5">
        <Label>Model discovery</Label>
        <SelectField
          items={DISCOVERY_ITEMS}
          value={discovery}
          onValueChange={(value) => (discovery = value as LocalModelDiscovery)}
          ariaLabel="Model discovery"
        />
      </div>
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="grid gap-1">
        <Label for="local-runtime-requires-key">Requires a token</Label>
        <p class="text-xs text-muted-foreground">
          Loopback servers usually authenticate nobody. On-premise gateways
          often do.
        </p>
      </div>
      <Switch
        id="local-runtime-requires-key"
        size="settings"
        checked={requiresApiKey}
        disabled={busy}
        aria-label="Requires a token"
        onCheckedChange={(checked) => (requiresApiKey = checked)}
      />
    </div>

    {#if requiresApiKey}
      <div class="grid gap-1.5">
        <Label for="local-runtime-key">
          Token {hasKey ? "(stored — leave blank to keep)" : ""}
        </Label>
        <Input
          size="xs"
          id="local-runtime-key"
          type="password"
          autocomplete="off"
          bind:value={apiKey}
          placeholder={hasKey ? "Paste a replacement token" : "Paste a token"}
          disabled={busy}
        />
      </div>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <div class="grid gap-1">
        <Label for="local-runtime-enabled">Enabled</Label>
        <p class="text-xs text-muted-foreground">
          A disabled runtime keeps its configuration but offers no models.
        </p>
      </div>
      <Switch
        id="local-runtime-enabled"
        size="settings"
        checked={enabled}
        disabled={busy}
        aria-label="Enabled"
        onCheckedChange={(checked) => (enabled = checked)}
      />
    </div>

    <div class="grid gap-1.5">
      <Label for="local-runtime-headers">Custom headers (optional)</Label>
      <Textarea
        id="local-runtime-headers"
        bind:value={headersText}
        rows={3}
        placeholder="X-Header: value
Another-Header: value"
        disabled={busy}
      />
      <p class="text-xs text-muted-foreground">
        One <code class="font-mono">Name: value</code> per line.
      </p>
    </div>

    <div class="grid gap-1.5">
      <Label for="local-runtime-compat"
        >Compatibility overrides (optional JSON)</Label
      >
      <Textarea
        id="local-runtime-compat"
        bind:value={compatText}
        rows={3}
        placeholder={'{ "supportsDeveloperRole": false }'}
        disabled={busy}
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
      {busy ? "Saving…" : editing ? "Save runtime" : "Add runtime"}
    </Button>
  {/snippet}
</Dialog>
