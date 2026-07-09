export class RuntimeMutationQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  enqueue<T>(_label: string, work: () => Promise<T> | T): Promise<T> {
    this.depth += 1;
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => {
        this.depth -= 1;
      },
      () => {
        this.depth -= 1;
      },
    );
    return run;
  }

  isIdle(): boolean {
    return this.depth === 0;
  }
}
