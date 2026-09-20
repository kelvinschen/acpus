import type { JsonValue } from "@acpus/expression/ir";
import {
  finalizeAgentBindings,
  hasPresetInjections,
  loadAgentPresetCatalog,
  tryNormalizeWorkflowInput,
  tryParseAgentInjectionMap,
  unboundAgentNames,
  type PreparedRunWorkflow,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";

export function checkWorkflowInvocation(
  workspaceDir: string,
  prepared: PreparedRunWorkflow,
  input: JsonValue | undefined,
  agents: unknown,
) {
  return Effect.gen(function* () {
    const normalized = input === undefined
      ? undefined
      : yield* Effect.fromResult(tryNormalizeWorkflowInput(prepared.ir, input));
    const injections = agents === undefined
      ? undefined
      : yield* Effect.fromResult(tryParseAgentInjectionMap(agents, prepared.ir.agents));
    if (injections !== undefined) {
      const presetCatalog = hasPresetInjections(injections)
        ? yield* loadAgentPresetCatalog({ workspaceDir })
        : undefined;
      yield* Effect.fromResult(finalizeAgentBindings({
        declarations: prepared.ir.agents,
        injections,
        ...(presetCatalog === undefined ? {} : { presetCatalog }),
      }));
    }
    return {
      input: normalized,
      agentInjections: injections,
      unboundAgents: injections === undefined ? unboundAgentNames(prepared.ir.agents) : [],
    };
  });
}
