import { defineWorkflow, z } from "acpus/core";
import { fmap } from "acpus/expression";

export default defineWorkflow({
  name: "eslint_fmap_fixture",
  inputSchema: z.object({
    issue: z.object({
      title: z.string(),
    }),
  }),
}).build(({ input }) => {
  const suffix = "!";
  const view = fmap(input.issue, issue => {
    return { title: issue.title.trim() };
  });
  const captured = fmap(input.issue, issue => issue.title + suffix);

  return { title: view.title, captured };
});
