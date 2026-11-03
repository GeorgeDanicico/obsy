"use client";

import { useEffect, useState } from "react";
import type { MetricsResponse } from "@/lib/logs/metrics";
import {
  cardMetrics,
  formatErrorRate,
  formatHeartbeatAge,
  formatLatency,
  formatPerMinute,
  parseMetricsResponse,
  type CardMetrics,
} from "@/lib/logs/view/metrics";

/** The server keeps a read for 30 s, so asking more often costs nothing but keeps the heartbeat age fresh. */
const POLL_MS = 15_000;

export type MetricsState = { status: "loading" | "ok" | "error"; response: MetricsResponse | null };

/**
 * Fetches `/api/logs/metrics` (one app with `container`, else every app) now and every 15 seconds.
 * A failure never throws: the state becomes "error" and the caller shows "metrics unavailable".
 */
export function useLogMetrics(container?: string): MetricsState {
  const [state, setState] = useState<MetricsState>({ status: "loading", response: null });

  useEffect(() => {
    let controller: AbortController | undefined;
    let cancelled = false;
    setState({ status: "loading", response: null });

    const load = async () => {
      controller = new AbortController();
      try {
        const query = container ? `?container=${encodeURIComponent(container)}` : "";
        const response = await fetch(`/api/logs/metrics${query}`, { signal: controller.signal, cache: "no-store" });
        const parsed = response.ok ? parseMetricsResponse(await response.json().catch(() => null)) : null;
        if (!cancelled) setState(parsed ? { status: "ok", response: parsed } : { status: "error", response: null });
      } catch {
        if (!cancelled) setState({ status: "error", response: null });
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [container]);

  return state;
}

function Heartbeat({ metrics }: { metrics: Extract<CardMetrics, { kind: "ok" }> }) {
  if (metrics.heartbeat) {
    const { heartbeat } = metrics.heartbeat;
    return <div><span>Worker heartbeat</span><strong className={heartbeat.stale ? "text-bad" : "text-green"} title={heartbeat.lastTickAt ?? undefined}>{formatHeartbeatAge(heartbeat.ageSeconds)}</strong></div>;
  }
  return null;
}

/** The "Requests" block of a container card on the dashboard. Renders nothing for an app with no such lines. */
export function CardLogMetrics({ state, appId }: { state: MetricsState; appId: string }) {
  if (state.status === "loading") return null;
  const metrics = cardMetrics(state.response, appId);
  if (metrics.kind === "none") return null;
  if (metrics.kind === "unavailable") return <div className="log-metrics"><div className="log-metrics-title"><strong>Request metrics</strong></div><p className="log-metrics-hint">Metrics unavailable: Obsy could not read this app&apos;s logs. It tries again shortly.</p></div>;

  const { requests } = metrics;
  return <div className="log-metrics">
    <div className="log-metrics-title"><strong>{requests ? "Requests" : "Worker"}</strong><span>last {requests?.windowMinutes ?? 15} min{metrics.partial ? " · partial" : ""}</span></div>
    <div className="detail-stat-grid log-metrics-grid">
      {requests ? <>
        <div><span>Requests / min</span><strong>{formatPerMinute(requests.perMinute)}</strong></div>
        <div><span>Error rate (5xx)</span><strong className={requests.errors ? "text-bad" : undefined} title={`${requests.errors} of ${requests.requests} requests`}>{formatErrorRate(requests.errorRate)}</strong></div>
        <div><span>p95 latency</span><strong>{formatLatency(requests.p95)}</strong></div>
        <div><span>Rate limited (429)</span><strong>{requests.rateLimited}</strong></div>
      </> : null}
      <Heartbeat metrics={metrics} />
    </div>
    {requests && metrics.noWorker ? <p className="log-metrics-hint">No worker heartbeat: add the worker&apos;s container to the apps config (it is found by its tick lines).</p> : null}
  </div>;
}

/** Per-route request table for the Logs page. */
export function RouteMetrics({ container }: { container: string }) {
  const state = useLogMetrics(container);
  if (state.status === "loading") return null;
  const app = state.response?.apps.find((candidate) => candidate.id === container);

  if (!app || !app.ok) {
    return <section className="panel route-metrics"><div className="panel-heading"><div><h2>Request metrics</h2><p>Metrics unavailable</p></div></div></section>;
  }
  const { requests, heartbeat } = app;
  if (!requests && !heartbeat) return null;

  return <section className="panel route-metrics" aria-label="Request metrics">
    <div className="panel-heading"><div><h2>{requests ? "Request metrics" : "Worker heartbeat"}</h2><p>Last {requests?.windowMinutes ?? 15} minutes{app.partial ? " (the read hit its time limit, so only part of it)" : ""}, from this app&apos;s request lines. Percentiles are nearest-rank.</p></div></div>
    <div className="route-metrics-summary">
      {requests ? <>
        <div><span>Requests / min</span><strong>{formatPerMinute(requests.perMinute)}</strong></div>
        <div><span>Requests</span><strong>{requests.requests.toLocaleString()}</strong></div>
        <div><span>Error rate (5xx)</span><strong className={requests.errors ? "text-bad" : undefined}>{formatErrorRate(requests.errorRate)}</strong></div>
        <div><span>429 responses</span><strong>{requests.rateLimited}</strong></div>
        <div><span>p50</span><strong>{formatLatency(requests.p50)}</strong></div>
        <div><span>p95</span><strong>{formatLatency(requests.p95)}</strong></div>
      </> : null}
      {heartbeat ? <div><span>Heartbeat</span><strong className={heartbeat.stale ? "text-bad" : "text-green"} title={heartbeat.lastTickAt ?? undefined}>{formatHeartbeatAge(heartbeat.ageSeconds)}</strong></div> : null}
    </div>
    {requests && requests.routes.length ? <div className="route-table">
      <div className="route-table-header" aria-hidden="true"><span>Route</span><span>Requests</span><span>p50</span><span>p95</span><span>5xx</span><span>429</span></div>
      {requests.routes.map((route) => <div className="route-table-row" key={route.route}>
        <span className="route-name" title={route.route}>{route.route === "other" ? `other (${requests.groupedRoutes} route${requests.groupedRoutes === 1 ? "" : "s"}, under 5 requests each)` : route.route}</span>
        <span>{route.requests.toLocaleString()}</span><span>{formatLatency(route.p50)}</span><span>{formatLatency(route.p95)}</span>
        <span className={route.errors ? "text-bad" : undefined}>{route.errors}</span><span>{route.rateLimited}</span>
      </div>)}
    </div> : requests ? <div className="logs-note">No requests in the last {requests.windowMinutes} minutes.</div> : null}
  </section>;
}
