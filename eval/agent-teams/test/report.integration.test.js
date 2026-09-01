import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationReport } from "../src/report.js";
import { SAMPLE_RUNS } from "../fixtures/sample-runs.js";

test("buildEvaluationReport integrates all teammate results into one assessment", () => {
  assert.deepEqual(buildEvaluationReport(SAMPLE_RUNS), {
    runCount: 4,
    quality: {
      total: 4,
      completed: 2,
      failed: 1,
      cancelled: 1,
      successRate: 0.5,
      unsuccessfulIds: ["run-b", "run-d"],
    },
    latency: {
      count: 4,
      minMs: 80,
      maxMs: 400,
      meanMs: 200,
      p95Ms: 400,
    },
    usage: {
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 50,
      totalTokens: 400,
    },
    assessment: {
      status: "needs-attention",
      reasons: ["success_rate_below_0.8", "p95_above_250ms"],
    },
  });
});
