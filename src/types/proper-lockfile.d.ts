declare module "proper-lockfile" {
  export type LockOptions = {
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };
    stale?: number;
    update?: number;
    realpath?: boolean;
  };

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
}
