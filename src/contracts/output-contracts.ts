import type { Role, Stage } from "../schema/workflow-spec.js";
import type { OutputContractName } from "./schemas.js";
export { getOutputContract, type OutputContract, type OutputContractOptions } from "./descriptors.js";
export { OutputContractNameSchema, type OutputContractName } from "./schemas.js";

export function contractNameForStage(stage: Stage, role?: Role): OutputContractName {
  if (stage.kind === "gate") return "gate";
  if (stage.kind === "summarize") {
    throw new Error(`Summarize stage ${stage.id} is deprecated. Run lint and migrate it to a terminal gate stage before compiling.`);
  }
  if (stage.kind === "decisionGate") return "decision";
  if (stage.kind === "discover") return "discover";
  if (role?.category === "implementation") return "implementation";
  if (role?.category === "validation" || role?.category === "review") return "validation";
  return "base";
}
