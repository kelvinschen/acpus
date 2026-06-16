import { Ajv } from "ajv";

/**
 * Module-level Ajv singleton for Signal Node payload validation.
 * `strict: false` matches the compiler's Ajv configuration.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

export class SignalPayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalPayloadValidationError";
  }
}

/**
 * Validate a Signal Node payload against the node's compiled output schema.
 *
 * The compiler sets `metadata.output` to a compiled JSON Schema only when the
 * Signal Node declared an `output`; otherwise it is `undefined`. A missing
 * schema means "accept any object payload" (mirroring Agent and Program steps).
 * On a schema mismatch, throws {@link SignalPayloadValidationError} carrying the
 * Ajv error text so the supervisor can surface it as a 422.
 */
export function validateSignalPayload(schema: Record<string, unknown> | undefined, payload: unknown): void {
  if (!schema) {
    return;
  }
  const validate = ajv.compile(schema);
  if (!validate(payload)) {
    throw new SignalPayloadValidationError(`Signal payload validation failed: ${ajv.errorsText(validate.errors)}`);
  }
}
