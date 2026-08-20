import type { JsonValue } from "@acpus/expression/ir";
import type { PreparedRunWorkflow } from "./admission/prepared-workflow.js";
import type { AgentOverrideMap } from "./control/agent-overrides.js";
import { RUNTIME_LAYOUT_VERSION } from "./runtime-layout.js";
import { RUNTIME_STORAGE_VERSION } from "./storage/database.js";
import type { RunDetails } from "./store/store.js";

export const RUNTIME_ABI_VERSION = 3;

export type RuntimeAuthorityIdentity = {
  workspaceKey: string;
  runtimeAbi: typeof RUNTIME_ABI_VERSION;
  layoutVersion: typeof RUNTIME_LAYOUT_VERSION;
  storageVersion: typeof RUNTIME_STORAGE_VERSION;
  authorityId: string;
  storeBinding: `sha256:${string}`;
  leaseGeneration: number;
};

export type RuntimeSubmission = {
  requestId: string;
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
};

export type RuntimeSubmitFailure = {
  type: "runtime-submit-failed";
  outcome: "not-admitted" | "admitted" | "unknown";
  runId?: string;
  code: "INVALID_REQUEST" | "CONTROL_CONFLICT" | "EXECUTION_UNAVAILABLE" | "STORE_BUSY" | "STORE_ERROR" | "INTERNAL_ERROR";
  message: string;
};

export type RuntimeControlResult =
  | { type: "pause"; state: "applied"; run: RunDetails }
  | { type: "resume"; state: "applied"; run: RunDetails }
  | { type: "retry"; state: "applied"; run: RunDetails; target: string }
  | { type: "cancel"; state: "applied"; run: RunDetails; target?: string }
  | {
    type: "steer";
    state: "applied";
    run: RunDetails;
    steerId: string;
    requestedTarget: string;
    target: string;
    delivery: "interrupt_continue";
    fencedAttemptId: string;
    continuation: "queued";
  }
  | { type: "fork"; state: "applied"; sourceRunId: string; run: RunDetails }
  | {
    type: "signal";
    state: "consumed";
    requestedTarget: string;
    target: string;
    validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
    run: RunDetails;
  };

export type RuntimeControlIntent =
  | { requestId: string; type: "pause" | "resume"; runId: string }
  | { requestId: string; type: "retry"; runId: string; target: string }
  | { requestId: string; type: "cancel"; runId: string; target?: string }
  | { requestId: string; type: "steer"; runId: string; target: string; instruction: string }
  | { requestId: string; type: "fork"; runId: string; target?: string; prepared?: PreparedRunWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap }
  | { requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue };

export type RuntimeControlFailure = {
  type: "runtime-control-failed";
  code: "RUN_NOT_FOUND" | "RUN_NOT_CONTROLLABLE" | "CONTROL_CONFLICT" | "INVALID_REQUEST" | "STORE_BUSY";
  message: string;
  ambiguity?: true;
};
