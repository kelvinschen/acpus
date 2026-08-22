import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const scenarios = new Set();
let argvSessionId;
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--scenario=")) addScenarios(argument.slice("--scenario=".length));
  else if (argument.startsWith("--session-id=")) argvSessionId = argument.slice("--session-id=".length);
  else addScenarios(argument.replace(/^--/u, ""));
}
addScenarios(process.env.ACP_FIXTURE_SCENARIO);
const hangingOpen = scenarios.has("hang-initialize") || scenarios.has("hang-new");
let cancellationReceived = false;
let terminationRequested = false;

if (process.env.ACP_FIXTURE_PID_PATH !== undefined) {
  writeFileSync(process.env.ACP_FIXTURE_PID_PATH, `${process.pid}\n`);
}
if (hangingOpen) {
  process.on("SIGTERM", () => {
    terminationRequested = true;
    if (cancellationReceived) process.exit(0);
  });
}

const requestLogPath = process.env.ACP_FIXTURE_LOG_PATH;
const freshSessionId = process.env.ACP_FIXTURE_SESSION_ID ?? argvSessionId ?? "fixture-session";
const exitCode = Number(process.env.ACP_FIXTURE_EXIT_CODE ?? 23);
const configValues = new Map([
  ["model-choice", "model-default"],
  ["alpha", "alpha-default"],
  ["middle", "middle-default"],
  ["zeta", "zeta-default"],
]);
const reverseRequests = new Map();
let activeSessionId = freshSessionId;
let activeSessionMethod = "new";
let cwd = process.cwd();
let promptCount = 0;
let activePrompt;
let exiting = false;

createInterface({ input: process.stdin })
  .on("close", () => {
    if (!exiting && !hangingOpen) process.exit(0);
  })
  .on("line", line => {
    const message = JSON.parse(line);
    if (requestLogPath !== undefined) appendFileSync(requestLogPath, `${JSON.stringify(message)}\n`);
    if (hangingOpen && message.method === "$/cancel_request") {
      cancellationReceived = true;
      if (terminationRequested) process.exit(0);
    }
    if (message.method === undefined && message.id !== undefined) {
      reverseRequests.get(message.id)?.(message);
      reverseRequests.delete(message.id);
      return;
    }
    void handle(message).catch(error => {
      if (message.id !== undefined) respondError(message.id, -32000, error instanceof Error ? error.message : String(error));
    });
  });

async function handle(request) {
  if (request.method === "initialize") {
    if (scenarios.has("exit-initialize")) {
      exiting = true;
      process.exit(exitCode);
    }
    if (scenarios.has("hang-initialize")) return;
    respond(request.id, {
      protocolVersion: scenarios.has("bad-protocol") ? 2 : 1,
      authMethods: [],
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        ...(scenarios.has("load") ? { loadSession: true } : {}),
        ...(scenarios.has("resume") || scenarios.has("close-session")
          ? { sessionCapabilities: {
              ...(scenarios.has("resume") ? { resume: {} } : {}),
              ...(scenarios.has("close-session") ? { close: {} } : {}),
            } }
          : {}),
      },
      agentInfo: { name: "acpus-acp-test-fixture", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "session/new") {
    if (scenarios.has("hang-new")) return;
    activate(request.params, freshSessionId, "new");
    respond(request.id, { sessionId: activeSessionId, ...sessionState() });
    if (scenarios.has("exit-after-new")) {
      exiting = true;
      setImmediate(() => process.exit(exitCode));
    }
    return;
  }
  if (request.method === "session/resume") {
    activate(request.params, request.params.sessionId, "resume");
    respond(request.id, sessionState());
    return;
  }
  if (request.method === "session/load") {
    activate(request.params, request.params.sessionId, "load");
    if (scenarios.has("load-replay")) {
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "load-replay",
        content: { type: "text", text: `replayed:${activeSessionId}` },
      });
    }
    respond(request.id, sessionState());
    return;
  }
  if (request.method === "session/set_config_option") {
    configValues.set(request.params.configId, request.params.value);
    respond(request.id, { configOptions: configOptions() });
    return;
  }
  if (request.method === "session/prompt") {
    await prompt(request);
    return;
  }
  if (request.method === "session/cancel") {
    await cancel(request.params.sessionId);
    return;
  }
  if (request.method === "session/close") {
    if (!scenarios.has("ignore-close")) respond(request.id, {});
    return;
  }
  if (request.id !== undefined) respond(request.id, {});
}

function activate(params, sessionId, method) {
  activeSessionId = sessionId;
  activeSessionMethod = method;
  cwd = params.cwd;
}

function sessionState() {
  return scenarios.has("config") ? { configOptions: configOptions() } : {};
}

function configOptions() {
  return [...configValues].map(([id, currentValue]) => ({
    type: "select",
    id,
    name: id,
    ...(id === "model-choice" ? { category: "model" } : {}),
    currentValue,
    options: [...new Set([currentValue, `${id}-default`])].map(value => ({ value, name: value })),
  }));
}

async function prompt(request) {
  promptCount += 1;
  activeSessionId = request.params.sessionId;
  const text = request.params.prompt?.[0]?.text ?? "";
  const state = { id: request.id, sessionId: activeSessionId, number: promptCount, text };
  activePrompt = state;

  if (scenarios.has("cancel-late")) {
    update({
      sessionUpdate: "tool_call",
      toolCallId: `cancel-tool-${state.number}`,
      title: "cancellable fixture work",
      kind: "execute",
      status: "in_progress",
      rawInput: { turn: state.number },
    });
    return;
  }

  if (scenarios.has("reverse")) await cooperate(state);
  else if (scenarios.has("events")) emitSemanticUpdates(state);
  else update({
    sessionUpdate: "agent_message_chunk",
    messageId: `message-${state.number}`,
    content: { type: "text", text: `reply|${activeSessionMethod}|${text}` },
  });

  finishPrompt(state, "end_turn");
  if (scenarios.has("post-response-update")) {
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: `late-${state.number}`,
      content: { type: "text", text: `late:${state.number}` },
    });
  }
}

