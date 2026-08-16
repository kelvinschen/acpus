import type { JsonValue as AcpusJsonValue } from "@acpus/expression/ir";
import type {
  InspectionRead,
} from "@acpus/runtime";
import type { RuntimeControlIntent } from "@acpus/runtime/host";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import type { Context } from "@deepseek-ai/cordis";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import {
  defineTool,
  type JsonValue as DshJsonValue,
  type ParameterPropertySpec,
  type ToolRunContext,
  type ValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import type { UpdateAgentProfilesInput } from "./agent-profiles.js";
import type { AcpusMode } from "./mode.js";
import {
  normalizeAuthoringInput,
  prepareAuthoringWorkflow,
  type InvalidWorkflow,
} from "./submission.js";
import type { DelegatedTaskSelector, ResolvedTaskSelector } from "../task.js";

const JSON_OUTPUT = { type: "json" } as const;
const TARGET_LIMIT = 50;
const ARTIFACT_LIMIT = 50;
const ARTIFACT_READ_LIMIT = 64 * 1024;
const TOOL_TEXT_LIMIT = 64 * 1024;
const TOOL_IDENTITY_LIMIT = 1_024;
const CONTROL_STATUSES = new Set(["running", "awaiting", "failed", "timed_out"]);
type InspectionTreeEntry = Extract<InspectionRead, { kind: "run" }>["tree"][number];

type ControlAction =
  | { type: "pause" | "resume" }
  | { type: "cancel" | "retry"; scope: "task" }
  | { type: "cancel" | "retry"; scope: "target"; target: string }
  | { type: "steer"; target: string; instruction: string }
  | { type: "signal"; target: string; payload: DshJsonValue }
  | {
      type: "fork";
      workflow:
        | { type: "inherit" }
        | { type: "replace"; source: string };
      input:
        | { type: "inherit" }
        | { type: "replace"; value: DshJsonValue };
      restart:
        | { type: "compatible" }
        | { type: "target"; target: string };
    };

export function registerSupervisorTools(ctx: Context): void {
  ctx.tools.register(profilesTool(ctx));
  ctx.tools.register(tasksTool(ctx));
  ctx.tools.register(runTool(ctx));
  ctx.tools.register(inspectTool(ctx));
  ctx.tools.register(controlTool(ctx));
  ctx.tools.register(artifactTool(ctx));
}

function profilesTool(ctx: Context) {
  return defineTool({
    name: "acpus_profiles",
    description: "Atomically set or remove user-defined Agent Profiles. The built-in dsh Profile is immutable. Changes become visible in the next model step's System Prompt.",
    parameters: {
      changes: {
        type: "array",
        required: true,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                operation: { type: "string", const: "set", required: true },
                profile: {
                  type: "object",
                  required: true,
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true },
                    use: { type: "string", required: true },
                    model: {
                      type: "string",
                      description: "Optional model override. Omit this field to inherit the Agent default; an empty string is treated as omitted.",
                    },
                    guidance: { type: "string", required: true },
                  },
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                operation: { type: "string", const: "remove", required: true },
                id: { type: "string", required: true },
              },
            },
          ],
        },
      },
    },
    output: output(),
    async execute(args) {
      return json(await mode(ctx).updateAgentProfiles(
        args as unknown as UpdateAgentProfilesInput,
      ));
    },
  });
}

