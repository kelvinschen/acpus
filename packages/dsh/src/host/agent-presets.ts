import type {
  AgentPresetCatalog,
  AgentPresetChoice,
  AgentPresetProvider,
  HostAgentPreset,
  ResolvedAgentPreset,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  AgentPresetAgentView,
  AgentPresetView,
} from "../remote/types.js";

export type AgentPresetSelectionView = Pick<
  AgentPresetChoice,
  "id" | "guidance" | "scope"
>;

const DSH_PRESET: HostAgentPreset = Object.freeze({
  id: "dsh",
  guidance: "Built-in DSH fallback. Prefer a fitting user-defined Preset unless DSH is requested.",
  agent: { use: "dsh" },
});

export const dshAgentPresetProvider: AgentPresetProvider = () =>
  Effect.succeed([DSH_PRESET]);

export function toAgentPresetSelectionView(
  choice: AgentPresetChoice,
): AgentPresetSelectionView {
  return {
    id: choice.id,
    guidance: choice.guidance,
    scope: choice.scope,
  };
}

export function toAgentPresetViews(
  catalog: AgentPresetCatalog,
): AgentPresetView[] {
  const resolution = catalog.resolve(catalog.choices.map(choice => choice.id));
  if (Result.isFailure(resolution)) {
    throw new Error(`Listed Agent Preset '${resolution.failure.id}' could not be resolved.`);
  }
  return catalog.choices.map(choice => {
    const resolved = resolution.success[choice.id];
    if (resolved === undefined) {
      throw new Error(`Listed Agent Preset '${choice.id}' did not resolve to a definition.`);
    }
    return {
      id: choice.id,
      guidance: choice.guidance,
      scope: choice.scope,
      agent: toAgentPresetAgentView(resolved.definition),
    };
  });
}

function toAgentPresetAgentView(
  definition: ResolvedAgentPreset["definition"],
): AgentPresetAgentView {
  const options = {
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.config === undefined
      ? {}
      : {
          config: Object.entries(definition.config)
            .map(([key, value]) => ({ key, value })),
        }),
  };
  return definition.kind === "agent_definition"
    ? { use: definition.use, ...options }
    : { command: definition.command, ...options };
}
