import { describe, expect, it } from "vitest";
import { AGENT_RAW_ACP_DEBUG_ENV, AGENT_RESPONSE_REPAIR_MAX_ENV, RUN_MAX_LEAF_CONCURRENCY_ENV, loadAgentHostPolicy, tryLoadRuntimeConfiguration } from "../src/configuration.js";

describe("daemon runtime configuration", () => {
  it("defaults the per-run leaf concurrency ceiling to 32", () => {
    const result = tryLoadRuntimeConfiguration({});

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({
      runMaxLeafConcurrency: 32,
      agentHostPolicy: {
        responseRepair: { type: "valid", max: 2 },
        captureRawAcpDebug: false,
      },
    });
  });

  it.each(["1", "8", "64", String(Number.MAX_SAFE_INTEGER)])("accepts canonical positive safe integer %s", value => {
    const result = tryLoadRuntimeConfiguration({ [RUN_MAX_LEAF_CONCURRENCY_ENV]: value });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.runMaxLeafConcurrency).toBe(Number(value));
  });

  it.each(["", "0", "-1", "01", "1.5", " 8", "8 ", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)])("rejects invalid value %j", value => {
    const result = tryLoadRuntimeConfiguration({ [RUN_MAX_LEAF_CONCURRENCY_ENV]: value });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
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

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.agentHostPolicy.responseRepair).toEqual({
      type: "invalid",
      failure: {
        type: "invalid-agent-response-repair-max",
        variable: AGENT_RESPONSE_REPAIR_MAX_ENV,
        value,
        message: `Environment variable ${AGENT_RESPONSE_REPAIR_MAX_ENV} must be a canonical non-negative decimal safe integer; set it before starting the Acpus daemon.`,
      },
    });
  });

  it("enables raw ACP debug only for the exact value 1", () => {
    expect(loadAgentHostPolicy({ [AGENT_RAW_ACP_DEBUG_ENV]: "1" }).captureRawAcpDebug).toBe(true);
    for (const value of [undefined, "0", "true", " 1", "1 "]) {
      expect(loadAgentHostPolicy(value === undefined ? {} : { [AGENT_RAW_ACP_DEBUG_ENV]: value }).captureRawAcpDebug).toBe(false);
    }
  });
});
