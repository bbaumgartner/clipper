export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  get busy(): boolean {
    return this.pending > 0;
  }

  waitIdle(): Promise<void> {
    return this.chain;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.pending -= 1;
    });
    return run;
  }
}
