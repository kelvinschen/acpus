import * as Result from "effect/Result";
import { admitRunForTest } from "./runtime-store.js";
import { defineWorkflow, z } from "@acpus/core";
import { lift } from "@acpus/expression";
import type { WorkflowDefinition } from "@acpus/core/workflow";
import type { JsonValue } from "@acpus/expression/ir";
import { tryNormalizeWorkflowInput } from "../../src/admission/input.js";
import type { PreparedRunWorkflow } from "../../src/admission/prepared-workflow.js";
import { openRuntimeStoreAdapter, type RuntimeStoreAdapter } from "../../src/store/store.js";
import { advanceRuntimeRun } from "./scheduler.js";
import { throwingSchedulerStore } from "./scheduler-store.js";
import { prepareSyntheticWorkflow } from "./runtime-harness.js";

export {
  initializeRuntimeStoreForTest,
  preparedWorkflow,
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRow,
  runtimeRows,
  runtimeRunDir,
  runtimeRunsRoot,
  scopedRuntimeWorkspace,
  snapshotPreparedWorkflow,
  withRuntimeWorkspace,
} from "./runtime-harness.js";

export async function admitSyntheticWorkflow(workspace: string, definition: WorkflowDefinition<any, any>, input: JsonValue = {}) {
  const prepared = await prepareSyntheticWorkflow(workspace, definition);
  return admitPreparedWorkflowForTest(workspace, prepared, Result.getOrThrow(tryNormalizeWorkflowInput(prepared.ir, input)));
}

export async function admitPreparedWorkflowForTest(workspace: string, prepared: PreparedRunWorkflow, input: JsonValue) {
  const store = await openRuntimeStoreAdapter(workspace);
  try {
    const admitted = await admitRunForTest(store, { prepared, cwd: workspace, input });
    const summary = await advanceRuntimeRun(workspace, store, admitted.id, `test:${admitted.id}`);
    const run = store.getRun(admitted.id);
    if (!run) throw new Error(`Admitted run '${admitted.id}' was not found.`);
    if (summary.status === "failed") return { status: summary.status, run, summary, message: rootFailureMessage(store, admitted.id) };
    if (summary.status === "awaiting") return { status: summary.status, run, summary, nodeKey: firstAwaitingNodeKey(store, admitted.id) };
    return { status: summary.status, run, summary };
  } finally {
    store.close();
  }
}

function firstAwaitingNodeKey(store: RuntimeStoreAdapter, runId: string): string {
  const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection;
  return Object.values(projection.instances).find(instance => instance.status === "awaiting")?.nodeKey
    ?? Object.values(projection.signalWaits).find(wait => wait.status === "awaiting")?.nodeKey
    ?? "";
}

function rootFailureMessage(store: RuntimeStoreAdapter, runId: string): string {
  const root = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection.frames.root;
  const error = root?.error;
  if (error && typeof error.message === "string") return error.message;
  if (error && typeof error.reason === "string") return error.reason;
  return root?.terminalReason ?? "scheduler_failed";
}

export function validWorkflow() {
  return defineWorkflow({
    name: "cli-valid",
    description: "Validate a boolean ready input.",
    inputSchema: z.object({ ready: z.boolean() }),
  }).build(({ input, step }) => {
    step("require_ready").assert({ condition: lift(input.ready, ready => ready === true) });
    return { ready: input.ready };
  });
}

export function scalarWorkflow() {
  return defineWorkflow({ name: "runtime-scalar-output" }).build(() => "ready");
}

export function metaWorkflow() {
  return defineWorkflow({
    name: "cli-meta",
  }).build(({ meta, step }) => {
    step("ready").assert({ condition: true });
    return {
      runId: meta.runId,
      workflowPath: meta.workflowPath,
      workflowName: meta.workflowName,
      workspaceDir: meta.workspaceDir,
    };
  });
}

export function taskArtifactWorkflow() {
  return defineWorkflow({
    name: "cli-task",
  }).build(({ step }) => {
    const result = step("local_task").task({
      input: null,
      exec: async ({ artifact }) => ({
        ok: true,
        artifact: await artifact.write("result.txt", "artifact-ok\n"),
      }),
    });
    return { ok: result.output.ok, artifact: result.output.artifact };
  });
}

