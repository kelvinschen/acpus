import type { ContentBlock } from "@agentclientprotocol/sdk";
import { expectTypeOf, test } from "vitest";
import {
  openAcpSession,
  type AcpClientOperation,
  type AcpContextUsage,
  type AcpCost,
  type AcpError,
  type AcpEvent,
  type AcpJsonValue,
  type AcpLaunch,
  type AcpOperation,
  type AcpPermissionMode,
  type AcpSession,
  type AcpSessionConfiguration,
  type AcpTokenUsage,
  type AcpTurnInput,
  type AcpTurnResult,
  type OpenAcpSessionInput,
} from "@acpus/acp";
import type { ResultAsync } from "neverthrow";

type ExpectedAcpEvent =
  | Readonly<{
      type: "message";
      channel: "assistant" | "thought";
      content: AcpJsonValue;
      messageId?: string;
    }>
  | Readonly<{
      type: "tool";
      action: "call" | "update";
      toolCallId: string;
      title?: string;
      name?: string;
      kind?: string;
      status?: string;
      input?: AcpJsonValue;
      output?: AcpJsonValue;
      content?: AcpJsonValue;
      locations?: AcpJsonValue;
    }>
  | Readonly<{
      type: "usage";
      context?: AcpContextUsage;
      tokens?: AcpTokenUsage;
      cost?: AcpCost;
    }>
  | Readonly<{ type: "plan"; value: AcpJsonValue }>
  | Readonly<{
      type: "session";
      update: "available_commands" | "current_mode" | "configuration" | "info";
      value: AcpJsonValue;
    }>
  | Readonly<{ type: "activity"; operation: AcpClientOperation }>
  | Readonly<{ type: "unknown"; name: string; value: AcpJsonValue }>;

type ExpectedErrorBase = Readonly<{
  operation: AcpOperation;
  origin: "input" | "persistence" | "client" | "provider" | "transport" | "process";
  providerEvidence: "none" | "inbound_activity" | "terminal_response";
  message: string;
  retryable: boolean;
  code?: string | number;
}>;

type ExpectedAcpError =
  | (ExpectedErrorBase & Readonly<{ type: "invalid_input" }>)
  | (ExpectedErrorBase & Readonly<{ type: "persistence"; path: string }>)
  | (ExpectedErrorBase & Readonly<{ type: "spawn" }>)
  | (ExpectedErrorBase & Readonly<{ type: "cancelled" }>)
  | (ExpectedErrorBase & Readonly<{ type: "cleanup" }>)
  | (ExpectedErrorBase & Readonly<{ type: "initialize" }>)
  | (ExpectedErrorBase & Readonly<{ type: "protocol" }>)
  | (ExpectedErrorBase & Readonly<{
      type: "capability";
      capability: "resume" | "load" | "configuration";
    }>)
  | (ExpectedErrorBase & Readonly<{ type: "session" }>)
  | (ExpectedErrorBase & Readonly<{ type: "configuration" }>)
  | (ExpectedErrorBase & Readonly<{
      type: "provider_exit";
      exitCode: number | null;
      signal: string | null;
    }>)
  | (ExpectedErrorBase & Readonly<{ type: "client_operation" }>)
  | (Omit<ExpectedErrorBase, "operation" | "origin" | "providerEvidence" | "retryable"> & Readonly<{
      type: "session_binding";
      operation: "open_session";
      origin: "persistence";
      providerEvidence: "none";
      retryable: false;
      categories: readonly [
        "launch" | "cwd" | "model" | "options",
        ...("launch" | "cwd" | "model" | "options")[],
      ];
    }>);

