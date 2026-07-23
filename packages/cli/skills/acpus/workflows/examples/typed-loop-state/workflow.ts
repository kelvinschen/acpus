/*
 * Pattern: Widen evolving loop state and replace it completely each round.
 * Nodes: loop
 */
import { defineWorkflow, z } from "acpus/core";
import { gte, lift } from "acpus/expression";

const StateSchema = z.object({
  items: z.array(z.string()),
  note: z.string().nullable(),
  phase: z.enum(["collecting", "complete"]),
});
type State = z.infer<typeof StateSchema>;

export default defineWorkflow({
  name: "typed-loop-state",
  inputSchema: z.object({ rounds: z.number().int().positive().default(2) }),
}).build(({ input, step }) => {
  const initialState: State = { items: [], note: null, phase: "collecting" };
  const result = step("collect").loop({
    state: initialState,
    do({ state, round }) {
      const nextState = lift(state, current => {
        const items = [...current.items, `item-${current.items.length + 1}`];
        const next: State = {
          items,
          note: current.note ?? "started",
          phase: items.length >= 2 ? "complete" : "collecting",
        };
        return next;
      });
      return { state: nextState, stop: gte(round, input.rounds) };
    },
  });

  return result.output;
});
