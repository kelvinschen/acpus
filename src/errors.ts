export type IssueSeverity = "warning" | "error" | "fatal";

export type OrchestratorIssue = {
  code: string;
  severity: IssueSeverity;
  path: string;
  message: string;
  suggestions?: string[];
  docs?: string;
};

export type IssueResult = {
  ok: boolean;
  phase: string;
  errors: OrchestratorIssue[];
  warnings: OrchestratorIssue[];
};

export function issue(input: OrchestratorIssue): OrchestratorIssue {
  return input;
}

export function resultFromIssues(phase: string, issues: OrchestratorIssue[]): IssueResult {
  const errors = issues.filter((entry) => entry.severity === "error" || entry.severity === "fatal");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return {
    ok: errors.length === 0,
    phase,
    errors,
    warnings
  };
}

export class OrchestratorError extends Error {
  readonly result: IssueResult;

  constructor(result: IssueResult) {
    super(result.errors[0]?.message ?? "acpus command failed");
    this.result = result;
  }
}
