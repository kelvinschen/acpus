export function stableJson(value: unknown): string {
  const json = JSON.stringify(sortJson(value));
  if (json === undefined) throw new Error("Stable JSON root is not serializable.");
  return json;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
