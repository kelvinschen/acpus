import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import {
  getArtifactPreview,
  getNodeExecutionInspection,
  getNodeRuntimeValues,
  type NodeExecutionInspection,
  type NodeDetail,
  type NodeInspection,
  type WebControlCommand,
  type WorkflowContext,
} from "../api.js";
import { ArtifactViewer } from "./ArtifactViewer.js";
import {
  InspectorSection,
  JsonBlock,
  JsonSection,
  KeyValue,
  StateBlock,
} from "./Inspector.js";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { NodeDefinitionSection } from "./NodeDefinition.js";
import { isTerminalRunStatus, RuntimeStatusIcon } from "./RunStatus.js";
import { formatDate, formatDuration, formatRelativeAge } from "./display-format.js";
import { Badge } from "./shadcn/badge.js";
import { Button } from "./shadcn/button.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./shadcn/tabs.js";
import { Textarea } from "./shadcn/textarea.js";
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";

export function Inspector({
  workspaceKey,
  runId,
  target,
  definition,
  agentProfile,
  inspection,
  loading,
}: {
  workspaceKey: string;
  runId: string | undefined;
  target: string | undefined;
  definition: NodeDetail | undefined;
  agentProfile: WorkflowContext["agents"][string] | undefined;
  inspection: NodeInspection | undefined;
  loading: boolean;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTabId>("overview");
  useEffect(() => {
    setActiveTab("overview");
  }, [target]);
  useEffect(() => {
    const hasArtifacts = (inspection?.artifacts.length ?? 0) > 0;
    const hasExecution = inspection?.staticKind === "agent";
    if ((activeTab === "artifacts" && !hasArtifacts) || (activeTab === "execution" && !hasExecution)) {
      setActiveTab("overview");
    }
  }, [activeTab, inspection?.artifacts.length, inspection?.staticKind]);
  if (loading) return <StateBlock tone="loading" title="Loading node details" />;
  if (!inspection) return <StateBlock tone="empty" title="Select a graph node" detail="Node runtime details appear here after selection." />;
  const hasArtifacts = inspection.artifacts.length > 0;
  const hasExecution = inspection.staticKind === "agent";
  return (
    <div className="inspector-stack tabbed">
      {inspection.timing && (
        <div className="inspector-runtime-meta" role="group" aria-label="Node timing">
          <div className="inspector-runtime-meta-item">
            <span>Node start</span>
            <strong>{formatDate(inspection.timing.startedAt)}</strong>
          </div>
          {inspection.timing.durationMs !== undefined && (
            <div className="inspector-runtime-meta-item duration">
              <span>Node duration</span>
              <strong>{formatDuration(inspection.timing.durationMs)}</strong>
            </div>
          )}
        </div>
      )}
      <Tabs className="inspector-tab-shell" value={activeTab} onValueChange={value => setActiveTab(value as InspectorTabId)}>
        <TabsList className="inspector-tabs" aria-label="Inspector sections">
          <InspectorTab id="overview">Overview</InspectorTab>
          {hasArtifacts && <InspectorTab id="artifacts">Artifacts <Badge variant="tabCount">{inspection.artifacts.length}</Badge></InspectorTab>}
          {hasExecution && <InspectorTab id="execution">Execution</InspectorTab>}
        </TabsList>

        <InspectorTabPanel id="overview">
          <>
          <InspectorSection title="Runtime target">
            {inspection.nodeKey && <KeyValue label="Node Key" value={inspection.nodeKey} />}
            {inspection.frameKey && <KeyValue label="Frame Key" value={inspection.frameKey} />}
            {inspection.latestAttempt && <KeyValue label="Latest attempt" value={`${inspection.latestAttempt.attemptNo} · ${inspection.latestAttempt.status}`} />}
          </InspectorSection>

          {definition && (
            <NodeDefinitionSection
              detail={definition}
              agentProfile={agentProfile}
              runtimeModel={inspection.agent?.model}
              lastObserved={inspection.agent?.lastObservedAt ? formatRelativeAge(inspection.agent.lastObservedAt) : undefined}
            />
          )}

          {definition && runId && target && supportsRuntimeValues(definition) && (
            <RuntimeValuesSection workspaceKey={workspaceKey} runId={runId} target={target} />
          )}

          {inspection.input && (
            <JsonSection title={inspection.input.kind === "runtime" ? "Input" : "Authored Input"} value={inspection.input.value} />
          )}

          {inspection.prompt && (
            <InspectorSection title="Prompt">
              <PromptContent workspaceKey={workspaceKey} runId={runId} prompt={inspection.prompt} />
            </InspectorSection>
          )}

          {inspection.loopProgress && (
            <>
              <InspectorSection title="Loop Progress">
                <KeyValue label="Round" value={String(inspection.loopProgress.round)} />
                <KeyValue label="Index" value={String(inspection.loopProgress.index)} />
                <KeyValue label="Frame Key" value={inspection.loopProgress.frameKey} />
                {inspection.loopProgress.activeIterationFrameKey && <KeyValue label="Iteration Frame" value={inspection.loopProgress.activeIterationFrameKey} />}
                {inspection.loopProgress.stop !== undefined && <KeyValue label="Stop" value={String(inspection.loopProgress.stop)} />}
              </InspectorSection>
              {inspection.loopProgress.activeChildNodeKeys.length > 0 && <JsonSection title="Active Child Node Keys" value={inspection.loopProgress.activeChildNodeKeys} />}
              {inspection.loopProgress.state !== undefined && <JsonSection title="Loop State" value={inspection.loopProgress.state} />}
              {inspection.loopProgress.transition !== undefined && <JsonSection title="Last Transition" value={inspection.loopProgress.transition} />}
            </>
          )}

          {inspection.output !== undefined && (
            <JsonSection title="Output" value={inspection.output} />
          )}

          {inspection.failure !== undefined && (
            <JsonSection title="Diagnostics" value={inspection.failure} />
          )}
          </>
        </InspectorTabPanel>

        {hasArtifacts && (
        <InspectorTabPanel id="artifacts" className="artifacts-panel">
          <ArtifactList workspaceKey={workspaceKey} runId={runId} artifacts={inspection.artifacts} />
        </InspectorTabPanel>
        )}

        {hasExecution && (
        <InspectorTabPanel id="execution">
          {runId && target && <AgentExecutionTab workspaceKey={workspaceKey} runId={runId} target={target} active={activeTab === "execution"} />}
        </InspectorTabPanel>
        )}
      </Tabs>
    </div>
  );
}

function RuntimeValuesSection({ workspaceKey, runId, target }: { workspaceKey: string; runId: string; target: string }) {
  const runtimeValues = useQuery({
    queryKey: ["node-runtime-values", workspaceKey, runId, target],
    queryFn: () => getNodeRuntimeValues(workspaceKey, runId, target),
    staleTime: Infinity,
    retry: false,
  });

  if (runtimeValues.isLoading) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock tone="loading" title="Loading runtime values" />
      </InspectorSection>
    );
  }
  if (runtimeValues.error) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock
          tone="error"
          title="Runtime values unavailable"
          detail={runtimeValues.error instanceof Error ? runtimeValues.error.message : String(runtimeValues.error)}
        />
      </InspectorSection>
    );
  }
  if (!runtimeValues.data?.available) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock
          tone={runtimeValues.data?.reason === "resolution_failed" ? "error" : "empty"}
          title="Runtime values unavailable"
          detail={runtimeValuesUnavailableDetail(runtimeValues.data?.reason)}
        />
      </InspectorSection>
    );
  }
  return <JsonSection title="Runtime Values" value={runtimeValues.data.values} />;
}

