import type { AcpRuntimeEvent, AcpRuntimeHandle } from "acpx/runtime";
import type { AgentRuntimeFactory, AgentTurnRequest, AgentTurnResult, OrchestratorAgentRuntime } from "../../src/runtime/agent-runtime.js";

export type FakeTurn = {
  match?: (request: AgentTurnRequest) => boolean;
  text: string;
};

export class FakeAgentRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];
  private index = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    const turnIndex = this.turns.findIndex((turn, index) => index >= this.index && (!turn.match || turn.match(input)));
    const selectedIndex = turnIndex >= 0 ? turnIndex : this.index;
    const selected = this.turns[selectedIndex] ?? this.turns.at(-1);
    this.index = selectedIndex + 1;
    const text = selected?.text ?? plainJsonOutput({ status: "completed", summary: "ok", artifacts: [], nextFocus: "done" });
    await onEvent?.({ type: "text_delta", text, stream: "output" });
    return {
      handle: fakeHandle(input),
      rawText: text,
      events: [{ type: "text_delta", text, stream: "output" }],
      status: "completed"
    };
  }
}

export function fakeRuntimeFactory(turns: FakeTurn[]): { runtime: FakeAgentRuntime; factory: AgentRuntimeFactory } {
  let runtime: FakeAgentRuntime | undefined;
  return {
    get runtime() {
      if (!runtime) runtime = new FakeAgentRuntime(turns);
      return runtime;
    },
    factory: () => {
      if (!runtime) runtime = new FakeAgentRuntime(turns);
      return runtime;
    }
  };
}

export function plainJsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function baseOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "completed", summary: "ok", artifacts: [], nextFocus: "next", ...extra };
}

export function implementationOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...baseOutput({ nextFocus: "validate" }), changedFiles: [], checks: [], ...extra };
}

export function validationOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseOutput({ nextFocus: "summarize" }),
    verdict: "pass",
    severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    findings: [],
    checks: [],
    ...extra
  };
}

export function summarizeOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseOutput({ nextFocus: "" }),
    finalVerdict: "success",
    deliverables: [],
    changedFiles: [],
    checks: [],
    warnings: [],
    risks: [],
    nextActions: [],
    ...extra
  };
}

function fakeHandle(input: AgentTurnRequest): AcpRuntimeHandle {
  return {
    sessionKey: input.sessionKey,
    backend: "fake",
    runtimeSessionName: input.sessionKey,
    cwd: input.cwd,
    acpxRecordId: `record-${input.sessionKey}`,
    backendSessionId: `backend-${input.sessionKey}`,
    agentSessionId: `agent-${input.sessionKey}`
  };
}
