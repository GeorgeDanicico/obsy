import { describe, expect, it } from "vitest";
import { parseDockerLine } from "./lines";
import { heartbeatAt, HEARTBEAT_RED_INTERVALS, MetricsAccumulator, MIN_ROUTE_REQUESTS, percentile, TICK_INTERVAL_MS } from "./metrics";

let seq = 0;
function entry(content: Record<string, unknown>, ts = "2026-11-03T11:50:00Z") {
  const parsed = parseDockerLine(`${ts} ${JSON.stringify(content)}`, "stdout", "app", (seq += 1));
  if (parsed.kind !== "log") throw new Error("not a log line");
  return parsed.entry;
}

const request = (route: string, status: number, ms?: number) => entry({ level: "info", event: "request", route, status, ...(ms === undefined ? {} : { ms }) });

function collect(lines: ReturnType<typeof entry>[]) {
  const acc = new MetricsAccumulator();
  for (const line of lines) acc.add(line);
  return acc;
}

describe("percentile (nearest rank)", () => {
  // Hand computed: rank = ceil(p/100 * n), value = sorted[rank - 1].
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("takes the value at rank ceil(p/100 * n)", () => {
    expect(percentile(ten, 50)).toBe(5); // ceil(5.0) = 5
    expect(percentile(ten, 95)).toBe(10); // ceil(9.5) = 10
    expect(percentile(ten, 90)).toBe(9); // ceil(9.0) = 9
    expect(percentile(ten, 10)).toBe(1); // ceil(1.0) = 1
  });

  it("is always a measured value, never an average of two", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20); // ceil(2) = 2, not 25
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30); // ceil(2.5) = 3
  });

  it("handles one value, a 100-value set and an empty one", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("request metrics", () => {
  it("computes the rate, error rate, 429 count and percentiles over a hand-counted set", () => {
    // /a: 10 requests, ms 10..100, one 500 and one 429. /b: 5 requests, ms 100,200,300,400,500, one 503.
    const lines = [
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, index) => request("/api/a", index === 3 ? 500 : index === 6 ? 429 : 200, ms)),
      ...[100, 200, 300, 400, 500].map((ms, index) => request("/api/b", index === 4 ? 503 : 200, ms)),
    ];
    const metrics = collect(lines).requestMetrics(15)!;

    expect(metrics.requests).toBe(15);
    expect(metrics.perMinute).toBe(1); // 15 requests / 15 minutes
    expect(metrics.errors).toBe(2);
    expect(metrics.errorRate).toBeCloseTo(2 / 15);
    expect(metrics.rateLimited).toBe(1);
    // Sorted ms of all 15: 10 20 30 40 50 60 70 80 90 100 100 200 300 400 500. p50 = rank 8 = 80, p95 = rank 15 = 500.
    expect(metrics.p50).toBe(80);
    expect(metrics.p95).toBe(500);

    expect(metrics.routes).toEqual([
      { route: "/api/a", requests: 10, errors: 1, rateLimited: 1, p50: 50, p95: 100 },
      { route: "/api/b", requests: 5, errors: 1, rateLimited: 0, p50: 300, p95: 500 },
    ]);
    expect(metrics.groupedRoutes).toBe(0);
  });

  it("groups routes with fewer than 5 requests into \"other\", last", () => {
    expect(MIN_ROUTE_REQUESTS).toBe(5);
    const lines = [
      ...Array.from({ length: 4 }, (_, index) => request("/api/small-1", 200, 10 * (index + 1))), // 4 requests: grouped
      ...Array.from({ length: 2 }, () => request("/api/small-2", 429, 1000)), // 2: grouped
      request("/api/small-3", 500, 5), // 1: grouped
      ...Array.from({ length: 5 }, (_, index) => request("/api/exactly-five", 200, index + 1)), // 5: kept
      ...Array.from({ length: 6 }, () => request("/api/busy", 200, 2)),
    ];
    const metrics = collect(lines).requestMetrics(15)!;

    expect(metrics.routes.map((route) => route.route)).toEqual(["/api/busy", "/api/exactly-five", "other"]);
    expect(metrics.groupedRoutes).toBe(3);
    // other pools 4 + 2 + 1 = 7 requests; ms sorted: 5 10 20 30 40 1000 1000. p50 = rank 4 = 30, p95 = rank 7 = 1000.
    expect(metrics.routes[2]).toEqual({ route: "other", requests: 7, errors: 1, rateLimited: 2, p50: 30, p95: 1000 });
    expect(metrics.requests).toBe(18);
  });

  it("has no \"other\" row when nothing is grouped", () => {
    const metrics = collect(Array.from({ length: 5 }, () => request("/api/a", 200, 5))).requestMetrics(15)!;
    expect(metrics.routes.map((route) => route.route)).toEqual(["/api/a"]);
  });

  it("counts only status 500 and above as errors, and 429 separately", () => {
    const metrics = collect([request("/x", 200, 1), request("/x", 404, 1), request("/x", 429, 1), request("/x", 499, 1), request("/x", 500, 1), request("/x", 599, 1)]).requestMetrics(15)!;
    expect(metrics.errors).toBe(2);
    expect(metrics.rateLimited).toBe(1);
    expect(metrics.errorRate).toBeCloseTo(2 / 6);
  });

  it("counts a request without a usable ms but leaves it out of the percentiles", () => {
    const metrics = collect([request("/x", 200, 10), request("/x", 200), entry({ event: "request", route: "/x", status: 200, ms: "fast" }), request("/x", 200, 30)]).requestMetrics(15)!;
    expect(metrics.requests).toBe(4);
    expect(metrics.p50).toBe(10); // ms values 10, 30: rank ceil(1) = 1
    expect(metrics.p95).toBe(30);
  });

  it("ignores lines that are not request lines or have no numeric status", () => {
    const acc = collect([entry({ event: "tick", ms: 5 }), entry({ event: "client_error" }), entry({ event: "request", route: "/x" }), entry({ event: "request", route: "/x", status: "200" })]);
    expect(acc.sawRequests).toBe(false);
    expect(acc.requestMetrics(15)).toBeNull();
  });

  it("puts a request without a route under \"unknown\"", () => {
    const metrics = collect(Array.from({ length: 5 }, () => entry({ event: "request", status: 200, ms: 1 }))).requestMetrics(15)!;
    expect(metrics.routes[0].route).toBe("unknown");
  });

  it("gives zeros for an app that is known to write request lines but was quiet", () => {
    const metrics = new MetricsAccumulator().emptyRequestMetrics(15);
    expect(metrics).toMatchObject({ requests: 0, perMinute: 0, errorRate: 0, rateLimited: 0, p50: null, p95: null, routes: [] });
  });
});

