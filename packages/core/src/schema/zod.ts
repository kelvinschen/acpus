import * as zod from "zod";

export type Schema<T = unknown> = zod.ZodType<T>;
export type InferSchema<S> = S extends zod.ZodType ? zod.output<S> : never;

export type ArtifactRef = {
  readonly kind: "artifact";
  readonly uri: string;
  readonly mediaType?: string;
};

export type SecretRef = {
  readonly kind: "secret";
  readonly name: string;
};

type AcpusZodExtensions = {
  integer(): zod.ZodType<number>;
  path(): zod.ZodType<string>;
  artifact(mediaType?: string): zod.ZodType<ArtifactRef>;
  secretRef(): zod.ZodType<SecretRef>;
};

function withAcpusMeta<T extends zod.ZodTypeAny>(schema: T, acpus: Record<string, unknown>): T {
  return schema.meta({ ...(zod.globalRegistry.get(schema) ?? {}), acpus }) as T;
}

export const z = {
  ...zod,
  integer(): zod.ZodType<number> {
    return withAcpusMeta(zod.number().int(), { kind: "integer" });
  },
  path(): zod.ZodType<string> {
    return withAcpusMeta(zod.string(), { kind: "path" }) as zod.ZodType<string>;
  },
  artifact(mediaType?: string): zod.ZodType<ArtifactRef> {
    const schema = zod.object({
      kind: zod.literal("artifact"),
      uri: zod.string(),
      mediaType: zod.string().optional(),
    }) as unknown as zod.ZodType<ArtifactRef>;
    return withAcpusMeta(schema as zod.ZodTypeAny, mediaType === undefined ? { kind: "artifact" } : { kind: "artifact", mediaType }) as zod.ZodType<ArtifactRef>;
  },
  secretRef(): zod.ZodType<SecretRef> {
    const schema = zod.object({ kind: zod.literal("secret"), name: zod.string() }) as unknown as zod.ZodType<SecretRef>;
    return withAcpusMeta(schema as zod.ZodTypeAny, { kind: "secret_ref" }) as zod.ZodType<SecretRef>;
  },
} as typeof zod & AcpusZodExtensions;

export const s = z;

export function isSchema(value: unknown): value is Schema<any> {
  return Boolean(value && typeof value === "object" && typeof (value as any).safeParse === "function" && ((value as any).def || (value as any)._def));
}
