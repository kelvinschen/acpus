import { expectTypeOf, test } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { ExprIR } from "@acpus/expression/ir";
import type { RunInspectionDetailedFailure } from "@acpus/runtime";
import { renderWorkflowVizHtml } from "@acpus/web";
import {
  getArtifactContent,
  getNodeInspection,
  getNodeRuntimeValues,
  getRuntimeStore,
  listRuns,
  listWorkspaces,
  repairRuntimeStore,
  submitRunCommand,
} from "../src/client/api.js";
import type {
  ArtifactContent,
  NodeInspection,
  NodeInspectionFailure,
  NodeRuntimeValues,
  RunRecord,
  RuntimeStoreStatus,
  WebControlCommand,
  WorkspaceCatalog,
  WorkspaceSummary,
  WorkflowVisualizationResult,
} from "../src/client/api.js";

test("Web transport contracts preserve their semantic shapes", () => {
  type ReadyResult = Extract<WorkflowVisualizationResult, { status: "ready" }>;
  type FailedResult = Extract<WorkflowVisualizationResult, { status: "failed" }>;
  expectTypeOf<ReadyResult["contract"]["output"]>().toEqualTypeOf<ExprIR>();
  expectTypeOf<FailedResult["phase"]>().toEqualTypeOf<"source" | "check" | "compile" | "lock" | "validate">();
  expectTypeOf<Parameters<typeof submitRunCommand>>().toEqualTypeOf<[workspaceKey: string, runId: string, command: WebControlCommand]>();
  expectTypeOf<Parameters<typeof listRuns>>().toEqualTypeOf<[workspaceKey: string]>();
  expectTypeOf<Parameters<typeof repairRuntimeStore>>().toEqualTypeOf<[]>();
  expectTypeOf<Parameters<typeof getNodeInspection>>().toEqualTypeOf<[workspaceKey: string, runId: string, target: string]>();
  expectTypeOf(getArtifactContent).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(getArtifactContent).parameter(1).toEqualTypeOf<string>();
  expectTypeOf(getArtifactContent).parameter(2).toEqualTypeOf<string>();
  expectTypeOf(getArtifactContent).parameter(3).toEqualTypeOf<AbortSignal | undefined>();
  expectTypeOf<Awaited<ReturnType<typeof getArtifactContent>>>().toEqualTypeOf<ArtifactContent>();
  expectTypeOf<Awaited<ReturnType<typeof getNodeInspection>>>().toEqualTypeOf<NodeInspection>();
  expectTypeOf<Awaited<ReturnType<typeof getNodeRuntimeValues>>>().toEqualTypeOf<NodeRuntimeValues>();
  expectTypeOf<Awaited<ReturnType<typeof listRuns>>>().toEqualTypeOf<RunRecord[]>();
  expectTypeOf<Awaited<ReturnType<typeof getRuntimeStore>>>().toEqualTypeOf<RuntimeStoreStatus>();
  expectTypeOf<Awaited<ReturnType<typeof repairRuntimeStore>>>().toEqualTypeOf<void>();
  expectTypeOf<Awaited<ReturnType<typeof listWorkspaces>>>().toEqualTypeOf<WorkspaceCatalog>();
  expectTypeOf<RunRecord>().toEqualTypeOf<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>();
  expectTypeOf<WorkspaceSummary>().toEqualTypeOf<{
    key: string;
    name: string;
    path: string;
    runCount?: number;
    lastRunUpdatedAt?: string;
  }>();
  expectTypeOf<NodeInspectionFailure>().toExtend<RunInspectionDetailedFailure>();
  expectTypeOf<RunInspectionDetailedFailure>().toExtend<NodeInspectionFailure>();
  expectTypeOf<Parameters<typeof renderWorkflowVizHtml>[0]>().toEqualTypeOf<{
    ir: WorkflowIR;
    sourceGraphDigest: string;
  }>();
});
