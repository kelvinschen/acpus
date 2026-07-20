import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

export default defineWorkflow({
  name: "fact-check",
  inputSchema: z.object({ article: z.string() }),
  agents: {
    extractor: { use: "claude" },
    verifier: { use: "pi" },
    redteam: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const claims = step("extract_claims").agent({
    agent: agents.extractor,
    cwd: meta.workspaceDir,
    outputSchema: z.array(z.string()).length(4),
    prompt: md`
      Extract exactly four important technical claims from this article:
      ${input.article}
      Return only the four concise claims requested by the output schema.
    `,
  });

  const verdicts = step("verify_claims").fanout({
    over: claims.output,
    maxConcurrency: 3,
    do({ item }) {
      return step("verify").agent({
        agent: agents.verifier,
        cwd: meta.workspaceDir,
        prompt: md`Check ${item} against project code and primary sources. Return a concise cited verdict.`,
      }).output;
    },
  });

  const attack = step("red_team").agent({
    agent: agents.redteam,
    cwd: meta.workspaceDir,
    prompt: md`Attack weak findings in ${verdicts.output}. Return only substantial objections and concessions.`,
  });

  const gate = step("publish_gate").signal({
    outputSchema: z.object({ approved: z.literal(true) }),
    prompt: md`Approve publishing the cited report from ${verdicts.output} after ${attack.output}?`,
  });

  const report = step("write_report").task({
    input: {
      verdicts: verdicts.output,
      attack: attack.output,
      approved: gate.output.approved,
    },
    exec: async ({ input, artifact }) => {
      const markdown = [
        "# Fact-check report",
        ...input.verdicts.map((verdict, index) => `\n## Claim ${index + 1}\n${verdict}`),
        `\n## Red-team review\n${input.attack}`,
      ].join("\n");
      return {
        report: await artifact.write("fact-check-report.md", markdown, { mediaType: "text/markdown" }),
      };
    },
  });

  return report.output;
});
