import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileYaml, createTestInterpreter } from "../interpreter/helper.js";
import { HookRunner } from "../../src/hooks/runner.js";
import { HookJournal } from "../../src/hooks/journal.js";
import type { HookConfig, HookJournalEntry } from "@acpus/core";

describe("Hooks integration", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  function setup(config: HookConfig, opts?: Parameters<typeof createTestInterpreter>[0]) {
    const ctx = createTestInterpreter({
      ...opts,
      interpreterOptions: { hookRunner: new HookRunner(config), nowTimestamp: "2025-01-01T00:00:00Z", sleep: () => Promise.resolve() }
    });
    cleanups.push(ctx.cleanup);
    return ctx;
  }

  const programWf = `
version: 1
name: hook-prog
workflow:
  steps:
    - id: step
      run: program
      cmd: ["sh", "-c", "echo \\\"env=$INJECTED\\\""]
      capture:
        from: stdout
        parse: text
`;

  it("beforeProgramExec injects only env into the subprocess", async () => {
    const config: HookConfig = {
      injectors: {
        beforeProgramExec: [
          { command: `printf '{"prependPrompt":"ignored-for-program","env":{"INJECTED":"yes"}}'` }
        ]
      }
    };
    const ir = compileYaml(programWf);
    const { interpreter, store } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "step");
    expect(String((node?.output as { output?: string })?.output)).toContain("env=yes");
  });

  it("an injector failure under fail policy fails the node with hook_failure", async () => {
    const config: HookConfig = {
      injectors: { beforeProgramExec: [{ command: "exit 7" }] }
    };
    const ir = compileYaml(programWf);
    const { interpreter, store } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "step");
    expect(node?.state).toBe("failed");
    expect(node?.error).toContain("beforeProgramExec");
  });

  it("an injector failure under skip policy continues without injecting", async () => {
    const config: HookConfig = {
      injectors: { beforeProgramExec: [{ command: "exit 1", on_failure: "skip" }] }
    };
    const ir = compileYaml(programWf);
    const { interpreter, store } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "step");
    expect(String((node?.output as { output?: string })?.output)).toContain("env=");
  });

  it("records program injector journal entries with env only", async () => {
    const config: HookConfig = {
      injectors: { beforeProgramExec: [{ command: `printf '{"prependPrompt":"ignored","env":{"JOURNALED":"yes"}}'` }] }
    };
    const ir = compileYaml(programWf);
    const { interpreter, store, tmpDir } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    const entries = new HookJournal(join(tmpDir, meta.runId)).read();
    expect(entries).toHaveLength(1);
    expect(entries[0].injector).toBe("beforeProgramExec");
    expect(entries[0].prepend_prompt).toBeNull();
    expect(entries[0].env).toEqual({ JOURNALED: "yes" });
    expect(entries[0].node_attempt).toBe(1);
  });

  it("fires beforeRun/afterRun and node lifecycle events into a sink file", async () => {
    const sink = join(setupTmp(), "events.log");
    const config: HookConfig = {
      events: {
        beforeRun: [appendEvent(sink, "beforeRun")],
        afterRun: [appendEvent(sink, "afterRun")],
        onNodeStart: [appendEvent(sink, "onNodeStart")],
        onNodeComplete: [appendEvent(sink, "onNodeComplete")]
      }
    };
    const ir = compileYaml(programWf);
    const { interpreter } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const lines = readFileSync(sink, "utf8").trim().split("\n");
    // beforeRun first, afterRun last; node start before node complete.
    expect(lines[0]).toBe("beforeRun");
    expect(lines.at(-1)).toBe("afterRun");
    expect(lines.indexOf("onNodeStart")).toBeLessThan(lines.indexOf("onNodeComplete"));
  });

  it("onNodeError fires when a node fails and never changes outcome", async () => {
    const sink = join(setupTmp(), "err.log");
    const config: HookConfig = {
      events: { onNodeError: [appendEvent(sink, "onNodeError"), { command: "exit 9" }] }
    };
    const ir = compileYaml(`
version: 1
name: hook-fail
workflow:
  steps:
    - id: boom
      run: program
      cmd: ["sh", "-c", "exit 4"]
`);
    const { interpreter, store } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    expect(store.listNodeStates(meta.runId).find((n) => n.nodeId === "boom")?.state).toBe("failed");
    expect(readFileSync(sink, "utf8")).toContain("onNodeError");
  });

  it("beforeAgentExec prepends prependPrompt to the agent prompt once", async () => {
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: `printf '{"prependPrompt":"INJECTED-CTX"}'` }] }
    };
    const ir = compileYaml(`
version: 1
name: hook-agent
agents:
  mock:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: think
      run: agent
      use: mock
      prompt: "do the thing"
`);
    const { interpreter, store } = setup(config, { agentResponses: { think: { value: "ok" } } });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const node = store.listNodeStates(meta.runId).find((n) => n.nodeId === "think");
    expect(node?.renderedPrompt).toContain("INJECTED-CTX");
    expect(node?.renderedPrompt).toContain("do the thing");
  });

  it("labels an injector-caused node failure with failure_kind hook_failure", async () => {
    const sink = join(setupTmp(), "err.json");
    const config: HookConfig = {
      injectors: { beforeProgramExec: [{ command: "exit 5" }] },
      events: { onNodeError: [capturePayload(sink)] }
    };
    const ir = compileYaml(programWf);
    const { interpreter } = setup(config, { useRealProgramExecutor: true });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("failed");
    const payload = JSON.parse(readFileSync(sink, "utf8").trim().split("\n")[0]);
    expect(payload.failure_kind).toBe("hook_failure");
  });

  it("does not re-run beforeAgentExec across internal auto-retry", async () => {
    const countSink = join(setupTmp(), "count");
    const config: HookConfig = {
      injectors: { beforeAgentExec: [{ command: `printf x >> '${countSink}'; printf '{}'` }] }
    };
    const ir = compileYaml(`
version: 1
name: hook-agent-retry
agents:
  mock:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: think
      run: agent
      use: mock
      prompt: "go"
      retry:
        max: 2
      output:
        ok: boolean
`);
    // First two attempts return schema-invalid output (triggers auto-retry),
    // third returns valid — all within one executeAgent call.
    const { interpreter, store } = setup(config, {
      agentResponses: { think: { sequence: [{ output: { bad: true } }, { output: { bad: true } }, { output: { ok: true } }] } }
    });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    // Injector fired exactly once despite multiple internal attempts.
    expect(readFileSync(countSink, "utf8")).toBe("x");
  });

  it("onStateChange does not fire for telemetry-only writes", async () => {
    const sink = join(setupTmp(), "states.json");
    const config: HookConfig = {
      events: { onStateChange: [capturePayload(sink)] }
    };
    const ir = compileYaml(`
version: 1
name: hook-agent-states
agents:
  mock:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: think
      run: agent
      use: mock
      prompt: "go"
`);
    const { interpreter } = setup(config, { agentResponses: { think: { value: "ok" } } });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const payloads = readFileSync(sink, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const agentTransitions = payloads
      .filter((p) => p.node_id === "think")
      .map((p) => `${p.from_state}->${p.to_state}`);
    // Exactly two transitions for the agent node — no self-transition emitted by
    // the running-attempt telemetry writes during execution.
    expect(agentTransitions).toEqual(["pending->running", "running->completed"]);
  });

  it("populates parent, composite, and agent payload fields", async () => {
    const sink = join(setupTmp(), "complete.json");
    const config: HookConfig = {
      events: { onNodeComplete: [capturePayload(sink)] }
    };
    const ir = compileYaml(`
version: 1
name: hook-fields
agents:
  mock:
    type: command
    use: "echo stub"
    model: sonnet
workflow:
  steps:
    - id: group
      max_concurrency: 2
      parallel:
        - id: think
          run: agent
          use: mock
          prompt: "go"
`);
    const { interpreter } = setup(config, { agentResponses: { think: { value: "ok" } } });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const payloads = readFileSync(sink, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const agentP = payloads.find((p) => p.node_id === "think");
    expect(agentP.parent_node_kind).toBe("parallel");
    expect(agentP.parent_node_key).toContain("group");
    expect(agentP.agent_type).toBe("command");
    expect(agentP.agent_model).toBe("sonnet");
    expect(agentP.is_retry).toBeUndefined(); // events don't set is_retry
    const parallelP = payloads.find((p) => p.node_id === "group");
    expect(parallelP.node_kind).toBe("parallel");
    expect(parallelP.max_concurrency).toBe(2);
  });

  it("populates nested agent telemetry on agent event payloads only", async () => {
    const sink = join(setupTmp(), "telemetry.json");
    const config: HookConfig = {
      events: { onNodeComplete: [capturePayload(sink)] }
    };
    const ir = compileYaml(`
version: 1
name: hook-agent-telemetry
agents:
  mock:
    type: command
    use: "echo stub"
workflow:
  steps:
    - id: think
      run: agent
      use: mock
      prompt: "go"
    - id: program
      run: program
      cmd: "echo ok"
`);
    const { interpreter } = setup(config, {
      useRealProgramExecutor: true,
      agentResponses: {
        think: {
          output: { ok: true },
          transcript: [
            JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 25, size: 100 } } }),
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, cachedWriteTokens: 2, thoughtTokens: 1, totalTokens: 21 } } })
          ].join("\n") + "\n"
        }
      }
    });
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const payloads = readFileSync(sink, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const agentP = payloads.find((p) => p.node_id === "think");
    expect(agentP.agent_telemetry).toMatchObject({
      attempt: 1,
      state: "completed",
      context: { used: 25, size: 100 },
      token_usage: {
        source: "prompt_response",
        input_tokens: 10,
        output_tokens: 5,
        cached_read_tokens: 3,
        cached_write_tokens: 2,
        thought_tokens: 1,
        total_tokens: 21
      }
    });
    expect(agentP.agent_telemetry.updated_at).toBeDefined();
    expect(agentP.agent_telemetry.context.updated_at).toBeDefined();
    const programP = payloads.find((p) => p.node_id === "program");
    expect(programP.agent_telemetry).toBeUndefined();
  });

  it("beforeRun fires once and is skipped on run retry", async () => {
    const sink = join(setupTmp(), "run.log");
    const config: HookConfig = {
      events: {
        beforeRun: [appendEvent(sink, "beforeRun")],
        afterRun: [appendEvent(sink, "afterRun")]
      }
    };
    const ir = compileYaml(`
version: 1
name: hook-run-retry
workflow:
  steps:
    - id: boom
      run: program
      cmd: ["sh", "-c", "exit 3"]
`);
    const { interpreter } = setup(config, { useRealProgramExecutor: true });
    const first = await interpreter.start(ir, { input: {} });
    expect(first.status).toBe("failed");
    // Run-level retry re-executes without re-firing beforeRun.
    interpreter.retryRun(first.runId);
    await interpreter.runToCompletion(ir, { input: {} }, first.runId);
    const lines = readFileSync(sink, "utf8").trim().split("\n");
    expect(lines.filter((l) => l === "beforeRun")).toHaveLength(1);
    expect(lines.filter((l) => l === "afterRun")).toHaveLength(2);
  });

  it("emits signal running->awaiting and awaiting->completed onStateChange transitions", async () => {
    const sink = join(setupTmp(), "signal-states.json");
    const config: HookConfig = {
      events: { onStateChange: [capturePayload(sink)] }
    };
    const ir = compileYaml(`
version: 1
name: hook-signal-states
workflow:
  steps:
    - id: approve
      run: signal
      prompt: "ok?"
      output:
        approved: boolean
      timeout: 30ms
      on_timeout: default
      default:
        approved: true
`);
    const { interpreter } = setup(config);
    const meta = await interpreter.start(ir, { input: {} });
    expect(meta.status).toBe("completed");
    const transitions = readFileSync(sink, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .filter((p) => p.node_id === "approve")
      .map((p) => `${p.from_state}->${p.to_state}`);
    expect(transitions).toEqual(["pending->running", "running->awaiting", "awaiting->completed"]);
  });

  let tmpRoots: string[] = [];
  function setupTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "acpus-hook-events-"));
    tmpRoots.push(dir);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }
});

/** A command handler that appends a marker line to a sink file. */
function appendEvent(sink: string, marker: string) {
  return { command: `printf '%s\\n' '${marker}' >> '${sink}'`, sync: true };
}

/** A command handler that appends the full stdin payload JSON (one line) to a sink. */
function capturePayload(sink: string) {
  return {
    command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>require("fs").appendFileSync(process.argv[1],s.replace(/\\n/g," ")+"\\n"))' '${sink}'`,
    sync: true
  };
}
