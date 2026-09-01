export const SAMPLE_RUNS = deepFreeze([
  {
    id: "run-a",
    status: "completed",
    durationMs: 120,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 20,
  },
  {
    id: "run-b",
    status: "failed",
    durationMs: 400,
    inputTokens: 60,
    outputTokens: 10,
  },
  {
    id: "run-c",
    status: "completed",
    durationMs: 200,
    inputTokens: 120,
    outputTokens: 50,
    cacheReadTokens: 30,
  },
  {
    id: "run-d",
    status: "cancelled",
    durationMs: 80,
    inputTokens: 20,
  },
]);

function deepFreeze(value) {
  for (const item of value) Object.freeze(item);
  return Object.freeze(value);
}
