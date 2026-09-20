import { realpath, stat } from "node:fs/promises";
import { addAbortListener } from "node:events";
import { isAbsolute } from "node:path";
import { resolveAcpusHome, withAcpusHome } from "@acpus/runtime";
import type { McpServer, CallToolResult, ServerContext, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as z from "zod/v4";
import { inspectRun } from "./inspection.js";
import { agentContext, artifact, controlRun, readGuide, runs, runWorkflow } from "./operations.js";
import { toolResult, type ToolFailure } from "./result.js";

export type RunTool = (effect: Effect.Effect<CallToolResult>, signal: AbortSignal) => Promise<CallToolResult>;

const nonempty = z.string().min(1).refine(value => value.trim().length > 0);
const workflowSource = {
  source: nonempty.describe("Inline TypeScript workflow source.").optional(),
  file: nonempty.describe("Workflow file path, absolute or relative to workspace.").optional(),
};
const workspace = nonempty.refine(isAbsolute, "workspace must be an absolute directory path").describe("Absolute project directory on the MCP server filesystem.");
const action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("resume") }),
  z.strictObject({ type: z.literal("cancel"), target: nonempty.optional() }),
  z.strictObject({ type: z.literal("retry"), target: nonempty }),
  z.strictObject({ type: z.literal("steer"), target: nonempty, instruction: z.string().min(1).refine(value => value.trim().length > 0) }),
  z.strictObject({ type: z.literal("signal"), target: nonempty, payload: z.json() }),
  z.strictObject({ type: z.literal("fork"), target: nonempty.optional(), ...workflowSource, input: z.json().optional(), agents: z.json().optional() })
    .refine(args => args.source === undefined || args.file === undefined, "Supply source or file, not both."),
]);

export const acpusInstructions = "ACPUS authors and executes typed TypeScript Workflows that orchestrate Agents and Tasks as durable, observable, controllable Runs. Before authoring, read acpus_guide for authoring rules and usage, then use acpus_agent for project-specific Agent context. Supply the task project’s absolute workspace on every project tool call; retain the returned workspace and runId for follow-up operations. Runs survive disconnect.";

export type AcpusToolHandler<Args extends Record<string, unknown> = Record<string, unknown>> =
  (args: Args, context: ServerContext) => Promise<CallToolResult>;

export interface AcpusMcpOptions {
  /** Wrap parsed tool calls with host context, observation, or result handling. */
  wrapTool?: <Args extends Record<string, unknown>>(name: string, handler: AcpusToolHandler<Args>) => AcpusToolHandler<Args>;
}

