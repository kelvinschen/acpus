export function assertWorkflowData(value: unknown, label: string): void {
  const issue = workflowDataIssue(value, "$", new Set());
  if (issue) throw new Error(`${label} is not workflow-admissible: ${issue}.`);
}

function workflowDataIssue(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${path} is non-finite number`;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return `${path} is ${typeof value}`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return `${path} is cyclic`;
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return `${path}[${index}] is a sparse array hole`;
      const issue = workflowDataIssue(value[index], `${path}[${index}]`, seen);
      if (issue) return issue;
    }
    seen.delete(value);
    return undefined;
  }
  if (typeof value !== "object") return `${path} is ${typeof value}`;
  if (seen.has(value)) return `${path} is cyclic`;
  if (!isPlainObject(value)) return `${path} is ${objectKind(value)}`;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    const issue = workflowDataIssue(item, `${path}.${key}`, seen);
    if (issue) return issue;
  }
  seen.delete(value);
  return undefined;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectKind(value: object): string {
  const tag = Object.prototype.toString.call(value).slice("[object ".length, -1);
  return tag || "non-plain object";
}
