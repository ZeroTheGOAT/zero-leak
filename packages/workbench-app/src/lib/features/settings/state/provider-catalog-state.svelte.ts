import type {
  CustomProvider,
  LocalModelEntry,
  LocalRuntime,
  ModelDefinition,
} from "$lib/api";

export const providerCatalogState = $state({
  catalogLoaded: false,
  customProviders: [] as CustomProvider[],
  modelDefinitions: [] as ModelDefinition[],
  localRuntimes: [] as LocalRuntime[],
  localModels: [] as LocalModelEntry[],
});