export function registerTools(server: McpServer, run: RunTool, options: AcpusMcpOptions = {}) {
  const acpusHome = resolveAcpusHome();

  function register<A extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: StandardSchemaWithJSON<unknown, A>,
    readOnly: boolean,
    execute: (args: A) => Effect.Effect<Record<string, unknown>, ToolFailure>,
  ) {
    const handler: AcpusToolHandler<A> = (args, ctx) => withAcpusHome(acpusHome, async () => {
      const signal = ctx.mcpReq.signal;
      const cancellation = new AbortController();
      // Abort listeners run in the caller's context; mutation confirmation must keep this Home.
      const abort = () => withAcpusHome(acpusHome, () => cancellation.abort(signal.reason));
      using _listener = addAbortListener(signal, abort);
      if (signal.aborted) abort();
      return await run(toolResult(execute(args)), cancellation.signal);
    });
    return server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON<unknown, A>>(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, ...(readOnly ? { destructiveHint: false, idempotentHint: true, openWorldHint: false } : {}) },
    }, options.wrapTool?.(name, handler) ?? handler);
  }

  function registerProject<A extends { workspace: string; runId?: string }>(
    name: string,
    description: string,
    inputSchema: StandardSchemaWithJSON<unknown, A>,
    readOnly: boolean,
    execute: (workspace: string, args: A) => Effect.Effect<Record<string, unknown>, ToolFailure>,
  ) {
    return register(name, description, inputSchema, readOnly, args => Effect.tryPromise({
      try: async () => {
        const path = await realpath(args.workspace);
        if (!(await stat(path)).isDirectory()) throw new Error(`Workspace '${path}' is not a directory.`);
        return path;
      },
      catch: error => ({ code: "INVALID_WORKSPACE", message: String(error), next: "Supply an accessible absolute project directory on the server filesystem." }),
    }).pipe(Effect.flatMap(workspace => execute(workspace, args).pipe(
      Effect.map(value => ({ workspace, ...(args.runId === undefined ? {} : { runId: args.runId }), ...value })),
      Effect.mapError(error => ({ workspace, ...(args.runId === undefined ? {} : { runId: args.runId }), ...error })),
    ))));
  }

  const acpus_guide = register("acpus_guide", "Read a bundled guide file or directory by a path listed in the guide. Omit path for the MCP usage guide and available topics.",
    z.strictObject({ path: nonempty.optional() }), true, args => readGuide(args.path));
  const acpus_agent = registerProject("acpus_agent", "Read the workspace, ACPUS Home, effective Agent scale and Preset choices. Scale is guidance, not a hard limit.",
    z.strictObject({ workspace }), true, workspace => agentContext(workspace));
  const acpus_run = registerProject("acpus_run", "Validate and run a workflow. Supply either source (TypeScript code) or file (path). Returns runId after durable admission; inspect it for results. Set dryRun only to validate without creating a Run. Preparation executes module code.",
    z.strictObject({ workspace, ...workflowSource, input: z.json().optional(), agents: z.json().optional(), dryRun: z.boolean().default(false) })
      .refine(args => (args.source === undefined) !== (args.file === undefined), "Supply exactly one of source or file."),
    false, (workspace, args) => runWorkflow(workspace, args));
  const acpus_list_runs = registerProject("acpus_list_runs", "List workspace Runs, optionally filtered by exact workflow name. Pass nextOffset to read the next page.",
    z.strictObject({ workspace, name: nonempty.optional(), offset: z.int().min(0).default(0), limit: z.int().min(1).max(200).default(50) }),
    true, (workspace, args) => runs(workspace, args.name, args.offset, args.limit));
  const acpus_inspect = registerProject("acpus_inspect", "Inspect a Run or exact target. Optionally wait up to 30 seconds for a decision boundary or completion. Timeout and request cancellation only detach observation; they never cancel the Run. Forensics requires target and cannot wait.",
    z.strictObject({
      workspace, runId: nonempty, target: nonempty.optional(), detail: z.enum(["summary", "timeline", "forensics"]).default("summary"),
      wait: z.enum(["decision", "terminal"]).optional(), timeoutMs: z.int().min(1).max(30_000).optional(),
    }), true, (workspace, args) => {
      if ((args.target === undefined && args.detail !== "summary") || (args.wait === undefined && args.timeoutMs !== undefined)) {
        return Effect.fail({ code: "INVALID_QUERY", message: "Detailed inspection requires target; timeoutMs requires wait.", next: "Supply a target or wait, or omit the dependent option." });
      }
      return inspectRun(workspace, args.target === undefined
        ? { kind: "run", runId: args.runId }
        : { kind: "target", runId: args.runId, target: args.target, detail: args.detail }, args.wait, args.timeoutMs);
    });
  const acpus_control = registerProject("acpus_control", "Apply one explicit Run control. Use exact target selectors from inspection. Fork inherits the workflow unless source or file is supplied, and inherits omitted input and Agent bindings. A receipt records the applied control, not completion of subsequent work.",
    z.strictObject({ workspace, runId: nonempty, action }), false, (workspace, args) => controlRun(workspace, args.runId, args.action));
  const acpus_artifact = registerProject("acpus_artifact", "List Run/target artifacts or read an artifact by ID. Text is limited to 64 KiB with an explicit truncated flag; binary artifacts return verified local paths and metadata.",
    z.strictObject({ workspace, runId: nonempty, action: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("list"), target: nonempty.optional() }),
      z.strictObject({ type: z.literal("read"), id: nonempty }),
    ]) }), true, (workspace, args) => artifact(workspace, args.runId, args.action));
  return { acpus_guide, acpus_agent, acpus_run, acpus_list_runs, acpus_inspect, acpus_control, acpus_artifact };
}
