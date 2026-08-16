import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const response = process.argv[2] ?? "DSH Acpus worker completed";
const promptSentinel = process.argv[3];
const sessionId = `acpus-dsh-fixture-${process.pid}`;

createInterface({ input: process.stdin })
  .on("close", () => process.exit(0))
  .on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      reply(request.id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      return;
    }
    if (request.method === "session/new") {
      reply(request.id, { sessionId });
      return;
    }
    if (request.method === "session/prompt") {
      if (promptSentinel !== undefined) writeFileSync(promptSentinel, "prompted\n");
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: response },
          },
        },
      });
      reply(request.id, { stopReason: "end_turn" });
      return;
    }
    if (request.id !== undefined) reply(request.id, {});
  });

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
