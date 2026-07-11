import { z } from "zod";

export { z };
export type Schema<T = unknown> = z.ZodType<T>;
