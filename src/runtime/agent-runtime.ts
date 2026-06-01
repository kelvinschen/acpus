import path from "node:path";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeOptions } from "acpx/runtime";
import type { Role } from "../schema/workflow-spec.js";
import { loadAcpxAgentOverrides } from "./acpx-config.js";

export type AgentTurnRequest = {
  sessionKey: string;
  roleName: string;
  role: Role;
  cwd: string;
  prompt: string;
  requestId: string;
  timeoutMs: number;
  repair?: boolean;
};

export type AgentTurnResult = {
  handle: AcpRuntimeHandle;
  rawText: string;
  events: AcpRuntimeEvent[];
  status: "completed" | "cancelled" | "failed";
  error?: string;
  errorCode?: string;
  errorDetailCode?: string;
  retryable?: boolean;
  stopReason?: string;
};

export interface OrchestratorAgentRuntime {
  runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult>;
  dispose?(): Promise<void>;
}

export type AgentRuntimeFactory = (input: { cwd: string; runDir: string }) => OrchestratorAgentRuntime;

let runtimeFactoryForTests: AgentRuntimeFactory | undefined;

export function setAgentRuntimeFactoryForTests(factory: AgentRuntimeFactory | undefined): void {
  runtimeFactoryForTests = factory;
}

export function createOrchestratorAgentRuntime(input: { cwd: string; runDir: string }): OrchestratorAgentRuntime {
  return runtimeFactoryForTests?.(input) ?? new AcpxRuntimeAdapter(input.cwd, input.runDir);
}

class AcpxRuntimeAdapter implements OrchestratorAgentRuntime {
  private readonly runtimes = new Map<string, AcpxRuntime>();
  private readonly activeHandles = new Map<string, { runtime: AcpxRuntime; handle: AcpRuntimeHandle }>();
  private readonly agentOverrides: Promise<Record<string, string> | undefined>;

  constructor(private readonly cwd: string, private readonly runDir: string) {
    this.agentOverrides = loadAcpxAgentOverrides(cwd);
  }

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const runtime = await this.runtimeForRole(input.role);
    const handle = await runtime.ensureSession({
      sessionKey: input.sessionKey,
      agent: input.role.agent,
      mode: "persistent",
      cwd: input.cwd
    });
    this.activeHandles.set(`${input.role.mode}:${input.sessionKey}`, { runtime, handle });
    const turn = runtime.startTurn({
      handle,
      text: input.prompt,
      mode: "prompt",
      requestId: input.requestId,
      timeoutMs: input.timeoutMs
    });
    const events: AcpRuntimeEvent[] = [];
    let rawText = "";
    for await (const event of turn.events) {
      events.push(event);
      if (event.type === "text_delta" && event.stream !== "thought") rawText += event.text;
      await onEvent?.(event);
    }
    const result = await turn.result;
    if (result.status === "failed") {
      return {
        handle,
        rawText,
        events,
        status: "failed",
        error: result.error.message,
        errorCode: result.error.code,
        errorDetailCode: result.error.detailCode,
        retryable: result.error.retryable
      };
    }
    return {
      handle,
      rawText,
      events,
      status: result.status,
      stopReason: result.stopReason
    };
  }

  async dispose(): Promise<void> {
    const handles = [...this.activeHandles.values()];
    this.activeHandles.clear();
    await Promise.all(handles.map(({ runtime, handle }) => runtime.close({
      handle,
      reason: "orchestrator runtime batch complete",
      discardPersistentState: false
    }).catch(() => undefined)));
  }

  private async runtimeForRole(role: Role): Promise<AcpxRuntime> {
    const permissionMode = role.mode === "edit" ? "approve-all" : role.mode === "denyAll" ? "deny-all" : "approve-reads";
    const existing = this.runtimes.get(permissionMode);
    if (existing) return existing;
    const overrides = await this.agentOverrides;
    const options: AcpRuntimeOptions = {
      cwd: this.cwd,
      sessionStore: createFileSessionStore({ stateDir: path.join(this.runDir, "acpx-state") }),
      agentRegistry: createAgentRegistry({ overrides }),
      permissionMode,
      nonInteractivePermissions: "fail",
      timeoutMs: undefined
    };
    const runtime = new AcpxRuntime(options);
    this.runtimes.set(permissionMode, runtime);
    return runtime;
  }
}
