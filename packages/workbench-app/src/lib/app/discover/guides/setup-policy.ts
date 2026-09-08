import {
  setupGuideSteps,
  type SetupGuideArea,
  type SetupGuideStep,
} from "./setup-content.js";

export function setupStepsForArea(
  area: SetupGuideArea,
): SetupGuideStep[] {
  return [...setupGuideSteps[area]];
}

export function adjacentSetupStep(
  index: number,
  length: number,
  direction: -1 | 1,
): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + direction));
}
