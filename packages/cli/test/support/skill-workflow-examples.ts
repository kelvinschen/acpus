import { fileURLToPath } from "node:url";

export const workflowNodeKinds = [
  "agent",
  "task",
  "signal",
  "assert",
  "if",
  "switch",
  "parallel",
  "fanout",
  "loop",
] as const;

export const skillWorkflowExamples = [
  {
    name: "typed loop state",
    directory: "typed-loop-state",
    pattern: "Widen evolving loop state and replace it completely each round.",
    nodes: ["loop"],
    reference: "authoring",
  },
  {
    name: "adversarial review",
    directory: "adversarial-review",
    pattern: "Plan adversarial lenses, fan out reviews, cross-critique, and synthesize.",
    nodes: ["agent", "fanout"],
    reference: "authoring",
  },
  {
    name: "change approval",
    directory: "change-approval",
    pattern: "Draft, iteratively refine, optionally approve, and enforce a change plan.",
    nodes: ["agent", "task", "signal", "assert", "if", "loop"],
    reference: "authoring",
  },
  {
    name: "issue triage",
    directory: "issue-triage",
    pattern: "Fan out issue triage, run branch work in parallel, and route by switch.",
    nodes: ["agent", "task", "switch", "parallel", "fanout"],
    reference: "authoring",
  },
  {
    name: "multi-aspect brainstorm",
    directory: "multi-aspect-brainstorm",
    pattern: "Run parallel agent perspectives in a bounded synthesis loop.",
    nodes: ["agent", "parallel", "loop"],
    reference: "authoring",
  },
  {
    name: "worktree tournament",
    directory: "worktree-tournament",
    pattern: "Create parallel worktree implementations and have an agent judge them.",
    nodes: ["agent", "task", "parallel"],
    reference: "authoring",
  },
  {
    name: "reusable task artifact",
    directory: "reusable-task-artifact",
    pattern: "Reuse a typed Task at two authored call sites and return its artifacts.",
    nodes: ["task"],
    reference: "advanced-authoring",
  },
  {
    name: "parallel approvals",
    directory: "parallel-approvals",
    pattern: "Open independent approval waits concurrently and require both results.",
    nodes: ["signal", "parallel"],
    reference: "signal-authoring",
  },
] as const;

export const skillWorkflowLibrary = [
  {
    name: "deep research",
    directory: "deep-research",
    purpose: "Investigate complex questions with verified evidence",
  },
] as const;

export function skillExampleWorkflowPath(directory: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/workflows/examples/${directory}/workflow.ts`, import.meta.url));
}

export function skillLibraryWorkflowPath(directory: string, relativePath = "workflow.ts"): string {
  return fileURLToPath(new URL(`../../skills/acpus/workflows/library/${directory}/${relativePath}`, import.meta.url));
}

export function skillReferencePath(reference: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/references/${reference}.md`, import.meta.url));
}

export function skillFilePath(relativePath: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/${relativePath}`, import.meta.url));
}
