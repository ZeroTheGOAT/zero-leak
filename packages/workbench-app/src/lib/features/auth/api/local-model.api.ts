import type {
  ImportLocalModelRequest,
  LocalModelInventory,
  LocalModelSelectorRequest,
  LocalModelStatus,
  LocalModelTestResult,
  UpdateLocalModelRequest,
} from "@nervekit/contracts/providers";
import { protocolRequest } from "@nervekit/protocol/adapters";

export async function getLocalModels(): Promise<LocalModelInventory> {
  return (await protocolRequest("localModel.list", {})).result;
}

export async function refreshLocalModels(
  runtimeId: string,
): Promise<LocalModelInventory> {
  return (await protocolRequest("localModel.refresh", { runtimeId })).result;
}

export async function importLocalModel(
  request: ImportLocalModelRequest,
): Promise<LocalModelInventory> {
  return (await protocolRequest("localModel.import", request)).result;
}

export async function updateLocalModel(
  request: UpdateLocalModelRequest,
): Promise<LocalModelInventory> {
  return (await protocolRequest("localModel.update", request)).result;
}

export async function removeLocalModel(
  request: LocalModelSelectorRequest,
): Promise<LocalModelInventory> {
  return (await protocolRequest("localModel.remove", request)).result;
}

export async function testLocalModel(
  request: LocalModelSelectorRequest,
): Promise<LocalModelTestResult> {
  return (await protocolRequest("localModel.test", request)).result;
}

export async function getLocalModelStatus(
  request: LocalModelSelectorRequest,
): Promise<LocalModelStatus> {
  return (await protocolRequest("localModel.status", request)).result;
}

export async function loadLocalModel(
  request: LocalModelSelectorRequest,
): Promise<LocalModelStatus> {
  return (await protocolRequest("localModel.load", request)).result;
}

export async function unloadLocalModel(
  request: LocalModelSelectorRequest,
): Promise<LocalModelStatus> {
  return (await protocolRequest("localModel.unload", request)).result;
}
