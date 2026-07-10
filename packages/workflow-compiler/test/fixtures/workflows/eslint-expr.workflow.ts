import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "eslint_expr_fixture",
  inputSchema: z.object({
    ready: z.boolean(),
    count: z.number(),
    name: z.string(),
    items: z.array(z.string()),
  }),
}).build(({ input, step }) => {
  if (!input.ready) {
    step("ready").assert({ condition: true });
  }
  const compared = input.count === input.count;
  const prompt = `${input.name}`;
  step(String(input.name)).assert({ condition: true });
  // @ts-expect-error Expr accessors expose array operations through fmap, not JavaScript methods.
  const mapped = input.items.map((item: string) => item);
  return { compared, prompt, mapped };
});
