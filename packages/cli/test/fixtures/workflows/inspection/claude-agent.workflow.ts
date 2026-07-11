/*
 * Pattern: Produce live Agent inspection telemetry through several read-only tools.
 * Nodes: agent
 */
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

export default defineWorkflow({
  name: "inspect-claude-agent-smoke",
  description: "Read-only Claude run used to verify compact and follow Agent telemetry.",
  inputSchema: z.object({
    repoPath: z.string(),
  }),
  agents: {
    observer: { use: "claude" },
  },
}).build(({ input, agents, meta, step }) => {
  const observation = step("observe_workspace").agent({
    outputSchema: z.object({ summary: z.string() }),
    run: {
      agent: agents.observer,
      cwd: input.repoPath,
      permissionMode: "approve-reads",
      prompt: md`
        Inspect this repository without changing it. Use read-only tools to:

        1. list the top-level workspace entries;
        2. find the implementation of followRunInspection;
        3. read the relevant source and report, in at most five sentences, how non-TTY follow receives Agent progress.

        Make at least two tool calls so run ${meta.runId} exposes useful live tool telemetry.
      `,
    },
    retry: { max: 1 },
    timeout: "10m",
  });

  return { runId: meta.runId, observation: observation.output.summary };
});
