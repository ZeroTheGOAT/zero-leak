import type {
  LocalRuntime,
  LocalRuntimeCatalog,
  LocalRuntimeProbe,
} from "@nervekit/contracts/providers";
import { protocolRequest } from "@nervekit/protocol/adapters";

export async function getLocalRuntimes(): Promise<LocalRuntimeCatalog> {
  return (await protocolRequest("localRuntime.list", {})).result;
}

export async function upsertLocalRuntime(
  runtime: LocalRuntime,
): Promise<LocalRuntimeCatalog> {
  return (await protocolRequest("localRuntime.upsert", runtime)).result;
}

export async function deleteLocalRuntime(
  id: string,
): Promise<LocalRuntimeCatalog> {
  return (await protocolRequest("localRuntime.delete", { id })).result;
}

export async function probeLocalRuntime(
  id: string,
): Promise<LocalRuntimeProbe> {
  return (await protocolRequest("localRuntime.probe", { id })).result;
}
