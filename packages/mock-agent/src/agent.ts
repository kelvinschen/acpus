import * as acp from "@agentclientprotocol/sdk";
import type {
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseDurationMs, responseText, selectResponse, splitIntoChunks, type MockRespond, type MockScript } from "./script.js";
import { TraceWriter } from "./trace.js";

interface SessionState {
  sessionId: string;
  cwd: string;
  pendingPrompt: AbortController | null;
  promptCount: number;
  ruleAttempts: Map<string, number>;
  previousRule: string | null;
}

export class MockAgent {
  private readonly sessions = new Map<string, SessionState>();
  private nextSessionNumber = 1;

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly script: MockScript,
    private readonly trace: TraceWriter
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.trace.write({ event: "initialize", agentId: this.script.agent_id });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false
        }
      },
      agentInfo: {
        name: this.script.agent_id,
        version: "0.1.0"
      }
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = this.script.deterministic_session_ids ? `mock-session-${this.nextSessionNumber++}` : `mock-${randomUUID()}`;
    this.sessions.set(sessionId, this.createSession(sessionId, params.cwd));
    this.trace.write({ event: "session/new", sessionId, cwd: params.cwd });
    return { sessionId };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.sessions.has(params.sessionId)) {
      if (!this.script.allow_unknown_session_load) {
        this.trace.write({ event: "error", sessionId: params.sessionId, error: { code: "E_SESSION_NOT_FOUND", message: "Session not found" } });
        throw new acp.RequestError(-32002, `Session ${params.sessionId} not found`, { code: "E_SESSION_NOT_FOUND", sessionId: params.sessionId });
      }
      this.sessions.set(params.sessionId, this.createSession(params.sessionId, params.cwd));
    }
    this.trace.write({ event: "session/load", sessionId: params.sessionId, cwd: params.cwd });
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.getSession(params.sessionId);
    session.pendingPrompt?.abort();
    const abortController = new AbortController();
    session.pendingPrompt = abortController;
    session.promptCount += 1;

    const promptText = extractPromptText(params.prompt);
    const selected = selectResponse(this.script, promptText, {
      promptCount: session.promptCount,
      ruleAttempts: session.ruleAttempts,
      previousRule: session.previousRule ?? undefined
    });
    const priorAttempts = session.ruleAttempts.get(selected.ruleName) ?? 0;
    session.ruleAttempts.set(selected.ruleName, priorAttempts + 1);
    session.previousRule = selected.ruleName;
    this.trace.write({
      event: "session/prompt",
      sessionId: params.sessionId,
      promptText,
      promptCount: session.promptCount,
      ruleName: selected.ruleName,
      responseIndex: selected.responseIndex
    });

    try {
      if (selected.response.type === "error") {
        this.trace.write({ event: "error", sessionId: params.sessionId, ruleName: selected.ruleName, error: selected.response.error });
        throw new acp.RequestError(-32603, selected.response.error.message, { code: selected.response.error.code });
      }

      if (selected.response.type === "hang") {
        this.trace.write({ event: "hang", sessionId: params.sessionId, ruleName: selected.ruleName });
        await waitUntilAborted(abortController.signal);
        this.trace.write({ event: "cancelled", sessionId: params.sessionId, ruleName: selected.ruleName });
        return { stopReason: "cancelled", userMessageId: params.messageId };
      }

      return await this.respondWithChunks(params, selected.ruleName, selected.response, abortController);
    } finally {
      if (session.pendingPrompt === abortController) {
        session.pendingPrompt = null;
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.pendingPrompt?.abort();
    this.trace.write({ event: "session/cancel", sessionId: params.sessionId });
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async setSessionMode(): Promise<Record<string, never>> {
    return {};
  }

  private async respondWithChunks(
    params: PromptRequest,
    ruleName: string,
    response: Extract<MockRespond, { type: "text" | "json" }>,
    abortController: AbortController
  ): Promise<PromptResponse> {
    const text = responseText(response);
    const stream = response.stream;
    const chunks = splitIntoChunks(text, stream?.chunks ?? 1);
    const intervalMs = parseDurationMs(stream?.chunk_interval, { strict: true });

    for (const [index, chunk] of chunks.entries()) {
      if (abortController.signal.aborted) {
        this.trace.write({ event: "cancelled", sessionId: params.sessionId, ruleName, chunkIndex: index });
        return { stopReason: "cancelled", userMessageId: params.messageId };
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: chunk
          }
        }
      });
      this.trace.write({ event: "session/update", sessionId: params.sessionId, ruleName, chunkIndex: index, text: chunk });

      if (response.crash_after_chunks !== undefined && index + 1 >= response.crash_after_chunks) {
        const exitCode = response.exit_code ?? 1;
        this.trace.write({ event: "crash", sessionId: params.sessionId, ruleName, chunkIndex: index, exitCode });
        process.exit(exitCode);
      }

      if (intervalMs > 0) {
        await delay(intervalMs, undefined, { signal: abortController.signal }).catch(() => undefined);
        if (abortController.signal.aborted) {
          this.trace.write({ event: "cancelled", sessionId: params.sessionId, ruleName, chunkIndex: index });
          return { stopReason: "cancelled", userMessageId: params.messageId };
        }
      }
    }

    if (abortController.signal.aborted) {
      this.trace.write({ event: "cancelled", sessionId: params.sessionId, ruleName, chunkIndex: chunks.length });
      return { stopReason: "cancelled", userMessageId: params.messageId };
    }

    this.trace.write({ event: "final", sessionId: params.sessionId, ruleName, stopReason: "end_turn" });
    return { stopReason: "end_turn", userMessageId: params.messageId };
  }

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new acp.RequestError(-32002, `Session ${sessionId} not found`, { code: "E_SESSION_NOT_FOUND", sessionId });
    }
    return session;
  }

  private createSession(sessionId: string, cwd: string): SessionState {
    return {
      sessionId,
      cwd,
      pendingPrompt: null,
      promptCount: 0,
      ruleAttempts: new Map(),
      previousRule: null
    };
  }
}

async function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function extractPromptText(prompt: PromptRequest["prompt"]): string {
  return prompt
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return block.uri;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
