import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  openAcpSession as openAcpSessionEffect,
  type AcpError,
  type AcpEvent,
  type AcpLaunch,
  type AcpSession,
  type OpenAcpSessionInput,
} from "@acpus/acp";
import { AcpTransportNodeLive } from "@acpus/acp/transport";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

const agentFixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const openSessions: AcpSession[] = [];
let sessionScope = Scope.makeUnsafe();

type JsonRecord = Record<string, unknown>;
type WireMessage = {
  id?: string | number;
  method?: string;
  params?: JsonRecord;
  result?: JsonRecord;
  error?: JsonRecord;
};

type Fixture = {
  root: string;
  cwd: string;
  stateDirectory: string;
  logPath: string;
};

function openAcpSession(
  input: OpenAcpSessionInput,
): Promise<Result.Result<AcpSession, AcpError>> {
  return settle(Scope.provide(sessionScope)(
    openAcpSessionEffect(input).pipe(Effect.provide(AcpTransportNodeLive)),
  ));
}

function settle<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}

afterEach(async () => {
  await Promise.allSettled(openSessions.splice(0).map(session => settle(session.close())));
  await settle(Scope.close(sessionScope, Exit.void));
  sessionScope = Scope.makeUnsafe();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("@acpus/acp session process integration", () => {
  it.each([
    { name: "null input", value: null },
    { name: "unknown launch kind", value: { recordId: "x", stateDirectory: "/tmp", cwd: "/tmp", launch: { kind: "remote" }, permissionMode: "deny-all" } },
    { name: "invalid permission mode", value: { recordId: "x", stateDirectory: "/tmp", cwd: "/tmp", launch: { kind: "argv", argv: ["agent"] }, permissionMode: "sometimes" } },
  ])("returns invalid_input for malformed runtime $name", async ({ value }) => {
    const result = await openAcpSession(value as unknown as OpenAcpSessionInput);
    expect(errorOf(result)).toMatchObject({ type: "invalid_input", operation: "open_session" });
  });

  it("does not inspect projections or spawn for an already-aborted open", async () => {
    const fixture = await createFixture();
    const stateFile = join(fixture.root, "state-is-a-file");
    const pidPath = join(fixture.root, "pre-aborted.pid");
    await writeFile(stateFile, "not a directory\n");
    const controller = new AbortController();
    controller.abort();

    const opened = await openAcpSession({
      ...inputFor(fixture, {
        recordId: "pre-aborted-open",
        signal: controller.signal,
        env: { ACP_FIXTURE_PID_PATH: pidPath },
      }),
      stateDirectory: stateFile,
    });

    expect(errorOf(opened)).toMatchObject({
      type: "cancelled",
      operation: "open_session",
      retryable: false,
    } satisfies Partial<AcpError>);
    expect(await pathExists(pidPath)).toBe(false);
    expect(await pathExists(fixture.logPath)).toBe(false);
  });

  it.each([
    { scenario: "hang-initialize", method: "initialize", operation: "initialize" },
    { scenario: "hang-new", method: "session/new", operation: "new_session" },
  ] as const)("atomically cancels a hanging $method open", async ({ scenario, method, operation }) => {
    const fixture = await createFixture();
    const pidPath = join(fixture.root, `${scenario}.pid`);
    const controller = new AbortController();
    const pending = openAcpSession(inputFor(fixture, {
      recordId: scenario,
      scenarios: [scenario],
      signal: controller.signal,
      env: { ACP_FIXTURE_PID_PATH: pidPath },
    }));
    await waitUntil(async () => {
      if (!await pathExists(pidPath) || !await pathExists(fixture.logPath)) return false;
      return methods(await requestLog(fixture.logPath)).includes(method);
    });
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    expect(providerGroupExists(pid)).toBe(true);
    const outbound = request(await requestLog(fixture.logPath), method);

    controller.abort();
    await waitUntil(async () => (await requestLog(fixture.logPath)).some(message => message.method === "$/cancel_request"));
    const cancellation = request(await requestLog(fixture.logPath), "$/cancel_request");
    const opened = await pending;

    expect(cancellation.params).toEqual({ requestId: outbound.id });
    expect(errorOf(opened)).toMatchObject({
      type: "cancelled",
      operation,
      retryable: false,
    } satisfies Partial<AcpError>);
    expect(providerGroupExists(pid)).toBe(false);
    expect(await stateFiles(fixture)).toEqual([]);
    await nextMacrotask();
    expect(await stateFiles(fixture)).toEqual([]);
  });

  it("opens fresh through structured argv and projects two semantic turns", async () => {
    const fixture = await createFixture();
    const session = await openSession(fixture, {
      recordId: "record/semantic",
      scenarios: ["events"],
      argvSessionId: "argv session with spaces",
      configuration: { model: null, options: { alpha: "first-explicit" } },
    });

    expect(session).toMatchObject({
      agentSessionId: "record/semantic",
      sessionId: "argv session with spaces",
      projectionPath: "sessions/record%2Fsemantic.json",
      reportedVersion: "1.0.0",
    });

    const firstEvents: AcpEvent[] = [];
    const secondEvents: AcpEvent[] = [];
    const first = await runTurn(session, {
      prompt: "first prompt",
      onEvent: event => firstEvents.push(event),
    });
    const second = await runTurn(session, {
      prompt: "second prompt",
      onEvent: event => secondEvents.push(event),
    });

    expect(first).toEqual({
      status: "completed",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    });
    expect(second).toEqual({
      status: "completed",
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
    });
    expect(firstEvents).toEqual(turnEvents(fixture.cwd, 1, "first prompt"));
    expect(secondEvents).toEqual(turnEvents(fixture.cwd, 2, "second prompt"));

    const projection = await readProjection(fixture, session);
    expect(projection).toMatchObject({
      schema: "acpus.acp-session.v3",
      agentSessionId: "record/semantic",
      binding: {
        launch: {
          kind: "argv",
          argv: [process.execPath, agentFixture, "--session-id=argv session with spaces"],
        },
        cwd: fixture.cwd,
        model: null,
        options: { alpha: "first-explicit" },
      },
      backend: {
        sessionId: "argv session with spaces",
        capabilities: { resume: false, load: false },
      },
      conversation: [
        { type: "message", role: "user", content: "first prompt" },
        { type: "thought", content: "thought:1" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          title: "inspect:1",
          name: "fixture_search",
          kind: "search",
          status: "completed",
          input: { query: "first prompt" },
        },
        { type: "message", role: "assistant", content: "assistant:1:first prompt" },
        {
          type: "tool-result",
          toolCallId: "tool-1",
          content: [{ type: "content", content: { type: "text", text: "result:1" } }],
        },
        { type: "message", role: "user", content: "second prompt" },
        { type: "thought", content: "thought:2" },
        {
          type: "tool-call",
          toolCallId: "tool-2",
          title: "inspect:2",
          name: "fixture_search",
          kind: "search",
          status: "completed",
          input: { query: "second prompt" },
        },
        { type: "message", role: "assistant", content: "assistant:2:second prompt" },
        {
          type: "tool-result",
          toolCallId: "tool-2",
          content: [{ type: "content", content: { type: "text", text: "result:2" } }],
        },
      ],
      lastStop: {
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      },
    });
    expect(projection).not.toHaveProperty("environment");
    expect(projection).not.toHaveProperty("permissionMode");
    expect(projection).not.toHaveProperty("reportedVersion");
    expect((projection.binding as JsonRecord).launch).not.toHaveProperty("name");

    const requests = await requestLog(fixture.logPath);
    expect(methods(requests)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
      "session/prompt",
    ]);
    expect(request(requests, "initialize").params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "acpus", version: "0.1.0" },
    });
    expect(request(requests, "session/new").params).toEqual({ cwd: fixture.cwd, mcpServers: [] });
    expect(requests.filter(message => message.method === "session/set_config_option")).toHaveLength(1);
  });

  it("quarantines updates received after the prompt response fence", async () => {
    const fixture = await createFixture();
    const session = await openSession(fixture, {
      recordId: "late-update-fence",
      scenarios: ["post-response-update"],
    });
    const firstEvents: AcpEvent[] = [];
    const secondEvents: AcpEvent[] = [];
    await runTurn(session, { prompt: "first", onEvent: event => firstEvents.push(event) });
    await runTurn(session, { prompt: "second", onEvent: event => secondEvents.push(event) });

    const projection = await readProjection(fixture, session);
    expect(firstEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "late-1" }),
    ]));
    expect(secondEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "late-1" }),
    ]));
    expect(JSON.stringify(projection.conversation)).not.toContain("late:");
  });

  it("resumes the recorded backend session after restart", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, { recordId: "restart", scenarios: ["resume"] });
    expect(await runTurn(first, { prompt: "before restart" })).toMatchObject({ status: "completed" });
    await closeTracked(first);

    const restartLog = join(fixture.root, "restart.ndjson");
    const resumed = await openSession(fixture, {
      recordId: "restart",
      scenarios: ["resume"],
      logPath: restartLog,
      sessionId: "replacement-must-not-be-used",
      sessionOpenMode: "existing_required",
    });
    const events: AcpEvent[] = [];
    expect(resumed.sessionId).toBe("fixture-session");
    expect(await runTurn(resumed, { prompt: "after restart", onEvent: event => events.push(event) }))
      .toMatchObject({ status: "completed", stopReason: "end_turn" });
    expect(events).toContainEqual({
      type: "message",
      channel: "assistant",
      content: { type: "text", text: "reply|resume|after restart" },
      messageId: "message-1",
    });

    const requests = await requestLog(restartLog);
    expect(methods(requests)).toEqual(["initialize", "session/resume", "session/prompt"]);
    expect(request(requests, "session/resume").params).toEqual({
      sessionId: "fixture-session",
      cwd: fixture.cwd,
      mcpServers: [],
    });
  });

  it("rejects a binding mismatch before spawning the Provider", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, { recordId: "binding-mismatch" });
    await closeTracked(first);
    const logPath = join(fixture.root, "binding-mismatch.ndjson");
    const pidPath = join(fixture.root, "binding-mismatch.pid");

    const reopened = await openAcpSession(inputFor(fixture, {
      recordId: "binding-mismatch",
      logPath,
      env: { ACP_FIXTURE_PID_PATH: pidPath },
      launch: { kind: "command", command: "provider-must-not-start" },
    }));

    expect(errorOf(reopened)).toMatchObject({
      type: "session_binding",
      operation: "open_session",
      origin: "persistence",
      providerEvidence: "none",
      categories: ["launch"],
      retryable: false,
    });
    expect(await pathExists(logPath)).toBe(false);
    expect(await pathExists(pidPath)).toBe(false);
  });

  it("requires an existing projection before spawning for existing_required", async () => {
    const fixture = await createFixture();
    const pidPath = join(fixture.root, "missing-existing.pid");
    const opened = await openAcpSession(inputFor(fixture, {
      recordId: "missing-existing",
      sessionOpenMode: "existing_required",
      env: { ACP_FIXTURE_PID_PATH: pidPath },
    }));

    expect(errorOf(opened)).toMatchObject({
      type: "persistence",
      operation: "open_session",
      origin: "persistence",
      providerEvidence: "none",
      code: "validate",
      retryable: false,
    });
    expect(await pathExists(fixture.logPath)).toBe(false);
    expect(await pathExists(pidPath)).toBe(false);
    expect(await stateFiles(fixture)).toEqual([]);
  });

  it("rejects a non-empty projection before spawning for new_or_empty", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, { recordId: "non-empty-new" });
    await runTurn(first, { prompt: "persisted history" });
    await closeTracked(first);
    const projectionPath = join(fixture.stateDirectory, first.projectionPath);
    const original = await readFile(projectionPath, "utf8");
    const logPath = join(fixture.root, "non-empty-new.ndjson");
    const pidPath = join(fixture.root, "non-empty-new.pid");

    const reopened = await openAcpSession(inputFor(fixture, {
      recordId: "non-empty-new",
      logPath,
      env: { ACP_FIXTURE_PID_PATH: pidPath },
    }));

    expect(errorOf(reopened)).toMatchObject({
      type: "persistence",
      operation: "open_session",
      origin: "persistence",
      providerEvidence: "none",
      code: "validate",
      retryable: false,
    });
    expect(await pathExists(logPath)).toBe(false);
    expect(await pathExists(pidPath)).toBe(false);
    expect(await readFile(projectionPath, "utf8")).toBe(original);
  });

  it("falls back to load and keeps replay updates out of the next turn callback", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, { recordId: "load-record", scenarios: ["load"] });
    expect(await runTurn(first, { prompt: "saved turn" })).toMatchObject({ status: "completed" });
    await closeTracked(first);

    const loadLog = join(fixture.root, "load.ndjson");
    const loaded = await openSession(fixture, {
      recordId: "load-record",
      scenarios: ["load", "load-replay"],
      logPath: loadLog,
      sessionOpenMode: "existing_required",
    });
    const turnEvents: AcpEvent[] = [];
    expect(await runTurn(loaded, { prompt: "current turn", onEvent: event => turnEvents.push(event) }))
      .toMatchObject({ status: "completed" });

    expect(turnEvents).toEqual([{
      type: "message",
      channel: "assistant",
      content: { type: "text", text: "reply|load|current turn" },
      messageId: "message-1",
    }]);
    const projection = await readProjection(fixture, loaded);
    expect(projection.conversation).toEqual(expect.arrayContaining([
      { type: "message", role: "user", content: "current turn" },
      { type: "message", role: "assistant", content: "reply|load|current turn" },
    ]));
    expect(methods(await requestLog(loadLog))).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  it("refuses unsupported recovery without creating a replacement session", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, { recordId: "unsupported", scenarios: ["resume"] });
    await closeTracked(first);

    const unsupportedLog = join(fixture.root, "unsupported.ndjson");
    const opened = await openAcpSession(inputFor(fixture, {
      recordId: "unsupported",
      logPath: unsupportedLog,
      sessionId: "must-not-be-created",
      sessionOpenMode: "existing_required",
    }));

    expect(Result.isFailure(opened)).toBe(true);
    if (Result.isSuccess(opened)) throw new Error("Expected unsupported recovery to fail.");
    expect(opened.failure).toMatchObject({
      type: "capability",
      operation: "resume_session",
      capability: "resume",
      retryable: false,
    } satisfies Partial<AcpError>);
    expect(methods(await requestLog(unsupportedLog))).toEqual(["initialize"]);
  });

  it("waits for late cancellation updates and the prompt result", async () => {
    const fixture = await createFixture();
    const releasePath = join(fixture.root, "release-cancel");
    const session = await openSession(fixture, {
      recordId: "cancel",
      scenarios: ["cancel-late"],
      env: { ACP_FIXTURE_RELEASE_PATH: releasePath },
    });
    const controller = new AbortController();
    const events: AcpEvent[] = [];
    const pending = settle(session.runTurn({
      prompt: "cancel me",
      signal: controller.signal,
      onEvent: event => events.push(event),
    }));
    await waitUntil(() => events.length === 1);

    controller.abort();
    await waitUntil(() => events.length === 2);
    let settled = false;
    void pending.then(() => { settled = true; });
    await nextMacrotask();
    expect(settled).toBe(false);
    expect(events).toEqual([
      {
        type: "tool",
        action: "call",
        toolCallId: "cancel-tool-1",
        title: "cancellable fixture work",
        kind: "execute",
        status: "in_progress",
        input: { turn: 1 },
      },
      {
        type: "tool",
        action: "update",
        toolCallId: "cancel-tool-1",
        status: "failed",
        output: { cancelled: true },
      },
    ]);

    await writeFile(releasePath, "release\n");
    expect(valueOf(await pending)).toEqual({
      status: "cancelled",
      stopReason: "cancelled",
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    });
    expect(methods(await requestLog(fixture.logPath))).toEqual([
      "initialize", "session/new", "session/prompt", "session/cancel",
    ]);
  });

  it("cancels an already-aborted turn without dispatching its prompt", async () => {
    const fixture = await createFixture();
    const session = await openSession(fixture, { recordId: "pre-aborted" });
    const controller = new AbortController();
    controller.abort();

    expect(await runTurn(session, {
      prompt: "must not dispatch",
      signal: controller.signal,
    })).toEqual({ status: "cancelled", stopReason: "cancelled" });

    await waitUntil(async () => methods(await requestLog(fixture.logPath)).includes("session/cancel"));
    expect(methods(await requestLog(fixture.logPath))).toEqual([
      "initialize", "session/new", "session/cancel",
    ]);
    expect(await readProjection(fixture, session)).toMatchObject({
      conversation: [{ type: "message", role: "user", content: "must not dispatch" }],
      lastStop: { stopReason: "cancelled" },
    });
  });

  it("observes cancellation delivery failure when configuration fails first", async () => {
    const fixture = await createFixture();
    const pidPath = join(fixture.root, "exit-after-new.pid");
    const session = await openSession(fixture, {
      recordId: "cancel-delivery-failure",
      scenarios: ["exit-after-new"],
      env: { ACP_FIXTURE_PID_PATH: pidPath },
    });
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    await waitUntil(() => !providerGroupExists(pid));
    await nextMacrotask();
    const controller = new AbortController();
    controller.abort();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      expect(await runTurn(session, {
        prompt: "cancel after transport close",
        configuration: { model: "unavailable-model" },
        signal: controller.signal,
      })).toEqual({ status: "cancelled", stopReason: "cancelled" });
      await nextMacrotask();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("isolates synchronous and asynchronous event callback failures", async () => {
    const fixture = await createFixture();
    const session = await openSession(fixture, { recordId: "callbacks", scenarios: ["events"] });
    let syncCalls = 0;
    let asyncCalls = 0;

    expect(await runTurn(session, {
      prompt: "sync callback",
      onEvent: () => {
        syncCalls += 1;
        throw new Error("sync observer failure");
      },
    })).toMatchObject({ status: "completed", stopReason: "end_turn" });
    expect(await runTurn(session, {
      prompt: "async callback",
      onEvent: async () => {
        asyncCalls += 1;
        throw new Error("async observer failure");
      },
    })).toMatchObject({ status: "completed", stopReason: "end_turn" });
    await nextMacrotask();

    expect(syncCalls).toBe(8);
    expect(asyncCalls).toBe(8);

    expect(await runTurn(session, {
      prompt: "never settling callback",
      onEvent: () => new Promise(() => {}),
    })).toMatchObject({ status: "completed", stopReason: "end_turn" });
  });

  it("enforces one active turn and idempotent close semantics", async () => {
    const fixture = await createFixture();
    const releasePath = join(fixture.root, "release-active");
    const session = await openSession(fixture, {
      recordId: "session-state",
      scenarios: ["cancel-late"],
      env: { ACP_FIXTURE_RELEASE_PATH: releasePath },
    });
    const controller = new AbortController();
    const activeTurn = settle(session.runTurn({ prompt: "active", signal: controller.signal }));
    await waitUntil(async () => methods(await requestLog(fixture.logPath)).includes("session/prompt"));

    const concurrent = await settle(session.runTurn({ prompt: "second" }));
    expect(errorOf(concurrent)).toMatchObject({
      type: "session",
      operation: "run_turn",
      retryable: false,
    });

    controller.abort();
    await writeFile(releasePath, "release\n");
    expect(valueOf(await activeTurn)).toMatchObject({ status: "cancelled" });
    const firstClose = settle(session.close("test close"));
    const secondClose = settle(session.close("ignored duplicate"));
    expect(valueOf(await firstClose)).toBeUndefined();
    expect(valueOf(await secondClose)).toBeUndefined();

    const afterClose = await settle(session.runTurn({ prompt: "closed" }));
    expect(errorOf(afterClose)).toMatchObject({
      type: "session",
      operation: "run_turn",
      retryable: false,
    });
    const index = openSessions.indexOf(session);
    if (index >= 0) openSessions.splice(index, 1);
  });

  it("waits for active turn settlement before close returns", async () => {
    const fixture = await createFixture();
    const releasePath = join(fixture.root, "release-close");
    const session = await openSession(fixture, {
      recordId: "close-active",
      scenarios: ["cancel-late", "close-session"],
      env: { ACP_FIXTURE_RELEASE_PATH: releasePath },
    });
    const turn = settle(session.runTurn({ prompt: "close while active" }));
    await waitUntil(async () => methods(await requestLog(fixture.logPath)).includes("session/prompt"));

    let closed = false;
    const closing = (async (): Promise<Result.Result<void, AcpError>> => {
      const result = await settle(session.close());
      closed = true;
      return result;
    })();
    await nextMacrotask();
    expect(closed).toBe(false);

    await writeFile(releasePath, "release\n");
    const turnResult = await turn;
    if (Result.isFailure(turnResult)) throw new Error(JSON.stringify(turnResult.failure));
    expect(turnResult.success).toMatchObject({ status: "cancelled" });
    expect(valueOf(await closing)).toBeUndefined();
    expect(methods(await requestLog(fixture.logPath))).toContain("session/close");
    const projection = await readProjection(fixture, session);
    expect(projection).toMatchObject({ lastStop: { stopReason: "cancelled" } });
    const index = openSessions.indexOf(session);
    if (index >= 0) openSessions.splice(index, 1);
  });

  it("forces transport and provider cleanup when an active turn ignores cancellation", async () => {
    const fixture = await createFixture();
    const pidPath = join(fixture.root, "ignore-cancel.pid");
    const session = await openSession(fixture, {
      recordId: "ignore-cancel-close",
      scenarios: ["cancel-late", "ignore-cancel"],
      env: { ACP_FIXTURE_PID_PATH: pidPath },
    });
    const turn = settle(session.runTurn({ prompt: "ignore cancellation" }));
    await waitUntil(async () => methods(await requestLog(fixture.logPath)).includes("session/prompt"));
    const pid = Number((await readFile(pidPath, "utf8")).trim());

    const closed = await settle(session.close("forced close"));

    expect(valueOf(closed)).toBeUndefined();
    expect(providerGroupExists(pid)).toBe(false);
    expect(valueOf(await turn)).toEqual({ status: "cancelled", stopReason: "cancelled" });
    const index = openSessions.indexOf(session);
    if (index >= 0) openSessions.splice(index, 1);
  });

  it("runs semantic Provider cleanup when the owning Session Scope closes", async () => {
    const fixture = await createFixture();
    const pidPath = join(fixture.root, "scope-close.pid");
    const owningScope = Scope.makeUnsafe();
    const opened = await settle(Scope.provide(owningScope)(
      openAcpSessionEffect(inputFor(fixture, {
        recordId: "scope-close",
        env: { ACP_FIXTURE_PID_PATH: pidPath },
      })).pipe(Effect.provide(AcpTransportNodeLive)),
    ));
    const session = valueOf(opened);
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    expect(providerGroupExists(pid)).toBe(true);

    await Effect.runPromise(Scope.close(owningScope, Exit.void));

    expect(providerGroupExists(pid)).toBe(false);
    expect(valueOf(await settle(session.close("already finalized")))).toBeUndefined();
  });

  it("rejects an unsupported ACP protocol version", async () => {
    const fixture = await createFixture();
    const badProtocol = await openAcpSession(inputFor(fixture, {
      recordId: "bad-protocol",
      scenarios: ["bad-protocol"],
      logPath: join(fixture.root, "bad-protocol.ndjson"),
    }));
    expect(errorOf(badProtocol)).toMatchObject({
      type: "initialize",
      operation: "initialize",
      retryable: false,
    });
  });

  it("sorts explicit model and options, retains omission, and replays after resume", async () => {
    const fixture = await createFixture();
    const first = await openSession(fixture, {
      recordId: "configuration",
      scenarios: ["config", "resume"],
      configuration: {
        model: "model-explicit",
        options: { zeta: "last", alpha: "first", middle: "middle" },
      },
    });
    expect(await runTurn(first, {
      prompt: "configured",
    })).toMatchObject({ status: "completed" });
    expect(await runTurn(first, { prompt: "retain configuration" })).toMatchObject({ status: "completed" });

    const firstRequests = await requestLog(fixture.logPath);
    expect(methods(firstRequests)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/prompt",
    ]);
    expect(configRequests(firstRequests)).toEqual([
      { sessionId: "fixture-session", configId: "model-choice", value: "model-explicit" },
      { sessionId: "fixture-session", configId: "alpha", value: "first" },
      { sessionId: "fixture-session", configId: "middle", value: "middle" },
      { sessionId: "fixture-session", configId: "zeta", value: "last" },
    ]);
    await closeTracked(first);

    const replayLog = join(fixture.root, "configuration-replay.ndjson");
    const resumed = await openSession(fixture, {
      recordId: "configuration",
      scenarios: ["config", "resume"],
      logPath: replayLog,
      sessionOpenMode: "existing_required",
      configuration: {
        model: "model-explicit",
        options: { zeta: "last", alpha: "first", middle: "middle" },
      },
    });
    expect(await runTurn(resumed, { prompt: "after replay" })).toMatchObject({ status: "completed" });
    const replayRequests = await requestLog(replayLog);
    expect(methods(replayRequests)).toEqual([
      "initialize",
      "session/resume",
      "session/set_config_option",
      "session/set_config_option",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(configRequests(replayRequests)).toEqual(configRequests(firstRequests));
  });

  it("rejects an attempt to mutate the Session configuration", async () => {
    const fixture = await createFixture();
    const session = await openSession(fixture, {
      recordId: "configuration-replacement",
      scenarios: ["config"],
      configuration: { model: null, options: { alpha: "alpha-explicit", zeta: "zeta-explicit" } },
    });

    await runTurn(session, { prompt: "initial options" });
    const mutation = await settle(session.runTurn({
      prompt: "replacement options",
      configuration: { options: { alpha: "alpha-replaced" } },
    }));

    expect(errorOf(mutation)).toMatchObject({
      type: "configuration",
      operation: "configure_session",
      providerEvidence: "none",
      retryable: false,
    });
    expect(configRequests(await requestLog(fixture.logPath))).toEqual([
      { sessionId: "fixture-session", configId: "alpha", value: "alpha-explicit" },
      { sessionId: "fixture-session", configId: "zeta", value: "zeta-explicit" },
    ]);
    expect(methods(await requestLog(fixture.logPath)).filter(method => method === "session/prompt"))
      .toHaveLength(1);
  });

  it("completes one reverse permission, filesystem, and terminal cooperation path", async () => {
    const fixture = await createFixture();
    const source = join(fixture.cwd, "reverse-input.txt");
    const target = join(fixture.cwd, "nested", "reverse-output.txt");
    await writeFile(source, "line one\nline two\n");
    const session = await openSession(fixture, {
      recordId: "reverse",
      scenarios: ["reverse"],
      permissionMode: "approve-all",
      env: {
        ACP_FIXTURE_READ_PATH: source,
        ACP_FIXTURE_EXPECTED_READ: "line one\nline two\n",
        ACP_FIXTURE_WRITE_PATH: target,
      },
    });
    const events: AcpEvent[] = [];

    expect(await runTurn(session, { prompt: "cooperate", onEvent: event => events.push(event) }))
      .toMatchObject({ status: "completed", stopReason: "end_turn" });
    expect(await readFile(target, "utf8")).toBe("fixture-written\n");
    expect(events.map(event => event.type === "activity" ? event.operation : event.type)).toEqual([
      "session/request_permission",
      "fs/read_text_file",
      "fs/write_text_file",
      "terminal/create",
      "terminal/wait_for_exit",
      "terminal/output",
      "terminal/release",
      "message",
    ]);
    const message = events.at(-1);
    expect(message).toMatchObject({ type: "message", channel: "assistant" });
    if (message?.type !== "message") throw new Error("Expected reverse cooperation summary.");
    const content = message.content as { type: string; text: string };
    expect(JSON.parse(content.text)).toEqual({
      permission: { outcome: { outcome: "selected", optionId: "allow-once" } },
      read: { content: "line one\nline two\n" },
      written: {},
      waited: { exitCode: 0, signal: null },
      output: {
        output: "fixture-terminal",
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
      },
      released: {},
    });

    const reverseResponses = (await requestLog(fixture.logPath))
      .filter(message => message.method === undefined && message.id !== undefined);
    expect(reverseResponses.map(message => message.id)).toEqual([
      "permission-1",
      "read-1",
      "write-1",
      "terminal-create-1",
      "terminal-wait-1",
      "terminal-output-1",
      "terminal-release-1",
    ]);
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "acpus-acp-session-"));
  temporaryRoots.push(root);
  const cwd = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await Promise.all([mkdir(cwd), mkdir(stateDirectory)]);
  return { root, cwd, stateDirectory, logPath: join(root, "requests.ndjson") };
}

function inputFor(
  fixture: Fixture,
  options: {
    recordId: string;
    scenarios?: readonly string[];
    argvSessionId?: string;
    sessionId?: string;
    logPath?: string;
    env?: NodeJS.ProcessEnv;
    permissionMode?: OpenAcpSessionInput["permissionMode"];
    configuration?: OpenAcpSessionInput["configuration"];
    launch?: AcpLaunch;
    sessionOpenMode?: OpenAcpSessionInput["sessionOpenMode"];
    signal?: AbortSignal;
  },
): OpenAcpSessionInput {
  const argv = [
    process.execPath,
    agentFixture,
    ...(options.argvSessionId === undefined ? [] : [`--session-id=${options.argvSessionId}`]),
  ] as [string, ...string[]];
  return {
    agentSessionId: options.recordId,
    sessionOpenMode: options.sessionOpenMode ?? "new_or_empty",
    stateDirectory: fixture.stateDirectory,
    launch: options.launch ?? { kind: "argv", argv, name: "integration-fixture" },
    cwd: fixture.cwd,
    env: {
      ACP_FIXTURE_LOG_PATH: options.logPath ?? fixture.logPath,
      ...(options.scenarios === undefined
        ? {}
        : { ACP_FIXTURE_SCENARIO: options.scenarios.join(",") }),
      ...(options.sessionId === undefined ? {} : { ACP_FIXTURE_SESSION_ID: options.sessionId }),
      ...options.env,
    },
    permissionMode: options.permissionMode ?? "deny-all",
    configuration: options.configuration ?? { model: null, options: {} },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function openSession(
  fixture: Fixture,
  options: Parameters<typeof inputFor>[1],
): Promise<AcpSession> {
  const opened = await openAcpSession(inputFor(fixture, options));
  if (Result.isFailure(opened)) throw new Error(`Could not open fixture session: ${JSON.stringify(opened.failure)}`);
  openSessions.push(opened.success);
  return opened.success;
}

async function closeTracked(session: AcpSession): Promise<void> {
  const index = openSessions.indexOf(session);
  if (index >= 0) openSessions.splice(index, 1);
  const closed = await settle(session.close());
  if (Result.isFailure(closed)) throw new Error(`Could not close fixture session: ${JSON.stringify(closed.failure)}`);
}

async function readProjection(
  fixture: Fixture,
  session: AcpSession,
): Promise<{ conversation: unknown[]; [key: string]: unknown }> {
  return JSON.parse(await readFile(join(fixture.stateDirectory, session.projectionPath), "utf8")) as {
    conversation: unknown[];
    [key: string]: unknown;
  };
}

async function requestLog(path: string): Promise<WireMessage[]> {
  const source = await readFile(path, "utf8");
  return source.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as WireMessage);
}

function methods(messages: WireMessage[]): string[] {
  return messages.flatMap(message => message.method === undefined ? [] : [message.method]);
}

function request(messages: WireMessage[], method: string): WireMessage {
  const found = messages.find(message => message.method === method);
  if (found === undefined) throw new Error(`Expected request ${method}.`);
  return found;
}

function configRequests(messages: WireMessage[]): JsonRecord[] {
  return messages.flatMap(message => message.method === "session/set_config_option"
    ? [message.params ?? {}]
    : []);
}

function valueOf<T, E>(result: Result.Result<T, E>): T {
  if (Result.isFailure(result)) throw new Error(`Expected operation to succeed: ${JSON.stringify(result.failure)}`);
  return result.success;
}

function errorOf<T, E>(result: Result.Result<T, E>): E {
  if (Result.isSuccess(result)) throw new Error("Expected operation to fail.");
  return result.failure;
}

async function runTurn(
  session: AcpSession,
  input: Parameters<AcpSession["runTurn"]>[0],
) {
  return valueOf(await settle(session.runTurn(input)));
}

function turnEvents(cwd: string, number: number, prompt: string): AcpEvent[] {
  return [
    {
      type: "plan",
      value: [{ content: `plan:${number}`, priority: "high", status: "in_progress" }],
    },
    {
      type: "message",
      channel: "thought",
      content: { type: "text", text: `thought:${number}` },
      messageId: `thought-${number}`,
    },
    {
      type: "tool",
      action: "call",
      toolCallId: `tool-${number}`,
      title: `inspect:${number}`,
      name: "fixture_search",
      kind: "search",
      status: "in_progress",
      input: { query: prompt },
      locations: [{ path: join(cwd, `turn-${number}.txt`), line: number }],
    },
    {
      type: "message",
      channel: "assistant",
      content: { type: "text", text: `assistant:${number}:${prompt}` },
      messageId: `message-${number}`,
    },
    {
      type: "tool",
      action: "update",
      toolCallId: `tool-${number}`,
      status: "completed",
      output: { private: `raw:${number}` },
      content: [{ type: "content", content: { type: "text", text: `result:${number}` } }],
    },
    {
      type: "usage",
      context: { used: number * 11, size: 1_000 },
      tokens: { inputTokens: number * 10, outputTokens: number, totalTokens: number * 11 },
      cost: { amount: number / 100, currency: "USD" },
    },
    {
      type: "session",
      update: "available_commands",
      value: [{ name: `command-${number}`, description: `Command ${number}` }],
    },
    {
      type: "unknown",
      name: "user_message_chunk",
      value: {
        sessionUpdate: "user_message_chunk",
        messageId: `echo-${number}`,
        content: { type: "text", text: `echo:${prompt}` },
      },
    },
  ];
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  throw new Error("Condition was not met.");
}

function nextMacrotask(): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, 0));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function stateFiles(fixture: Fixture): Promise<string[]> {
  return (await readdir(fixture.stateDirectory, { recursive: true })).sort();
}

function providerGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}
