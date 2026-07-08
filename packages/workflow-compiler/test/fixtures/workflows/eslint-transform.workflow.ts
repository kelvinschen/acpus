import { defineWorkflow, z } from "acpus/core";
import { transform } from "acpus/expression";

export default defineWorkflow({
  name: "eslint_transform_fixture",
  inputSchema: z.object({
    issue: z.object({
      title: z.string(),
    }),
  }),
}).build(({ input }) => {
  const suffix = "!";
  const view = transform(input.issue, issue => {
    return { title: issue.title.trim() };
  });
  const captured = transform(input.issue, issue => issue.title + suffix);

  return { title: view.title, captured };
});