function tasksTool(ctx: Context) {
  return defineTool({
    name: "acpus_tasks",
    description: "List up to 50 recent delegated tasks with exact selectors and fork ancestry.",
    parameters: {
      name: {
        type: "string",
        description: "Exact workflow name filter. Omit this field to list all tasks; an empty string is treated as omitted.",
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await mode(ctx).tasks(
        String(initiatingAgent(exec).id),
        args.name || undefined,
      );
      return json({
        tasks: result.tasks.slice(0, 50).map(item => ({
          task: item.task,
          status: item.status,
          ...(item.forkedFrom === undefined ? {} : { forkedFrom: item.forkedFrom }),
        })),
        truncated: result.truncated || result.tasks.length > 50,
      });
    },
  });
}

function runTool(ctx: Context) {
  return defineTool({
    name: "acpus_run",
    description: "Validate and durably admit an authored Acpus workflow. Authoring failures are returned as structured diagnostics.",
    parameters: {
      workflow: { type: "string", required: true },
      input: {
        type: "json",
        description: "Workflow business input. Omit this field to use an empty object; explicit JSON values including null are preserved.",
      },
    },
    output: {
      ...output(),
      presentationMeta: (_args, value) => value,
    },
    presentCall: () => ({ card: "generic", title: "Delegate task", kind: "execute" }),
    presentResult: () => ({ card: "generic", title: "DSH is solving your task" }),
    async execute(args, exec) {
      const agent = initiatingAgent(exec);
      const result = await mode(ctx).run({
        workspace: workspace(exec),
        sessionId: String(agent.id),
        toolCallId: String(exec.callId),
        workflow: args.workflow,
        ...(args.input === undefined ? {} : { input: args.input as AcpusJsonValue }),
        signal: exec.signal,
      });
      return json(result.status === "admitted"
        ? { status: "admitted", task: result.task }
        : result);
    },
  });
}

function inspectTool(ctx: Context) {
  return defineTool({
    name: "acpus_inspect",
    description: "Read one point-in-time snapshot of the latest task by default, or an exact task/target. This does not wait for progress; Signal and terminal states arrive as host notices. Task summaries expose only control-relevant Target selectors.",
    parameters: {
      task: taskParameter(false),
      target: {
        type: "string",
        description: "Exact Target selector. Omit this field to inspect the task summary; an empty string is treated as omitted.",
      },
      timeline: {
        type: "integer",
        description: "Recent Target timeline entries from 1 to 20. Use only with target; omit this field for summary detail. Zero is treated as omitted.",
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = args.target || undefined;
      const timeline = args.timeline || undefined;
      const requestedTask = args.task as DelegatedTaskSelector | undefined;
      const task = requestedTask?.name === "" && requestedTask.occurrence === 0
        ? undefined
        : requestedTask;
      if (timeline !== undefined
        && (target === undefined || timeline < 1 || timeline > 20)) {
        throw failure("timeline requires target and must be from 1 to 20.", "ACPUS_INSPECT_INVALID");
      }
      const selected = await mode(ctx).resolveTask(
        String(initiatingAgent(exec).id),
        task,
      );
      const result = await selected.runtime.inspect(target === undefined
        ? { kind: "run", runId: selected.runId }
        : {
            kind: "target",
            runId: selected.runId,
            target,
            detail: timeline === undefined ? "summary" : "timeline",
          });
      if (result.isErr()) {
        throw failure(hideRunIdentity(result.error.message, selected.runId), "ACPUS_INSPECT_FAILED");
      }
      return json(compactInspection(
        result.value,
        selected.selector,
        timeline,
      ));
    },
  });
}

function controlTool(ctx: Context) {
  return defineTool({
    name: "acpus_control",
    description: "Apply one control action to an exact delegated task. Expected control refusals are returned as rejected results.",
    parameters: {
      task: taskParameter(true),
      action: {
        required: true,
        oneOf: [
          actionSchema("pause"),
          actionSchema("resume"),
          actionSchema("cancel", {
            scope: { type: "string", const: "task", required: true },
          }),
          actionSchema("cancel", {
            scope: { type: "string", const: "target", required: true },
            target: { type: "string", required: true },
          }),
          actionSchema("retry", {
            scope: { type: "string", const: "task", required: true },
          }),
          actionSchema("retry", {
            scope: { type: "string", const: "target", required: true },
            target: { type: "string", required: true },
          }),
          actionSchema("steer", {
            target: { type: "string", required: true },
            instruction: { type: "string", required: true },
          }),
          actionSchema("signal", {
            target: { type: "string", required: true },
            payload: { type: "json", required: true },
          }),
          actionSchema("fork", {
            workflow: {
              required: true,
              description: "Inherit the source workflow or replace it with authored TypeScript source.",
              oneOf: [
                actionSchema("inherit"),
                actionSchema("replace", {
                  source: { type: "string", required: true },
                }),
              ],
            },
            input: {
              required: true,
              description: "Inherit the source input or replace it with an explicit JSON value.",
              oneOf: [
                actionSchema("inherit"),
                actionSchema("replace", {
                  value: { type: "json", required: true },
                }),
              ],
            },
            restart: {
              required: true,
              description: "Use compatibility-based reuse or restart from one exact source Target.",
              oneOf: [
                actionSchema("compatible"),
                actionSchema("target", {
                  target: { type: "string", required: true },
                }),
              ],
            },
          }),
        ],
      },
    },
    output: output(),
    async execute(args, exec) {
      const service = mode(ctx);
      const agent = initiatingAgent(exec);
      const selected = await service.resolveTask(
        String(agent.id),
        args.task as DelegatedTaskSelector,
      );
      const action = args.action as unknown as ControlAction;
      const prepared = await prepareFork(action, selected.workspace);
      if (prepared.status === "invalid") return json(prepared);
      const intent = controlIntent(
        action,
        selected.runId,
        String(exec.callId),
        prepared.prepared,
        prepared.input,
      );
      const cancel = action.type === "cancel"
        ? await service.prepareModelCancel(
            String(agent.id),
            selected.generation,
            intent.requestId,
          )
        : undefined;
      if (cancel?.status === "rejected") {
        return json({ status: "rejected", reason: cancel.reason, task: selected.selector });
      }
      const result = await selected.runtime.control(intent);
      if (result.isErr()) {
        if (cancel?.status === "ready") {
          await service.settleModelCancel(
            cancel.control.id,
            "rejected",
            result.error.code === "RUN_NOT_CONTROLLABLE"
              ? "not-controllable"
              : "temporarily-unavailable",
          );
        }
        return json({
          status: "rejected",
          reason: hideRunIdentity(result.error.message, selected.runId),
          task: selected.selector,
        });
      }
      if (cancel?.status === "ready") {
        await service.settleModelCancel(cancel.control.id, "applied");
      }
      let task = selected.selector;
      if (result.value.type === "fork") {
        task = await service.linkFork(
          String(agent.id),
          String(exec.callId),
          selected.generation,
          selected.workspace,
          result.value.run,
        );
      } else {
        await service.reconcileTask(selected.link);
      }
      return json({ status: "applied", task });
    },
  });
}

function artifactTool(ctx: Context) {
  return defineTool({
    name: "acpus_artifact",
    description: "List safe artifact metadata or read bounded text/JSON content from an exact delegated task.",
    parameters: {
      task: taskParameter(true),
      action: {
        required: true,
        oneOf: [
          actionSchema("list"),
          actionSchema("read", {
            id: { type: "string", required: true },
            maxBytes: {
              type: "integer",
              description: `Maximum bytes from 1 to ${ARTIFACT_READ_LIMIT}. Omit this field for ${ARTIFACT_READ_LIMIT}; zero is treated as omitted.`,
            },
          }),
        ],
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const selected = await mode(ctx).resolveTask(
        String(initiatingAgent(exec).id),
        args.task as DelegatedTaskSelector,
      );
      const action = args.action as unknown as
        | { type: "list" }
        | { type: "read"; id: string; maxBytes?: number };
      if (action.type === "list") {
        const listed = await selected.runtime.listArtifacts(selected.runId);
        if (listed.isErr()) {
          throw failure(hideRunIdentity(listed.error.message, selected.runId), "ACPUS_ARTIFACT_READ_FAILED");
        }
        if (listed.value === undefined) {
          throw failure("The selected delegated task was not found.", "ACPUS_TASK_NOT_FOUND");
        }
        return json({
          artifacts: listed.value.slice(0, ARTIFACT_LIMIT).map(safeArtifact),
          truncated: listed.value.length > ARTIFACT_LIMIT,
        });
      }
      const maxBytes = action.maxBytes || ARTIFACT_READ_LIMIT;
      if (maxBytes < 1 || maxBytes > ARTIFACT_READ_LIMIT) {
        throw failure(`maxBytes must be from 1 to ${ARTIFACT_READ_LIMIT}.`, "ACPUS_ARTIFACT_INVALID");
      }
      const read = await selected.runtime.readArtifact(selected.runId, action.id);
      if (read.isErr()) {
        throw failure(hideRunIdentity(read.error.message, selected.runId), "ACPUS_ARTIFACT_READ_FAILED");
      }
      if (read.value === undefined) {
        throw failure(`Artifact '${action.id}' was not found.`, "ACPUS_ARTIFACT_NOT_FOUND");
      }
      const artifact = safeArtifact(read.value.artifact);
      if (!isTextArtifact(read.value.artifact.mediaType)) {
        return json({ status: "unreadable", artifact, reason: "binary" });
      }
      const bytes = read.value.bytes.subarray(0, maxBytes);
      const text = bytes.toString("utf8").replace(/\uFFFD$/u, "");
      const truncated = read.value.bytes.length > bytes.length;
      if (!truncated && isJsonArtifact(read.value.artifact.mediaType)) {
        try {
          return json({ status: "read", artifact, content: JSON.parse(text), truncated: false });
        } catch {
          // A declared JSON artifact can still be incomplete or non-standard; expose it as text.
        }
      }
      return json({ status: "read", artifact, content: text, truncated });
    },
  });
}

async function prepareFork(
  action: ControlAction,
  workspace: string,
): Promise<{
  status: "ready";
  prepared?: PreparedWorkflow;
  input?: AcpusJsonValue;
} | InvalidWorkflow> {
  if (action.type !== "fork") return { status: "ready" };
  const prepared = action.workflow.type === "replace"
    ? await prepareAuthoringWorkflow(workspace, action.workflow.source)
    : undefined;
  if (prepared?.status === "invalid") return prepared;
  if (action.input.type === "inherit") {
    return {
      status: "ready",
      ...(prepared === undefined ? {} : { prepared: prepared.prepared }),
    };
  }
  if (prepared === undefined) {
    return { status: "ready", input: action.input.value as AcpusJsonValue };
  }
  const normalized = normalizeAuthoringInput(
    prepared.prepared,
    action.input.value as AcpusJsonValue,
  );
  if (normalized.status === "invalid") return normalized;
  return { status: "ready", prepared: prepared.prepared, input: normalized.input };
}

function controlIntent(
  action: ControlAction,
  runId: string,
  callId: string,
  prepared?: PreparedWorkflow,
  input?: AcpusJsonValue,
): RuntimeControlIntent {
  const requestId = `dsh-control:${callId}`;
  switch (action.type) {
    case "pause":
    case "resume":
      return { requestId, type: action.type, runId };
    case "retry":
    case "cancel":
      return {
        requestId,
        type: action.type,
        runId,
        ...(action.scope === "target" ? { target: action.target } : {}),
      };
    case "steer":
      return { requestId, type: "steer", runId, target: action.target, instruction: action.instruction };
    case "signal":
      return { requestId, type: "signal", runId, nodeId: action.target, payload: action.payload as AcpusJsonValue };
    case "fork":
      return {
        requestId,
        type: "fork",
        runId,
        ...(action.restart.type === "target" ? { target: action.restart.target } : {}),
        ...(prepared === undefined ? {} : { prepared }),
        ...(input === undefined ? {} : { input }),
      };
  }
}

function compactInspection(
  value: InspectionRead,
  selector: ResolvedTaskSelector,
  timeline?: number,
): unknown {
  if (value.kind === "candidates") {
    return {
      status: "ambiguous",
      task: { ...selector, status: value.run.status },
      requestedTarget: boundedIdentity(value.target),
      candidates: value.entries.slice(0, TARGET_LIMIT).map(entry => ({
        target: boundedIdentity(entry.selector),
        status: entry.status,
        breadcrumb: boundedText(entry.breadcrumb),
      })),
      candidatesTruncated: value.entries.length > TARGET_LIMIT,
    };
  }
  if (value.kind === "archived-run") {
    return { task: { ...selector, status: value.run.status }, targets: [] };
  }
  if (value.kind === "run") {
    const targets = collectTargets(value.tree);
    const attention = firstAttention(value.tree);
    return {
      task: { ...selector, status: value.run.status },
      ...(value.output === undefined ? {} : { result: boundedJson(value.output) }),
      ...(value.run.failure === undefined ? {} : { failure: value.run.failure }),
      ...(attention === undefined ? {} : { attention }),
      targets: targets.items,
      targetsTruncated: targets.truncated,
    };
  }
  const subject = {
    target: boundedIdentity(value.subject.selector ?? value.subject.label),
    label: boundedIdentity(value.subject.label),
    kind: boundedIdentity(value.subject.kind),
    status: value.state.status,
  };
  if (value.detail === "timeline") {
    return {
      task: { ...selector, status: value.run.status },
      subject,
      ...(value.current === undefined ? {} : { current: value.current }),
      recent: value.recent.slice(-(timeline ?? 20)),
    };
  }
  if (value.detail === "forensics") return { task: selector, subject };
  return {
    task: { ...selector, status: value.run.status },
    subject,
    ...(value.state.failure === undefined ? {} : { failure: value.state.failure }),
    ...(value.pulse === undefined ? {} : { summary: value.pulse }),
    ...(value.attention === undefined ? {} : { attention: value.attention }),
    ...(value.visibility === undefined ? {} : { visibility: value.visibility }),
  };
}

function collectTargets(tree: InspectionTreeEntry[]): {
  items: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  const items: Array<Record<string, unknown>> = [];
  let truncated = false;
  const visit = (entries: InspectionTreeEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "item" && entry.subject.selector !== undefined
        && CONTROL_STATUSES.has(entry.state.status)) {
        if (items.length === TARGET_LIMIT) {
          truncated = true;
        } else {
          items.push({
            target: boundedIdentity(entry.subject.selector),
            label: boundedIdentity(entry.subject.label),
            kind: boundedIdentity(entry.subject.kind),
            status: entry.state.status,
            ...(entry.attention?.summary === undefined && entry.pulse?.headline === undefined
              ? {}
              : { summary: boundedText(entry.attention?.summary ?? entry.pulse?.headline ?? "") }),
          });
        }
      }
      visit(entry.children);
    }
  };
  visit(tree);
  return { items, truncated };
}

function firstAttention(tree: InspectionTreeEntry[]): Record<string, unknown> | undefined {
  for (const entry of tree) {
    if (entry.type === "item" && entry.attention !== undefined) {
      return {
        target: entry.subject.selector,
        ...entry.attention,
      };
    }
    const child = firstAttention(entry.children);
    if (child !== undefined) return child;
  }
  return undefined;
}

function actionSchema(
  type: string,
  properties: Record<string, ParameterPropertySpec> = {},
): ValueSchemaSpec {
  return {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      type: { type: "string" as const, const: type, required: true as const },
      ...properties,
    },
  };
}

