import { createInterface } from "node:readline";

const configuredResponse = process.argv[2] ?? "fixture response";
const flags = new Set(process.argv.slice(3));
const includeLiveBreakdown = flags.has("live-breakdown");
const includeLateToolUpdate = flags.has("late-tool-update");
const responseText = `${configuredResponse}|${process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS ?? "unset"}`;
const sessionId = `fixture-${process.pid}`;
let promptCount = 0;

createInterface({ input: process.stdin })
  .on("close", () => process.exit(0))
  .on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      return;
    }
    if (request.method === "session/new") {
      respond(request.id, { sessionId });
      return;
    }
    if (request.method === "session/prompt") {
      promptCount += 1;
      const inputTokens = promptCount * 10;
      const outputTokens = promptCount + 1;
      const totalTokens = inputTokens + outputTokens;
      const toolCallId = `fixture-tool-${promptCount}`;
      if (includeLateToolUpdate) {
        update({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "fixture tool",
          kind: "search",
          status: "in_progress",
        });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: responseText },
          },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: totalTokens,
            size: 100,
            ...(includeLiveBreakdown && promptCount === 2
              ? { _meta: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }
              : {}),
          },
        },
      });
      if (includeLateToolUpdate) {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
        });
      }
      respond(request.id, {
        stopReason: "end_turn",
        usage: { inputTokens, outputTokens, totalTokens },
      });
      return;
    }
    if (request.id !== undefined) respond(request.id, {});
  });

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function update(value) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
