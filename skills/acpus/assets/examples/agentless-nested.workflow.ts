import { defineWorkflow, z } from "acpus/core";
import { coalesce, eq, gte, head, md, template } from "acpus/expression";

const WorkItem = z.object({
  id: z.string(),
  kind: z.enum(["ship", "hold", "revise"]),
  score: z.number(),
});

const Approval = z.object({
  approved: z.boolean(),
  reviewer: z.string(),
  notes: z.string().default(""),
});

export default defineWorkflow({
  name: "agentless-nested",
  inputSchema: z.object({
    items: z.array(WorkItem),
    minScore: z.number().default(70),
  }),
}).build(({ input, meta, step }) => {
  const lanes = step("item_lanes").fanout({
    over: input.items,
    key: ({ item }) => template`item-${item.id}`,
    maxConcurrency: 3,
    do: ({ item, itemIndex, step }) => {
      const lane = step("lane_parallel").parallel({
        branches: {
          facts: {
            do: ({ step }) => {
              const facts = step("collect_facts").task({
                run: {
                  input: {
                    id: item.id,
                    itemIndex,
                    kind: item.kind,
                    score: item.score,
                  },
                  exec: async ({ input }) => ({
                    label: `${input.itemIndex}:${input.id}:${input.kind}`,
                    score: input.score,
                  }),
                },
              });
              return { label: facts.output.label, score: facts.output.score };
            },
          },
          decision: {
            do: ({ step }) => {
              const routed = step("route_item").switch({
                cases: [
                  {
                    when: eq(item.kind, "ship"),
                    then: ({ step }) => {
                      const calibration = step("ship_loop").loop({
                        initial: { done: false, round: 0, score: item.score, summary: "seed" },
                        maxIterations: 3,
                        do: ({ iter, previous, step }) => {
                          const round = step("ship_round").task({
                            run: {
                              input: {
                                id: item.id,
                                iter,
                                minScore: input.minScore,
                                previousScore: previous.score,
                              },
                              exec: async ({ input }) => {
                                const score = input.previousScore + input.iter * 5;
                                return {
                                  done: score >= input.minScore,
                                  round: input.iter + 1,
                                  score,
                                  summary: `${input.id} ship round ${input.iter} score ${score}`,
                                };
                              },
                            },
                          });
                          return {
                            done: round.output.done,
                            round: round.output.round,
                            score: round.output.score,
                            summary: round.output.summary,
                          };
                        },
                        stopWhen: ({ result }) => result.done,
                        onExhausted: "returnLast",
                      });
                      return {
                        route: "ship",
                        accepted: calibration.output.done,
                        finalScore: calibration.output.score,
                        summary: calibration.output.summary,
                      };
                    },
                  },
                  {
                    when: eq(item.kind, "revise"),
                    then: ({ step }) => {
                      const revision = step("revise_loop").loop({
                        initial: { done: false, round: 0, score: item.score, summary: "seed" },
                        maxIterations: 2,
                        do: ({ iter, previous, step }) => {
                          const round = step("revise_round").task({
                            run: {
                              input: {
                                id: item.id,
                                iter,
                                previousScore: previous.score,
                              },
                              exec: async ({ input }) => {
                                const score = input.previousScore + 10;
                                return {
                                  done: input.iter >= 1,
                                  round: input.iter + 1,
                                  score,
                                  summary: `${input.id} revise round ${input.iter} score ${score}`,
                                };
                              },
                            },
                          });
                          return {
                            done: round.output.done,
                            round: round.output.round,
                            score: round.output.score,
                            summary: round.output.summary,
                          };
                        },
                        stopWhen: ({ result }) => result.done,
                        onExhausted: "returnLast",
                      });
                      return {
                        route: "revise",
                        accepted: gte(revision.output.score, input.minScore),
                        finalScore: revision.output.score,
                        summary: revision.output.summary,
                      };
                    },
                  },
                ],
                default: ({ step }) => {
                  const hold = step("hold_loop").loop({
                    initial: { done: false, round: 0, score: item.score, summary: "seed" },
                    maxIterations: 1,
                    do: ({ iter, previous, step }) => {
                      const round = step("hold_round").task({
                        run: {
                          input: {
                            id: item.id,
                            iter,
                            previousScore: previous.score,
                          },
                          exec: async ({ input }) => ({
                            done: true,
                            round: input.iter + 1,
                            score: input.previousScore,
                            summary: `${input.id} held at ${input.previousScore}`,
                          }),
                        },
                      });
                      return {
                        done: round.output.done,
                        round: round.output.round,
                        score: round.output.score,
                        summary: round.output.summary,
                      };
                    },
                    stopWhen: ({ result }) => result.done,
                    onExhausted: "returnLast",
                  });
                  return {
                    route: "hold",
                    accepted: false,
                    finalScore: hold.output.score,
                    summary: hold.output.summary,
                  };
                },
              });

              return {
                route: routed.output.route,
                accepted: routed.output.accepted,
                finalScore: routed.output.finalScore,
                summary: routed.output.summary,
              };
            },
          },
        },
      });

      return {
        id: item.id,
        label: lane.output.facts.label,
        route: lane.output.decision.route,
        accepted: lane.output.decision.accepted,
        finalScore: lane.output.decision.finalScore,
        summary: lane.output.decision.summary,
      };
    },
  });

  const approval = step("human_approval").signal({
    outputSchema: Approval,
    run: {
      prompt: md`
        Approve the nested composite result for run ${meta.runId}.
        Lanes: ${lanes.output}
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
    firstRoute: coalesce(head(lanes.output).route, "(none)"),
    firstSummary: coalesce(head(lanes.output).summary, "(none)"),
  };
});
