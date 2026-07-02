import * as zod from "zod";

export type Schema<T = unknown> = zod.ZodType<T>;
export type InferSchema<S> = S extends zod.ZodType ? zod.output<S> : never;

type AcpusZodExtensions = {
  path(): zod.ZodType<string>;
};

function withAcpusMeta<T extends zod.ZodTypeAny>(schema: T, acpus: Record<string, unknown>): T {
  return schema.meta({ ...(zod.globalRegistry.get(schema) ?? {}), acpus }) as T;
}

export const z = {
  ...zod,
  path(): zod.ZodType<string> {
    return withAcpusMeta(zod.string(), { kind: "path" }) as zod.ZodType<string>;
  },
} as typeof zod & AcpusZodExtensions;

export const s = z;

export function isSchema(value: unknown): value is Schema<any> {
  return Boolean(value && typeof value === "object" && typeof (value as any).safeParse === "function" && ((value as any).def || (value as any)._def));
}
