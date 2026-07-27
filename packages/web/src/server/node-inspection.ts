import type {
  RunInspectionAgentExecutionDocument,
  RunInspectionTargetDetailsDocument,
} from "@acpus/runtime";
import type {
  NodeExecutionInspection,
  NodeInspection,
  NodeInspectionFailure,
} from "../api-types.js";

type LoadJsonArtifact = (artifactRef: unknown) => Promise<unknown | undefined>;

export async function projectNodeInspection(
  inspection: RunInspectionTargetDetailsDocument,
  loadJsonArtifact: LoadJsonArtifact,
): Promise<NodeInspection> {
  const summary = inspection.summary;
  const cancelTarget = inspection.availableControls.find(control => control.type === "cancel")?.target;
  let prompt = summary.prompt;
  if (prompt?.kind === "artifact" && prompt.field === "prompt") {
    const artifact = await loadJsonArtifact(prompt);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error(`Registered Agent prompt artifact '${prompt.artifactId}' is unavailable.`);
    }
    const text = (artifact as Record<string, unknown>)[prompt.field];
    if (typeof text !== "string") {
      throw new Error(`Registered Agent prompt artifact '${prompt.artifactId}' has no string prompt.`);
    }
    prompt = { ...prompt, text };
  }
  const signal = summary.nodeStatus === "awaiting" ? summary.signal : undefined;
  return {
    ...(summary.nodeId === undefined ? {} : { nodeId: summary.nodeId }),
    ...(summary.nodeKey === undefined ? {} : { nodeKey: summary.nodeKey }),
    ...(summary.frameKey === undefined ? {} : { frameKey: summary.frameKey }),
    ...(cancelTarget === undefined ? {} : { cancelTarget }),
    ...(summary.staticKind === undefined ? {} : { staticKind: summary.staticKind }),
    runStartedAt: summary.runStartedAt,
    ...(summary.runDurationMs === undefined ? {} : { runDurationMs: summary.runDurationMs }),
    ...(summary.latestAttempt === undefined ? {} : {
      latestAttempt: {
        attemptNo: summary.latestAttempt.attemptNo,
        status: summary.latestAttempt.status,
      },
    }),
    ...(summary.agent === undefined ? {} : {
      agent: {
        key: summary.agent.key,
        ...(summary.agent.model === undefined ? {} : { model: summary.agent.model }),
        ...(summary.agent.lastObservedAt === undefined ? {} : { lastObservedAt: summary.agent.lastObservedAt }),
      },
    }),
    ...(summary.input === undefined ? {} : {
      input: {
        kind: summary.input.kind,
        value: summary.input.value,
      },
    }),
    ...(prompt === undefined ? {} : {
      prompt: {
        kind: prompt.kind,
        ...(prompt.text === undefined ? {} : { text: prompt.text }),
        ...(prompt.artifactId === undefined ? {} : { artifactId: prompt.artifactId }),
        ...(prompt.mediaType === undefined ? {} : { mediaType: prompt.mediaType }),
      },
    }),
    ...(summary.loopProgress === undefined ? {} : {
      loopProgress: {
        frameKey: summary.loopProgress.frameKey,
        index: summary.loopProgress.index,
        round: summary.loopProgress.round,
        ...(summary.loopProgress.state === undefined ? {} : { state: summary.loopProgress.state }),
        ...(summary.loopProgress.stop === undefined ? {} : { stop: summary.loopProgress.stop }),
        ...(summary.loopProgress.transition === undefined ? {} : { transition: summary.loopProgress.transition }),
        ...(summary.loopProgress.activeIterationFrameKey === undefined
          ? {}
          : { activeIterationFrameKey: summary.loopProgress.activeIterationFrameKey }),
        activeChildNodeKeys: summary.loopProgress.activeChildNodeKeys,
      },
    }),
    ...(summary.output === undefined ? {} : { output: summary.output }),
    ...(summary.failure === undefined ? {} : { failure: projectFailure(summary.failure) }),
    artifacts: summary.artifacts.map(artifact => ({
      id: artifact.id,
      path: artifact.path,
      size: artifact.size,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
    })),
    ...(signal === undefined ? {} : {
      awaitingSignal: {
        target: signal.target,
        ...(signal.promptPreview === undefined ? {} : { prompt: signal.promptPreview }),
      },
    }),
  };
}