test("@acpus/acp exposes the frozen stable session boundary", () => {
  expectTypeOf(openAcpSession).toEqualTypeOf<
    (input: OpenAcpSessionInput) => ResultAsync<AcpSession, AcpError>
  >();
  expectTypeOf<AcpPermissionMode>().toEqualTypeOf<
    "approve-reads" | "approve-all" | "deny-all"
  >();
  expectTypeOf<AcpLaunch>().toEqualTypeOf<
    | Readonly<{ kind: "command"; command: string; name?: string }>
    | Readonly<{ kind: "argv"; argv: readonly [string, ...string[]]; name?: string }>
  >();
  expectTypeOf<AcpSessionConfiguration>().toEqualTypeOf<Readonly<{
    model?: string;
    options?: Readonly<Record<string, string>>;
  }>>();
  expectTypeOf<OpenAcpSessionInput>().toEqualTypeOf<Readonly<{
    agentSessionId: string;
    sessionOpenMode: "new_or_empty" | "existing_required";
    stateDirectory: string;
    launch: AcpLaunch;
    cwd: string;
    env?: Readonly<NodeJS.ProcessEnv>;
    permissionMode: AcpPermissionMode;
    configuration: Readonly<{
      model: string | null;
      options: Readonly<Record<string, string>>;
    }>;
    signal?: AbortSignal;
  }>>();
  expectTypeOf<keyof AcpSession>().toEqualTypeOf<
    "agentSessionId" | "sessionId" | "projectionPath" | "reportedVersion" | "runTurn" | "close"
  >();
  expectTypeOf<AcpSession["runTurn"]>().toEqualTypeOf<
    (input: AcpTurnInput) => ResultAsync<AcpTurnResult, AcpError>
  >();
  expectTypeOf<AcpSession["close"]>().toEqualTypeOf<
    (reason?: string) => ResultAsync<void, AcpError>
  >();
  expectTypeOf<AcpTurnInput>().toEqualTypeOf<Readonly<{
    prompt: string;
    configuration?: AcpSessionConfiguration;
    signal?: AbortSignal;
    onEvent?: (event: AcpEvent) => unknown;
  }>>();

  const frozenLaunch = {
    kind: "argv",
    argv: ["fixture-agent", "--stdio"],
    name: "fixture",
  } as const satisfies AcpLaunch;
  const frozenInput = {
    agentSessionId: "session-1",
    sessionOpenMode: "new_or_empty",
    stateDirectory: "/state",
    launch: frozenLaunch,
    cwd: "/workspace",
    env: { ACP_FIXTURE: "1" },
    permissionMode: "approve-reads",
    configuration: { model: null, options: {} },
    signal: new AbortController().signal,
  } as const satisfies OpenAcpSessionInput;
  expectTypeOf<typeof frozenInput>().toMatchTypeOf<OpenAcpSessionInput>();
  expectTypeOf(openAcpSession(frozenInput))
    .toEqualTypeOf<ResultAsync<AcpSession, AcpError>>();
});

test("@acpus/acp exposes package-owned result, event, and error values", () => {
  expectTypeOf<AcpTokenUsage>().toEqualTypeOf<Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  }>>();
  expectTypeOf<AcpTurnResult>().toEqualTypeOf<Readonly<{
    status: "completed" | "cancelled";
    stopReason: string;
    usage?: AcpTokenUsage;
  }>>();
  expectTypeOf<AcpEvent>().toEqualTypeOf<ExpectedAcpEvent>();
  expectTypeOf<AcpError>().toEqualTypeOf<ExpectedAcpError>();

  const frozenResult = {
    status: "completed",
    stopReason: "end_turn",
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  } as const satisfies AcpTurnResult;
  const frozenEvents = [
    { type: "message", channel: "assistant", content: "done" },
    { type: "message", channel: "thought", content: { text: "inspect" } },
    { type: "tool", action: "call", toolCallId: "tool-1", name: "read_file", input: { path: "README.md" } },
    { type: "usage", context: { used: 5, size: 100 }, tokens: { totalTokens: 5 } },
    { type: "plan", value: ["inspect", "report"] },
    { type: "session", update: "configuration", value: { model: "model-1" } },
    { type: "activity", operation: "fs/read_text_file" },
    { type: "unknown", name: "extension", value: null },
  ] as const satisfies readonly AcpEvent[];
  const frozenError = {
    type: "persistence",
    operation: "open_session",
    origin: "persistence",
    providerEvidence: "none",
    path: "sessions/record-1.json",
    message: "Projection unavailable.",
    retryable: false,
  } as const satisfies AcpError;

  expectTypeOf<typeof frozenResult>().toMatchTypeOf<AcpTurnResult>();
  expectTypeOf<typeof frozenEvents>().toMatchTypeOf<readonly AcpEvent[]>();
  expectTypeOf<typeof frozenError>().toMatchTypeOf<AcpError>();
});

const sdkPrompt: ContentBlock = { type: "text", text: "raw SDK prompt" };
// @ts-expect-error public turns accept one package-owned string prompt, not an SDK ContentBlock.
const invalidSdkPrompt: AcpTurnInput["prompt"] = sdkPrompt;

// @ts-expect-error permission policy is a closed three-value union.
const invalidPermission: AcpPermissionMode = "interactive";

// @ts-expect-error argv launches require a non-empty structured tuple.
const invalidLaunch: AcpLaunch = { kind: "argv", argv: [] };

declare const session: AcpSession;
// @ts-expect-error session recovery is owned by openAcpSession, not a public method.
session.resume();
// @ts-expect-error low-level loading is not part of the public callable session surface.
session.load();
// @ts-expect-error cancellation is supplied to runTurn through AbortSignal.
session.cancel();
