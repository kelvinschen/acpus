import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage } from "../src/usage.js";
import { SAMPLE_RUNS } from "../fixtures/sample-runs.js";

test("summarizeUsage totals provider token fields without double counting cache reads", () => {
  assert.deepEqual(summarizeUsage(SAMPLE_RUNS), {
    inputTokens: 300,
    outputTokens: 100,
    cacheReadTokens: 50,
    totalTokens: 400,
  });
});

test("summarizeUsage defaults missing fields and rejects invalid token counts", () => {
  assert.deepEqual(summarizeUsage([{}]), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  });
  assert.throws(() => summarizeUsage([{ outputTokens: 1.5 }]), /outputTokens/);
});
