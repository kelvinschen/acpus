import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  IconUserOutline16: () => null,
}));

import * as client from "@acpus/dsh/client";

describe("Acpus Client activation", () => {
  it("mounts its Remote contribution before consuming the acpus namespace", async () => {
    const ctx = new Context();
    const acpus = {
      readSessionActivity: vi.fn(),
      awaitSessionActivityRevision: vi.fn(),
    };
    class AcpusRemoteService extends Service {
      constructor(serviceCtx: Context) {
        super(serviceCtx, "remote.acpus");
        Object.assign(this, acpus);
      }
    }
    class RemoteService extends Service {
      readonly mount = vi.fn(async () => {
        const namespace = this.ctx.plugin(serviceCtx => {
          new AcpusRemoteService(serviceCtx);
        });
        await namespace.await();
        return namespace.dispose;
      });

      constructor(serviceCtx: Context) {
        super(serviceCtx, "remote");
      }

      $mount(): Promise<() => Promise<void>> {
        return this.mount();
      }
    }
    const remote = new RemoteService(ctx);
    ctx.provide("slots", {
      inject: (_name: string, register: () => (() => void)) => register(),
      register: () => () => {},
    });

    const fiber = ctx.plugin({ inject: [...client.inject], apply: client.apply });
    await fiber.await();

    expect(fiber.store).toBeDefined();
    expect(remote.mount).toHaveBeenCalledOnce();
    expect(ctx.get("remote.acpus")).toBeInstanceOf(AcpusRemoteService);

    await fiber.dispose();
    expect(ctx.get("remote.acpus")).toBeUndefined();
  });
});
