// Checking and presenting what `/api/logs/metrics` sends back. Pure.
import type { AppLogMetrics, Heartbeat, MetricsResponse, RequestMetrics, RouteStats } from "../metrics";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => (finite(value) ? value : null);

function toRoute(value: unknown): RouteStats | null {
  if (!isRecord(value) || typeof value.route !== "string" || !finite(value.requests)) return null;
  return {
    route: value.route.slice(0, 200),
    requests: value.requests,
    errors: finite(value.errors) ? value.errors : 0,
    rateLimited: finite(value.rateLimited) ? value.rateLimited : 0,
    p50: finiteOrNull(value.p50),
    p95: finiteOrNull(value.p95),
  };
}

function toRequests(value: unknown): RequestMetrics | null {
  if (!isRecord(value) || !finite(value.requests) || !finite(value.perMinute) || !finite(value.errorRate)) return null;
  return {
    windowMinutes: finite(value.windowMinutes) ? value.windowMinutes : 15,
    requests: value.requests,
    perMinute: value.perMinute,
    errors: finite(value.errors) ? value.errors : 0,
    errorRate: value.errorRate,
    rateLimited: finite(value.rateLimited) ? value.rateLimited : 0,
    p50: finiteOrNull(value.p50),
    p95: finiteOrNull(value.p95),
    routes: Array.isArray(value.routes) ? value.routes.map(toRoute).filter((route): route is RouteStats => route !== null) : [],
    groupedRoutes: finite(value.groupedRoutes) ? value.groupedRoutes : 0,
  };
}

function toHeartbeat(value: unknown): Heartbeat | null {
  if (!isRecord(value) || typeof value.stale !== "boolean") return null;
  return { lastTickAt: typeof value.lastTickAt === "string" ? value.lastTickAt : null, ageSeconds: finiteOrNull(value.ageSeconds), stale: value.stale };
}

function toApp(value: unknown): AppLogMetrics | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (value.ok === false) return { id: value.id, ok: false, error: typeof value.error === "string" ? value.error.slice(0, 200) : "Metrics are unavailable" };
  if (value.ok !== true) return null;
  return { id: value.id, ok: true, partial: value.partial === true, requests: toRequests(value.requests), heartbeat: toHeartbeat(value.heartbeat) };
}

/** The body of a successful `GET /api/logs/metrics`, or null if it is not one. */
export function parseMetricsResponse(body: unknown): MetricsResponse | null {
  if (!isRecord(body) || !Array.isArray(body.apps)) return null;
  return {
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : "",
    windowMinutes: finite(body.windowMinutes) ? body.windowMinutes : 15,
    tickIntervalMs: finite(body.tickIntervalMs) ? body.tickIntervalMs : 30_000,
    apps: body.apps.map(toApp).filter((app): app is AppLogMetrics => app !== null),
  };
}

/** What a dashboard card shows for one app. */
export type CardMetrics =
  | { kind: "none" }
  | { kind: "unavailable" }
  | {
      kind: "ok";
      partial: boolean;
      requests: RequestMetrics | null;
      /** The app's own heartbeat (it is a worker), or that of a worker found in another app. */
      heartbeat: { heartbeat: Heartbeat; own: boolean; workerId: string } | null;
      /** An app with requests but no worker anywhere in the apps config. */
      noWorker: boolean;
    };

/**
 * Works out the card of `appId`. `null` means the metrics could not be fetched. An app that writes
 * neither request nor tick lines shows nothing. An app with request lines also shows the heartbeat
 * of the worker found among the other apps, or a hint when there is none.
 */
export function cardMetrics(response: MetricsResponse | null, appId: string): CardMetrics {
  if (!response) return { kind: "unavailable" };
  const app = response.apps.find((candidate) => candidate.id === appId);
  if (!app) return { kind: "none" };
  if (!app.ok) return { kind: "unavailable" };

  if (app.heartbeat) return { kind: "ok", partial: app.partial, requests: app.requests, heartbeat: { heartbeat: app.heartbeat, own: true, workerId: app.id }, noWorker: false };
  if (!app.requests) return { kind: "none" };

  const worker = response.apps.find((candidate) => candidate.id !== appId && candidate.ok && candidate.heartbeat);
  return {
    kind: "ok",
    partial: app.partial,
    requests: app.requests,
    heartbeat: worker && worker.ok && worker.heartbeat ? { heartbeat: worker.heartbeat, own: false, workerId: worker.id } : null,
    noWorker: !worker,
  };
}

export function formatPerMinute(value: number) {
  if (value === 0) return "0";
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** `0.0125` as "1.3%"; "0%" for none, "<0.1%" for a tiny rate. */
export function formatErrorRate(rate: number) {
  if (rate <= 0) return "0%";
  const percent = rate * 100;
  if (percent < 0.1) return "<0.1%";
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function formatLatency(ms: number | null) {
  if (ms === null) return "—";
  if (ms >= 10_000) return `${Math.round(ms / 1000)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatHeartbeatAge(seconds: number | null, windowMinutes = 15) {
  if (seconds === null) return `No tick in ${windowMinutes} min`;
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}
