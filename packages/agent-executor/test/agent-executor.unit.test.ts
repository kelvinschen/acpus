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
          "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"usage_update\",\"used\":120,\"size\":200,\"_meta\":{\"usage\":{\"input_tokens\":99,\"output_tokens\":1}}}}}",
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

      expect(Object.keys(progress[0] as Record<string, unknown>).sort()).toEqual(["responseText", "telemetry", "updatedAt"].sort());
      expect(progress).toEqual([
        {
          responseText: "",
          telemetry: {
            eventCount: 1,
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
            input: { preview: "review", truncated: false, originalBytes: 6, headBytes: 6 },
            output: { preview: "", truncated: false, originalBytes: 0, headBytes: 0 },
            cwd: "/repo",
            acpxRecordId: "record-1",
          },
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        expect.objectContaining({ responseText: "hel", telemetry: expect.objectContaining({ eventCount: 2 }) }),
        expect.objectContaining({ responseText: "hello", telemetry: expect.objectContaining({ eventCount: 3 }) }),
        expect.objectContaining({
          responseText: "hello",
          telemetry: expect.objectContaining({
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
        telemetry: {
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
        telemetry: expect.objectContaining({
          eventCount: 1,
          tools: { totalToolCallCount: 0, calls: [] },
        }),
        updatedAt: "2026-07-01T00:00:00.000Z",
      }]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        status: "completed",
        responseText: "",
        telemetry: { eventCount: 1 },
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

      expect(progress).toMatchObject([{ responseText: "ok", telemetry: { eventCount: 1 } }]);
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

  it("classifies provider exits", async () => {
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
        timeout: "5ms",
        onProgress: update => progress.push(update),
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureKind: "timeout",
        message: "Agent turn timed out after 5ms.",
        responseText: "partial",
      });
      expect(progress).toMatchObject([{ responseText: "partial", telemetry: { eventCount: 1 } }]);
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

    await expect(executeAgentTurn({
      agent: { kind: "named", name: "codex" },
      prompt: "review",
      cwd: "/repo",
      env: {},
      sessionName: "session",
      permissionMode: "approve-all",
      signal: controller.signal,
      onProgress: update => progress.push(update),
    })).resolves.toMatchObject({ status: "cancelled", responseText: "partial" });

    expect(progress).toMatchObject([{ responseText: "partial", telemetry: { eventCount: 1 } }]);
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
