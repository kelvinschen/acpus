import type ts from "typescript";

export type AnalyzedTask = {
  inline: boolean;
  metadata?: TaskBundleMetadata;
  issue?: TaskAuthoringIssue;
  source?: TaskSourceLocation;
};

export type TaskBundleMetadata = {
  inline: boolean;
  sourceFile?: string;
  exportName?: string;
  sourceKind?: "task-module" | "workflow-module";
};

export type TaskAuthoringIssue =
  | { kind: "invalid-reusable-task-reference"; name?: string }
  | { kind: "workflow-local-reusable-task"; name: string }
  | { kind: "unsupported-task-import"; name: string; specifier?: string; reason: "third-party" | "unresolved" | "barrel" | "read-failed" }
  | { kind: "invalid-reusable-task-export"; importedName: string; file?: string; reason: "missing-default" | "missing-named" | "not-task-define" }
  | { kind: "inline-task-capture"; names: string[] }
  | { kind: "ambiguous-task-callsite" };

export type TaskAnalysisFact = {
  stepId: string;
  inline: boolean;
  issue?: TaskAuthoringIssue;
  source?: TaskSourceLocation;
};

export type TaskMetadataFact = {
  stepId: string;
  metadata: TaskBundleMetadata;
};

export type WorkflowTaskAnalysis = Map<string, AnalyzedTask>;

export type TaskSourceLocation = {
  file: string;
  line: number;
  column: number;
};

export type ImportBinding = { specifier: string; importedName: string };

export type WorkflowTaskExport = { exportName: string; initializer?: ts.Expression };

export type TaskCallsite = {
  stepId: string;
  options: ts.ObjectLiteralExpression;
  source: TaskSourceLocation;
};
