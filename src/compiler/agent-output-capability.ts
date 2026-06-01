import type { OutputContractName } from "./contracts.js";

export type AgentOutputMode = "nativeSchema" | "toolCall" | "rawText";

export type AgentOutputCapability = {
  mode: AgentOutputMode;
  contract: OutputContractName;
  schemaName: string;
  rawTextFallback: boolean;
};

export function rawTextOutputCapability(contract: OutputContractName): AgentOutputCapability {
  return {
    mode: "rawText",
    contract,
    schemaName: `final-json.${contract}`,
    rawTextFallback: true
  };
}
