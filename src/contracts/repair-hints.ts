import type { z } from "zod";

export type FixHint = {
  path: string;
  message: string;
  instruction: string;
};

export function describeZodIssue(issue: z.core.$ZodIssue): FixHint {
  const path = issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/";
  return {
    path,
    message: issue.message,
    instruction: `Fix ${path}: ${issue.message}`
  };
}

export function aliasHintText(): string {
  return "Allowed deterministic alias: inside checks[] only, convert result to status when result is pass, fail, skipped, or unknown and status is missing.";
}
