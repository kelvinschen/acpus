import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { MockAgent } from "./agent.js";
import type { MockScript } from "./script.js";
import { TraceWriter } from "./trace.js";

export function startMockAgentServer(script: MockScript, trace: TraceWriter): acp.AgentSideConnection {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  return new acp.AgentSideConnection((connection) => new MockAgent(connection, script, trace), stream);
}
