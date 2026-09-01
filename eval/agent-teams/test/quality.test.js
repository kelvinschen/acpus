import assert from "node:assert/strict";
import test from "node:test";
import { summarizeQuality } from "../src/quality.js";
import { SAMPLE_RUNS } from "../fixtures/sample-runs.js";

test("summarizeQuality returns the exact outcome distribution", () => {
  assert.deepEqual(summarizeQuality(SAMPLE_RUNS), {
    total: 4,
    completed: 2,
    failed: 1,
    cancelled: 1,
    successRate: 0.5,
    unsuccessfulIds: ["run-b", "run-d"],
  });
});

test("summarizeQuality handles empty input and rejects unknown statuses", () => {
  assert.deepEqual(summarizeQuality([]), {
    total: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    successRate: 0,
    unsuccessfulIds: [],
  });
  assert.throws(
    () => summarizeQuality([{ id: "run-x", status: "timed-out" }]),
    /status/i,
  );
});
