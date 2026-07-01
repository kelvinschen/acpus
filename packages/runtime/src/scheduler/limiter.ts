import PQueue from "p-queue";

export type ConcurrencyLimiter = {
  add<T>(task: () => Promise<T>): Promise<T>;
  onIdle(): Promise<void>;
  clear(): void;
};

export function createConcurrencyLimiter(concurrency: number): ConcurrencyLimiter {
  const queue = new PQueue({ concurrency });
  return {
    add: task => queue.add(task),
    onIdle: () => queue.onIdle(),
    clear: () => queue.clear(),
  };
}
