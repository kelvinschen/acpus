import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Handler = (...args: any[]) => void;
  type Scenario = (child: FakeChild, call: SpawnCall) => void;
  type SpawnHook = (child: FakeChild, call: SpawnCall) => void;
  type SpawnCall = { command: string; args: string[]; options: any; input: string };

  class FakeEmitter {
    private readonly handlers = new Map<string, Handler[]>();
    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    off(event: string, handler: Handler): this {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter(current => current !== handler));
      return this;
    }
    listenerCount(event: string): number {
      return this.handlers.get(event)?.length ?? 0;
    }
    emit(event: string, ...args: any[]): void {
      const handlers = this.handlers.get(event) ?? [];
      if (event === "error" && handlers.length === 0) throw args[0];
      for (const handler of handlers) handler(...args);
    }
  }

  class FakeChild extends FakeEmitter {
    readonly pid = undefined;
    readonly stdout = new FakeEmitter();
    readonly stderr = new FakeEmitter();
    unref = vi.fn();
    readonly stdin = Object.assign(new FakeEmitter(), {
      end: (input = "") => {
        const call = state.calls[state.calls.length - 1];
        if (!call) throw new Error("missing spawn call");
        call.input = input;
        queueMicrotask(() => (state.scenarios.shift() ?? successScenario)(this, call));
      },
    });
  }

  const successScenario: Scenario = child => {
    child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"ok\"}}}}\n");
    child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\"}}\n");
    child.emit("close", 0);
  };

  const state = {
    calls: [] as SpawnCall[],
    children: [] as FakeChild[],
    scenarios: [] as Scenario[],
    spawnHooks: [] as Array<SpawnHook | undefined>,
  };

  return {
    state,
    spawn: vi.fn((command: string, args: string[], options: any) => {
      const call = { command, args, options, input: "" };
      const child = new FakeChild();
      state.calls.push(call);
      state.children.push(child);
      state.spawnHooks.shift()?.(child, call);
      return child;
    }),
    scenario: {
      success: successScenario,
      exit(code: number, stderr = ""): Scenario {
        return child => {
          if (stderr) child.stderr.emit("data", stderr);
          child.emit("close", code);
        };
      },
      error(message: string): Scenario {
        return child => child.emit("error", new Error(message));
      },
      stdout(text: string, exitCode = 0): Scenario {
        return child => {
          child.stdout.emit("data", text);
          child.emit("close", exitCode);
        };
      },
    },
  };
});

vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

function tailFromAgent(args: string[], agent: string): string[] {
  const index = args.indexOf(agent);
  if (index < 0) throw new Error(`missing agent ${agent} in ${args.join(" ")}`);
  return args.slice(index);
}

