// Metrics computed from `request` and `tick` log lines. Pure: no Docker, no clock.
import type { LogEntry } from "./lines";

/** How far back the metrics look. One `docker logs --since 15m` read per app covers it. */
export const METRICS_WINDOW_MS = 15 * 60_000;
export const METRICS_WINDOW_MINUTES = METRICS_WINDOW_MS / 60_000;
/** A route with fewer requests than this in the window is grouped into "other". */
export const MIN_ROUTE_REQUESTS = 5;
/** The worker's `TICK_INTERVAL_MS` in the expense-tracker repo (src/lib/notifications/worker.ts). */
export const TICK_INTERVAL_MS = 30_000;
/** The heartbeat is red once the last tick is older than this many tick intervals. */
export const HEARTBEAT_RED_INTERVALS = 3;
/** The name of the row that holds the routes with too few requests. */
export const OTHER_ROUTE = "other";

/**
 * Nearest-rank percentile: for `n` sorted values, the p-th percentile is the value at rank
 * `ceil(p / 100 * n)` (1-based). It is always one of the measured values, never an interpolation.
 * Example: for 1..10, p50 is 5 (rank 5) and p95 is 10 (rank 10). `null` for an empty list.
 */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  const n = sortedAscending.length;
  if (!n) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAscending[rank - 1];
}

export type RouteStats = {
  /** A route template, or "other" for the grouped small routes. */
  route: string;
  requests: number;
  /** Status 500 or above. */
  errors: number;
  /** Status 429. */
  rateLimited: number;
  p50: number | null;
  p95: number | null;
};

export type RequestMetrics = {
  windowMinutes: number;
  requests: number;
  /** Requests divided by the window length, not by how long the app has been up. */
  perMinute: number;
  errors: number;
  /** `errors / requests`, 0 to 1 (0 with no requests). */
  errorRate: number;
  rateLimited: number;
  p50: number | null;
  p95: number | null;
  /** Busiest first (ties by name); the "other" row, if any, is last. */
  routes: RouteStats[];
  /** How many routes were grouped into "other". */
  groupedRoutes: number;
};

type Bucket = { requests: number; errors: number; rateLimited: number; ms: number[] };

const newBucket = (): Bucket => ({ requests: 0, errors: 0, rateLimited: 0, ms: [] });

function describe(route: string, bucket: Bucket): RouteStats {
  const sorted = [...bucket.ms].sort((a, b) => a - b);
  return { route, requests: bucket.requests, errors: bucket.errors, rateLimited: bucket.rateLimited, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

/** Collects `request` and `tick` lines one at a time, so a read never holds the lines themselves. */
export class MetricsAccumulator {
  private readonly routes = new Map<string, Bucket>();
  private readonly all = newBucket();
  private lastTick: number | null = null;

  add(entry: LogEntry) {
    const { event, fields } = entry.line;
    if (event === "tick") {
      this.lastTick = Math.max(this.lastTick ?? 0, entry.seconds);
      return;
    }
    if (event !== "request" || !fields) return;

    const { status, ms, route } = fields;
    if (typeof status !== "number" || !Number.isFinite(status)) return;
    const name = typeof route === "string" && route ? route.slice(0, 200) : "unknown";
    let bucket = this.routes.get(name);
    if (!bucket) this.routes.set(name, (bucket = newBucket()));

    for (const target of [bucket, this.all]) {
      target.requests += 1;
      if (status >= 500) target.errors += 1;
      if (status === 429) target.rateLimited += 1;
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) target.ms.push(ms);
    }
  }

  get sawRequests() {
    return this.all.requests > 0;
  }

  /** Milliseconds since the epoch of the newest `tick` line, or null if there was none. */
  get lastTickMs() {
    return this.lastTick;
  }

  /** The request metrics, or null when no line in the window was a request line. */
  requestMetrics(windowMinutes = METRICS_WINDOW_MINUTES): RequestMetrics | null {
    return this.all.requests ? summarizeRequests(this.routes, this.all, windowMinutes) : null;
  }

  /** The same, for an app that is known to write request lines but was quiet in this window. */
  emptyRequestMetrics(windowMinutes = METRICS_WINDOW_MINUTES): RequestMetrics {
    return summarizeRequests(new Map(), newBucket(), windowMinutes);
  }
}

function summarizeRequests(routes: Map<string, Bucket>, all: Bucket, windowMinutes: number): RequestMetrics {
  const kept: RouteStats[] = [];
  const other = newBucket();
  let grouped = 0;
  for (const [route, bucket] of routes) {
    if (bucket.requests >= MIN_ROUTE_REQUESTS) {
      kept.push(describe(route, bucket));
      continue;
    }
    grouped += 1;
    other.requests += bucket.requests;
    other.errors += bucket.errors;
    other.rateLimited += bucket.rateLimited;
    other.ms.push(...bucket.ms);
  }
  kept.sort((a, b) => b.requests - a.requests || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  if (grouped) kept.push(describe(OTHER_ROUTE, other));

  const overall = describe("", all);
  return {
    windowMinutes,
    requests: all.requests,
    perMinute: all.requests / windowMinutes,
    errors: all.errors,
    errorRate: all.requests ? all.errors / all.requests : 0,
    rateLimited: all.rateLimited,
    p50: overall.p50,
    p95: overall.p95,
    routes: kept,
    groupedRoutes: grouped,
  };
}

export type Heartbeat = {
  /** ISO time of the last `tick` line in the window; null when there was none. */
  lastTickAt: string | null;
  ageSeconds: number | null;
  /** Red: no tick in the window, or the last one is older than 3 tick intervals. */
  stale: boolean;
};

/** The worker's heartbeat at `now`, from the time of its last tick line. */
export function heartbeatAt(lastTickMs: number | null, now: number): Heartbeat {
  if (lastTickMs === null) return { lastTickAt: null, ageSeconds: null, stale: true };
  const ageMs = Math.max(0, now - lastTickMs);
  return { lastTickAt: new Date(lastTickMs).toISOString(), ageSeconds: Math.floor(ageMs / 1000), stale: ageMs > HEARTBEAT_RED_INTERVALS * TICK_INTERVAL_MS };
}

/** What one read of one app leaves in the cache. */
export type MetricsSnapshot = {
  /** The read stopped at its time limit, so these numbers cover only part of the window. */
  partial: boolean;
  requests: RequestMetrics | null;
  /** The app writes `tick` lines: it is a worker. */
  worker: { lastTickMs: number | null } | null;
};

/** One app's entry in the API response. */
export type AppLogMetrics =
  | { id: string; ok: true; partial: boolean; requests: RequestMetrics | null; heartbeat: Heartbeat | null }
  | { id: string; ok: false; error: string };

export type MetricsResponse = {
  generatedAt: string;
  windowMinutes: number;
  tickIntervalMs: number;
  apps: AppLogMetrics[];
};
