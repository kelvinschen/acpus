import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Sha256Digest } from "@acpus/core/content-identity";
import type { WorkflowIR } from "@acpus/core/ir";
import { type WorkflowDefinition, compileWorkflowDefinition } from "@acpus/core/workflow";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type {
  PreparedRunWorkflow,
  RunWorkflowLockArtifact,
  WorkflowSourceFile,
} from "../../src/admission/prepared-workflow.js";
import { resolveRuntimeLayout, setRuntimeHomeForTest } from "../../src/runtime-layout.js";
import { stableJson } from "../../src/stable-json.js";
import { openRuntimeStoreAdapter } from "../../src/store/store.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
type SnapshotPreparedWorkflow = Extract<PreparedRunWorkflow, { source: { kind: "snapshot" } }>;

export async function withRuntimeWorkspace<T>(
  name: string,
  fn: (workspace: string) => Promise<T>,
  options: { authoringEnvironment?: boolean } = {},
): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  const home = await mkdtemp(join(root, `${name}-home-`));
  const restoreHome = setRuntimeHomeForTest(workspace, home);
  try {
    if (options.authoringEnvironment) {
      await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
      await linkWorkspaceCore(workspace);
      await writeWorkspaceTsconfig(workspace);
    }
    return await fn(workspace);
  } finally {
    restoreHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}

export function scopedRuntimeWorkspace(name: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const root = join(repoRoot, ".tmp-tests");
      await mkdir(root, { recursive: true });
      const [workspace, home] = await Promise.all([
        mkdtemp(join(root, `${name}-`)),
        mkdtemp(join(root, `${name}-home-`)),
      ]);
      return { workspace, home, restoreHome: setRuntimeHomeForTest(workspace, home) };
    }),
    fixture => Effect.promise(async () => {
      fixture.restoreHome();
      await Promise.all([
        rm(fixture.workspace, { recursive: true, force: true }),
        rm(fixture.home, { recursive: true, force: true }),
      ]);
    }),
  ).pipe(Effect.map(fixture => fixture.workspace));
}

export async function initializeRuntimeStoreForTest(workspace: string): Promise<void> {
  const store = await openRuntimeStoreAdapter(workspace);
  store.close();
}

export async function prepareSyntheticWorkflow(
  workspace: string,
  definition: WorkflowDefinition<any, any>,
  filename = `${definition.config.name}.workflow.ts`,
): Promise<PreparedRunWorkflow> {
  const workflowPath = join(workspace, filename);
  await writeFile(workflowPath, "");
  const ir = compileWorkflowDefinition(definition);
  return preparedWorkflow(ir, workflowPath, workspace);
}

export function preparedWorkflow(ir: WorkflowIR, workflowPath: string, cwd: string): PreparedRunWorkflow {
  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  const irFileDigest = digest(irJson);
  const entry = relative(cwd, workflowPath).split(/[\\/]/).join("/");
  const entryDigest = digest(readFileSync(workflowPath));
  const sourceGraphDigest = digest(`${stableJson({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: [{ path: entry, digest: entryDigest }],
  })}\n`);
  const source = { kind: "workspace" as const, entry };
  const lock: RunWorkflowLockArtifact = {
    kind: "acpus_workflow_preparation_lock",
    version: 2,
    workflow: { source, entryDigest },
    ir: { path: "workflow.ir.json", digest: irFileDigest },
    sourceGraphDigest,
  };
  return { source, ir, irJson, sourceGraphDigest, lock };
}

export function snapshotPreparedWorkflow(
  prepared: PreparedRunWorkflow,
  files: WorkflowSourceFile[],
  entry = "workflow.ts",
): SnapshotPreparedWorkflow {
  const sortedFiles = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sourceGraphDigest = digest(`${stableJson({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: sortedFiles.map(file => ({ path: file.path, digest: digest(file.content) })),
  })}\n`);
  const source = { kind: "snapshot" as const, entry, digest: sourceGraphDigest };
  return {
    ...prepared,
    source,
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files: sortedFiles,
    },
    sourceGraphDigest,
    lock: {
      ...prepared.lock,
      sourceGraphDigest,
      workflow: {
        source,
        entryDigest: digest(sortedFiles.find(file => file.path === entry)!.content),
      },
    },
  };
}

export function runtimeRow(workspace: string, sql: string, ...params: string[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

export function runtimeRows(workspace: string, sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function runtimeDatabasePath(workspace: string): string {
  return resolveRuntimeLayout(workspace).databasePath;
}

export function runtimeRunsRoot(workspace: string): string {
  return resolveRuntimeLayout(workspace).runsRoot;
}

export function runtimeRunDir(workspace: string, runId: string): string {
  return join(runtimeRunsRoot(workspace), runId);
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

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
