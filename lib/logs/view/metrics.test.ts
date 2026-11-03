import { describe, expect, it } from "vitest";
import type { AppLogMetrics, MetricsResponse, RequestMetrics } from "../metrics";
import { cardMetrics, formatErrorRate, formatHeartbeatAge, formatLatency, formatPerMinute, parseMetricsResponse } from "./metrics";

const requests: RequestMetrics = { windowMinutes: 15, requests: 30, perMinute: 2, errors: 1, errorRate: 1 / 30, rateLimited: 0, p50: 40, p95: 300, routes: [], groupedRoutes: 0 };
const web: AppLogMetrics = { id: "web", ok: true, partial: false, requests, heartbeat: null };
const worker: AppLogMetrics = { id: "worker", ok: true, partial: false, requests: null, heartbeat: { lastTickAt: "2026-11-03T11:59:30.000Z", ageSeconds: 30, stale: false } };
const db: AppLogMetrics = { id: "db", ok: true, partial: false, requests: null, heartbeat: null };
const response = (...apps: AppLogMetrics[]): MetricsResponse => ({ generatedAt: "2026-11-03T12:00:00.000Z", windowMinutes: 15, tickIntervalMs: 30_000, apps });

describe("cardMetrics", () => {
  it("shows the requests and the heartbeat of the worker found among the other apps", () => {
    expect(cardMetrics(response(web, worker, db), "web")).toEqual({ kind: "ok", partial: false, requests, heartbeat: { heartbeat: worker.ok && worker.heartbeat, own: false, workerId: "worker" }, noWorker: false });
  });

  it("hints at the missing worker instead of failing", () => {
    expect(cardMetrics(response(web, db), "web")).toMatchObject({ kind: "ok", heartbeat: null, noWorker: true });
  });

  it("shows a worker's own heartbeat on its own card", () => {
    expect(cardMetrics(response(web, worker), "worker")).toMatchObject({ kind: "ok", requests: null, heartbeat: { own: true, workerId: "worker" }, noWorker: false });
  });

  it("shows nothing for an app with neither request nor tick lines", () => {
    expect(cardMetrics(response(web, worker, db), "db")).toEqual({ kind: "none" });
    expect(cardMetrics(response(web), "missing")).toEqual({ kind: "none" });
  });

  it("says unavailable when the fetch or that app's read failed", () => {
    expect(cardMetrics(null, "web")).toEqual({ kind: "unavailable" });
    expect(cardMetrics(response({ id: "web", ok: false, error: "Docker is not available" }), "web")).toEqual({ kind: "unavailable" });
  });

  it("does not take the heartbeat of a worker that could not be read", () => {
    expect(cardMetrics(response(web, { id: "worker", ok: false, error: "x" }), "web")).toMatchObject({ kind: "ok", heartbeat: null, noWorker: true });
  });
});

describe("parseMetricsResponse", () => {
  it("round-trips a good body and drops malformed apps", () => {
    const body = { ...response(web, worker), apps: [web, worker, { id: "x" }, 5, { id: "bad", ok: false }] };
    const parsed = parseMetricsResponse(JSON.parse(JSON.stringify(body)))!;
    expect(parsed.apps.map((app) => app.id)).toEqual(["web", "worker", "bad"]);
    expect(parsed.apps[0]).toEqual(web);
    expect(parsed.apps[2]).toEqual({ id: "bad", ok: false, error: "Metrics are unavailable" });
  });

  it("refuses what is not a metrics body", () => {
    expect(parseMetricsResponse(null)).toBeNull();
    expect(parseMetricsResponse({ error: "no" })).toBeNull();
    expect(parseMetricsResponse({ apps: "x" })).toBeNull();
  });

  it("ignores a requests object without numbers", () => {
    const parsed = parseMetricsResponse({ apps: [{ id: "a", ok: true, requests: { requests: "many" }, heartbeat: { stale: "yes" } }] })!;
    expect(parsed.apps[0]).toEqual({ id: "a", ok: true, partial: false, requests: null, heartbeat: null });
  });
});

describe("formatting", () => {
  it("formats rates, latencies and ages", () => {
    expect(formatPerMinute(0)).toBe("0");
    expect(formatPerMinute(0.667)).toBe("0.7");
    expect(formatPerMinute(12.4)).toBe("12");
    expect(formatErrorRate(0)).toBe("0%");
    expect(formatErrorRate(0.0004)).toBe("<0.1%");
    expect(formatErrorRate(1 / 30)).toBe("3.3%");
    expect(formatErrorRate(0.25)).toBe("25%");
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(42.4)).toBe("42 ms");
    expect(formatLatency(1250)).toBe("1.3 s");
    expect(formatLatency(12_400)).toBe("12 s");
    expect(formatHeartbeatAge(12)).toBe("12s ago");
    expect(formatHeartbeatAge(125)).toBe("2m 5s ago");
    expect(formatHeartbeatAge(null)).toBe("No tick in 15 min");
  });
});
