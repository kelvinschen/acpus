import type { Role, Stage } from "../schema/workflow-spec.js";
import type { OutputContractName } from "./schemas.js";
export { getOutputContract, type OutputContract, type OutputContractOptions } from "./descriptors.js";
export { normalizeDeterministicAliases, type AliasNormalization } from "./normalize.js";
export { OutputContractNameSchema, type OutputContractName } from "./schemas.js";

export function contractNameForStage(stage: Stage, role?: Role): OutputContractName {
  if (stage.kind === "summarize") return "summarize";
  if (stage.kind === "decisionGate") return "decision";
  if (stage.kind === "discover") return "discover";
  if (role?.category === "implementation") return "implementation";
  if (role?.category === "validation" || role?.category === "review") return "validation";
  return "base";
}
