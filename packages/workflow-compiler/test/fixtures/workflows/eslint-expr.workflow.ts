import { defineWorkflow, z } from "@acpus/core";

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
  // @ts-expect-error Fixture intentionally exercises Acpus AL005 over Expr accessors.
  const mapped = input.items.map((item: string) => item);
  return { compared, prompt, mapped };
});
