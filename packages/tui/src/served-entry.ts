import { runTui } from "./index.js";

const endpoint = process.env.ACPUS_TUI_ENDPOINT;
if (!endpoint) {
  throw new Error("ACPUS_TUI_ENDPOINT is required");
}

await runTui({
  endpoint,
  runId: process.env.ACPUS_TUI_RUN_ID || undefined,
  readOnly: process.env.ACPUS_TUI_READ_ONLY === "1"
});
