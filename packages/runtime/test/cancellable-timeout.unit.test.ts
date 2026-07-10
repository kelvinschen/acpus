import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleCancellableTimeout } from "../src/cancellable-timeout.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cancellable timeout", () => {
  it("chunks delays above the Node timer limit", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();

    scheduleCancellableTimeout(MAX_TIMER_DELAY_MS + 1, onElapsed);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);

    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the active chunk", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const cancel = scheduleCancellableTimeout(Number.MAX_SAFE_INTEGER, onElapsed);

    cancel();
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);

    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses actual monotonic elapsed time when a chunk callback is delayed", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(MAX_TIMER_DELAY_MS + 1);
    const onElapsed = vi.fn();

    scheduleCancellableTimeout(MAX_TIMER_DELAY_MS + 1, onElapsed);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);

    expect(onElapsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is unaffected by backward wall-clock changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const onElapsed = vi.fn();

    scheduleCancellableTimeout(100, onElapsed);
    vi.setSystemTime(new Date("2025-07-10T00:00:00.000Z"));
    vi.advanceTimersByTime(100);

    expect(onElapsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
