import { createInterface } from "node:readline";

let promptId;
const leaveClientHandlerPending = process.argv.includes("--leave-client-handler-pending");

createInterface({ input: process.stdin })
  .on("close", () => process.exit(0))
  .on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { promptCapabilities: {} },
        agentInfo: { name: "cancel-client-handler", version: "1" },
      });
      return;
    }
    if (message.method === "session/new") {
      respond(message.id, { sessionId: "cancel-session" });
      return;
    }
    if (message.method === "session/prompt") {
      promptId = message.id;
      write({
        jsonrpc: "2.0",
        id: "terminal-wait",
        method: "terminal/wait_for_exit",
        params: { sessionId: "cancel-session", terminalId: "pending-terminal" },
      });
      if (!leaveClientHandlerPending) {
        setImmediate(() => write({
          jsonrpc: "2.0",
          method: "$/cancel_request",
          params: { requestId: "terminal-wait" },
        }));
      }
      return;
    }
    if (message.id === "terminal-wait" && message.method === undefined) {
      respond(promptId, { stopReason: "end_turn" });
    }
  });

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
