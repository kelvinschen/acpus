import { z } from "zod";

export const OutputContractNameSchema = z.enum([
  "base",
  "implementation",
  "validation",
  "decision",
  "discover",
  "summarize",
  "diagnostic"
]);

export type OutputContractName = z.infer<typeof OutputContractNameSchema>;

export const ArtifactSchema = z.object({
  kind: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional()
}).passthrough();

export const SeverityCountsSchema = z.object({
  P0: z.number().int().nonnegative(),
  P1: z.number().int().nonnegative(),
  P2: z.number().int().nonnegative(),
  P3: z.number().int().nonnegative()
});

export const FindingSchema = z.object({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  summary: z.string(),
  path: z.string().optional(),
  details: z.string().optional()
}).passthrough();

export const CheckSchema = z.object({
  command: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(["pass", "fail", "skipped", "unknown"]),
  summary: z.string().optional()
}).passthrough();

export const BaseOutputSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
  nextFocus: z.string(),
  blockedReason: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).passthrough();

export const ImplementationOutputSchema = BaseOutputSchema.extend({
  changedFiles: z.array(z.string()),
  checks: z.array(CheckSchema)
}).passthrough();

export const ValidationOutputSchema = BaseOutputSchema.extend({
  verdict: z.enum(["pass", "fix", "blocked", "unknown"]),
  severityCounts: SeverityCountsSchema,
  findings: z.array(FindingSchema),
  checks: z.array(CheckSchema)
}).passthrough();

export const DecisionOutputSchema = BaseOutputSchema.extend({
  route: z.string()
}).passthrough();

export const SummarizeOutputSchema = BaseOutputSchema.extend({
  finalVerdict: z.enum(["success", "success_with_warnings", "blocked", "failed", "unknown"]),
  deliverables: z.array(z.string()),
  changedFiles: z.array(z.string()),
  checks: z.array(CheckSchema),
  warnings: z.array(z.string()),
  risks: z.array(z.string()),
  nextActions: z.array(z.string())
}).passthrough();

export const DiagnosticOutputSchema = BaseOutputSchema.extend({
  data: z.record(z.string(), z.unknown())
}).passthrough();

export function discoverOutputSchema(outputKey = "items", maxItems?: number): z.ZodType<Record<string, unknown>> {
  return BaseOutputSchema
    .extend({
      [outputKey]: z.array(z.unknown())
    })
    .passthrough()
    .superRefine((value, ctx) => {
      const items = value[outputKey];
      if (typeof maxItems === "number" && Array.isArray(items) && items.length > maxItems) {
        ctx.addIssue({
          code: "custom",
          path: [outputKey],
          message: `discover output exceeded max item limit (${maxItems}).`
        });
      }
    });
}

export function schemaForContract(name: OutputContractName, options: { outputKey?: string; maxItems?: number } = {}): z.ZodType {
  switch (name) {
    case "implementation":
      return ImplementationOutputSchema;
    case "validation":
      return ValidationOutputSchema;
    case "decision":
      return DecisionOutputSchema;
    case "discover":
      return discoverOutputSchema(options.outputKey, options.maxItems);
    case "summarize":
      return SummarizeOutputSchema;
    case "diagnostic":
      return DiagnosticOutputSchema;
    case "base":
      return BaseOutputSchema;
  }
}