function supportsRuntimeValues(definition: NodeDetail): boolean {
  if (definition.kind === "parallel") return definition.maxConcurrency !== undefined;
  return definition.kind === "assert"
    || definition.kind === "if"
    || definition.kind === "switch"
    || definition.kind === "fanout"
    || definition.kind === "loop";
}

function runtimeValuesUnavailableDetail(reason: string | undefined): string {
  if (reason === "not_started") return "This node has not started.";
  if (reason === "not_selected") return "This node was not selected for execution.";
  if (reason === "not_yet_resolved") return "The runtime has not resolved these values yet.";
  if (reason === "resolution_failed") return "The runtime could not resolve these values.";
  if (reason === "not_recorded") return "No durable runtime values were recorded.";
  return "Runtime values are not available for this node.";
}

type InspectorTabId = "overview" | "artifacts" | "execution";

function InspectorTab({ id, children }: { id: InspectorTabId; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={id}
      id={`inspector-tab-${id}`}
      className="inspector-tab"
      aria-controls={`inspector-panel-${id}`}
    >
      {children}
    </TabsTrigger>
  );
}

function InspectorTabPanel({ id, className, children }: { id: InspectorTabId; className?: string; children: React.ReactNode }) {
  return (
    <TabsContent
      value={id}
      id={`inspector-panel-${id}`}
      className={`inspector-tab-panel${className ? ` ${className}` : ""}`}
      aria-labelledby={`inspector-tab-${id}`}
    >
      {children}
    </TabsContent>
  );
}

