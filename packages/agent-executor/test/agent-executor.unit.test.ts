import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Handler = (...args: any[]) => void;
  type Scenario = (child: FakeChild, call: SpawnCall) => void;
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
    emit(event: string, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  class FakeChild extends FakeEmitter {
    readonly pid = undefined;
    readonly stdout = new FakeEmitter();
    readonly stderr = new FakeEmitter();
    unref = vi.fn();
    readonly stdin = {
      end: (input = "") => {
        const call = state.calls[state.calls.length - 1];
        if (!call) throw new Error("missing spawn call");
        call.input = input;
        queueMicrotask(() => (state.scenarios.shift() ?? successScenario)(this, call));
      },
    };
  }

  const successScenario: Scenario = child => {
    child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"ok\"}}}}\n");
    child.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\"}}\n");
    child.emit("close", 0);
  };

  const state = {
    calls: [] as SpawnCall[],
    scenarios: [] as Scenario[],
  };

  return {
    state,
    spawn: vi.fn((command: string, args: string[], options: any) => {
      state.calls.push({ command, args, options, input: "" });
      return new FakeChild();
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
    fake.state.scenarios.length = 0;
    fake.spawn.mockClear();
  });

  it("ensures the session before prompting and extracts assistant text", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
      model: "gpt-5.4",
      timeout: "30s",
    })).resolves.toMatchObject({
      status: "completed",
      responseText: "ok",
      telemetry: { eventCount: 2, stopReason: "end_turn" },
    });

    expect(fake.state.calls.map(call => call.command)).toEqual([process.execPath, process.execPath]);
    expect(fake.state.calls.map(call => call.options.cwd)).toEqual(["/repo", "/repo"]);
    expect(fake.state.calls.map(call => call.args.slice(1))).toEqual([
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--model", "gpt-5.4", "--timeout", "30", "codex", "sessions", "ensure", "--name", "run-node"],
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--model", "gpt-5.4", "--timeout", "30", "codex", "prompt", "-s", "run-node", "-f", "-"],
    ]);
    expect(fake.state.calls[1]!.input).toBe("review");
  });

  it("passes acpx timeout as positive seconds while keeping local millisecond timeout", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "run-node",
      permissionMode: "approve-all",
      timeout: "1500ms",
    });

    expect(fake.state.calls.map(call => call.args.slice(1, 9))).toEqual([
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "2"],
      ["--cwd", "/repo", "--format", "json", "--json-strict", "--approve-all", "--timeout", "2"],
    ]);
  });

  it("shares one local timeout budget across ensure, set-mode, and prompt", async () => {
    vi.useFakeTimers();
    try {
      fake.state.scenarios.push(
        fake.scenario.success,
        child => setTimeout(() => child.emit("close", 0), 4),
        child => setTimeout(() => child.emit("close", 0), 10),
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
        timeout: "5ms",
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureKind: "timeout",
        message: "Agent turn timed out after 5ms.",
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

  it("returns raw acpx stdout only when raw debug capture is requested", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.not.toHaveProperty("rawDebug");

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

  it("captures context, token usage, full IO preview, cwd, and acpx record id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    try {
      fake.state.scenarios.push(
        fake.scenario.stdout("{\"acpxRecordId\":\"record-1\"}\n"),
        fake.scenario.stdout([
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":120,\"size\":200}}}",
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":0,\"size\":240}}}",
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hello\"}}}}",
          "{\"jsonrpc\":\"2.0\",\"id\":\"req-1\",\"result\":{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":10,\"output_tokens\":2,\"cacheReadInputTokens\":3,\"cache_creation_input_tokens\":4,\"thoughtTokens\":5,\"total_tokens\":24}}}",
        ].join("\n") + "\n"),
      );
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      await expect(executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
      })).resolves.toMatchObject({
        status: "completed",
        responseText: "hello",
        telemetry: {
          eventCount: 4,
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
          input: { preview: "review", truncated: false, originalBytes: 6, headBytes: 6 },
          output: { preview: "hello", truncated: false, originalBytes: 5, headBytes: 5 },
          cwd: "/repo",
          acpxRecordId: "record-1",
        },
      });
    } finally {
      vi.useRealTimers();
    }
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
        telemetry: {
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
      expect(JSON.stringify(result.telemetry.tools.calls[0])).not.toContain("secret");
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

    expect(result.telemetry.tools).toMatchObject({
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
    expect(result.telemetry.tools.calls[0]!.input!.preview).toContain("[acpus truncated 9002 bytes]");
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
      failureKind: "config",
      message: "Invalid params: unsupported mode",
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
      failureKind: "spawn",
      message: "spawn failed",
    });
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
      failureKind: "provider_exit",
      message: "Malformed acpx JSON output: not json",
    });
  });

  it("extracts JSON-RPC error messages without exposing raw protocol JSON", async () => {
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
      failureKind: "config",
      message: "Unsupported model",
      rawDebug: {
        stdout: "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32602,\"message\":\"Unsupported model\"}}\n",
      },
    });
  });

  it("classifies provider exits and output overflow", async () => {
    const { executeAgentTurn } = await import("@acpus/agent-executor");

    fake.state.scenarios.push(fake.scenario.success, fake.scenario.exit(2, "agent crashed"));
    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({ status: "failed", failureKind: "provider_exit", message: "agent crashed" });

    fake.state.scenarios.push(fake.scenario.success, fake.scenario.stdout("x".repeat(1_000_001)));
    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
    })).resolves.toMatchObject({ status: "failed", failureKind: "output_overflow" });
    expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toContainEqual(["codex", "cancel", "-s", "session"]);
  });

  it("classifies turn timeouts", async () => {
    vi.useFakeTimers();
    try {
      fake.state.scenarios.push(fake.scenario.success, child => {
        setTimeout(() => child.emit("close", null), 10);
      });
      const { executeAgentTurn } = await import("@acpus/agent-executor");

      const result = executeAgentTurn({
        agent: { kind: "named", name: "codex" },
        prompt: "review",
        cwd: "/repo",
        env: {},
        sessionName: "session",
        permissionMode: "approve-all",
        timeout: "5ms",
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureKind: "timeout",
        message: "Agent turn timed out after 5ms.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs acpx cancel for an aborted active prompt", async () => {
    const controller = new AbortController();
    fake.state.scenarios.push(fake.scenario.success, child => {
      controller.abort();
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
    })).resolves.toMatchObject({ status: "cancelled" });

    expect(fake.state.calls.map(call => tailFromAgent(call.args, "codex"))).toContainEqual(["codex", "cancel", "-s", "session"]);
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
