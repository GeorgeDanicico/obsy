import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedCache } from "./cache";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createSharedCache", () => {
  it("runs one load for callers that arrive while it is in flight", async () => {
    const cache = createSharedCache<number>({ ttlMs: 30_000 });
    let release: (value: number) => void = () => {};
    const load = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));

    const results = [cache.get("a", load), cache.get("a", load), cache.get("a", load)];
    expect(load).toHaveBeenCalledTimes(1);
    release(7);
    expect(await Promise.all(results)).toEqual([7, 7, 7]);
  });

  it("reuses a result for 30 seconds, then loads again", async () => {
    const cache = createSharedCache<number>({ ttlMs: 30_000 });
    let count = 0;
    const load = vi.fn(async () => (count += 1));

    expect(await cache.get("a", load)).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(await cache.get("a", load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await cache.get("a", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("counts the 30 seconds from when the load finished", async () => {
    const cache = createSharedCache<number>({ ttlMs: 30_000 });
    let release: (value: number) => void = () => {};
    const load = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));

    const first = cache.get("a", load);
    vi.advanceTimersByTime(10_000);
    release(1);
    await first;
    vi.advanceTimersByTime(29_000);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps keys apart", async () => {
    const cache = createSharedCache<string>({ ttlMs: 30_000 });
    const load = vi.fn(async () => "x");
    await Promise.all([cache.get("a", load), cache.get("b", load)]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failure: concurrent callers share it, the next one retries", async () => {
    const cache = createSharedCache<number>({ ttlMs: 30_000 });
    let fail: (error: Error) => void = () => {};
    const load = vi.fn<() => Promise<number>>(() => new Promise<number>((_, reject) => (fail = reject)));

    const first = cache.get("a", load);
    const second = cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(1);
    fail(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");

    load.mockImplementation(async () => 5);
    expect(await cache.get("a", load)).toBe(5);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("turns a load that throws at once into a rejected promise", async () => {
    const cache = createSharedCache<number>({ ttlMs: 30_000 });
    await expect(cache.get("a", () => { throw new Error("sync"); })).rejects.toThrow("sync");
  });
});
