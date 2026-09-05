/** Bounded ffmpeg job queue. Two slots let a preview encode start while
 * thumbs or a filmstrip run, without flooding the disk with one process per source. */
export class JobQueue {
  private pending = 0;
  private active = 0;
  private readonly limit: number;
  private readonly ready: Array<() => void> = [];
  private idle: Array<() => void> = [];

  constructor(concurrency = 2) {
    this.limit = Math.max(1, concurrency);
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  waitIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idle.push(resolve);
    });
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.takeSlot().then(fn);
    void run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.freeSlot();
      this.pending -= 1;
      if (this.pending === 0) {
        const waiting = this.idle.splice(0);
        for (const resolve of waiting) resolve();
      }
    });
    return run;
  }

  private takeSlot(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.ready.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private freeSlot(): void {
    this.active -= 1;
    const next = this.ready.shift();
    if (next) next();
  }
}
