/*
 * Pattern: Exercise nested composite inspection and an actionable Signal wait.
 * Nodes: task, if, parallel, fanout, loop, signal, assert
 */
import { defineWorkflow, z } from "acpus/core";
import { eq, gte, template } from "acpus/expression";

export default defineWorkflow({
  name: "inspect-composite-smoke",
  description: "A deliberately nested, slowly advancing workflow for inspect/follow smoke tests.",
  inputSchema: z.object({
    items: z.array(z.string()).default(["alpha", "alpha", "beta"]),
    rounds: z.number().default(2),
    usePrimary: z.boolean().default(true),
  }),
}).build(({ input, meta, step }) => {
  const route = step("route").if({
    condition: eq(input.usePrimary, true),
    then() {
      const selected = step("primary_route").task({
        run: {
          input: { mode: "primary" },
          exec: async ({ input }) => {
            await new Promise(resolve => setTimeout(resolve, 300));
            return { mode: input.mode };
          },
        },
      });
      return { mode: selected.output.mode };
    },
    else() {
      const skipped = step("fallback_route").task({
        run: {
          input: { mode: "fallback" },
          exec: async ({ input }) => {
            await new Promise(resolve => setTimeout(resolve, 300));
            return { mode: input.mode };
          },
        },
      });
      return { mode: skipped.output.mode };
    },
  });

  const work = step("work").parallel({
    maxConcurrency: 2,
    branches: {
      batches() {
        const batches = step("batches").fanout({
          over: input.items,
          maxConcurrency: 2,
          do({ item, itemIndex }) {
            const refined = step("refine_item").loop({
              state: { value: item, completedRounds: 0 },
              do({ round, state }) {
                const iteration = step("refine_round").task({
                  run: {
                    input: { value: state.value, round, itemIndex },
                    exec: async ({ input }) => {
                      await new Promise(resolve => setTimeout(resolve, 350));
                      return {
                        value: `${input.value}:round-${input.round}`,
                        completedRounds: input.round,
                        itemIndex: input.itemIndex,
                      };
                    },
                  },
                });
                return {
                  state: {
                    value: iteration.output.value,
                    completedRounds: iteration.output.completedRounds,
                  },
                  stop: gte(round, input.rounds),
                };
              },
            });
            return {
              itemIndex,
              value: refined.output.value,
              completedRounds: refined.output.completedRounds,
            };
          },
        });
        return { results: batches.output };
      },
      audit() {
        const audit = step("audit_route").task({
          run: {
            input: { mode: route.output.mode },
            exec: async ({ input }) => {
              await new Promise(resolve => setTimeout(resolve, 650));
              return { summary: `audited:${input.mode}` };
            },
          },
        });
        return { summary: audit.output.summary };
      },
    },
  });

  const approval = step("approval").signal({
    outputSchema: z.object({ approved: z.boolean(), note: z.string().default("") }),
    run: { prompt: template`Approve composite smoke run ${meta.runId} after ${work.output.audit.summary}?` },
    timeout: "10m",
    onTimeout: { message: "composite smoke approval timed out" },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Composite smoke was rejected: ${approval.output.note}`,
  });

  return {
    runId: meta.runId,
    mode: route.output.mode,
    audit: work.output.audit.summary,
    results: work.output.batches.results,
    note: approval.output.note,
  };
});
