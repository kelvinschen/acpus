import { defineWorkflow, z } from "acpus/core";
import { and, eq, md, template } from "acpus/expression";

const Candidate = z.object({
  id: z.string(),
  kind: z.enum(["ship", "hold"]),
  score: z.number(),
});

const Approval = z.object({
  approved: z.boolean(),
  reviewer: z.string(),
  notes: z.string().default(""),
});

export default defineWorkflow({
  name: "quorum-agentless",
  inputSchema: z.object({
    candidates: z.array(Candidate),
    threshold: z.number().default(70),
  }),
}).build(({ input, meta, step }) => {
  const accepted = step("accepted_candidates").fanout({
    strategy: "quorum",
    count: 2,
    over: input.candidates,
    key: ({ item }) => template`candidate-${item.id}`,
    maxConcurrency: 2,
    do: ({ item, itemIndex, step }) => {
      const lane = step("candidate_lane").parallel({
        branches: {
          facts: {
            do: ({ step }) => {
              const facts = step("facts").task({
                run: {
                  input: { id: item.id, itemIndex, score: item.score },
                  exec: async ({ input }) => ({
                    label: `${input.itemIndex}:${input.id}`,
                    score: input.score,
                  }),
                },
              });
              return { label: facts.output.label, score: facts.output.score };
            },
          },
          verdict: {
            do: ({ step }) => {
              const routed = step("route").switch({
                cases: [
                  {
                    when: eq(item.kind, "ship"),
                    then: ({ step }) => {
                      const decision = step("ship_decision").task({
                        run: {
                          input: { id: item.id, score: item.score, threshold: input.threshold },
                          exec: async ({ input }) => ({
                            accepted: input.score >= input.threshold,
                            route: "ship",
                            summary: `${input.id} scored ${input.score} against ${input.threshold}`,
                          }),
                        },
                      });
                      return {
                        accepted: decision.output.accepted,
                        route: decision.output.route,
                        summary: decision.output.summary,
                      };
                    },
                  },
                ],
                default: ({ step }) => {
                  const held = step("hold_decision").task({
                    run: {
                      input: { id: item.id, score: item.score },
                      exec: async ({ input }) => ({
                        accepted: false,
                        route: "hold",
                        summary: `${input.id} held at ${input.score}`,
                      }),
                    },
                  });
                  return {
                    accepted: held.output.accepted,
                    route: held.output.route,
                    summary: held.output.summary,
                  };
                },
              });
              return {
                accepted: routed.output.accepted,
                route: routed.output.route,
                summary: routed.output.summary,
              };
            },
          },
        },
      });

      return {
        id: item.id,
        label: lane.output.facts.label,
        score: lane.output.facts.score,
        accepted: lane.output.verdict.accepted,
        route: lane.output.verdict.route,
        summary: lane.output.verdict.summary,
      };
    },
  });

  const proof = step("prove_array_not_envelope").task({
    run: {
      input: { accepted: accepted.output },
      exec: async ({ input }) => {
        const value = input.accepted;
        const envelopeKeys = value && typeof value === "object" && !Array.isArray(value)
          ? ["accepted", "result", "winner"].filter(key => key in value)
          : [];

        return {
          isArray: Array.isArray(value),
          acceptedCount: Array.isArray(value) ? value.length : 0,
          noEnvelopeKeys: envelopeKeys.length === 0,
          ids: Array.isArray(value) ? value.map(item => item.id) : [],
          envelopeKeys,
        };
      },
    },
  });

  step("require_quorum_array").assert({
    condition: and(proof.output.isArray, eq(proof.output.acceptedCount, 2), proof.output.noEnvelopeKeys),
    message: template`Expected quorum fanout output to be a two-item accepted array, got ${proof.output}`,
  });

  const approval = step("human_approval").signal({
    outputSchema: Approval,
    run: {
      prompt: md`
        Approve quorum proof for run ${meta.runId}.
        Accepted item ids: ${proof.output.ids}
        Envelope keys observed: ${proof.output.envelopeKeys}
      `,
    },
    timeout: "24h",
    onTimeout: { action: "fail", message: "approval timed out" },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Approval denied by ${approval.output.reviewer}: ${approval.output.notes}`,
  });

  return {
    runId: meta.runId,
    approved: approval.output.approved,
    reviewer: approval.output.reviewer,
    acceptedItems: accepted.output,
    proof: proof.output,
  };
});
