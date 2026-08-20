import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha256Digest } from "@acpus/core/content-identity";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import {
  tryValidatePreparedRunWorkflow,
  type PreparedRunValidationFailure,
  type PreparedRunWorkflow,
  type WorkflowSourceFile,
} from "../src/admission/prepared-workflow.js";
import { stableJson } from "../src/stable-json.js";

type SnapshotPreparedWorkflow = Extract<PreparedRunWorkflow, { source: { kind: "snapshot" } }>;

describe("prepared workflow snapshot validation", () => {
  it("matches the canonical source graph digest vector", () => {
    const prepared = preparedSnapshot([
      { path: "workflow.ts", content: "export default 1;\n" },
    ]);

    expect(prepared.source).toEqual({
      kind: "snapshot",
      entry: "workflow.ts",
      digest: "sha256:7e383697a9071b82ad5bd7185791ca677d40d04ea6a31603e26885a8ceac8508",
    });
    expect(tryValidatePreparedRunWorkflow("/unused-workspace", prepared).isOk()).toBe(true);
  });

  const unsupportedVersion = workflowIr();
  (unsupportedVersion as { irVersion: number }).irVersion = 6;

  it.each([
    { name: "an unsupported IR version", ir: unsupportedVersion },
    {
      name: "an open root record",
      ir: workflowIr({
        root: { nodes: [], output: { kind: "object", fields: {} }, extra: true } as unknown as WorkflowIR["root"],
      }),
    },
    { name: "an unresolved output reference", ir: workflowIr({ output: { kind: "ref", path: ["unknown", "value"] } }) },
    {
      name: "an error diagnostic",
      ir: workflowIr({ diagnostics: [{ code: "TEST", severity: "error", message: "not admissible" }] }),
    },
  ])("rejects self-consistent $name", ({ ir }) => {
    const result = tryValidatePreparedRunWorkflow("/unused-workspace", preparedWithIr(ir));
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected invalid frozen IR");
    expect(result.error).toMatchObject({
      type: "prepared-workflow-invalid",
      reason: "invalid-ir",
    });
  });

  it("accepts warning diagnostics without mutating prepared input", () => {
    const prepared = preparedWithIr(workflowIr({
      diagnostics: [{ code: "W002", severity: "warning", message: "warning only" }],
    }));
    const original = structuredClone(prepared);

    expect(tryValidatePreparedRunWorkflow("/unused-workspace", prepared).isOk()).toBe(true);
    expect(prepared).toEqual(original);
  });

  describe("prepared IR and lock mismatches", () => {
    const valid = preparedSnapshot([{ path: "workflow.ts", content: "export default 1;\n" }]);
    const mismatchedIrJson = `${JSON.stringify({ ...valid.ir, name: "other" }, null, 2)}\n`;
    const packageLockDigest = `sha256:${"a".repeat(64)}` as Sha256Digest;

    it.each([
      { name: "invalid IR JSON", prepared: { ...valid, irJson: "{" }, reason: "invalid-ir-json" },
      { name: "IR JSON and value mismatch", prepared: { ...valid, irJson: mismatchedIrJson }, reason: "ir-mismatch" },
      {
        name: "IR digest mismatch",
        prepared: { ...valid, lock: { ...valid.lock, ir: { ...valid.lock.ir, digest: packageLockDigest } } },
        reason: "ir-digest-mismatch",
      },
      { name: "package-lock mismatch", prepared: { ...valid, packageLockDigest }, reason: "package-lock-mismatch" },
    ] as const)("reports $reason for $name", ({ prepared, reason }) => {
      expect(tryValidatePreparedRunWorkflow("/unused-workspace", prepared)._unsafeUnwrapErr()).toMatchObject({
        type: "prepared-workflow-invalid",
        reason,
      });
    });
  });

  describe("malformed or tampered bundles", () => {
    const valid = preparedSnapshot([
      { path: "helper.ts", content: "export const helper = true;\n" },
      { path: "workflow.ts", content: "export default 1;\n" },
    ]);
    const cases: Array<{
      name: string;
      prepared: PreparedRunWorkflow;
      reason: PreparedRunValidationFailure["reason"];
    }> = [
      {
        name: "missing entry",
        prepared: {
          ...valid,
          source: { ...valid.source, entry: "missing.ts" },
          lock: {
            ...valid.lock,
            workflow: {
              ...valid.lock.workflow,
              source: { ...valid.source, entry: "missing.ts" },
            },
          },
        },
        reason: "entry-mismatch",
      },
      {
        name: "tampered entry digest",
        prepared: {
          ...valid,
          lock: {
            ...valid.lock,
            workflow: {
              ...valid.lock.workflow,
              entryDigest: `sha256:${"f".repeat(64)}`,
            },
          },
        },
        reason: "entry-mismatch",
      },
      {
        name: "unsorted files",
        prepared: withBundle(valid, [...valid.sourceBundle.files].reverse()),
        reason: "source-bundle-mismatch",
      },
      {
        name: "duplicate files",
        prepared: withBundle(valid, [
          { path: "workflow.ts", content: "one" },
          { path: "workflow.ts", content: "two" },
        ]),
        reason: "source-bundle-mismatch",
      },
      {
        name: "non-portable file path",
        prepared: withBundle(valid, [
          { path: "../escape.ts", content: "escape" },
          { path: "workflow.ts", content: "entry" },
        ]),
        reason: "source-bundle-mismatch",
      },
      {
        name: "snapshot without bundle",
        prepared: withoutBundle(valid),
        reason: "source-bundle-mismatch",
      },
      {
        name: "bundle with an extra key",
        prepared: {
          ...valid,
          sourceBundle: {
            ...valid.sourceBundle,
            unexpected: true,
          },
        } as unknown as PreparedRunWorkflow,
        reason: "source-bundle-mismatch",
      },
      {
        name: "workspace with bundle",
        prepared: withWorkspaceSource(valid),
        reason: "source-bundle-mismatch",
      },
      {
        name: "file-directory prefix collision",
        prepared: withBundle(valid, [
          { path: "workflow.ts", content: "entry" },
          { path: "workflow.ts/helper.ts", content: "collision" },
        ]),
        reason: "source-bundle-mismatch",
      },
      {
        name: "case-folded directory collision",
        prepared: withBundle(valid, [
          { path: "A/helper.ts", content: "one" },
          { path: "a/workflow.ts", content: "two" },
        ]),
        reason: "source-bundle-mismatch",
      },
      {
        name: "expanding case-folded directory collision",
        prepared: withBundle(valid, [
          { path: "STRASSE/helper.ts", content: "one" },
          { path: "Straße/other.ts", content: "two" },
          { path: "workflow.ts", content: "entry" },
        ]),
        reason: "source-bundle-mismatch",
      },
      {
        name: "tampered helper content",
        prepared: withBundle(valid, valid.sourceBundle.files.map(file => file.path === "helper.ts"
          ? { ...file, content: `${file.content}// tampered\n` }
          : file)),
        reason: "source-graph-mismatch",
      },
      {
        name: "tampered source digest",
        prepared: {
          ...valid,
          source: { ...valid.source, digest: `sha256:${"f".repeat(64)}` as Sha256Digest },
          lock: {
            ...valid.lock,
            workflow: {
              ...valid.lock.workflow,
              source: { ...valid.source, digest: `sha256:${"f".repeat(64)}` as Sha256Digest },
            },
          },
        },
        reason: "source-graph-mismatch",
      },
    ];

    it.each(cases)("rejects $name", item => {
      const result = tryValidatePreparedRunWorkflow("/unused-workspace", item.prepared);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error(`expected '${item.name}' to fail`);
      expect(result.error).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: item.reason,
      });
    });
  });

  it("returns a detached validated value", () => {
    const prepared = preparedSnapshot([
      { path: "workflow.ts", content: "export default 1;\n" },
    ]);
    const validated = tryValidatePreparedRunWorkflow("/unused-workspace", prepared)._unsafeUnwrap();
    const source = structuredClone(validated.source);
    const lock = structuredClone(validated.lock);
    const bundle = structuredClone(validated.sourceBundle);
    const ir = structuredClone(validated.ir);

    prepared.source.entry = "mutated.ts";
    prepared.lock.workflow.source.entry = "mutated.ts";
    prepared.sourceBundle.files[0]!.content = "mutated";
    prepared.ir.name = "mutated";

    expect(validated.source).toEqual(source);
    expect(validated.lock).toEqual(lock);
    expect(validated.sourceBundle).toEqual(bundle);
    expect(validated.ir).toEqual(ir);
  });

  it("distinguishes a missing workspace entry from a missing runtime workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-runtime-workspace-validation-"));
    const prepared = withWorkspaceSource(preparedSnapshot([
      { path: "workflow.ts", content: "export default 1;\n" },
    ]), false);
    try {
      const missingEntry = tryValidatePreparedRunWorkflow(workspace, prepared);
      expect(missingEntry._unsafeUnwrapErr()).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: "entry-mismatch",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    expect(() => tryValidatePreparedRunWorkflow(workspace, prepared)).toThrow();
  });

  it("rejects a non-directory runtime workspace as a system failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-runtime-workspace-validation-"));
    const workspace = join(root, "workspace");
    const prepared = withWorkspaceSource(preparedSnapshot([
      { path: "workflow.ts", content: "export default 1;\n" },
    ]), false);
    try {
      await writeFile(workspace, "not a directory\n");
      expect(() => tryValidatePreparedRunWorkflow(workspace, prepared)).toThrow(
        "Runtime workspace must be a directory.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a reusable-task referrer that resolves outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-runtime-referrer-validation-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "workflow.ts"), "export default 1;\n");
      await writeFile(join(root, "outside.ts"), "export const task = true;\n");
      await symlink(join(root, "outside.ts"), join(workspace, "referrer.ts"));
      const prepared = preparedWorkspaceWithReferrers("referrer.ts");

      expect(tryValidatePreparedRunWorkflow(workspace, prepared)._unsafeUnwrapErr()).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: "entry-mismatch",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a regular reusable-task referrer contained by the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-runtime-referrer-validation-"));
    try {
      await writeFile(join(workspace, "workflow.ts"), "export default 1;\n");
      await writeFile(join(workspace, "referrer.ts"), "export const task = true;\n");

      expect(tryValidatePreparedRunWorkflow(
        workspace,
        preparedWorkspaceWithReferrers("referrer.ts"),
      ).isOk()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("accepts a reusable-task referrer symlink that resolves inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-runtime-referrer-validation-"));
    try {
      await writeFile(join(workspace, "workflow.ts"), "export default 1;\n");
      await writeFile(join(workspace, "target.ts"), "export const task = true;\n");
      await symlink(join(workspace, "target.ts"), join(workspace, "referrer.ts"));

      expect(tryValidatePreparedRunWorkflow(
        workspace,
        preparedWorkspaceWithReferrers("referrer.ts"),
      ).isOk()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a nested reusable-task referrer through an escaping directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-runtime-referrer-validation-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(workspace, "workflow.ts"), "export default 1;\n");
      await writeFile(join(outside, "referrer.ts"), "export const task = true;\n");
      await symlink(outside, join(workspace, "linked"));
      const task = reusableTask("linked/referrer.ts", "nested-reusable");
      const prepared = withWorkspaceSource(preparedWithIr(workflowIr({
        nodes: [{
          id: "fanout",
          kind: "fanout",
          strategy: "all",
          over: { kind: "array", items: [] },
          do: {
            nodes: [{
              id: "loop",
              kind: "loop",
              state: { kind: "object", fields: {} },
              do: {
                nodes: [task],
                output: {
                  kind: "object",
                  fields: {
                    state: { kind: "object", fields: {} },
                    stop: { kind: "literal", value: true },
                  },
                },
              },
            }],
            output: { kind: "object", fields: {} },
          },
        }],
      })), false);

      expect(tryValidatePreparedRunWorkflow(workspace, prepared)._unsafeUnwrapErr()).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: "entry-mismatch",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type WorkflowParts = Partial<Omit<WorkflowIR, "root">> & {
  nodes?: WorkflowIR["root"]["nodes"];
  output?: WorkflowIR["root"]["output"];
  root?: WorkflowIR["root"];
};

function workflowIr(partial: WorkflowParts = {}): WorkflowIR {
  const { nodes, output = { kind: "object", fields: {} }, root, ...rest } = partial;
  return {
    irVersion: 8,
    name: "snapshot-validation",
    agents: {},
    inputSchema: {
      kind: "object",
      fields: { ready: { kind: "boolean" } },
      required: ["ready"],
      additionalProperties: false,
    },
    diagnostics: [],
    ...rest,
    root: root ?? { nodes: nodes ?? [], output },
  } as WorkflowIR;
}

function preparedWithIr(ir: WorkflowIR): SnapshotPreparedWorkflow {
  const prepared = preparedSnapshot([{ path: "workflow.ts", content: "export default 1;\n" }]);
  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  return {
    ...prepared,
    ir,
    irJson,
    lock: {
      ...prepared.lock,
      ir: { path: "workflow.ir.json", digest: sha256(irJson) },
    },
  };
}

function preparedWorkspaceWithReferrers(...paths: string[]): PreparedRunWorkflow {
  return withWorkspaceSource(preparedWithIr(workflowIr({
    nodes: paths.map((path, index) => reusableTask(path, `reusable-${index}`)),
  })), false);
}

function reusableTask(
  path: string,
  id: string,
): WorkflowIR["root"]["nodes"][number] {
  return {
    id,
    kind: "task",
    run: {
      input: { kind: "object", fields: {} },
      target: {
        kind: "module",
        specifier: "./task.js",
        exportName: "task",
        referrer: { path },
      },
    },
  };
}

function preparedSnapshot(
  files: WorkflowSourceFile[],
  entry = "workflow.ts",
): SnapshotPreparedWorkflow {
  const sortedFiles = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sourceGraphDigest = sha256(`${stableJson({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: sortedFiles.map(file => ({ path: file.path, digest: sha256(file.content) })),
  })}\n`);
  const source = { kind: "snapshot" as const, entry, digest: sourceGraphDigest };
  const ir = workflowIr();
  const irJson = `${JSON.stringify(ir, null, 2)}\n`;
  return {
    source,
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files: sortedFiles,
    },
    ir,
    irJson,
    sourceGraphDigest,
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 2,
      workflow: {
        source,
        entryDigest: sha256(sortedFiles.find(file => file.path === entry)!.content),
      },
      ir: { path: "workflow.ir.json", digest: sha256(irJson) },
      sourceGraphDigest,
    },
  } satisfies SnapshotPreparedWorkflow;
}

function withBundle(
  prepared: SnapshotPreparedWorkflow,
  files: readonly WorkflowSourceFile[],
): SnapshotPreparedWorkflow {
  return {
    ...prepared,
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files,
    },
  };
}

function withoutBundle(prepared: SnapshotPreparedWorkflow): PreparedRunWorkflow {
  const { sourceBundle: _, ...without } = prepared;
  return without as PreparedRunWorkflow;
}

function withWorkspaceSource(
  prepared: SnapshotPreparedWorkflow,
  retainBundle = true,
): PreparedRunWorkflow {
  const source = { kind: "workspace" as const, entry: prepared.source.entry };
  const workspace = {
    ...prepared,
    source,
    lock: {
      ...prepared.lock,
      workflow: { ...prepared.lock.workflow, source },
    },
  };
  if (retainBundle) return workspace as unknown as PreparedRunWorkflow;
  const { sourceBundle: _, ...without } = workspace;
  return without;
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