function PromptContent({ workspaceKey, runId, prompt }: { workspaceKey: string; runId: string | undefined; prompt: NonNullable<NodeInspection["prompt"]> }) {
  if (prompt.text) return <MarkdownBlock value={prompt.text} />;
  if (!runId || !prompt.artifactId) return <StateBlock tone="empty" title="Prompt unavailable" detail="No prompt artifact or inline prompt was recorded for this scope." />;
  return <ArtifactPreviewBlock workspaceKey={workspaceKey} runId={runId} artifactId={prompt.artifactId} {...(prompt.mediaType ? { mediaType: prompt.mediaType } : {})} />;
}

function ArtifactList({ workspaceKey, runId, artifacts }: { workspaceKey: string; runId: string | undefined; artifacts: NodeInspection["artifacts"] }) {
  const [viewerArtifactId, setViewerArtifactId] = useState<string | undefined>();
  const viewerTrigger = useRef<HTMLButtonElement | null>(null);
  const viewerArtifact = artifacts.find(artifact => artifact.id === viewerArtifactId);
  return (
    <div className="artifact-stack">
      <div className="artifact-list">
        {artifacts.map(artifact => (
          <Button
            key={artifact.id}
            type="button"
            variant="ghost"
            className="artifact-row"
            aria-label={`View artifact ${artifact.path}, ${artifact.mediaType ?? "unknown type"}, ${formatSize(artifact.size)}`}
            aria-haspopup="dialog"
            title={runId ? artifact.path : "Run unavailable"}
            disabled={!runId}
            onClick={event => {
              viewerTrigger.current = event.currentTarget;
              setViewerArtifactId(artifact.id);
            }}
          >
            <span className="artifact-title mono" title={artifact.path}>{artifact.path}</span>
            <span className="artifact-media">{artifact.mediaType ?? "unknown"}</span>
            <span className="artifact-size mono">{formatSize(artifact.size)}</span>
            <span className="artifact-view-cue" aria-hidden="true">
              <Maximize2 size={15} strokeWidth={2} />
              <span>View</span>
            </span>
          </Button>
        ))}
      </div>
      {runId && viewerArtifact && (
        <ArtifactViewer
          key={viewerArtifact.id}
          workspaceKey={workspaceKey}
          runId={runId}
          artifact={viewerArtifact}
          {...(viewerTrigger.current ? { restoreFocus: viewerTrigger.current } : {})}
          onClose={() => setViewerArtifactId(current => current === viewerArtifact.id ? undefined : current)}
        />
      )}
    </div>
  );
}