describe("worker heartbeat", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");

  it("takes the newest tick line", () => {
    const acc = collect([entry({ event: "tick" }, "2026-11-03T11:59:00Z"), entry({ event: "tick" }, "2026-11-03T11:59:30Z"), entry({ event: "tick" }, "2026-11-03T11:58:00Z"), entry({ event: "tick_failed" }, "2026-11-03T11:59:50Z")]);
    expect(acc.lastTickMs).toBe(Date.parse("2026-11-03T11:59:30Z"));
  });

  it("is null without a tick line", () => {
    expect(collect([request("/x", 200, 1)]).lastTickMs).toBeNull();
  });

  it("reports the age in seconds", () => {
    expect(heartbeatAt(now - 12_500, now)).toEqual({ lastTickAt: "2026-11-03T11:59:47.500Z", ageSeconds: 12, stale: false });
  });

  it("is red only past 3 tick intervals", () => {
    expect(TICK_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_RED_INTERVALS).toBe(3);
    expect(heartbeatAt(now - 89_000, now).stale).toBe(false);
    expect(heartbeatAt(now - 90_000, now).stale).toBe(false); // exactly 3 intervals is still fine
    expect(heartbeatAt(now - 91_000, now).stale).toBe(true);
  });

  it("is red when there was no tick in the window, and never negative", () => {
    expect(heartbeatAt(null, now)).toEqual({ lastTickAt: null, ageSeconds: null, stale: true });
    expect(heartbeatAt(now + 5000, now).ageSeconds).toBe(0);
  });
});
