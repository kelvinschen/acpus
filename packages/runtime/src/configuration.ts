import { err, ok, type Result } from "neverthrow";
import { DEFAULT_MAX_LEAF_CONCURRENCY } from "./scheduler/advance.js";

export const RUN_MAX_LEAF_CONCURRENCY_ENV = "ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY";
export const AGENT_RESPONSE_REPAIR_MAX_ENV = "ACPUS_AGENT_RESPONSE_REPAIR_MAX";
export const AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV = "ACPUS_AGENT_ACP_INACTIVITY_FAIL_AFTER_MS";

const DEFAULT_AGENT_RESPONSE_REPAIR_MAX = 2;
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;

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
  inactivityFailAfterMs?: number;
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
} | {
  type: "invalid-agent-acp-inactivity-fail-after-ms";
  variable: typeof AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV;
  value: string;
  message: string;
};

export function tryLoadRuntimeConfiguration(env: NodeJS.ProcessEnv): Result<RuntimeConfiguration, RuntimeConfigurationFailure> {
  return tryRunMaxLeafConcurrency(env[RUN_MAX_LEAF_CONCURRENCY_ENV]).andThen(runMaxLeafConcurrency =>
    tryAcpInactivityFailAfterMs(env[AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV]).map(inactivityFailAfterMs => ({
      runMaxLeafConcurrency,
      agentHostPolicy: loadAgentHostPolicy(env, inactivityFailAfterMs),
    })),
  );
}

export function loadAgentHostPolicy(env: NodeJS.ProcessEnv, inactivityFailAfterMs?: number): AgentHostPolicy {
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
    ...(inactivityFailAfterMs === undefined ? {} : { inactivityFailAfterMs }),
  };
}

function tryAcpInactivityFailAfterMs(value: string | undefined): Result<number | undefined, RuntimeConfigurationFailure> {
  if (value === undefined) return ok(undefined);
  if (/^[1-9]\d*$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= MAX_NATIVE_TIMER_DELAY_MS) return ok(parsed);
  }
  return err({
    type: "invalid-agent-acp-inactivity-fail-after-ms",
    variable: AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV,
    value,
    message: `Environment variable ${AGENT_ACP_INACTIVITY_FAIL_AFTER_MS_ENV} must be a canonical positive decimal integer no greater than ${MAX_NATIVE_TIMER_DELAY_MS}; set it before starting the Acpus daemon.`,
  });
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
