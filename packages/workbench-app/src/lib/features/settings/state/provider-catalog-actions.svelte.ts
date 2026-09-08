import {
  getLocalModels,
  getLocalRuntimes,
  getProviderCatalog,
  type LocalModelInventory,
} from "$lib/api";
import { loadSettingsPanel } from "$lib/application/settings";
import { clientLog } from "$lib/platform/logging/client-logger";
import { providerCatalogState } from "./provider-catalog-state.svelte";

let loadInFlight: Promise<void> | undefined;

export function loadProviderCatalog(): Promise<void> {
  if (loadInFlight) return loadInFlight;
  loadInFlight = Promise.all([
    getProviderCatalog(),
    getLocalRuntimes(),
    // Asks each runtime what it is serving the first time only, so the local
    // model list is a real reading rather than the last thing that was cached.
    getLocalModels(),
  ])
    .then(([catalog, localRuntimes, localModels]) => {
      providerCatalogState.customProviders = catalog.providers;
      providerCatalogState.modelDefinitions = catalog.models;
      providerCatalogState.localRuntimes = localRuntimes.runtimes;
      providerCatalogState.localModels = localModels.models;
      providerCatalogState.catalogLoaded = true;
    })
    .catch((error: unknown) => {
      // A fire-and-forget load must not become an unhandled rejection. The
      // settings page keeps its empty placeholders — catalogLoaded stays
      // false, so the next visit asks again — and the failure is logged for
      // the diagnostics view rather than disappearing.
      clientLog("error", "settings", "Provider catalog load failed", {
        error,
      });
    })
    .finally(() => {
      loadInFlight = undefined;
    });
  return loadInFlight;
}

export async function refreshProviderCatalog(): Promise<void> {
  await loadProviderCatalog();
  await loadSettingsPanel();
}

/**
 * Adopt the inventory a local model mutation returned. The operations answer
 * with the whole reconciled list, so there is nothing left to fetch.
 */
export function applyLocalModelInventory(inventory: LocalModelInventory): void {
  providerCatalogState.localModels = inventory.models;
}
