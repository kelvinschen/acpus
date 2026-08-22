import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV, AGENT_RESPONSE_REPAIR_MAX_ENV, RUN_MAX_LEAF_CONCURRENCY_ENV, loadAgentHostPolicy, tryLoadRuntimeConfiguration } from "../src/configuration.js";

describe("daemon runtime configuration", () => {
  it("defaults the per-run leaf concurrency ceiling to 32", () => {
    const result = tryLoadRuntimeConfiguration({});

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toEqual({
      runMaxLeafConcurrency: 32,
      agentHostPolicy: {
        responseRepair: { type: "valid", max: 2 },
      },
    });
  });

  it.each(["1", "8", "64", String(Number.MAX_SAFE_INTEGER)])("accepts canonical positive safe integer %s", value => {
    const result = tryLoadRuntimeConfiguration({ [RUN_MAX_LEAF_CONCURRENCY_ENV]: value });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.runMaxLeafConcurrency).toBe(Number(value));
  });

  it.each(["", "0", "-1", "01", "1.5", " 8", "8 ", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)])("rejects invalid value %j", value => {
    const result = tryLoadRuntimeConfiguration({ [RUN_MAX_LEAF_CONCURRENCY_ENV]: value });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toEqual({
        type: "invalid-run-max-leaf-concurrency",
        variable: RUN_MAX_LEAF_CONCURRENCY_ENV,
        value,
        message: `Environment variable ${RUN_MAX_LEAF_CONCURRENCY_ENV} must be a canonical positive decimal safe integer; set it before starting the Acpus daemon.`,
      });
    }
  });

  it.each(["0", "1", "8", String(Number.MAX_SAFE_INTEGER)])("accepts Agent response repair max %s", value => {
    expect(loadAgentHostPolicy({ [AGENT_RESPONSE_REPAIR_MAX_ENV]: value })).toMatchObject({
      responseRepair: { type: "valid", max: Number(value) },
    });
  });

  it.each(["", "-1", "01", "1.5", " 2", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)])("retains invalid Agent response repair value %j as attempt policy", value => {
    const result = tryLoadRuntimeConfiguration({ [AGENT_RESPONSE_REPAIR_MAX_ENV]: value });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.agentHostPolicy.responseRepair).toEqual({
      type: "invalid",
      failure: {
        type: "invalid-agent-response-repair-max",
        variable: AGENT_RESPONSE_REPAIR_MAX_ENV,
        value,
        message: `Environment variable ${AGENT_RESPONSE_REPAIR_MAX_ENV} must be a canonical non-negative decimal safe integer; set it before starting the Acpus daemon.`,
      },
    });
  });

  it("parses a bounded host inactivity limit once at daemon startup", () => {
    const result = tryLoadRuntimeConfiguration({ [AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV]: "3600000" });

    expect(Result.isSuccess(result) ? result.success.agentHostPolicy.inactivityFailAfterMs : undefined).toBe(3_600_000);
  });

  it.each(["", "0", "01", "-1", "1.5", "2147483648", "Infinity"])("rejects invalid ACP inactivity limit %j", value => {
    const result = tryLoadRuntimeConfiguration({ [AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV]: value });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({
      type: "invalid-agent-acp-inactivity-fail-after-ms",
      variable: AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV,
      value,
    });
  });
});