function taskParameter(required: boolean): ParameterPropertySpec {
  const schema: ParameterPropertySpec = {
    type: "object" as const,
    description: required
      ? "Exact delegated task selector."
      : "Exact delegated task selector. Omit this field to select the latest task.",
    additionalProperties: false,
    properties: {
      name: {
        type: "string" as const,
        required: true as const,
        description: "Exact non-empty workflow name.",
      },
      occurrence: {
        type: "integer" as const,
        required: true as const,
        description: "Positive task occurrence.",
      },
    },
  };
  return required ? { ...schema, required: true } : schema;
}

function output() {
  return { schema: JSON_OUTPUT, render: (_args: unknown, value: DshJsonValue) => text(value) };
}

function safeArtifact(artifact: { id: string; size: number; mediaType?: string }) {
  return {
    id: boundedIdentity(artifact.id),
    size: artifact.size,
    ...(artifact.mediaType === undefined ? {} : { mediaType: boundedIdentity(artifact.mediaType) }),
  };
}

function isJsonArtifact(mediaType?: string): boolean {
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function isTextArtifact(mediaType?: string): boolean {
  return mediaType?.startsWith("text/") === true || isJsonArtifact(mediaType);
}

function boundedJson(value: AcpusJsonValue): AcpusJsonValue | { text: string; truncated: true } {
  const source = JSON.stringify(value);
  return Buffer.byteLength(source, "utf8") <= TOOL_TEXT_LIMIT
    ? value
    : { text: truncateUtf8(source, TOOL_TEXT_LIMIT), truncated: true };
}

function mode(ctx: Context): AcpusMode {
  const service = ctx.get("acpusMode") as AcpusMode | undefined;
  if (service === undefined) throw failure("Acpus mode Host service is unavailable.", "ACPUS_HOST_UNAVAILABLE");
  return service;
}

function initiatingAgent(exec: ToolRunContext) {
  if (exec.agent === undefined) throw failure("Acpus tools require an initiating DSH Agent.", "ACPUS_SESSION_REQUIRED");
  return exec.agent;
}

function workspace(exec: ToolRunContext): string {
  const cwd = initiatingAgent(exec).session.header.cwd;
  if (cwd === undefined) throw failure("Acpus mode requires a workspace.", "ACPUS_WORKSPACE_REQUIRED");
  return cwd;
}

function text(value: DshJsonValue) {
  return [{ type: "text" as const, text: JSON.stringify(value) }];
}

function hideRunIdentity(message: string, runId: string): string {
  return message.split(runId).join("the selected delegated task");
}

function boundedText(value: string): string {
  return truncateUtf8(value, TOOL_TEXT_LIMIT);
}

function boundedIdentity(value: string): string {
  return truncateUtf8(value, TOOL_IDENTITY_LIMIT);
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return Buffer.from(value).subarray(0, limit).toString("utf8").replace(/\uFFFD$/u, "");
}

function json(value: unknown): DshJsonValue {
  return JSON.parse(JSON.stringify(value)) as DshJsonValue;
}

function failure(message: string, code: string): HarnessError {
  return new HarnessError(message, code);
}
