import { expectTypeOf, test } from "vitest";
import type { ProcessHost } from "@acpus/owned-process";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import {
  type AcpTransportConnection,
  type AcpTransportConnectInput,
  type AcpTransportShape,
  type AcpTransportPromptResult,
  type AcpTransportUpdate,
} from "@acpus/acp/transport";
import type { AcpError } from "@acpus/acp";

test("ACP transport exposes one Effect-native SDK adapter", () => {
  expectTypeOf<AcpTransportShape["connect"]>().toEqualTypeOf<
    (input: AcpTransportConnectInput) => Effect.Effect<
      AcpTransportConnection,
      AcpError,
      ProcessHost | Scope.Scope
    >
  >();
  expectTypeOf<AcpTransportConnection["updates"]>()
    .toEqualTypeOf<Stream.Stream<AcpTransportUpdate, AcpError>>();
  expectTypeOf<AcpTransportConnection["initialize"]>()
    .toMatchTypeOf<() => Effect.Effect<unknown, AcpError>>();
  expectTypeOf<AcpTransportConnection["prompt"]>()
    .toMatchTypeOf<(sessionId: string, prompt: string) => Effect.Effect<AcpTransportPromptResult, AcpError>>();
});
