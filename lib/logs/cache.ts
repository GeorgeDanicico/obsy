/**
 * A keyed cache for async loads. While a load is running, every caller for that key gets the same
 * promise (one load at a time per key); a finished load is reused for `ttlMs`, counted from when
 * it finished. A failed load is not kept: the next caller tries again.
 */
export function createSharedCache<T>({ ttlMs, now = Date.now }: { ttlMs: number; now?: () => number }) {
  type Entry = { promise: Promise<T>; expiresAt: number | null };
  const entries = new Map<string, Entry>();

  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing && (existing.expiresAt === null || now() < existing.expiresAt)) return existing.promise;

      const entry: Entry = { promise: new Promise<T>((resolve) => resolve(load())), expiresAt: null };
      entries.set(key, entry);
      entry.promise.then(
        () => {
          entry.expiresAt = now() + ttlMs;
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.promise;
    },
    clear: () => entries.clear(),
  };
}
