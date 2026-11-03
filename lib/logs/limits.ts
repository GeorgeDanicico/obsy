export type Release = () => void;

export type Limiter = {
  /** Resolves with a release function, or `null` when the limiter is full or the wait ran out. */
  acquire(signal?: AbortSignal): Promise<Release | null>;
  readonly active: number;
  readonly waiting: number;
};

/**
 * At most `max` holders at once. Up to `maxQueue` callers wait, each for at most `maxWaitMs`;
 * anyone beyond that is turned away straight away.
 */
export function createLimiter({ max, maxQueue = 0, maxWaitMs = 0 }: { max: number; maxQueue?: number; maxWaitMs?: number }): Limiter {
  let active = 0;
  const queue: Array<(release: Release | null) => void> = [];

  const makeRelease = (): Release => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = queue.shift();
      if (next) {
        active += 1;
        next(makeRelease());
      }
    };
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(null);
      if (active < max) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      if (queue.length >= maxQueue || maxWaitMs <= 0) return Promise.resolve(null);

      return new Promise((resolve) => {
        const settle = (release: Release | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        };
        const giveUp = () => {
          const index = queue.indexOf(settle);
          if (index !== -1) queue.splice(index, 1);
          settle(null);
        };
        const onAbort = () => giveUp();
        const timer = setTimeout(giveUp, maxWaitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(settle);
      });
    },
  };
}
