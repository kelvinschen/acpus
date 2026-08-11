import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const readyPath = process.env.ACPUS_TEST_AGENT_READY_PATH;
const releasePath = process.env.ACPUS_TEST_AGENT_RELEASE_PATH;
const sessionId = `wal-usage-${process.pid}`;
let activePrompt;

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
      activePrompt = request.id;
      usage(6, 4, 2);
      setTimeout(() => {
        if (activePrompt === undefined) return;
        usage(24, 18, 6);
        if (readyPath) writeFileSync(readyPath, "ready");
        waitForRelease();
      }, 25);
      return;
    }
    if (request.method === "session/cancel" && activePrompt !== undefined) {
      respond(activePrompt, { stopReason: "cancelled" });
      activePrompt = undefined;
      return;
    }
    if (request.id !== undefined) respond(request.id, {});
  });

function waitForRelease() {
  if (activePrompt === undefined) return;
  if (releasePath && existsSync(releasePath)) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
    });
    respond(activePrompt, { stopReason: "end_turn" });
    activePrompt = undefined;
    return;
  }
  setTimeout(waitForRelease, 10);
}

function usage(totalTokens, inputTokens, outputTokens) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: totalTokens,
        size: 100,
        _meta: { usage: { totalTokens, inputTokens, outputTokens } },
      },
    },
  });
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
