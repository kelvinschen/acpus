import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLatency } from "../src/latency.js";
import { SAMPLE_RUNS } from "../fixtures/sample-runs.js";

test("summarizeLatency returns mean and nearest-rank p95", () => {
  assert.deepEqual(summarizeLatency(SAMPLE_RUNS), {
    count: 4,
    minMs: 80,
    maxMs: 400,
    meanMs: 200,
    p95Ms: 400,
  });
});

test("summarizeLatency handles empty input and rejects invalid duration", () => {
  assert.deepEqual(summarizeLatency([]), {
    count: 0,
    minMs: null,
    maxMs: null,
    meanMs: null,
    p95Ms: null,
  });
  assert.throws(() => summarizeLatency([{ durationMs: -1 }]), /durationMs/);
});