export function taskInvocationOptionsWorkflow() {
  return defineWorkflow({
    name: "runtime-task-invocation-options",
    inputSchema: z.object({ workDir: z.string(), commandTimeout: z.string(), runSlowCommand: z.boolean() }),
  }).build(({ input, step }) => {
    const result = step("inspect_invocation").task({
      input: { name: "runtime", mode: "strict", runSlowCommand: input.runSlowCommand },
      cwd: input.workDir,
      env: { RUNTIME_TASK_ENV: "from-run-env" },
      execution: { defaultCommandTimeout: input.commandTimeout },
      exec: async ({ input, $, env }) => {
        if (input.runSlowCommand) await $`${process.execPath} -e ${"setTimeout(() => {}, 10_000)"}`;
        const command = await $`${process.execPath} -e ${"process.stdout.write(process.cwd())"}`;
        return {
          inputName: input.name,
          cwd: command.stdout.trim(),
          processCwd: process.cwd(),
          envValue: env.RUNTIME_TASK_ENV ?? "",
          processEnvValue: process.env.RUNTIME_TASK_ENV ?? "",
          sameEnvObject: env === process.env,
          inputMode: input.mode,
        };
      },
    });
    return {
      inputName: result.output.inputName,
      cwd: result.output.cwd,
      processCwd: result.output.processCwd,
      envValue: result.output.envValue,
      processEnvValue: result.output.processEnvValue,
      sameEnvObject: result.output.sameEnvObject,
      inputMode: result.output.inputMode,
    };
  });
}

export function replacementTaskWorkflow() {
  return defineWorkflow({
    name: "cli-task-replacement",
  }).build(({ step }) => {
    const result = step("local_task").task({
      input: null,
      exec: async ({ artifact }) => ({
        ok: true,
        artifact: await artifact.write("result.txt", "replacement\n"),
      }),
    });
    const extra = step("extra").task({
      input: null,
      exec: async () => ({ extra: true }),
    });
    return { ok: result.output.ok, artifact: result.output.artifact, extra: extra.output.extra };
  });
}

export function failingTaskWorkflow() {
  return defineWorkflow({
    name: "cli-failing-task",
  }).build(({ step }) => {
    step("boom").task({
      input: null,
      exec: async () => {
        throw new Error("task exploded");
      },
    });
    return {};
  });
}

export function failingPureWorkflow() {
  return defineWorkflow({
    name: "cli-failing-pure",
  }).build(({ step }) => {
    step("fail").assert({ condition: false });
    return {};
  });
}

export function missingProviderWorkflow() {
  return defineWorkflow({
    name: "cli-agent",
    agents: { reviewer: { use: "missing-provider" } },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.reviewer, prompt: "review" });
    return {};
  });
}

export function inputEchoWorkflow() {
  return defineWorkflow({
    name: "cli-input-echo",
    inputSchema: z.object({ value: z.string() }),
  }).build(({ input, step }) => {
    step("echo").assert({ condition: true });
    return { value: input.value };
  });
}

export function signalWorkflow() {
  return defineWorkflow({
    name: "cli-signal",
  }).build(({ step }) => {
    step("before").assert({ condition: true });
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      prompt: "approve",
    });
    step("after").assert({ condition: approval.output.ok });
    return { ok: approval.output.ok };
  });
}

export function timedSignalWorkflow(timeout: "100ms" | "1ms" = "100ms") {
  return defineWorkflow({
    name: "cli-timed-signal",
  }).build(({ step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout,
      onTimeout: { message: "Approval timed out" },
      prompt: "approve",
    });
    return { ok: approval.output.ok };
  });
}

export function fanoutSignalWorkflow() {
  return defineWorkflow({
    name: "cli-fanout-signal",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    const approvals = step("approvals").fanout({
      over: input.items,
      do() {
        const approval = step("approve").signal({
          outputSchema: z.object({ ok: z.boolean() }),
          prompt: "approve",
        });
        return { ok: approval.output.ok };
      },
    });
    return { approvals: approvals.output };
  });
}

export function parallelSignalAllWorkflow() {
  return defineWorkflow({
    name: "cli-parallel-signal-all",
  }).build(({ step }) => {
    const approvals = step("approvals").parallel({
      strategy: "all",
      branches: {
        left() {
          const approval = step("left_approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "left",
          });
          return { ok: approval.output.ok };
        },
        right() {
          const approval = step("right_approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "right",
          });
          return { ok: approval.output.ok };
        },
      },
    });
    return { approvals: approvals.output };
  });
}

export function parallelSignalRaceWorkflow() {
  return defineWorkflow({
    name: "cli-parallel-signal-race",
  }).build(({ step }) => {
    const approval = step("approval").parallel({
      strategy: "race",
      branches: {
        left() {
          const approval = step("left_approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "left",
          });
          return { ok: approval.output.ok };
        },
        right() {
          const approval = step("right_approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "right",
          });
          return { ok: approval.output.ok };
        },
      },
    });
    return { approval: approval.output };
  });
}
