import { summarizeLatency } from "./latency.js";
import { summarizeQuality } from "./quality.js";
import { summarizeUsage } from "./usage.js";

/**
 * Lead integration: compose the three independently implemented summaries.
 *
 * @param {readonly {
 *   id: string,
 *   status: string,
 *   durationMs: number,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheReadTokens?: number
 * }[]} runs
 */
export function buildEvaluationReport(_runs) {
  void summarizeQuality;
  void summarizeLatency;
  void summarizeUsage;
  throw new Error("TODO(lead-integration): implement buildEvaluationReport");
}