function projectFailure(
  failure: NonNullable<RunInspectionTargetDetailsDocument["summary"]["failure"]>,
): NodeInspectionFailure {
  const upstream = failure.upstream;
  return {
    origin: failure.origin,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    message: failure.message,
    ...(upstream === undefined ? {} : {
      upstream: {
        source: upstream.source,
        ...(upstream.operation === undefined ? {} : { operation: upstream.operation }),
        ...(upstream.exitCode === undefined ? {} : { exitCode: upstream.exitCode }),
        ...(upstream.code === undefined ? {} : { code: upstream.code }),
        ...(upstream.origin === undefined ? {} : { origin: upstream.origin }),
        ...(upstream.protocol === undefined ? {} : {
          protocol: {
            name: upstream.protocol.name,
            ...(upstream.protocol.code === undefined ? {} : { code: upstream.protocol.code }),
            ...(upstream.protocol.message === undefined ? {} : { message: upstream.protocol.message }),
          },
        }),
        ...(upstream.data === undefined ? {} : { data: upstream.data }),
      },
    }),
  };
}

export function projectNodeExecution(
  execution: RunInspectionAgentExecutionDocument,
): NodeExecutionInspection {
  const projection = {
    summary: {
      status: execution.summary.status,
      ...(execution.summary.sessionName === undefined ? {} : { sessionName: execution.summary.sessionName }),
      ...(execution.summary.turnCount === undefined ? {} : { turnCount: execution.summary.turnCount }),
      ...(execution.summary.message === undefined ? {} : { message: execution.summary.message }),
    },
    ...(execution.lastObservedAt === undefined ? {} : { lastObservedAt: execution.lastObservedAt }),
    ...(execution.contextWindow === undefined ? {} : {
      contextWindow: {
        ...(execution.contextWindow.used === undefined ? {} : { used: execution.contextWindow.used }),
        ...(execution.contextWindow.size === undefined ? {} : { size: execution.contextWindow.size }),
        ...(execution.contextWindow.percent === undefined ? {} : { percent: execution.contextWindow.percent }),
        ...(execution.contextWindow.updatedAt === undefined ? {} : { updatedAt: execution.contextWindow.updatedAt }),
      },
    }),
    ...(execution.tokenUsage === undefined ? {} : {
      tokenUsage: {
        ...(execution.tokenUsage.source === undefined ? {} : { source: execution.tokenUsage.source }),
        ...(execution.tokenUsage.inputTokens === undefined ? {} : { inputTokens: execution.tokenUsage.inputTokens }),
        ...(execution.tokenUsage.outputTokens === undefined ? {} : { outputTokens: execution.tokenUsage.outputTokens }),
        ...(execution.tokenUsage.totalTokens === undefined ? {} : { totalTokens: execution.tokenUsage.totalTokens }),
      },
    }),
    ...(execution.output === undefined ? {} : {
      output: {
        tail: execution.output.tail,
        totalBytes: execution.output.totalBytes,
        truncated: execution.output.truncated,
      },
    }),
    ...(execution.toolCallCount === undefined ? {} : { toolCallCount: execution.toolCallCount }),
    lastToolCalls: execution.lastToolCalls.map(tool => ({
      turn: tool.turn,
      ...(tool.toolCallId === undefined ? {} : { toolCallId: tool.toolCallId }),
      ...(tool.toolName === undefined ? {} : { toolName: tool.toolName }),
      ...(tool.status === undefined ? {} : { status: tool.status }),
      ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
      ...(tool.inputPreview === undefined ? {} : { inputPreview: tool.inputPreview }),
    })),
    recentToolsIncomplete: execution.recentToolsIncomplete,
  };
  return execution.available
    ? { available: true, ...projection }
    : {
      available: false,
      reason: execution.reason === "not-agent"
        ? "The selected scope is not an Agent node."
        : "No agent execution metadata exists for the selected scope.",
      ...projection,
    };
}
