import { defineWorkflow, z } from "acpus/core";
import { coalesce, eq, gte, head, md, template } from "acpus/expression";

const Lane = z.object({
  id: z.string(),
  mode: z.enum(["auto", "manual"]),
  score: z.number(),
});

const AgentDecision = z.object({
  ok: z.boolean(),
  summary: z.string(),
});

export default defineWorkflow({
  name: "web-composite-agent",
  inputSchema: z.object({
    lanes: z.array(Lane),
    minScore: z.number(),
    runAgents: z.boolean(),
    requireSignal: z.boolean(),
  }),
  agents: {
    reviewer: { use: "pi", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const execution = step("execution").parallel({
    maxConcurrency: 3,
    branches: {
      lane_matrix: {
        do: ({ step }) => {
          const lanes = step("lanes").fanout({
            over: input.lanes,
            key: ({ item }) => template`lane-${item.id}`,
            maxConcurrency: 2,
            do: ({ item, step }) => {
              const route = step("route").switch({
                cases: [
                  {
                    when: eq(item.mode, "auto"),
                    then: ({ step }) => {
                      const auto = step("auto_route").task({
                        run: {
                          input: { lane: item.id, score: item.score },
                          exec: async ({ input }) => {
                            await new Promise(resolve => setTimeout(resolve, 30_000));
                            return {
                              route: "auto-fast",
                              accepted: input.score >= 80,
                            };
                          },
                        },
                      });
                      return {
                        route: auto.output.route,
                        accepted: auto.output.accepted,
                      };
                    },
                  },
                ],
                default: ({ step }) => {
                  const manual = step("manual_route").task({
                    run: {
                      input: { lane: item.id, score: item.score },
                      exec: async ({ input }) => {
                        await new Promise(resolve => setTimeout(resolve, 30_000));
                        return {
                          route: "manual-review",
                          accepted: input.score >= 60,
                        };
                      },
                    },
                  });
                  return {
                    route: manual.output.route,
                    accepted: manual.output.accepted,
                  };
                },
              });

              const repair = step("repair_loop").loop({
                initial: {
                  count: 0 as number,
                  done: false as boolean,
                  note: "seed" as string,
                },
                maxIterations: 2,
                do: () => {
                  return {
                    count: 1 as number,
                    done: true as boolean,
                    note: "done" as string,
                  };
                },
                stopWhen: ({ result }) => result.done,
                onExhausted: "returnLast",
              });

              step("score_gate").assert({
                condition: gte(item.score, input.minScore),
                message: template`Lane ${item.id} scored below ${input.minScore}.`,
              });

              return {
                lane: item.id,
                route: route.output.route,
                accepted: route.output.accepted,
                repair_count: repair.output.count,
                repair_note: repair.output.note,
              };
            },
          });

          return {
            first_lane: coalesce(head(lanes.output).lane, "none"),
            first_route: coalesce(head(lanes.output).route, "none"),
            count: 2,
          };
        },
      },
      agent_preview: {
        do: ({ step }) => {
          const review = step("agent_gate").if({
            condition: input.runAgents,
            then: ({ step }) => {
              const agent = step("reviewer_agent").agent({
                outputSchema: AgentDecision,
                retry: { max: 0 },
                timeout: "300s",
                run: {
                  agent: agents.reviewer,
                  prompt: md`
                    Review the current Acpus web composite-agent display run.
                    Return a JSON object with ok and summary.
                  `,
                  sessionKey: template`${meta.runId}:web-composite-agent`,
                },
              });
              return {
                ok: agent.output.ok,
                summary: agent.output.summary,
              };
            },
            else: ({ step }) => {
              const skipped = step("skip_agent").task({
                run: {
                  input: {},
                  exec: async () => {
                    await new Promise(resolve => setTimeout(resolve, 30_000));
                    return {
                      ok: true,
                      summary: "agent branch present in static graph; skipped for local web display",
                    };
                  },
                },
              });
              return {
                ok: skipped.output.ok,
                summary: skipped.output.summary,
              };
            },
          });

          return {
            ok: review.output.ok,
            summary: review.output.summary,
          };
        },
      },
      race_preview: {
        do: ({ step }) => {
          const race = step("race").parallel({
            strategy: "race",
            branches: {
              cache: {
                do: ({ step }) => {
                  const hit = step("cache_hit").task({
                    run: {
                      input: {},
                      exec: async () => {
                        await new Promise(resolve => setTimeout(resolve, 30_000));
                        return { source: "cache", value: "warm" };
                      },
                    },
                  });
                  return { source: hit.output.source, value: hit.output.value };
                },
              },
              compute: {
                do: ({ step }) => {
                  const calc = step("compute_value").task({
                    run: {
                      input: {},
                      exec: async () => {
                        await new Promise(resolve => setTimeout(resolve, 30_000));
                        return { source: "compute", value: "fresh" };
                      },
                    },
                  });
                  return { source: calc.output.source, value: calc.output.value };
                },
              },
            },
          });

          return {
            winner: race.output.winner,
            source: race.output.result.source,
            value: race.output.result.value,
          };
        },
      },
    },
  });

  const operatorGate = step("operator_gate").if({
    condition: input.requireSignal,
    then: ({ step }) => {
      const approval = step("operator_signal").signal({
        outputSchema: z.object({ ok: z.boolean(), note: z.string() }),
        run: {
          prompt: template`Approve run ${meta.runId} after reviewing the web graph.`,
        },
      });
      return {
        ok: approval.output.ok,
        note: approval.output.note,
      };
    },
    else: ({ step }) => {
      const auto = step("auto_operator_gate").task({
        run: {
          input: {},
          exec: async () => {
            await new Promise(resolve => setTimeout(resolve, 30_000));
            return { ok: true, note: "signal branch skipped" };
          },
        },
      });
      return {
        ok: auto.output.ok,
        note: auto.output.note,
      };
    },
  });

  step("final_gate").assert({
    condition: operatorGate.output.ok,
    message: template`Operator gate rejected: ${operatorGate.output.note}`,
  });

  return {
    run_id: meta.runId,
    first_lane: execution.output.lane_matrix.first_lane,
    first_route: execution.output.lane_matrix.first_route,
    agent_ok: execution.output.agent_preview.ok,
    agent_summary: execution.output.agent_preview.summary,
    race_winner: execution.output.race_preview.winner,
    operator_note: operatorGate.output.note,
  };
});
