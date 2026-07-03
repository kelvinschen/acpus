import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import { where } from "@acpus/expression";
import { type WorkflowDefinition, compileWorkflowDefinition } from "@acpus/core/workflow";
import type { WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { admitWorkflowRun, normalizeWorkflowInput, type PreparedRunWorkflow, type RunWorkflowLockArtifact } from "@acpus/runtime";
import { prepareWorkflow } from "@acpus/workflow-compiler";

export const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const runtimeFixtureRoot = join(repoRoot, "packages", "runtime", "test", "fixtures");

export function fixturePath(relativePath: string): string {
  return join(runtimeFixtureRoot, relativePath);
}

export async function withRuntimeWorkspace<T>(name: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  try {
    await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
    await linkWorkspaceCore(workspace);
    await writeWorkspaceTsconfig(workspace);
    return await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeWorkspaceTsconfig(workspace: string): Promise<void> {
  await writeFile(join(workspace, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      customConditions: ["development"],
    },
    include: ["*.ts"],
  }, null, 2)}\n`);
}

async function linkWorkspaceCore(workspace: string): Promise<void> {
  await mkdir(join(workspace, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(workspace, "packages", "core"), "dir");
}

export async function prepareFixture(workspace: string, relativePath: string): Promise<PreparedRunWorkflow> {
  const target = join(workspace, basename(relativePath).replace(/\.fixture$/, ".ts"));
  await copyFile(fixturePath(relativePath), target);
  return prepareWorkflow({ workflow: target, cwd: workspace }) as Promise<PreparedRunWorkflow>;
}

export async function admitFixture(workspace: string, relativePath: string, input: JsonValue = {}) {
  const prepared = await prepareFixture(workspace, relativePath);
  return admitWorkflowRun(workspace, prepared, normalizeWorkflowInput(prepared.ir, input));
}

export async function prepareSyntheticWorkflow(workspace: string, definition: WorkflowDefinition<any, any>, filename = `${definition.config.name}.workflow.ts`): Promise<PreparedRunWorkflow> {
  const workflowPath = join(workspace, filename);
  await writeFile(workflowPath, "");
  const ir = compileWorkflowDefinition(definition, { source: filename });
  return preparedWorkflow(ir, workflowPath, workspace);
}

export async function admitSyntheticWorkflow(workspace: string, definition: WorkflowDefinition<any, any>, input: JsonValue = {}) {
  const prepared = await prepareSyntheticWorkflow(workspace, definition);
  return admitWorkflowRun(workspace, prepared, normalizeWorkflowInput(prepared.ir, input));
}

export function validWorkflow() {
  return defineWorkflow({
    name: "cli-valid",
    inputSchema: z.object({ ready: z.boolean() }),
  }).build(({ input, step }) => {
    step("require_ready").assert({ condition: where(input, { ready: true }) });
    return { ready: input.ready };
  });
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

export function defaultRefInputWorkflow() {
  return defineWorkflow({
    name: "cli-default-ref-input",
    inputSchema: z.object({
      base: z.string().default("main"),
      patch: z.object({
        kind: z.literal("artifact"),
        uri: z.string(),
        mediaType: z.literal("text/plain"),
      }),
      token: z.string(),
    }),
  }).build(({ input }) => ({ base: input.base, patch: input.patch, token: input.token }));
}

export function taskArtifactWorkflow() {
  return defineWorkflow({
    name: "cli-task",
  }).build(({ step }) => {
    const result = step("local_task").task({
      run: {
        input: {},
        exec: async ({ artifact }) => ({
          ok: true,
          artifact: await artifact.writeText("result.txt", "artifact-ok\n"),
        }),
      },
    });
    return { ok: result.output.ok, artifact: result.output.artifact };
  });
}

export function taskInvocationOptionsWorkflow() {
  return defineWorkflow({
    name: "runtime-task-invocation-options",
    inputSchema: z.object({ workDir: z.path() }),
  }).build(({ input, step }) => {
    const result = step("inspect_invocation").task({
      run: {
        input: { name: "runtime", mode: "strict" },
        cwd: input.workDir,
        env: { RUNTIME_TASK_ENV: "from-run-env" },
        execution: { defaultCommandTimeout: "5s" },
        exec: async ({ input, $, env }) => {
          const command = await $`pwd`;
          return {
            inputName: input.name,
            cwd: command.stdout.trim(),
            envValue: env.RUNTIME_TASK_ENV ?? "",
            inputMode: input.mode,
          };
        },
      },
    });
    return {
      inputName: result.output.inputName,
      cwd: result.output.cwd,
      envValue: result.output.envValue,
      inputMode: result.output.inputMode,
    };
  });
}

export function replacementTaskWorkflow() {
  return defineWorkflow({
    name: "cli-task-replacement",
  }).build(({ step }) => {
    const result = step("local_task").task({
      run: {
        input: {},
        exec: async ({ artifact }) => ({
          ok: true,
          artifact: await artifact.writeText("result.txt", "replacement\n"),
        }),
      },
    });
    const extra = step("extra").task({
      run: {
        input: {},
        exec: async () => ({ extra: true }),
      },
    });
    return { ok: result.output.ok, artifact: result.output.artifact, extra: extra.output.extra };
  });
}

export function failingTaskWorkflow() {
  return defineWorkflow({
    name: "cli-failing-task",
  }).build(({ step }) => {
    step("boom").task({
      run: {
        input: {},
        exec: async () => {
          throw new Error("task exploded");
        },
      },
    });
    return {};
  });
}

export function failOnceTaskWorkflow() {
  return defineWorkflow({
    name: "cli-fail-once-task",
    inputSchema: z.object({ workDir: z.path() }),
  }).build(({ input, step }) => {
    const result = step("eventual").task({
      run: {
        input: {},
        cwd: input.workDir,
        exec: async ({ $ }) => {
          await $`sh -c "if [ -f .retry-marker ]; then exit 0; fi; touch .retry-marker; exit 1"`;
          return { ok: true };
        },
      },
    });
    return { ok: result.output.ok };
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
    step("review").agent({ run: { agent: agents.reviewer, prompt: "review" } });
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
      run: { prompt: "approve" },
    });
    step("after").assert({ condition: approval.output.ok });
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
      do: ({ step }) => {
        const approval = step("approve").signal({
          outputSchema: z.object({ ok: z.boolean() }),
          run: { prompt: "approve" },
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
        left: {
          do: ({ step }) => {
            const approval = step("left_approve").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "left" },
            });
            return { ok: approval.output.ok };
          },
        },
        right: {
          do: ({ step }) => {
            const approval = step("right_approve").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "right" },
            });
            return { ok: approval.output.ok };
          },
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
        left: {
          do: ({ step }) => {
            const approval = step("left_approve").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "left" },
            });
            return { ok: approval.output.ok };
          },
        },
        right: {
          do: ({ step }) => {
            const approval = step("right_approve").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "right" },
            });
            return { ok: approval.output.ok };
          },
        },
      },
    });
    return { approval: approval.output };
  });
}

export function preparedWorkflow(ir: WorkflowIR, workflowPath: string, cwd: string): PreparedRunWorkflow {
  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  const irDigest = digest(irJson);
  const sourceGraphDigest = digest(`${ir.lock.workflowSourceDigest ?? ""}\n`);
  const lock: RunWorkflowLockArtifact = {
    kind: "acpus_preflight_lock",
    version: 1,
    workflow: {
      entry: workflowPath.slice(cwd.length + 1),
      ...(ir.lock.workflowSourceDigest ? { sourceDigest: ir.lock.workflowSourceDigest } : {}),
    },
    ir: {
      path: "workflow.ir.json",
      digest: irDigest,
    },
    sourceGraphDigest,
    generatedAt: "2026-06-29T00:00:00.000Z",
  };
  return {
    workflowPath,
    ir,
    irJson,
    irDigest,
    sourceGraphDigest,
    lock,
  };
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function runtimeRow(workspace: string, sql: string, ...params: string[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

export function runtimeRows(workspace: string, sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
