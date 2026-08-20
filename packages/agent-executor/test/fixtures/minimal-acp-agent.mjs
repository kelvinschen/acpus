import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const configuredResponse = process.argv[2] ?? "fixture response";
const flags = new Set(process.argv.slice(3));
const freshSessionId = process.env.ACP_FIXTURE_SESSION_ID ?? "fixture-session";
const exitCode = Number(process.env.ACP_FIXTURE_EXIT_CODE ?? 17);
const configValues = new Map([["fixture", "default"]]);
const reverseRequests = new Map();
let activeSessionId = freshSessionId;
let activeSessionMethod = "new";
let cwd = process.cwd();
let promptCount = 0;
let activePrompt;
let exiting = false;

if (process.env.ACP_FIXTURE_PID_PATH !== undefined) {
  await writeFile(process.env.ACP_FIXTURE_PID_PATH, `${process.pid}\n`);
}

createInterface({ input: process.stdin })
  .on("close", () => {
    if (!exiting) process.exit(0);
  })
  .on("line", line => {
    const message = JSON.parse(line);
    if (message.method === undefined && message.id !== undefined) {
      reverseRequests.get(message.id)?.(message);
      reverseRequests.delete(message.id);
      return;
    }
    void handle(message);
  });

async function handle(request) {
  if (request.method === "initialize") {
    if (flags.has("exit-on-initialize")) return exit();
    if (flags.has("malformed-on-initialize")) return malformed();
    await pauseOpen("initialize");
    const agentCapabilities = initializeCapabilities();
    respond(request.id, {
      protocolVersion: 1,
      authMethods: [],
      ...(agentCapabilities === undefined ? {} : { agentCapabilities }),
      agentInfo: { name: "acpus-test-fixture", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "session/new") {
    if (flags.has("reject-new")) {
      respondError(request.id, -32000, "fixture rejected session/new");
      return;
    }
    await pauseOpen("new");
    activate(request.params, freshSessionId, "new");
    respond(request.id, { sessionId: activeSessionId, ...sessionState() });
    return;
  }
  if (request.method === "session/resume") {
    activate(request.params, request.params.sessionId, "resume");
    respond(request.id, sessionState());
    return;
  }
  if (request.method === "session/load") {
    activate(request.params, request.params.sessionId, "load");
    if (flags.has("load-replay")) {
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "fixture-replay",
        content: { type: "text", text: `fixture replay|load|${activeSessionId}` },
      });
    }
    respond(request.id, sessionState());
    return;
  }
  if (request.method === "session/set_config_option") {
    configValues.set(request.params.configId, request.params.value);
    const result = { configOptions: configOptions() };
    if (flags.has("config-update")) update({ sessionUpdate: "config_option_update", ...result });
    respond(request.id, result);
    return;
  }
  if (request.method === "session/prompt") {
    await prompt(request);
    return;
  }
  if (request.method === "session/cancel") {
    await cancel(request.params?.sessionId);
    return;
  }
  if (request.id !== undefined) respond(request.id, {});
}

async function pauseOpen(operation) {
  if (flags.has(`delay-${operation}`)) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, Number(process.env.ACP_FIXTURE_DELAY_MS ?? 5_100)));
  }
  if (!flags.has(`gate-${operation}`)) return;
  const directory = process.env.ACP_FIXTURE_GATE_DIRECTORY;
  if (directory === undefined) throw new Error("ACP_FIXTURE_GATE_DIRECTORY is required for an open gate.");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${operation}.started`), "");
  const release = resolve(directory, `${operation}.release`);
  while (!await exists(release)) await new Promise(resolvePoll => setTimeout(resolvePoll, 10));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function initializeCapabilities() {
  if (flags.has("no-agent-capabilities")) return undefined;
  return {
    ...(flags.has("no-prompt-capabilities")
      ? {}
      : { promptCapabilities: { image: false, audio: false, embeddedContext: false } }),
    ...(flags.has("load-session") || flags.has("all-capabilities") ? { loadSession: true } : {}),
    ...(flags.has("resume-session") || flags.has("all-capabilities")
      ? { sessionCapabilities: { resume: {} } }
      : {}),
  };
}

function activate(params, sessionId, method) {
  activeSessionId = sessionId;
  activeSessionMethod = method;
  cwd = params.cwd;
}

function sessionState() {
  return flags.has("config-options") ? { configOptions: configOptions() } : {};
}

function configOptions() {
  return [...configValues].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    if (typeof value === "boolean") return { type: "boolean", id, name: id, currentValue: value };
    const currentValue = String(value);
    const values = [...new Set(["default", currentValue])];
    return {
      type: "select",
      id,
      name: id,
      currentValue,
      options: values.map(option => ({ value: option, name: option })),
    };
  });
}

async function prompt(request) {
  if (flags.has("exit-on-prompt") || flags.has("exit")) return exit();
  if (flags.has("malformed-on-prompt") || flags.has("malformed")) return malformed();

  promptCount += 1;
  activeSessionId = request.params.sessionId;
  const state = {
    id: request.id,
    sessionId: request.params.sessionId,
    promptCount,
    settled: false,
    toolCallId: `fixture-tool-${promptCount}`,
  };
  activePrompt = state;
  const lateCancel = flags.has("late-cancel-update")
    || flags.has("late-cancel-first") && promptCount === 1;

  const inputTokens = promptCount * 10;
  const outputTokens = promptCount + 1;
  const totalTokens = inputTokens + outputTokens;
  const withTool = enabled("tool")
    || flags.has("late-tool-update")
    || lateCancel
    || flags.has("permission-request");

  if (enabled("plan")) {
    update({
      sessionUpdate: "plan",
      entries: [
        { content: "inspect fixture input", priority: "high", status: "completed" },
        { content: "return fixture output", priority: "medium", status: "in_progress" },
      ],
    });
  }
  if (withTool) {
    update({
      sessionUpdate: "tool_call",
      toolCallId: state.toolCallId,
      title: "fixture tool",
      kind: flags.has("permission-request") ? "edit" : "search",
      status: "in_progress",
      rawInput: { query: "fixture" },
      locations: [{ path: resolve(cwd, "fixture.txt"), line: 1 }],
    });
  }
  if (enabled("thought")) {
    update({
      sessionUpdate: "agent_thought_chunk",
      messageId: `fixture-thought-${promptCount}`,
      content: { type: "text", text: "fixture thought" },
    });
  }
  if (!flags.has("no-text")) {
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: `fixture-message-${promptCount}`,
      content: { type: "text", text: responseText() },
    });
  }
  if (!flags.has("no-usage")) {
    update({
      sessionUpdate: "usage_update",
      used: totalTokens,
      size: 100,
      ...(flags.has("live-breakdown") && promptCount === 2
        ? { _meta: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }
        : {}),
    });
  }
  if (flags.has("paced-activity")) {
    const delayMs = Number(process.env.ACP_FIXTURE_ACTIVITY_DELAY_MS ?? 25);
    for (let index = 0; index < 2; index += 1) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: `fixture-${index}`, description: "activity" }],
      });
    }
  }
  if (flags.has("exit-after-update")) return exit();

  await runReverseRequests(state);
  if (state.settled) return;

  if (withTool && !lateCancel) {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: state.toolCallId,
      status: "completed",
      rawOutput: { ok: true },
      content: [{ type: "content", content: { type: "text", text: "fixture tool output" } }],
    });
  }
  if (flags.has("cancel-prompt") || lateCancel) return;

  state.settled = true;
  respond(request.id, {
    stopReason: "end_turn",
    usage: { inputTokens, outputTokens, totalTokens },
  });
  if (activePrompt === state) activePrompt = undefined;
}

function responseText() {
  const session = flags.has("echo-session") ? `|${activeSessionMethod}|${activeSessionId}` : "";
  const config = flags.has("echo-config")
    ? `|${JSON.stringify(Object.fromEntries([...configValues].sort(([left], [right]) => left.localeCompare(right))))}`
    : "";
  return `${configuredResponse}${session}${config}`;
}

async function runReverseRequests(state) {
  const suffix = state.promptCount;
  if (flags.has("permission-request")) {
    await reverse(`fixture-permission-${suffix}`, "session/request_permission", {
      sessionId: state.sessionId,
      toolCall: {
        toolCallId: state.toolCallId,
        title: "fixture tool",
        kind: "edit",
        status: "in_progress",
        rawInput: { path: writePath() },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (state.settled) return;
  }
  if (flags.has("fs-read")) {
    await reverse(`fixture-fs-read-${suffix}`, "fs/read_text_file", {
      sessionId: state.sessionId,
      path: process.env.ACP_FIXTURE_READ_PATH ?? resolve(cwd, "fixture-input.txt"),
      line: 1,
      limit: 20,
    });
    if (state.settled) return;
  }
  if (flags.has("fs-write")) {
    await reverse(`fixture-fs-write-${suffix}`, "fs/write_text_file", {
      sessionId: state.sessionId,
      path: writePath(),
      content: "fixture output\n",
    });
    if (state.settled) return;
  }
  if (flags.has("terminal")) await runTerminalRequests(state, suffix);
}

async function runTerminalRequests(state, suffix) {
  const created = await reverse(`fixture-terminal-create-${suffix}`, "terminal/create", {
    sessionId: state.sessionId,
    command: process.execPath,
    args: ["-e", "process.stdout.write('fixture terminal')"],
    cwd,
    outputByteLimit: 1024,
  });
  if (state.settled) return;
  const terminalId = created.result?.terminalId ?? "fixture-terminal";
  for (const [name, method] of [
    ["output", "terminal/output"],
    ["wait", "terminal/wait_for_exit"],
    ["kill", "terminal/kill"],
    ["release", "terminal/release"],
  ]) {
    await reverse(`fixture-terminal-${name}-${suffix}`, method, { sessionId: state.sessionId, terminalId });
    if (state.settled) return;
  }
}

async function cancel(sessionId) {
  const state = activePrompt;
  if (state === undefined || state.sessionId !== sessionId || state.settled) return;
  if (flags.has("ignore-cancel")) return;
  if (flags.has("late-cancel-update") || flags.has("late-cancel-first")) {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: state.toolCallId,
      status: "failed",
      rawOutput: { cancelled: true },
    }, state.sessionId);
  }
  if (flags.has("gate-cancel")) await pauseOpen("cancel");
  state.settled = true;
  respond(state.id, { stopReason: "cancelled" });
  activePrompt = undefined;
}

function enabled(name) {
  return flags.has(name) || flags.has("all-updates");
}

function writePath() {
  return process.env.ACP_FIXTURE_WRITE_PATH ?? resolve(cwd, "fixture-output.txt");
}

function reverse(id, method, params) {
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise(resolveRequest => reverseRequests.set(id, resolveRequest));
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(value, sessionId = activeSessionId) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function malformed() {
  process.stdout.write("{malformed fixture output\n");
}

function exit() {
  exiting = true;
  process.stdout.end(() => process.exit(exitCode));
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
