import type { AgentAuthoringContext, AgentPresetChoice, EffectiveAuthoringAgentScale } from "@acpus/runtime";

const GUIDELINE = "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.";

export function formatAgentAuthoringContext(context: AgentAuthoringContext): string {
  return `${formatAuthoringAgentScale(context.scale)}\n\n${formatAgentPresetChoices(context.presets.choices)}\n`;
}

export function formatAuthoringAgentScale(scale: EffectiveAuthoringAgentScale | undefined): string {
  if (scale === undefined) {
    return "Authoring Agent scale: unconfigured (when configured, this is soft guidance, not a hard limit)";
  }
  return [
    "Authoring Agent scale:",
    `  value: ${scale.value}`,
    ...(scale.maxAgentOccurrences === undefined
      ? []
      : [`  suggested maximum Agent execution occurrences: ${scale.maxAgentOccurrences}`]),
    `  source: ${scale.source}`,
    `  guidance: ${GUIDELINE}`,
  ].join("\n");
}

function formatAgentPresetChoices(choices: readonly AgentPresetChoice[]): string {
  if (choices.length === 0) return "Agent Preset choices (select by guidance): none";
  const lines = ["Agent Preset choices (select by guidance):"];
  for (const scope of ["host", "project", "global"] as const) {
    const scopedChoices = choices.filter(choice => choice.scope === scope);
    if (scopedChoices.length === 0) continue;
    lines.push(`  ${scope}:`);
    const idWidth = scopedChoices.reduce((width, choice) => Math.max(width, choice.id.length), 0);
    for (const choice of scopedChoices) lines.push(`    ${choice.id.padEnd(idWidth)}  ${choice.guidance}`);
  }
  return lines.join("\n");
}
