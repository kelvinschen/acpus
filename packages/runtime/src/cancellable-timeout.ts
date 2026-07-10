const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function scheduleCancellableTimeout(delayMs: number, onElapsed: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const startedAt = performance.now();

  const schedule = (): void => {
    const remainingMs = delayMs - Math.max(0, performance.now() - startedAt);
    if (remainingMs <= 0) {
      onElapsed();
      return;
    }
    timer = setTimeout(schedule, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };

  timer = setTimeout(schedule, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}
