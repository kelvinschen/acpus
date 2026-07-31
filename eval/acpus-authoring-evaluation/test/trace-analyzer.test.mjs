import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  analyzeArtifactListing,
  analyzeTraceArtifact,
  selectAuthoringTraceArtifacts,
} from "../scripts/trace-analyzer.mjs";

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.trace.jsonl`, import.meta.url));
const artifact = (agent, requirementIndex, trialIndex, path, suffix = agent) => ({
  nodeKey: `evaluate_requirements[${requirementIndex}]/agent_runs.${agent}/${agent}_trials[${trialIndex}]/${agent}_authoring~${suffix}`,
  mediaType: "application/x-ndjson",
  path,
});

test("normalizes Pi, Claude, and TraeX tool event formats", async () => {
  const payload = {
    ok: true,
    runId: "synthetic-formats",
    artifacts: [
      artifact("pi", 0, 0, fixture("pi")),
      artifact("claude", 0, 0, fixture("claude")),
      artifact("traex", 0, 0, fixture("traex")),
    ],
  };

  const metrics = await analyzeArtifactListing(payload, { expectedSessions: 3 });

  assert.equal(metrics.valid, true);
  assert.deepEqual(metrics.summary, {
    sessions: 3,
    totalChecks: 3,
    meanChecks: 1,
    firstCheckPass: 2,
    singleCheckPass: 2,
    failedChecks: 1,
    sessionsAtLeastThreeChecks: 0,
    p95Checks: 1,
    maxChecks: 1,
  });
  assert.deepEqual(metrics.diagnosticCodes, {
    AL002: { occurrences: 1, sessions: 1 },
    TS2322: { occurrences: 1, sessions: 1 },
  });
  assert.equal(metrics.sessions.find(session => session.agent === "pi").checks[0].outcome, "failed");
  assert.equal(metrics.sessions.find(session => session.agent === "claude").checks[0].outcome, "passed");
  assert.equal(metrics.sessions.find(session => session.agent === "traex").checks[0].outcome, "passed");
});

test("excludes retrospective artifacts and non-trace authoring artifacts", () => {
  const selected = selectAuthoringTraceArtifacts({
    ok: true,
    artifacts: [
      artifact("pi", 0, 0, fixture("pi")),
      {
        nodeKey: "evaluate_requirements[0]/agent_runs.pi/pi_trials[0]/pi_retrospective~r",
        mediaType: "application/x-ndjson",
        path: fixture("pi"),
      },
      {
        ...artifact("pi", 0, 0, fixture("pi").replace(".trace.jsonl", ".json")),
        mediaType: "application/json",
      },
    ],
  });

  assert.equal(selected.length, 1);
});

test("does not count commands or prose that merely mention workflow check", async () => {
  const session = await analyzeTraceArtifact(
    artifact("pi", 1, 0, fixture("false-positive"), "false-positive"),
  );

  assert.equal(session.valid, true);
  assert.deepEqual(session.checks, []);
});

test("invalidates a tool call containing chained workflow checks", async () => {
  const session = await analyzeTraceArtifact(
    artifact("claude", 1, 0, fixture("chained"), "chained"),
  );

  assert.equal(session.valid, false);
  assert.deepEqual(session.checks, []);
  assert.match(session.invalidReasons[0], /contains 2 workflow checks/u);
});

test("invalidates a workflow check with no explicit or terminal outcome", async () => {
  const session = await analyzeTraceArtifact(
    artifact("traex", 1, 0, fixture("unknown"), "unknown"),
  );

  assert.equal(session.valid, false);
  assert.equal(session.checks[0].outcome, "unknown");
  assert.match(session.invalidReasons[0], /no explicit exit code/u);
});

test("CLI writes JSON and Markdown metrics from an artifact listing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acpus-trace-analyzer-"));
  try {
    const listingPath = join(directory, "artifacts.json");
    const outputDirectory = join(directory, "output");
    await writeFile(listingPath, JSON.stringify({
      ok: true,
      runId: "synthetic-cli",
      artifacts: [
        artifact("pi", 0, 0, fixture("pi")),
        artifact("claude", 0, 0, fixture("claude")),
        artifact("traex", 0, 0, fixture("traex")),
      ],
    }));
    const cliPath = fileURLToPath(new URL("../scripts/analyze-traces.mjs", import.meta.url));

    const result = spawnSync(process.execPath, [
      cliPath,
      "synthetic-cli",
      "--artifacts-json",
      listingPath,
      "--cli-version",
      "synthetic",
      "--expected-sessions",
      "3",
      "--output-dir",
      outputDirectory,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(await readFile(join(outputDirectory, "trace-metrics.json"), "utf8"));
    const report = await readFile(join(outputDirectory, "trace-metrics.md"), "utf8");
    assert.equal(metrics.valid, true);
    assert.equal(metrics.source.cliVersion, "synthetic");
    assert.equal(metrics.source.retrospectiveIncluded, false);
    assert.match(report, /\| Checks \| 3 \|/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
