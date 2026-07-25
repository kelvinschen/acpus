import type * as ts from "typescript/unstable/ast";

export type AnalyzedTask = {
  inline: boolean;
  metadata?: TaskReferenceMetadata;
  issue?: TaskAuthoringIssue;
  source?: TaskSourceLocation;
};

export type TaskReferenceMetadata = {
  specifier: string;
  exportName: string;
};

export type TaskAuthoringIssue =
  | { kind: "invalid-reusable-task-reference"; name?: string }
  | { kind: "workflow-local-reusable-task"; name: string }
  | { kind: "invalid-reusable-task-export"; importedName: string; file?: string; reason: "missing-default" | "missing-named" | "not-task-define" }
  | { kind: "inline-task-capture"; names: string[] }
  | { kind: "ambiguous-task-callsite"; firstSource: TaskSourceLocation };

export type TaskAnalysisFact = {
  stepId: string;
  inline: boolean;
  issue?: TaskAuthoringIssue;
  source?: TaskSourceLocation;
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
