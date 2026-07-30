/*
 * Pattern: Produce live Agent inspection progress through several read-only tools.
 * Nodes: agent
 */
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

export default defineWorkflow({
  name: "inspect-claude-agent-smoke",
  description: "Read-only Claude run used to verify compact and follow Agent progress.",
  inputSchema: z.object({
    repoPath: z.string(),
  }),
  agents: {
    observer: { use: "claude" },
  },
}).build(({ input, agents, meta, step }) => {
  const observation = step("observe_workspace").agent({
    outputSchema: z.object({ summary: z.string() }),
    agent: agents.observer,
    cwd: input.repoPath,
    permissionMode: "approve-reads",
    prompt: md`
      Inspect this repository without changing it. Use read-only tools to:

      1. list the top-level workspace entries;
      2. find the implementation of observeInspection;
      3. read the relevant source and report, in at most five sentences, how append-only follow receives Agent progress.

      Make at least two tool calls so run ${meta.runId} exposes useful live tool progress.
    `,
    timeout: "10m",
  });

  return { runId: meta.runId, observation: observation.output.summary };
});
