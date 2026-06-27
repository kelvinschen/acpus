#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { loadMockScript } from "./script.js";
import { startMockAgentServer } from "./server.js";
import { TraceWriter, type TraceMode } from "./trace.js";

export { MockAgent } from "./agent.js";
export {
  loadMockScript,
  parseMockScript,
  responseText,
  selectResponse,
  splitIntoChunks,
  parseDurationMs,
  type MockScript,
  type MockRespond,
  type MockRule,
  type MockRuleWhen,
  type ResponseSelectionContext
} from "./script.js";
export { startMockAgentServer } from "./server.js";
export { TraceWriter, type TraceEvent, type TraceMode } from "./trace.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const scriptPath = resolve(process.cwd(), options.script);
    const tracePath = resolve(process.cwd(), options.trace ?? `${dirname(scriptPath)}/mock-trace.jsonl`);
    const script = loadMockScript(scriptPath);
    startMockAgentServer(script, new TraceWriter(tracePath, { mode: options.traceMode }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    }));
    process.exitCode = 1;
  }
}

interface CliOptions {
  script: string;
  trace?: string;
  traceMode?: TraceMode;
}

function parseArgs(args: string[]): CliOptions {
  let script: string | undefined;
  let trace: string | undefined;
  let traceMode: TraceMode | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--script") {
      script = args[++index];
      continue;
    }
    if (arg === "--trace") {
      trace = args[++index];
      continue;
    }
    if (arg === "--trace-mode") {
      const value = args[++index];
      if (value !== "append" && value !== "overwrite") {
        throw new Error("--trace-mode must be append or overwrite.");
      }
      traceMode = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: acpus-mock-agent --script mock.yaml [--trace mock-trace.jsonl] [--trace-mode append|overwrite]");
      process.exit(0);
    }
    throw new Error(`Unknown argument '${arg}'.`);
  }

  if (!script) {
    throw new Error("--script is required.");
  }
  return { script, trace, traceMode };
}