function ArtifactPreviewBlock({ workspaceKey, runId, artifactId, mediaType }: { workspaceKey: string; runId: string; artifactId: string; mediaType?: string }) {
  const preview = useQuery({
    queryKey: ["artifact-preview", workspaceKey, runId, artifactId],
    queryFn: () => getArtifactPreview(workspaceKey, runId, artifactId),
  });
  if (preview.isLoading) return <StateBlock tone="loading" title="Loading artifact" />;
  if (preview.error) return <StateBlock tone="error" title="Artifact preview failed" detail={preview.error instanceof Error ? preview.error.message : String(preview.error)} />;
  const loaded = preview.data;
  if (!loaded) return null;
  const effectiveMediaType = mediaType ?? loaded.mediaType;
  let body: React.ReactNode;
  if (isJsonMedia(effectiveMediaType)) {
    const value = tryParseJsonPreview(loaded.text);
    body = value.ok ? (
      <div className="json-standalone">
        <JsonBlock value={value.value} />
      </div>
    ) : (
      <TextArtifactPreview value={loaded.text} label="Raw JSON text" />
    );
  } else if (isMarkdownMedia(effectiveMediaType)) {
    body = <MarkdownBlock value={loaded.text} />;
  } else if (isTextMedia(effectiveMediaType)) {
    body = <TextArtifactPreview value={loaded.text} />;
  } else {
    body = <StateBlock tone="empty" title="Preview unavailable" detail={`Preview is not available for ${effectiveMediaType}.`} />;
  }
  return (
    <div className="artifact-preview-stack">
      {loaded.truncated && (
        <div className="artifact-preview-notice" role="status">
          Showing first 128 KiB of {formatSize(loaded.size)}.
        </div>
      )}
      <div className="artifact-preview-body">{body}</div>
    </div>
  );
}

export function AgentExecutionTab({ workspaceKey, runId, target, active }: { workspaceKey: string; runId: string; target: string; active: boolean }) {
  const execution = useQuery({
    queryKey: ["node-execution", workspaceKey, runId, target],
    queryFn: () => getNodeExecutionInspection(workspaceKey, runId, target),
    enabled: active,
    refetchInterval: query => agentExecutionRefetchInterval(
      active,
      (query.state.data as NodeExecutionInspection | undefined)?.summary.status,
    ),
  });
  if (execution.isLoading) return <StateBlock tone="loading" title="Loading execution details" />;
  if (execution.error) return <StateBlock tone="error" title="Execution details failed" detail={execution.error instanceof Error ? execution.error.message : String(execution.error)} />;
  if (!execution.data) return <StateBlock tone="empty" title="No execution details" detail="No agent execution metadata exists for the selected scope." />;
  const data = execution.data;
  if (!data.available) return <StateBlock tone="empty" title="No execution details" detail={data.reason ?? "No agent execution metadata exists for the selected scope."} />;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Summary">
        <KeyValue label="Status" value={data.summary.status} />
        {data.lastObservedAt && <KeyValue label="Last observed" value={formatRelativeAge(data.lastObservedAt)} />}
        {data.summary.sessionName && <KeyValue label="Session" value={data.summary.sessionName} />}
        {data.summary.turnCount !== undefined && <KeyValue label="Turns" value={String(data.summary.turnCount)} />}
        {data.summary.message && <KeyValue label="Message" value={data.summary.message} />}
      </InspectorSection>
      {data.contextWindow && (
        <InspectorSection title="Context Window">
          <ContextWindowMeter context={data.contextWindow} />
        </InspectorSection>
      )}
      {data.tokenUsage && (
        <InspectorSection title="Token Usage">
          <TokenUsageMetrics usage={data.tokenUsage} />
        </InspectorSection>
      )}
      {data.output && (
        <InspectorSection title="Output Stream">
          <TextArtifactPreview value={data.output.tail} label={progressOutputLabel(data.output)} />
        </InspectorSection>
      )}
      <InspectorSection title="Recent observed tools">
        {data.recentTools.length > 0
          ? <ToolCallList calls={data.recentTools} />
          : <StateBlock tone="empty" title="No retained tool observations" detail="No retained tool observations are available for this agent." />}
      </InspectorSection>
    </div>
  );
}

