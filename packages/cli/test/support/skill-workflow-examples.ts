import { fileURLToPath } from "node:url";

export const skillWorkflowExamples = [
  {
    name: "typed loop state",
    directory: "typed-loop-state",
    reference: "authoring",
  },
  {
    name: "adversarial review",
    directory: "adversarial-review",
    reference: "authoring",
  },
  {
    name: "change approval",
    directory: "change-approval",
    reference: "authoring",
  },
  {
    name: "issue triage",
    directory: "issue-triage",
    reference: "authoring",
  },
  {
    name: "scaled exploration",
    directory: "scaled-exploration",
    reference: "authoring",
  },
  {
    name: "worktree tournament",
    directory: "worktree-tournament",
    reference: "authoring",
  },
  {
    name: "reusable task artifact",
    directory: "reusable-task-artifact",
    reference: "advanced-authoring",
  },
  {
    name: "parallel approvals",
    directory: "parallel-approvals",
    reference: "signal-authoring",
  },
] as const;

export const skillWorkflowLibrary = [
  {
    name: "deep research",
    directory: "deep-research",
  },
] as const;

export function skillLibraryWorkflowPath(directory: string, relativePath = "workflow.ts"): string {
  return fileURLToPath(new URL(`../../skills/acpus/workflows/library/${directory}/${relativePath}`, import.meta.url));
}

export function skillReferencePath(reference: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/references/${reference}.md`, import.meta.url));
}

export function skillFilePath(relativePath: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/${relativePath}`, import.meta.url));
}
