import { issue, type OrchestratorIssue } from "../errors.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";

export type ResumePolicy = {
  fanout: Record<string, {
    allowPartial?: boolean;
    maxItems?: number;
    skipItemIndexes?: number[];
  }>;
};

export type ResumePolicyOptions = {
  allowPartialFanout?: string[];
  maxFanoutItems?: string[];
  skipFanoutItem?: string[];
};

export function parseResumePolicyOptions(options: ResumePolicyOptions): {
  policy: ResumePolicy;
  issues: OrchestratorIssue[];
} {
  const fanout: ResumePolicy["fanout"] = {};
  const issues: OrchestratorIssue[] = [];

  for (const stage of options.allowPartialFanout ?? []) {
    fanout[stage] = { ...(fanout[stage] ?? {}), allowPartial: true };
  }

  for (let index = 0; index < (options.maxFanoutItems ?? []).length; index += 1) {
    const item = options.maxFanoutItems?.[index] ?? "";
    const parsed = parseStageInteger(item);
    if (!parsed) {
      issues.push(issue({
        code: "RESUME_POLICY_INVALID_MAX_ITEMS",
        severity: "error",
        path: `/resumePolicy/maxFanoutItems/${index}`,
        message: `Invalid --max-fanout-items value: ${item}.`,
        suggestions: ["Use stage=count with a non-negative integer count, for example review_files=4."]
      }));
      continue;
    }
    fanout[parsed.stage] = { ...(fanout[parsed.stage] ?? {}), maxItems: parsed.value };
  }

  for (let index = 0; index < (options.skipFanoutItem ?? []).length; index += 1) {
    const item = options.skipFanoutItem?.[index] ?? "";
    const parsed = parseStageInteger(item);
    if (!parsed) {
      issues.push(issue({
        code: "RESUME_POLICY_INVALID_SKIP_ITEM",
        severity: "error",
        path: `/resumePolicy/skipFanoutItem/${index}`,
        message: `Invalid --skip-fanout-item value: ${item}.`,
        suggestions: ["Use stage=index with a non-negative zero-based item index, for example review_files=2."]
      }));
      continue;
    }
    const existing = fanout[parsed.stage] ?? {};
    fanout[parsed.stage] = {
      ...existing,
      skipItemIndexes: [...(existing.skipItemIndexes ?? []), parsed.value]
    };
  }

  return { policy: { fanout }, issues };
}

export function validateResumePolicy(spec: WorkflowSpec, policy: ResumePolicy): OrchestratorIssue[] {
  const issues: OrchestratorIssue[] = [];
  const stageIds = spec.stages.map((stage) => stage.id);

  for (const [stageId, fanoutPolicy] of Object.entries(policy.fanout)) {
    const stageIndex = spec.stages.findIndex((stage) => stage.id === stageId);
    const stage = spec.stages[stageIndex];
    const policyPath = `/resumePolicy/fanout/${stageId}`;
    if (!stage) {
      issues.push(issue({
        code: "RESUME_POLICY_STAGE_UNKNOWN",
        severity: "error",
        path: policyPath,
        message: `Resume policy references unknown stage ${stageId}.`,
        suggestions: [`Use one of the declared stage ids: ${stageIds.join(", ")}.`]
      }));
      continue;
    }
    if (stage.kind !== "fanout") {
      issues.push(issue({
        code: "RESUME_POLICY_STAGE_NOT_FANOUT",
        severity: "error",
        path: policyPath,
        message: `Resume policy stage ${stageId} is ${stage.kind}, not fanout.`,
        suggestions: ["Use a fanout stage id for fanout resume policy overrides."]
      }));
      continue;
    }

    const role = spec.roles[stage.role];
    if (fanoutPolicy.allowPartial && role?.mode === "edit") {
      issues.push(issue({
        code: "RESUME_POLICY_PARTIAL_REQUIRES_READONLY",
        severity: "error",
        path: `${policyPath}/allowPartial`,
        message: `Resume cannot enable partial results for edit fanout stage ${stageId}.`,
        suggestions: ["Use diagnose for recovery advice, then start a new run if edit recovery is needed."]
      }));
    }

    const compiledMaxItems = stage.limits?.maxFanoutItems ?? spec.limits.maxFanoutItems ?? 1;
    if (fanoutPolicy.maxItems !== undefined && fanoutPolicy.maxItems > compiledMaxItems) {
      issues.push(issue({
        code: "RESUME_POLICY_MAX_ITEMS_NOT_TIGHTENING",
        severity: "error",
        path: `${policyPath}/maxItems`,
        message: `Resume maxItems ${fanoutPolicy.maxItems} exceeds compiled fanout cap ${compiledMaxItems} for stage ${stageId}.`,
        suggestions: [`Use a value between 0 and ${compiledMaxItems}, or start a new run from an updated spec.`]
      }));
    }

    for (const [index, itemIndex] of (fanoutPolicy.skipItemIndexes ?? []).entries()) {
      if (itemIndex >= compiledMaxItems) {
        issues.push(issue({
          code: "RESUME_POLICY_SKIP_ITEM_OUT_OF_RANGE",
          severity: "error",
          path: `${policyPath}/skipItemIndexes/${index}`,
          message: `Resume skip item index ${itemIndex} is outside compiled fanout cap ${compiledMaxItems} for stage ${stageId}.`,
          suggestions: [`Use an item index from 0 to ${Math.max(0, compiledMaxItems - 1)}.`]
        }));
      }
    }
  }

  return issues;
}

export function localizeResumePolicyForSegment(
  policy: ResumePolicy,
  segment: { purpose?: string; fanoutStageId?: string; itemStart?: number; itemCount?: number }
): ResumePolicy {
  if (segment.purpose !== "fanout-batch" || !segment.fanoutStageId) return policy;
  const stagePolicy = policy.fanout[segment.fanoutStageId];
  if (!stagePolicy) return { fanout: {} };
  const itemStart = segment.itemStart ?? 0;
  const itemCount = segment.itemCount ?? 0;
  const localized: ResumePolicy["fanout"][string] = { ...stagePolicy };
  if (stagePolicy.maxItems !== undefined) {
    localized.maxItems = Math.max(0, Math.min(itemCount, stagePolicy.maxItems - itemStart));
  }
  const localSkipItemIndexes = (stagePolicy.skipItemIndexes ?? [])
    .filter((index) => index >= itemStart && index < itemStart + itemCount)
    .map((index) => index - itemStart);
  if (localSkipItemIndexes.length > 0) localized.skipItemIndexes = localSkipItemIndexes;
  else delete localized.skipItemIndexes;
  return {
    fanout: {
      [segment.fanoutStageId]: localized
    }
  };
}

export function mergeResumePolicy(existing: unknown, next: ResumePolicy): ResumePolicy {
  const current = existing && typeof existing === "object" ? existing as ResumePolicy : { fanout: {} };
  return {
    fanout: {
      ...(current.fanout ?? {}),
      ...Object.fromEntries(Object.entries(next.fanout).map(([stage, policy]) => [
        stage,
        {
          ...(current.fanout?.[stage] ?? {}),
          ...policy,
          skipItemIndexes: [
            ...(current.fanout?.[stage]?.skipItemIndexes ?? []),
            ...(policy.skipItemIndexes ?? [])
          ]
        }
      ]))
    }
  };
}

function parseStageInteger(value: string): { stage: string; value: number } | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const stage = value.slice(0, separator);
  const rawValue = value.slice(separator + 1);
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return { stage, value: parsed };
}
