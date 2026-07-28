import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type {
  PreparedRunValidationFailure,
  PreparedRunWorkflow,
  Sha256Digest,
  WorkflowSourceFile,
} from "../src/store/store.js";
import { tryValidatePreparedRunWorkflow } from "../src/store/store.js";
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

  it("rejects malformed or tampered bundles through one typed boundary", () => {
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

    for (const item of cases) {
      const result = tryValidatePreparedRunWorkflow("/unused-workspace", item.prepared);
      expect(result.isErr(), item.name).toBe(true);
      if (result.isOk()) throw new Error(`expected '${item.name}' to fail`);
      expect(result.error).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: item.reason,
      });
    }
  });

  it("returns a detached validated value", () => {
    const prepared = preparedSnapshot([
      { path: "workflow.ts", content: "export default 1;\n" },
    ]);
    const validated = tryValidatePreparedRunWorkflow("/unused-workspace", prepared)._unsafeUnwrap();
    const source = structuredClone(validated.source);
    const lock = structuredClone(validated.lock);
    const bundle = structuredClone(validated.sourceBundle);

    prepared.source.entry = "mutated.ts";
    prepared.lock.workflow.source.entry = "mutated.ts";
    prepared.sourceBundle.files[0]!.content = "mutated";

    expect(validated.source).toEqual(source);
    expect(validated.lock).toEqual(lock);
    expect(validated.sourceBundle).toEqual(bundle);
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
});

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
  const ir: WorkflowIR = {
    irVersion: 6,
    name: "snapshot-validation",
    agents: {},
    inputSchema: {
      kind: "object",
      fields: { ready: { kind: "boolean" } },
      required: ["ready"],
      additionalProperties: false,
    },
    diagnostics: [],
    root: { nodes: [], output: { kind: "object", fields: {} } },
  };
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
