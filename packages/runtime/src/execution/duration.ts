export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`Invalid duration '${value}'.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return amount * 3_600_000;
}
