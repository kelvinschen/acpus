#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeArtifactListing, renderTraceMetricsMarkdown } from "./trace-analyzer.mjs";

function acpusBinary(explicit) {
  if (explicit) return explicit;
  if (process.env.ACPUS_BIN) return process.env.ACPUS_BIN;
  const workspaceBinary = resolve(process.cwd(), "node_modules", ".bin", "acpus");
  return existsSync(workspaceBinary) ? workspaceBinary : "acpus";
}

function runAcpus(binary, arguments_) {
  return execFileSync(binary, arguments_, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      "acpus-bin": { type: "string" },
      "artifacts-json": { type: "string" },
      "cli-version": { type: "string" },
      "expected-sessions": { type: "string", default: "90" },
      "output-dir": { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: analyze-traces.mjs <run-id> [--output-dir <dir>] [--artifacts-json <file>]");
  }

  const runId = positionals[0];
  const expectedSessions = Number(values["expected-sessions"]);
  if (!Number.isInteger(expectedSessions) || expectedSessions < 0) {
    throw new Error("--expected-sessions must be a non-negative integer.");
  }

  let payload;
  let artifactBaseDir = process.cwd();
  let artifactListingCommand = null;
  let cliVersion = values["cli-version"] ?? null;
  if (values["artifacts-json"]) {
    const listingPath = resolve(values["artifacts-json"]);
    payload = JSON.parse(await readFile(listingPath, "utf8"));
    artifactBaseDir = dirname(listingPath);
  } else {
    const binary = acpusBinary(values["acpus-bin"]);
    const arguments_ = ["runs", "artifacts", runId, "--json"];
    payload = JSON.parse(runAcpus(binary, arguments_));
    artifactListingCommand = `${binary} ${arguments_.join(" ")}`;
    cliVersion ??= runAcpus(binary, ["--version"]);
  }
  if (payload.runId !== undefined && payload.runId !== runId) {
    throw new Error(`Artifact listing run ${payload.runId} does not match requested run ${runId}.`);
  }

  const metrics = await analyzeArtifactListing(payload, {
    artifactBaseDir,
    expectedSessions,
    cliVersion,
    artifactListingCommand,
  });
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const outputDirectory = values["output-dir"]
    ? resolve(values["output-dir"])
    : resolve(scriptDirectory, "..", "results", runId);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, "trace-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(resolve(outputDirectory, "trace-metrics.md"), renderTraceMetricsMarkdown(metrics)),
  ]);

  process.stdout.write(`${outputDirectory}\n`);
  if (!metrics.valid) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