function ContextWindowMeter({ context }: { context: NonNullable<NodeExecutionInspection["contextWindow"]> }) {
  const percent = Math.max(0, Math.min(context.percent ?? 0, 100));
  return (
    <div className="execution-card">
      <div className="execution-meter-head">
        <strong>{context.used ?? "?"} / {context.size ?? "?"}</strong>
        {context.percent !== undefined && <span>{context.percent}%</span>}
      </div>
      <div className="execution-meter" aria-label={`Context window ${context.percent ?? 0}% used`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {context.updatedAt && <small>Updated {formatDate(context.updatedAt)}</small>}
    </div>
  );
}

function TokenUsageMetrics({ usage }: { usage: NonNullable<NodeExecutionInspection["tokenUsage"]> }) {
  return (
    <div className="execution-metrics">
      <Metric label="Input" value={usage.inputTokens} />
      <Metric label="Output" value={usage.outputTokens} />
      <Metric label="Total" value={usage.totalTokens} />
      {usage.source && <Metric label="Source" value={usage.source} />}
    </div>
  );
}

function progressOutputLabel(output: NonNullable<NodeExecutionInspection["output"]>): string {
  const retained = new TextEncoder().encode(output.tail).length;
  return output.truncated ? `Last ${retained} of ${output.totalBytes} bytes` : `${output.totalBytes} bytes`;
}

function Metric({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="execution-metric">
      <span>{label}</span>
      <strong>{value ?? "n/a"}</strong>
    </div>
  );
}

function ToolCallList({ calls }: { calls: NodeExecutionInspection["recentTools"] }) {
  return (
    <div className="tool-call-stack">
      {calls.map((call, index) => (
        <div key={`${call.turn}-${call.toolCallId ?? index}`} className="tool-call-row">
          <div className="tool-call-head">
            <div>
              <strong>{call.toolName ?? "Tool call"}</strong>
              <span>turn {call.turn}{call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ""}</span>
            </div>
            {call.status && <ToolCallStatus status={call.status} />}
          </div>
          {call.inputPreview && <p>{call.inputPreview}</p>}
        </div>
      ))}
    </div>
  );
}

function ToolCallStatus({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  return (
    <span className={`tool-call-status ${display}`}>
      <RuntimeStatusIcon status={display} />
      <span>{runtimeStatusLabel(display)}</span>
    </span>
  );
}

function MarkdownBlock({ value }: { value: string }) {
  return <MarkdownDocument value={value} variant="compact" />;
}

function TextArtifactPreview({ value, label }: { value: string; label?: string }) {
  return (
    <div className="text-artifact-shell">
      {label && <div className="artifact-preview-label">{label}</div>}
      <pre className="text-artifact-preview">{value}</pre>
    </div>
  );
}

export function SignalBox({
  wait,
  onSubmit,
}: {
  wait: NonNullable<NodeInspection["awaitingSignal"]>;
  onSubmit(payload: Extract<WebControlCommand, { type: "signal" }>["payload"]): void;
}) {
  const [payload, setPayload] = useState("{}");
  const [payloadError, setPayloadError] = useState<string | undefined>();
  return (
    <form
      className="signal-box"
      onSubmit={e => {
        e.preventDefault();
        try {
          onSubmit(JSON.parse(payload));
          setPayloadError(undefined);
        } catch {
          setPayloadError("Signal payload must be valid JSON.");
        }
      }}
    >
      <strong>Awaiting Signal</strong>
      {wait.prompt && <p>{wait.prompt}</p>}
      <Textarea
        value={payload}
        aria-label="Signal payload JSON"
        aria-invalid={payloadError ? true : undefined}
        aria-describedby={payloadError ? "signal-payload-error" : undefined}
        onChange={e => {
          setPayload(e.target.value);
          if (payloadError) setPayloadError(undefined);
        }}
      />
      {payloadError && <p id="signal-payload-error" className="signal-error" role="alert">{payloadError}</p>}
      <Button className="primary-button" type="submit">Submit Signal</Button>
    </form>
  );
}

export function nodeInspectionRefetchInterval(status: string | undefined): 1_000 | false {
  return isTerminalRunStatus(status) ? false : 1_000;
}

export function agentExecutionRefetchInterval(
  active: boolean,
  status: string | undefined,
): 2_500 | false {
  return active && (
    status === "starting"
    || status === "ready"
    || status === "running"
    || status === "awaiting"
  ) ? 2_500 : false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isJsonMedia(mediaType: string): boolean {
  return mediaType.includes("json") || mediaType.includes("ndjson");
}

function isMarkdownMedia(mediaType: string): boolean {
  return mediaType.includes("markdown") || mediaType.includes("md");
}

function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType.includes("xml") || mediaType.includes("yaml");
}

function tryParseJsonPreview(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return { ok: false };
    const values: unknown[] = [];
    for (const line of lines) {
      try {
        values.push(JSON.parse(line));
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value: values };
  }
}
