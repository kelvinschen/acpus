export type VersionedWakeup = {
  current(): number;
  waitForChange(after: number): Promise<number>;
  wake(): void;
};

export function createVersionedWakeup(): VersionedWakeup {
  let version = 0;
  let pulse = deferred<number>();
  return {
    current: () => version,
    waitForChange: after => after === version ? pulse.promise : Promise.resolve(version),
    wake: () => {
      version += 1;
      const current = pulse;
      pulse = deferred<number>();
      current.resolve(version);
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
