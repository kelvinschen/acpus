import type { NodeDetail, WorkflowContext } from "../api.js";
import { InspectorSection, JsonSection, KeyValue } from "./Inspector.js";

type AgentDetail = Extract<NodeDetail, { kind: "agent" }>;
type AgentProfile = WorkflowContext["agents"][string];

export function NodeDefinitionSection({
  detail,
  agentProfile,
  runtimeModel,
  lastObserved,
}: {
  detail: NodeDetail;
  agentProfile: AgentProfile | undefined;
  runtimeModel: string | undefined;
  lastObserved: string | undefined;
}) {
  if (detail.kind === "agent") {
    return (
      <AgentDefinitionSection
        detail={detail}
        agentProfile={agentProfile}
        runtimeModel={runtimeModel}
        lastObserved={lastObserved}
      />
    );
  }
  return <JsonSection title="Definition" value={definitionFields(detail)} expandNested />;
}

export function AgentDefinitionSection({
  detail,
  agentProfile,
  runtimeModel,
  lastObserved,
}: {
  detail: AgentDetail;
  agentProfile: AgentProfile | undefined;
  runtimeModel: string | undefined;
  lastObserved: string | undefined;
}) {
  const agent = agentProfile?.kind === "agent_definition" ? agentProfile.use : detail.use;
  const command = agentProfile?.kind === "agent_command" ? agentProfile.command : detail.command;
  const model = detail.model ?? agentProfile?.config?.model ?? agentProfile?.model ?? runtimeModel;
  const config = Object.entries(agentProfile?.config ?? {}).sort(([left], [right]) => left.localeCompare(right));

  return (
    <InspectorSection title="Agent Definition">
      <KeyValue label="Name" value={detail.agent} />
      {agent && <KeyValue label="Agent" value={agent} />}
      {command && <KeyValue label="Command" value={command} />}
      {model && <KeyValue label="Effective model" value={model} />}
      {config.map(([key, value]) => <KeyValue key={key} label={`Config · ${key}`} value={value} />)}
      {detail.outputSchema && <KeyValue label="Output schema" value={detail.outputSchema} />}
      {lastObserved && <KeyValue label="Last observed" value={lastObserved} />}
    </InspectorSection>
  );
}

function definitionFields(detail: Exclude<NodeDetail, { kind: "agent" }>): Record<string, unknown> {
  const { kind: _kind, ...fields } = detail;
  return fields;
}
