import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const startedPath = process.env.ACP_FIXTURE_STARTED_PATH;
const pidPath = process.env.ACP_FIXTURE_PID_PATH;
const releasePath = process.env.ACP_FIXTURE_RELEASE_PATH;
if (startedPath === undefined || pidPath === undefined || releasePath === undefined) {
  throw new Error("ACP fixture paths are required.");
}
writeFileSync(pidPath, String(process.pid));

createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      agentInfo: { name: "hanging-open-fixture", version: "1" },
    });
    return;
  }
  if (request.method === "session/new") {
    writeFileSync(startedPath, "");
    void waitForRelease().then(() => respond(request.id, { sessionId: "fixture-session" }));
  }
});

async function waitForRelease() {
  while (!existsSync(releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
