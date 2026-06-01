import type { Role, Stage } from "../schema/workflow-spec.js";
import { contractNameForStage, getOutputContract, type OutputContractName } from "../contracts/output-contracts.js";
import { contractFooterText as contractText } from "../contracts/descriptors.js";

export { contractNameForStage, contractText, getOutputContract, type OutputContractName };

export function safetyFooter(stage: Stage, role?: Role): string {
  const contractName = contractNameForStage(stage, role);
  return getOutputContract(contractName, stage.kind === "discover" ? { outputKey: stage.output, maxItems: stage.limits?.maxFanoutItems } : undefined).footerText();
}