describe("executeAgentTurn", () => {
  beforeEach(() => {
    fake.state.calls.length = 0;
    fake.state.children.length = 0;
    fake.state.scenarios.length = 0;
    fake.state.spawnHooks.length = 0;
    fake.spawn.mockClear();
  });

  it("ensures the session before prompting and extracts assistant text", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    const result = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
      model: "gpt-5.4",
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      status: "completed",
      responseText: "ok",
      summary: { eventCount: 2, stopReason: "end_turn" },
      timing: {
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        elapsedMs: expect.any(Number),
      },
    });
    expect(result).not.toHaveProperty("trace");
    expect(result.summary).not.toHaveProperty("timing");

    expect(fake.state.calls.map(call => call.command)).toEqual([process.execPath, process.execPath]);
    expect(fake.state.calls.map(call => call.options.cwd)).toEqual(["/repo", "/repo"]);
    expect(fake.state.calls.map(call => call.args.slice(1))).toEqual([
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--model", "gpt-5.4", "--timeout", "30", "codex", "sessions", "ensure", "--name", "run-node"],
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--model", "gpt-5.4", "--timeout", "30", "codex", "prompt", "-s", "run-node", "-f", "-"],
    ]);
    expect(fake.state.calls[1]!.input).toBe("review");
  });

  it.each([
    { timeoutMs: 1, seconds: "1" },
    { timeoutMs: 1_500, seconds: "2" },
  ])("passes $timeoutMs ms to acpx as $seconds positive seconds", async ({ timeoutMs, seconds }) => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const now = vi.spyOn(performance, "now").mockReturnValue(0);

    try {
      await executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs,
      });

      expect(fake.state.calls.map(call => call.args.slice(1, 9))).toEqual([
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", seconds],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", seconds],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1, 1.5])("rejects invalid timeoutMs %s as config", async timeoutMs => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
      timeoutMs,
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "config", message: "Agent turn timeoutMs must be a non-negative safe integer." },
      timing: { elapsedMs: expect.any(Number) },
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("treats a zero millisecond budget as an immediate timeout", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
      timeoutMs: 0,
      captureTrace: true,
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "timeout", message: "Agent turn timed out after 0ms." },
      trace: { events: [expect.objectContaining({ type: "turn_end", status: "timed_out" })] },
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("rearms a long timeout after the maximum native timer chunk", async () => {
    vi.useFakeTimers();
    const maxTimerDelayMs = 2_147_483_647;
    try {
      fake.state.scenarios.push(fake.scenario.success, () => {});
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: maxTimerDelayMs + 1,
      });
      let settled = false;
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toEqual([
        ["codex", "sessions", "ensure", "--name", "run-node"],
        ["codex", "prompt", "-s", "run-node", "-f", "-"],
        ["codex", "cancel", "-s", "run-node"],
      ]);
      fake.state.children[1]!.emit("close", null);

      await expect(result).resolves.toMatchObject({ status: "failed", failure: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts synchronous subprocess startup against the shared timeout budget", async () => {
    vi.useFakeTimers();
    try {
      fake.state.scenarios.push(fake.scenario.success);
      fake.state.spawnHooks.push(undefined, child => {
        vi.advanceTimersByTime(6);
        queueMicrotask(() => child.emit("close", 0));
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({ status: "failed", failure: { kind: "timeout" } });
      expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toEqual([
        ["codex", "sessions", "ensure", "--name", "run-node"],
        ["codex", "prompt", "-s", "run-node", "-f", "-"],
        ["codex", "cancel", "-s", "run-node"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an expired deadline authoritative when close beats the timer callback", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      fake.state.scenarios.push(fake.scenario.success, child => {
        now.mockReturnValue(6);
        child.emit("close", 0);
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
      })).resolves.toMatchObject({ status: "failed", failure: { kind: "timeout" } });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps an expired deadline authoritative over a synchronous spawn failure", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      fake.state.spawnHooks.push(() => {
        now.mockReturnValue(6);
        throw new Error("spawn failed");
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
      })).resolves.toMatchObject({ status: "failed", failure: { kind: "timeout" } });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps synchronous abort authoritative over an expired spawn failure", async () => {
    const controller = new AbortController();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      fake.state.spawnHooks.push(() => {
        now.mockReturnValue(6);
        controller.abort();
        throw new Error("spawn failed");
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
        signal: controller.signal,
      })).resolves.toMatchObject({ status: "cancelled" });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps synchronous abort authoritative when successful spawn also exhausts the deadline", async () => {
    const controller = new AbortController();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      fake.state.spawnHooks.push(child => {
        now.mockReturnValue(6);
        controller.abort();
        queueMicrotask(() => child.emit("close", null));
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
        signal: controller.signal,
      })).resolves.toMatchObject({ status: "cancelled" });
      expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toEqual([
        ["codex", "sessions", "ensure", "--name", "run-node"],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps abort authoritative when ensure settles before an expired continuation", async () => {
    const controller = new AbortController();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      fake.state.scenarios.push(child => {
        child.emit("close", 0);
        now.mockReturnValue(6);
        controller.abort();
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
        signal: controller.signal,
      })).resolves.toMatchObject({ status: "cancelled" });
      expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toEqual([
        ["codex", "sessions", "ensure", "--name", "run-node"],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps elapsed timeout enforcement stable across wall-clock rollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.success,
        child => setTimeout(() => child.emit("close", 0), 10),
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "run-node",
        permissionMode: "approve-all",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2);
      vi.setSystemTime(new Date("2026-06-30T23:59:00.000Z"));
      await vi.advanceTimersByTimeAsync(8);

      const outcome = await result;
      expect(outcome).toMatchObject({
        status: "failed",
        failure: { kind: "timeout" },
        timing: {
          startedAt: "2026-07-01T00:00:00.000Z",
          finishedAt: "2026-06-30T23:59:00.008Z",
          elapsedMs: 10,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds Claude user settings env by default without mutating request env", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const env = { PATH: "/bin" };

    await executeAgentTurn({
      agent: { kind: "named", name: "claude" },
      prompt: "review",
      cwd: "/repo",
      env,
      sessionName: "run-node",
      permissionMode: "approve-all",
    });

    expect(fake.state.calls.map(call => call.options.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS)).toEqual(["1", "1"]);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("preserves explicit Claude user settings env overrides", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await executeAgentTurn({
      agent: { kind: "named", name: "claude" },
      prompt: "review",
      cwd: "/repo",
      env: { ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "0" },
      sessionName: "run-node",
      permissionMode: "approve-all",
    });

    expect(fake.state.calls.map(call => call.options.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS)).toEqual(["0", "0"]);
  });

  it("does not add Claude user settings env for other named or command agents", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
    });
    expect(fake.state.calls.map(call => call.options.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS)).toEqual([undefined, undefined]);

    fake.state.calls.length = 0;
    await executeAgentTurn({
      agent: { kind: "command", command: "npx -y @agentclientprotocol/claude-agent-acp" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
    });
    expect(fake.state.calls.map(call => call.options.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS)).toEqual([undefined, undefined]);
  });

  it("shares one local timeout budget across ensure, set-mode, and prompt", async () => {
    vi.useFakeTimers();
    try {
      fake.state.scenarios.push(
        fake.scenario.success,
        child => setTimeout(() => child.emit("close", 0), 4),
        child => setTimeout(() => child.emit("close", 0), 2),
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "claude" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        agentMode: "plan",
        timeoutMs: 5,
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failure: { kind: "timeout", message: "Agent turn timed out after 5ms." },
      });
      expect(fake.state.calls.map(call => tailFromAgent(call.args, "claude"))).toEqual([
        ["claude", "sessions", "ensure", "--name", "session"],
        ["claude", "set-mode", "plan", "-s", "session"],
        ["claude", "prompt", "-s", "session", "-f", "-"],
        ["claude", "cancel", "-s", "session"],
      ]);
      expect(fake.state.calls.map(call => call.args.slice(1, 9))).toEqual([
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "1"],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "1"],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "1"],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "1"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the remaining shared timeout budget to detached cancel", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      fake.state.scenarios.push(
        fake.scenario.success,
        child => setTimeout(() => {
          controller.abort();
          child.emit("close", null);
        }, 1_100),
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        timeoutMs: 2_500,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(result).resolves.toMatchObject({ status: "cancelled" });
      expect(fake.state.calls.map(call => call.args.slice(1, 9))).toEqual([
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "3"],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "3"],
        ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "2"],
      ]);
      expect(tailFromAgent(fake.state.calls[2]!.args, "codex")).toEqual(["codex", "cancel", "-s", "session"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns raw acpx stdout only when raw debug capture is requested", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    const defaultResult = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    });
    expect(defaultResult).not.toHaveProperty("rawDebug");
    expect(defaultResult).not.toHaveProperty("trace");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      captureRawDebug: true,
    })).resolves.toMatchObject({
      rawDebug: {
        stdout: expect.stringContaining("\"sessionUpdate\":\"agent_message_chunk\""),
      },
    });
  });

  it("captures ordered normalized trace events with full provider tool payloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.stdout("{\"acpxRecordId\":\"record-1\"}\n"),
        child => {
          const emit = (event: unknown) => {
            child.stdout.emit("data", `${JSON.stringify(event)}\n`);
            vi.advanceTimersByTime(5);
          };
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read", status: "running", rawInput: { path: "README.md" }, rawOutput: { buffered: true }, content: [{ type: "text", text: "starting" }], locations: [{ path: "README.md", line: 1 }], _meta: { claudeCode: { toolName: "Read" } } } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { text: "contents" }, content: [{ type: "text", text: "contents" }] } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 10, size: 100, _meta: { usage: { input_tokens: 8, output_tokens: 2 } } } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan", entries: [{ content: "inspect", status: "completed" }] } } });
          emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "future_update", value: { keep: true } } } });
          emit({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 2 } } });
          child.emit("close", 0);
        },
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = await executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        captureTrace: true,
      });

      expect(result).toMatchObject({ status: "completed", responseText: "answer" });
      expect(result.trace?.events.map(event => event.type)).toEqual([
        "message", "message", "tool", "tool", "usage", "plan", "unknown", "usage", "turn_end",
      ]);
      expect(result.trace?.events.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(result.trace?.events[0]).toMatchObject({ type: "message", channel: "thought", content: { type: "text", text: "thinking" } });
      expect(result.trace?.events[2]).toMatchObject({
        type: "tool",
        action: "call",
        toolCallId: "tool-1",
        toolName: "Read",
        rawInput: { path: "README.md" },
        rawOutput: { buffered: true },
        content: [{ type: "text", text: "starting" }],
        locations: [{ path: "README.md", line: 1 }],
      });
      expect(result.trace?.events[3]).toMatchObject({ type: "tool", action: "update", rawOutput: { text: "contents" } });
      expect(result.trace?.events[4]).toMatchObject({ type: "usage", context: { used: 10, size: 100 }, tokenUsage: { input_tokens: 8, output_tokens: 2 } });
      expect(result.trace?.events[5]).toMatchObject({ type: "plan", value: [{ content: "inspect", status: "completed" }] });
      expect(result.trace?.events[6]).toMatchObject({ type: "unknown", tag: "future_update", value: expect.any(Object) });
      expect(result.trace?.events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", stopReason: "end_turn" });
      expect(result.trace).toMatchObject({
        startedAt: result.timing.startedAt,
        elapsedMs: result.timing.elapsedMs,
      });
      expect(result.trace?.events.at(-1)).toMatchObject({
        observedAt: result.timing.finishedAt,
        elapsedMs: result.timing.elapsedMs,
      });
      expect(result.summary.tools.calls[0]).toMatchObject({
        startedAt: "2026-07-01T00:00:00.010Z",
        updatedAt: "2026-07-01T00:00:00.015Z",
        completedAt: "2026-07-01T00:00:00.015Z",
      });
      expect(result.trace?.events.every((event, index, events) => index === 0 || event.elapsedMs >= events[index - 1]!.elapsedMs)).toBe(true);
      expect(new Set(result.trace?.events.map(event => event.observedAt)).size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes client protocol frames from trace while retaining raw wire and provider operations", async () => {
    const prompt = "run pwd and return TRACE_FILTER_OK";
    const excludedMethods = [
      "initialize",
      "authenticate",
      "logout",
      "$/cancel_request",
      "mcp/message",
      "providers/list",
      "nes/complete",
      "document/open",
      "session/new",
      "session/load",
      "session/prompt",
      "session/cancel",
      "session/set_mode",
      "session/set_config_option",
      "session/set_model",
      "session/status",
    ];
    const retainedMethods = [
      "session/request_permission",
      "fs/read_text_file",
      "terminal/create",
      "elicitation/create",
      "mcp/connect",
      "mcp/disconnect",
      "extension/future_operation",
    ];
    const events = [
      ...excludedMethods.map(method => ({
        jsonrpc: "2.0",
        method,
        params: method === "session/prompt" ? { prompt } : { marker: method },
      })),
      ...retainedMethods.map(method => ({ jsonrpc: "2.0", method, params: { marker: method } })),
      { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "future_update", value: { keep: true } } } },
      { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TRACE_FILTER_OK" } } } },
      { jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } },
    ];
    fake.state.scenarios.push(
      fake.scenario.stdout("{\"acpxRecordId\":\"record-1\"}\n"),
      fake.scenario.stdout(events.map(event => JSON.stringify(event)).join("\n") + "\n"),
    );
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    const result = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt,
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      captureRawDebug: true,
      captureTrace: true,
    });

    expect(result).toMatchObject({
      status: "completed",
      responseText: "TRACE_FILTER_OK",
      summary: { eventCount: events.length, stopReason: "end_turn" },
    });
    expect(result.rawDebug?.stdout).toContain('"method":"session/prompt"');
    expect(result.rawDebug?.stdout).toContain(prompt);
    expect(JSON.stringify(result.trace)).not.toContain(prompt);
    const unknownValues = result.trace?.events
      .filter(event => event.type === "unknown")
      .map(event => event.value) ?? [];
    expect(unknownValues.map(value => (value as { method?: string }).method)).toEqual([
      ...retainedMethods,
      "session/update",
    ]);
    expect(result.trace?.events.map(event => event.type)).toEqual([
      ...retainedMethods.map(() => "unknown"),
      "unknown",
      "message",
      "turn_end",
    ]);
    expect(result.trace?.events.map(event => event.sequence)).toEqual(
      result.trace?.events.map((_, index) => index),
    );
    expect(result.trace?.events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", stopReason: "end_turn" });
    for (const method of excludedMethods) expect(JSON.stringify(result.trace)).not.toContain(`\"method\":\"${method}\"`);
  });

  it("captures normalized facts without duplicating prompt or response text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.stdout("{\"acpxRecordId\":\"record-1\"}\n"),
        fake.scenario.stdout([
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":120,\"size\":200,\"_meta\":{\"usage\":{\"input_tokens\":99,\"output_tokens\":1}}}}}",
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":0,\"size\":240}}}",
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hello\"}}}}",
          "{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":10,\"output_tokens\":2,\"cacheReadInputTokens\":3,\"cache_creation_input_tokens\":4,\"thoughtTokens\":5,\"total_tokens\":24}}}",
        ].join("\n") + "\n"),
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = await executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
      });

      expect(result).toMatchObject({
        status: "completed",
        responseText: "hello",
        summary: {
          eventCount: 4,
          availability: { context: "available", tokenUsage: "available" },
          stopReason: "end_turn",
          context: { used: 120, size: 240, updatedAt: "2026-07-01T00:00:00.000Z" },
          tokenUsage: {
            source: "prompt_response",
            inputTokens: 10,
            outputTokens: 2,
            cachedReadTokens: 3,
            cachedWriteTokens: 4,
            thoughtTokens: 5,
            totalTokens: 24,
          },
          tools: { totalToolCallCount: 0, calls: [] },
          cwd: "/repo",
          acpxRecordId: "record-1",
        },
      });
      expect(JSON.stringify(result.summary)).not.toContain("review");
      expect(JSON.stringify(result.summary)).not.toContain("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks missing and non-total token telemetry without inventing totals", async () => {
    fake.state.scenarios.push(
      fake.scenario.success,
      fake.scenario.stdout("{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\"}}\n"),
      fake.scenario.success,
      fake.scenario.stdout("{\"jsonrpc\":\"2.0\",\"id\":\"req-2\",\"result\":{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":10,\"outputTokens\":2}}}\n"),
    );
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const request = {
      agent: { kind: "named" as const, name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all" as const,
    };

    const unavailable = await executeAgentTurn(request);
    const partial = await executeAgentTurn(request);

    expect(unavailable.summary).toMatchObject({
      availability: { context: "unavailable", tokenUsage: "unavailable" },
    });
    expect(unavailable.summary).not.toHaveProperty("tokenUsage");
    expect(partial.summary).toMatchObject({
      availability: { context: "unavailable", tokenUsage: "partial" },
      tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2 },
    });
    expect(partial.summary.tokenUsage).not.toHaveProperty("totalTokens");
  });

  it("reports normalized progress while prompt stdout is still streaming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.stdout("{\"acpxRecordId\":\"record-1\"}\n"),
        child => {
          child.stdout.emit("data", [
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":80,\"size\":200,\"_meta\":{\"usage\":{\"input_tokens\":10,\"outputTokens\":2,\"cache_read_input_tokens\":3,\"cacheCreationInputTokens\":4,\"thought_tokens\":5,\"total_tokens\":24}}}}}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hel\"}}}}",
          ].join("\n") + "\n");
          child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"lo\"}}}}\n");
          child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"tool-1\",\"status\":\"running\",\"rawInput\":{\"cmd\":\"pnpm test\"},\"_meta\":{\"claudeCode\":{\"toolName\":\"Bash\"}}}}}\n");
          setTimeout(() => child.emit("close", 0), 10);
        },
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");
      const progress: unknown[] = [];

      const resultPromise = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        onProgress: update => progress.push(update),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(Object.keys(progress[0] as Record<string, unknown>).sort()).toEqual(["responseText", "summary", "updatedAt"].sort());
      expect(progress).toEqual([
        {
          responseText: "",
          summary: {
            eventCount: 1,
            availability: { context: "available", tokenUsage: "available" },
            context: { used: 80, size: 200, updatedAt: "2026-07-01T00:00:00.000Z" },
            tokenUsage: {
              source: "usage_update",
              inputTokens: 10,
              outputTokens: 2,
              cachedReadTokens: 3,
              cachedWriteTokens: 4,
              thoughtTokens: 5,
              totalTokens: 24,
            },
            tools: { totalToolCallCount: 0, calls: [] },
            cwd: "/repo",
            acpxRecordId: "record-1",
          },
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        expect.objectContaining({ responseText: "hel", summary: expect.objectContaining({ eventCount: 2 }) }),
        expect.objectContaining({ responseText: "hello", summary: expect.objectContaining({ eventCount: 3 }) }),
        expect.objectContaining({
          responseText: "hello",
          summary: expect.objectContaining({
            eventCount: 4,
            tools: {
              totalToolCallCount: 1,
              calls: [expect.objectContaining({
                toolCallId: "tool-1",
                toolName: "Bash",
                status: "running",
                input: expect.objectContaining({ preview: "{\"cmd\":\"pnpm test\"}" }),
              })],
            },
          }),
        }),
      ]);
      expect(JSON.stringify(progress)).not.toContain("session/update");

      await vi.advanceTimersByTimeAsync(10);
      await expect(resultPromise).resolves.toMatchObject({
        status: "completed",
        responseText: "hello",
        summary: {
          eventCount: 4,
          context: { used: 80, size: 200 },
          tokenUsage: { source: "usage_update", inputTokens: 10, outputTokens: 2, totalTokens: 24 },
          tools: { totalToolCallCount: 1 },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports progress for thought-only prompt activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.stdout("{}\n"),
        child => {
          child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"thinking\"}}}}\n");
          setTimeout(() => child.emit("close", 0), 1);
        },
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");
      const progress: unknown[] = [];

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        onProgress: update => progress.push(update),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(progress).toEqual([{
        responseText: "",
        summary: expect.objectContaining({
          eventCount: 1,
          tools: { totalToolCallCount: 0, calls: [] },
        }),
        updatedAt: "2026-07-01T00:00:00.000Z",
      }]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        status: "completed",
        responseText: "",
        summary: { eventCount: 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a complete stdout line before reporting progress", async () => {
    vi.useFakeTimers();
    try {
      const line = "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"ok\"}}}}\n";
      fake.state.scenarios.push(
        fake.scenario.stdout("{}\n"),
        child => {
          child.stdout.emit("data", line.slice(0, 40));
          setTimeout(() => {
            child.stdout.emit("data", line.slice(40));
            child.emit("close", 0);
          }, 1);
        },
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");
      const progress: unknown[] = [];
      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        onProgress: update => progress.push(update),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(progress).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(progress).toMatchObject([{ responseText: "ok", summary: { eventCount: 1 } }]);
      await expect(result).resolves.toMatchObject({ status: "completed", responseText: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves UTF-8 text when a stdout chunk splits a multibyte character", async () => {
    vi.useFakeTimers();
    try {
      const text = "你好";
      const line = `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      })}\n`;
      const splitAt = Buffer.byteLength(line.slice(0, line.indexOf("你")), "utf8") + 1;
      const bytes = Buffer.from(line, "utf8");
      fake.state.scenarios.push(
        fake.scenario.stdout("{}\n"),
        child => {
          child.stdout.emit("data", bytes.subarray(0, splitAt));
          setTimeout(() => {
            child.stdout.emit("data", bytes.subarray(splitAt));
            child.emit("close", 0);
          }, 1);
        },
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");
      const progress: unknown[] = [];
      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        onProgress: update => progress.push(update),
      });

      await vi.advanceTimersByTimeAsync(1);

      expect(progress).toMatchObject([{ responseText: text }]);
      await expect(result).resolves.toMatchObject({ status: "completed", responseText: text });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the agent turn running when progress observation throws", async () => {
    fake.state.scenarios.push(
      fake.scenario.stdout("{}\n"),
      fake.scenario.stdout("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"ok\"}}}}\n"),
    );
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const onProgress = vi.fn(() => {
      throw new Error("observer failed");
    });

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      onProgress,
    })).resolves.toMatchObject({ status: "completed", responseText: "ok" });
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it("keeps the agent turn running when async progress observation rejects", async () => {
    fake.state.scenarios.push(
      fake.scenario.stdout("{}\n"),
      fake.scenario.stdout("{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"ok\"}}}}\n"),
    );
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const onProgress = vi.fn(async () => {
      throw new Error("observer rejected");
    });

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      onProgress,
    })).resolves.toMatchObject({ status: "completed", responseText: "ok" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it("captures tool call lifecycle and rawInput preview without rawOutput", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(fake.scenario.success, fake.scenario.stdout([
        "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"tool-1\",\"title\":\"Read file\",\"kind\":\"read\",\"status\":\"running\",\"rawInput\":{\"path\":\"README.md\"},\"rawOutput\":\"secret\",\"_meta\":{\"claudeCode\":{\"toolName\":\"Read\"}}}}}",
        "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":\"tool-1\",\"status\":\"completed\"}}}",
        "{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\"}}",
      ].join("\n") + "\n"));
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = await executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
      });

      expect(result).toMatchObject({
        status: "completed",
        summary: {
          tools: {
            totalToolCallCount: 1,
            calls: [{
              toolCallId: "tool-1",
              title: "Read file",
              kind: "read",
              toolName: "Read",
              status: "completed",
              input: {
                preview: "{\"path\":\"README.md\"}",
                truncated: false,
                originalBytes: 20,
                headBytes: 20,
              },
              startedAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
              completedAt: "2026-07-01T00:00:00.000Z",
            }],
          },
        },
      });
      expect(JSON.stringify(result.summary.tools.calls[0])).not.toContain("secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates large rawInput JSON previews with 4KiB head and tail", async () => {
    const rawInput = "x".repeat(9_000);
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.stdout(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          status: "running",
          rawInput,
        },
      },
    })}\n`));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    const result = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    });

    expect(result.summary.tools).toMatchObject({
      totalToolCallCount: 1,
      calls: [{
        input: {
          truncated: true,
          originalBytes: 9002,
          headBytes: 4096,
          tailBytes: 4096,
        },
      }],
    });
    expect(result.summary.tools.calls[0]!.input!.preview).toContain("[acpus truncated 9002 bytes]");
  });

  it("uses acpx --agent for custom command agents and maps permission modes", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await executeAgentTurn({
      agent: { kind: "command", command: "custom acp" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "deny-all",
    });

    expect(fake.state.calls[0]!.args.slice(1)).toEqual(["--cwd", "/repo", "--format", "json", "--json-strict", "--deny-all", "--agent", "custom acp", "sessions", "ensure", "--name", "session"]);
    expect(fake.state.calls[0]!.args).not.toContain("--policy");
    expect(fake.state.calls[0]!.args).not.toContain("--permission-policy");
    expect(fake.state.calls[0]!.args).not.toContain("--approve-all");
    expect(fake.state.calls[0]!.args).not.toContain("--approve-reads");
  });

  it("applies agentMode only before the initial prompt turn", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await executeAgentTurn({
      agent: { kind: "named", name: "claude" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-reads",
      agentMode: "bypassPermissions",
    });

    expect(fake.state.calls.map(call => tailFromAgent(call.args, "claude"))).toEqual([
      ["claude", "sessions", "ensure", "--name", "session"],
      ["claude", "set-mode", "bypassPermissions", "-s", "session"],
      ["claude", "prompt", "-s", "session", "-f", "-"],
    ]);
  });

  it("classifies rejected set-mode as config without sending a prompt", async () => {
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.exit(1, "Invalid params: unsupported mode"));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "claude" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      agentMode: "missing-mode",
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "config", message: "Invalid params: unsupported mode" },
    });
    expect(fake.state.calls).toHaveLength(2);
  });

  it("classifies spawn failures", async () => {
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.error("spawn failed"));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "spawn", message: "spawn failed" },
      timing: { elapsedMs: expect.any(Number) },
    });
  });

  it("keeps provider stderr after stdin EPIPE and ignores stdout after settlement", async () => {
    fake.state.scenarios.push(fake.scenario.success, child => {
      child.stdin.emit("error", new Error("write EPIPE"));
      child.stderr.emit("data", "provider rejected input");
      child.emit("close", 7);
      child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"late\"}}}}\n");
    });
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const progress: unknown[] = [];

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      onProgress: update => progress.push(update),
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "provider_exit", message: "provider rejected input" },
      stderr: "provider rejected input",
      responseText: "",
    });
    expect(progress).toEqual([]);
  });

  it("classifies malformed acpx json output as provider failure", async () => {
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.stdout("not json\n"));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "provider_exit", message: "Malformed acpx JSON output: not json" },
    });
  });

  it("preserves structured JSON-RPC prompt failures without exposing raw protocol JSON by default", async () => {
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.stdout("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32602,\"message\":\"Unsupported model\"}}\n", 1));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      model: "missing-model",
      captureRawDebug: true,
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "config",
        message: "Unsupported model",
        upstream: {
          source: "acpx",
          operation: "prompt",
          exitCode: 1,
          protocol: { name: "json-rpc", code: -32602, message: "Unsupported model" },
        },
      },
      rawDebug: {
        stdout: "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32602,\"message\":\"Unsupported model\"}}\n",
      },
    });
  });

  it("uses acpx JSON-RPC details as the actionable sessions ensure failure", async () => {
    const data = {
      acpxCode: "RUNTIME",
      origin: "cli",
      sessionId: "unknown",
      details: "failed to reload config: /home/example/.codex/config.toml:6:26: unknown variant `max`",
      extra: { preserved: true },
    };
    fake.state.scenarios.push(fake.scenario.stdout(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error", data },
    })}\n`, 1));
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        kind: "provider_exit",
        message: data.details,
        upstream: {
          source: "acpx",
          operation: "sessions.ensure",
          exitCode: 1,
          code: "RUNTIME",
          origin: "cli",
          protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
          data,
        },
      },
    });
    expect(fake.state.calls).toHaveLength(1);
  });

  it("classifies provider exits", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    fake.state.scenarios.push(fake.scenario.success, fake.scenario.exit(2, "agent crashed"));
    const result = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      captureTrace: true,
    });
    expect(result).toMatchObject({ status: "failed", failure: { kind: "provider_exit", message: "agent crashed" } });
    expect(result.trace?.events.at(-1)).toMatchObject({ type: "turn_end", status: "failed", message: "agent crashed" });
  });

  it("does not infer backend failure kinds from authentication or model wording", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    fake.state.scenarios.push(fake.scenario.success, fake.scenario.exit(1, "Authentication required for selected model"));

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "pi" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({
      status: "failed",
      failure: { kind: "provider_exit", message: "Authentication required for selected model" },
    });
  });

  it("classifies turn timeouts", async () => {
    vi.useFakeTimers();
    try {
      fake.state.scenarios.push(fake.scenario.success, child => {
        child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"partial\"}}}}\n");
        setTimeout(() => child.emit("close", null), 10);
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");
      const progress: unknown[] = [];

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        timeoutMs: 5,
        onProgress: update => progress.push(update),
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failure: { kind: "timeout", message: "Agent turn timed out after 5ms." },
        responseText: "partial",
      });
      expect(progress).toMatchObject([{ responseText: "partial", summary: { eventCount: 1 } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs acpx cancel for an aborted active prompt", async () => {
    const controller = new AbortController();
    fake.state.scenarios.push(fake.scenario.success, child => {
      child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"partial\"}}}}\n");
      controller.abort();
      child.emit("close", null);
    });
    const { executeAgentTurn } = await import("@acpus/agent-executor");
    const progress: unknown[] = [];

    const result = await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      signal: controller.signal,
      onProgress: update => progress.push(update),
      captureTrace: true,
    });
    expect(result).toMatchObject({ status: "cancelled", responseText: "partial" });
    expect(result.timing.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(progress).toMatchObject([{ responseText: "partial", summary: { eventCount: 1 } }]);
    expect(result.trace?.events.at(-1)).toMatchObject({ type: "turn_end", status: "cancelled" });
    expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toContainEqual(["codex", "cancel", "-s", "session"]);
    const cancelChild = fake.state.children.at(-1)!;
    expect(cancelChild.listenerCount("error")).toBe(1);
    expect(() => cancelChild.emit("error", new Error("cancel spawn failed"))).not.toThrow();
  });

  it("keeps abort authoritative across stdin and child process errors", async () => {
    const controller = new AbortController();
    fake.state.scenarios.push(fake.scenario.success, child => {
      child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"partial\"}}}}\n");
      controller.abort();
      child.stdin.emit("error", new Error("write EPIPE"));
      child.emit("error", new Error("late child error"));
      child.emit("close", null);
    });
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "cancelled", responseText: "partial" });
  });

  it("does not cancel a completed prompt when the signal aborts later", async () => {
    const controller = new AbortController();
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "completed" });

    controller.abort();

    expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toEqual([
      ["codex", "sessions", "ensure", "--name", "session"],
      ["codex", "prompt", "-s", "session", "-f", "-"],
    ]);
  });

});
