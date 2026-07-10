import { z } from "zod";

export { z };
export type Schema<T = unknown> = z.ZodType<T>;

export function isSchema(value: unknown): value is Schema<any> {
  return Boolean(value && typeof value === "object" && typeof (value as any).safeParse === "function" && ((value as any).def || (value as any)._def));
}
