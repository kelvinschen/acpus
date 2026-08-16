import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerSupervisorTools } from "../src/host/tools.js";

describe("Acpus Supervisor tool contract", () => {
  it("makes control scope and fork inheritance explicit", () => {
    const { tools } = registerTools({});
    const control = tool(tools, "acpus_control");
    const action = property(control, "action") as { oneOf: SchemaBranch[] };

    const branches = action.oneOf;
    expect(branches.filter(branch => branch.properties.type.const === "cancel"))
      .toEqual([
        expect.objectContaining({
          required: ["type", "scope"],
          properties: expect.objectContaining({
            scope: expect.objectContaining({ const: "task" }),
          }),
        }),
        expect.objectContaining({
          required: ["type", "scope", "target"],
          properties: expect.objectContaining({
            scope: expect.objectContaining({ const: "target" }),
          }),
        }),
      ]);

    const fork = branches.find(branch => branch.properties.type.const === "fork");
    if (fork === undefined) throw new Error("Expected the fork action schema.");
    expect(fork).toMatchObject({ required: ["type", "workflow", "input", "restart"] });
    expect(nestedTags(fork, "workflow"))
      .toEqual(["inherit", "replace"]);
    expect(nestedTags(fork, "input"))
      .toEqual(["inherit", "replace"]);
    expect(nestedTags(fork, "restart"))
      .toEqual(["compatible", "target"]);
  });

  it("treats read-only placeholder values as omitted", async () => {
    const tasks = vi.fn(async () => ({ tasks: [], truncated: false }));
    const inspect = vi.fn(async () => success({
      kind: "archived-run",
      run: { status: "completed" },
    }));
    const resolveTask = vi.fn(async () => selected({ inspect }));
    const { tools } = registerTools({ tasks, resolveTask });

    await expect(tool(tools, "acpus_tasks").execute(
      { name: "" },
      execution(),
    )).resolves.toEqual({ tasks: [], truncated: false });
    expect(tasks).toHaveBeenCalledWith("session", undefined);

    await expect(tool(tools, "acpus_inspect").execute(
      { task: { name: "", occurrence: 0 }, target: "", timeline: 0 },
      execution(),
    )).resolves.toEqual({
      task: { name: "workflow", occurrence: 1, status: "completed" },
      targets: [],
    });
    expect(resolveTask).toHaveBeenCalledWith("session", undefined);
    expect(inspect).toHaveBeenCalledWith({ kind: "run", runId: "run-1" });
  });

  it("treats zero timeline as Target summary detail", async () => {
    const inspect = vi.fn(async () => success({
      kind: "archived-run",
      run: { status: "completed" },
    }));
    const { tools } = registerTools({
      resolveTask: vi.fn(async () => selected({ inspect })),
    });

    await tool(tools, "acpus_inspect").execute(
      { target: "@target", timeline: 0 },
      execution(),
    );

    expect(inspect).toHaveBeenCalledWith({
      kind: "target",
      runId: "run-1",
      target: "@target",
      detail: "summary",
    });
  });

  it("maps explicit task and Target retry scopes without broadening", async () => {
    const control = vi.fn(async () => success({ type: "retry" }));
    const reconcileTask = vi.fn(async () => undefined);
    const { tools } = registerTools({
      resolveTask: vi.fn(async () => selected({ control })),
      reconcileTask,
    });
    const retry = tool(tools, "acpus_control");

    await retry.execute({
      task: { name: "workflow", occurrence: 1 },
      action: { type: "retry", scope: "task" },
    }, execution("task-retry"));
    await retry.execute({
      task: { name: "workflow", occurrence: 1 },
      action: { type: "retry", scope: "target", target: "@target" },
    }, execution("target-retry"));

    expect(control).toHaveBeenNthCalledWith(1, {
      requestId: "dsh-control:task-retry",
      type: "retry",
      runId: "run-1",
    });
    expect(control).toHaveBeenNthCalledWith(2, {
      requestId: "dsh-control:target-retry",
      type: "retry",
      runId: "run-1",
      target: "@target",
    });
    expect(reconcileTask).toHaveBeenCalledTimes(2);
  });

  it("preserves an explicit null fork input replacement", async () => {
    const control = vi.fn(async () => success({
      type: "fork",
      run: { id: "run-2", name: "workflow" },
    }));
    const linkFork = vi.fn(async () => ({ name: "workflow", occurrence: 2 }));
    const { tools } = registerTools({
      resolveTask: vi.fn(async () => selected({ control })),
      linkFork,
    });

    await expect(tool(tools, "acpus_control").execute({
      task: { name: "workflow", occurrence: 1 },
      action: {
        type: "fork",
        workflow: { type: "inherit" },
        input: { type: "replace", value: null },
        restart: { type: "compatible" },
      },
    }, execution("fork-null"))).resolves.toEqual({
      status: "applied",
      task: { name: "workflow", occurrence: 2 },
    });
    expect(control).toHaveBeenCalledWith({
      requestId: "dsh-control:fork-null",
      type: "fork",
      runId: "run-1",
      input: null,
    });
  });

  it("uses the artifact read limit when maxBytes is zero", async () => {
    const bytes = Buffer.alloc(64 * 1024 + 1, "a");
    const readArtifact = vi.fn(async () => success({
      artifact: { id: "artifact", size: bytes.length, mediaType: "text/plain" },
      bytes,
    }));
    const { tools } = registerTools({
      resolveTask: vi.fn(async () => selected({ readArtifact })),
    });

    const result = await tool(tools, "acpus_artifact").execute({
      task: { name: "workflow", occurrence: 1 },
      action: { type: "read", id: "artifact", maxBytes: 0 },
    }, execution());

    expect(result).toMatchObject({
      status: "read",
      truncated: true,
      content: expect.any(String),
    });
    expect((result as { content: string }).content).toHaveLength(64 * 1024);
  });
});

function registerTools(mode: Record<string, unknown>): { tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  const ctx = {
    tools: { register: (definition: ToolDefinition) => tools.push(definition) },
    get: (name: string) => name === "acpusMode" ? mode : undefined,
  } as unknown as Context;
  registerSupervisorTools(ctx);
  return { tools };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const definition = tools.find(candidate => candidate.name === name);
  if (definition === undefined) throw new Error(`Expected ${name} to be registered.`);
  return definition;
}

function property(definition: ToolDefinition, name: string): unknown {
  const properties = definition.parameters.properties as Record<string, unknown> | undefined;
  if (typeof properties !== "object" || properties === null) {
    throw new Error(`Expected ${definition.name} parameter properties.`);
  }
  return properties[name];
}

type SchemaProperty = {
  const?: string;
  oneOf?: SchemaBranch[];
};

type SchemaBranch = {
  properties: Record<string, SchemaProperty> & { type: SchemaProperty };
  required: string[];
};

function nestedTags(branch: SchemaBranch, name: string): Array<string | undefined> {
  const nested = branch.properties[name]?.oneOf;
  if (nested === undefined) throw new Error(`Expected nested ${name} choices.`);
  return nested.map(choice => choice.properties.type.const);
}

function selected(runtime: Record<string, unknown>) {
  return {
    runId: "run-1",
    workspace: "/workspace",
    runtime,
    generation: 1,
    selector: { name: "workflow", occurrence: 1 },
    link: { id: "link" },
  };
}

function success(value: unknown) {
  return { isErr: () => false, value };
}

function execution(callId = "call") {
  return {
    callId,
    signal: new AbortController().signal,
    agent: {
      id: "session",
      session: { header: { cwd: "/workspace" } },
    },
  } as never;
}
