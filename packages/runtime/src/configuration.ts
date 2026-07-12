import { err, ok, type Result } from "neverthrow";
import { DEFAULT_MAX_LEAF_CONCURRENCY } from "./scheduler/advance.js";

export const RUN_MAX_LEAF_CONCURRENCY_ENV = "ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY";
export const AGENT_RESPONSE_REPAIR_MAX_ENV = "ACPUS_AGENT_RESPONSE_REPAIR_MAX";
export const AGENT_RAW_ACP_DEBUG_ENV = "ACPUS_AGENT_RAW_ACP_DEBUG";

const DEFAULT_AGENT_RESPONSE_REPAIR_MAX = 2;

export type AgentHostPolicyFailure = {
  type: "invalid-agent-response-repair-max";
  variable: typeof AGENT_RESPONSE_REPAIR_MAX_ENV;
  value: string;
  message: string;
};

export type AgentHostPolicy = {
  responseRepair:
    | { type: "valid"; max: number }
    | { type: "invalid"; failure: AgentHostPolicyFailure };
  captureRawAcpDebug: boolean;
};

export type RuntimeConfiguration = {
  runMaxLeafConcurrency: number;
  agentHostPolicy: AgentHostPolicy;
};

export type RuntimeConfigurationFailure = {
  type: "invalid-run-max-leaf-concurrency";
  variable: typeof RUN_MAX_LEAF_CONCURRENCY_ENV;
  value: string;
  message: string;
};

export function tryLoadRuntimeConfiguration(env: NodeJS.ProcessEnv): Result<RuntimeConfiguration, RuntimeConfigurationFailure> {
  const runMaxLeafConcurrency = tryRunMaxLeafConcurrency(env[RUN_MAX_LEAF_CONCURRENCY_ENV]);
  return runMaxLeafConcurrency.map(value => ({
    runMaxLeafConcurrency: value,
    agentHostPolicy: loadAgentHostPolicy(env),
  }));
}

export function loadAgentHostPolicy(env: NodeJS.ProcessEnv): AgentHostPolicy {
  const value = env[AGENT_RESPONSE_REPAIR_MAX_ENV];
  let responseRepair: AgentHostPolicy["responseRepair"];
  if (value === undefined) {
    responseRepair = { type: "valid", max: DEFAULT_AGENT_RESPONSE_REPAIR_MAX };
  } else if (/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) {
    responseRepair = { type: "valid", max: Number(value) };
  } else {
    responseRepair = {
      type: "invalid",
      failure: {
        type: "invalid-agent-response-repair-max",
        variable: AGENT_RESPONSE_REPAIR_MAX_ENV,
        value,
        message: `Environment variable ${AGENT_RESPONSE_REPAIR_MAX_ENV} must be a canonical non-negative decimal safe integer; set it before starting the Acpus daemon.`,
      },
    };
  }
  return {
    responseRepair,
    captureRawAcpDebug: env[AGENT_RAW_ACP_DEBUG_ENV] === "1",
  };
}

function tryRunMaxLeafConcurrency(value: string | undefined): Result<number, RuntimeConfigurationFailure> {
  if (value === undefined) return ok(DEFAULT_MAX_LEAF_CONCURRENCY);
  if (/^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return ok(parsed);
  }
  return err({
    type: "invalid-run-max-leaf-concurrency",
    variable: RUN_MAX_LEAF_CONCURRENCY_ENV,
    value,
    message: `Environment variable ${RUN_MAX_LEAF_CONCURRENCY_ENV} must be a canonical positive decimal safe integer; set it before starting the Acpus daemon.`,
  });
}
