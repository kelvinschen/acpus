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
    name: "adversarial review",
    directory: "adversarial-review",
    pattern: "Plan adversarial lenses, fan out reviews, cross-critique, and synthesize.",
    nodes: ["agent", "fanout"],
  },
  {
    name: "change approval",
    directory: "change-approval",
    pattern: "Draft, iteratively refine, optionally approve, and enforce a change plan.",
    nodes: ["agent", "task", "signal", "assert", "if", "loop"],
  },
  {
    name: "issue triage",
    directory: "issue-triage",
    pattern: "Fan out issue triage, run branch work in parallel, and route by switch.",
    nodes: ["agent", "task", "switch", "parallel", "fanout"],
  },
  {
    name: "multi-aspect brainstorm",
    directory: "multi-aspect-brainstorm",
    pattern: "Run parallel agent perspectives in a bounded synthesis loop.",
    nodes: ["agent", "parallel", "loop"],
  },
  {
    name: "worktree tournament",
    directory: "worktree-tournament",
    pattern: "Create parallel worktree implementations and have an agent judge them.",
    nodes: ["agent", "task", "parallel"],
  },
] as const;

export function skillWorkflowPath(directory: string): string {
  return fileURLToPath(new URL(`../../skills/acpus/examples/workflows/${directory}/workflow.ts`, import.meta.url));
}
