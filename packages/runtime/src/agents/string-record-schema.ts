import { z } from "@acpus/core/schema";

export const PreservingStringRecordSchema = z.unknown().superRefine((value, context) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    context.addIssue({ code: "custom", message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      context.addIssue({ code: "custom", path: [key], message: "must be a string" });
    }
  }
}).transform(value => Object.fromEntries(Object.entries(value as Record<string, string>)));
