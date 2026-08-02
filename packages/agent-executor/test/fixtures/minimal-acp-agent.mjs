import { createInterface } from "node:readline";

const configuredResponse = process.argv[2] ?? "fixture response";
const responseText = `${configuredResponse}|${process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS ?? "unset"}`;
const sessionId = `fixture-${process.pid}`;

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
      respond(request.id, { stopReason: "end_turn" });
      return;
    }
    if (request.id !== undefined) respond(request.id, {});
  });

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