function emitSemanticUpdates(state) {
  const number = state.number;
  const toolCallId = `tool-${number}`;
  update({
    sessionUpdate: "plan",
    entries: [{ content: `plan:${number}`, priority: "high", status: "in_progress" }],
  });
  update({
    sessionUpdate: "agent_thought_chunk",
    messageId: `thought-${number}`,
    content: { type: "text", text: `thought:${number}` },
  });
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: `inspect:${number}`,
    name: "fixture_search",
    kind: "search",
    status: "in_progress",
    rawInput: { query: state.text },
    locations: [{ path: resolve(cwd, `turn-${number}.txt`), line: number }],
  });
  update({
    sessionUpdate: "agent_message_chunk",
    messageId: `message-${number}`,
    content: { type: "text", text: `assistant:${number}:${state.text}` },
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: { private: `raw:${number}` },
    content: [{ type: "content", content: { type: "text", text: `result:${number}` } }],
  });
  update({
    sessionUpdate: "usage_update",
    used: number * 11,
    size: 1_000,
    cost: { amount: number / 100, currency: "USD" },
    _meta: { usage: usage(number) },
  });
  update({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: `command-${number}`, description: `Command ${number}` }],
  });
  update({
    sessionUpdate: "user_message_chunk",
    messageId: `echo-${number}`,
    content: { type: "text", text: `echo:${state.text}` },
  });
}

async function cooperate(state) {
  const permission = resultOf(await reverse(`permission-${state.number}`, "session/request_permission", {
    sessionId: state.sessionId,
    toolCall: {
      toolCallId: `reverse-tool-${state.number}`,
      title: "Edit fixture output",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: process.env.ACP_FIXTURE_WRITE_PATH },
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ],
  }));
  assert(permission.outcome?.outcome === "selected" && permission.outcome.optionId === "allow-once", "permission response");

  const read = resultOf(await reverse(`read-${state.number}`, "fs/read_text_file", {
    sessionId: state.sessionId,
    path: process.env.ACP_FIXTURE_READ_PATH,
    line: 1,
    limit: 20,
  }));
  assert(read.content === process.env.ACP_FIXTURE_EXPECTED_READ, "filesystem read response");
  const written = resultOf(await reverse(`write-${state.number}`, "fs/write_text_file", {
    sessionId: state.sessionId,
    path: process.env.ACP_FIXTURE_WRITE_PATH,
    content: "fixture-written\n",
  }));
  assert(Object.keys(written).length === 0, "filesystem write response");

  const created = resultOf(await reverse(`terminal-create-${state.number}`, "terminal/create", {
    sessionId: state.sessionId,
    command: process.execPath,
    args: ["-e", "process.stdout.write('fixture-terminal')"],
    cwd,
    outputByteLimit: 1_024,
  }));
  assert(typeof created.terminalId === "string", "terminal create response");
  const terminalParams = { sessionId: state.sessionId, terminalId: created.terminalId };
  const waited = resultOf(await reverse(`terminal-wait-${state.number}`, "terminal/wait_for_exit", terminalParams));
  assert(waited.exitCode === 0 && waited.signal === null, "terminal wait response");
  const output = resultOf(await reverse(`terminal-output-${state.number}`, "terminal/output", terminalParams));
  assert(output.output === "fixture-terminal" && output.truncated === false, "terminal output response");
  const released = resultOf(await reverse(`terminal-release-${state.number}`, "terminal/release", terminalParams));
  assert(Object.keys(released).length === 0, "terminal release response");

  const summary = { permission, read, written, waited, output, released };
  update({
    sessionUpdate: "agent_message_chunk",
    messageId: `reverse-summary-${state.number}`,
    content: { type: "text", text: JSON.stringify(summary) },
  });
}

async function cancel(sessionId) {
  const state = activePrompt;
  if (state === undefined || state.sessionId !== sessionId) return;
  if (scenarios.has("ignore-cancel")) return;
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: `cancel-tool-${state.number}`,
    status: "failed",
    rawOutput: { cancelled: true },
  });
  const releasePath = process.env.ACP_FIXTURE_RELEASE_PATH;
  if (releasePath !== undefined) await waitForPath(releasePath);
  finishPrompt(state, "cancelled");
}

function finishPrompt(state, stopReason) {
  if (activePrompt !== state) return;
  respond(state.id, { stopReason, usage: usage(state.number) });
  activePrompt = undefined;
}

function usage(number) {
  return { inputTokens: number * 10, outputTokens: number, totalTokens: number * 11 };
}

function reverse(id, method, params) {
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise(resolveRequest => reverseRequests.set(id, resolveRequest));
}

function resultOf(response) {
  if (response.error !== undefined) throw new Error(`reverse request failed: ${response.error.message}`);
  return response.result;
}

function assert(condition, label) {
  if (!condition) throw new Error(`unexpected ${label}`);
}

async function waitForPath(path) {
  while (!existsSync(path)) await new Promise(resolveWait => setTimeout(resolveWait, 5));
}

function addScenarios(value) {
  for (const scenario of value?.split(",") ?? []) {
    if (scenario.trim() !== "") scenarios.add(scenario.trim());
  }
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(value) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: activeSessionId, update: value },
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
