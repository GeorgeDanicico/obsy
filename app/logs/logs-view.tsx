"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/app/components/icons";
import { RouteMetrics } from "@/app/components/log-metrics";
import type { LogApp } from "@/lib/logs/view/apps";
import type { Failure } from "@/lib/logs/view/api";
import {
  canGoLive,
  effectiveSince,
  filtersToHref,
  isLive,
  parseFilters,
  readQuery,
  sameFilters,
  SINCE_PRESETS,
  streamQuery,
  validateFilters,
  type LogFilters,
} from "@/lib/logs/view/filters";
import { describeEnd, type Row } from "@/lib/logs/view/tail";
import { LogRow } from "./log-row";
import { useLiveTail, type TailStatus } from "./use-live-tail";
import { useLogsResult } from "./use-logs-result";

const TEXT_DEBOUNCE_MS = 400;
const LEVEL_OPTIONS = [
  { value: "", label: "All levels" },
  { value: "info", label: "Info and up" },
  { value: "warn", label: "Warnings and up" },
  { value: "error", label: "Errors only" },
] as const;

/** The filters as the page URL has them right now. */
function currentFilters() {
  return parseFilters(new URLSearchParams(window.location.search));
}

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function FailureNotice({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  return <div className="error-banner logs-error" role="alert"><Icon name="alert" size={16} /><div><strong>{failure.message}</strong>{failure.errors.length ? <ul>{failure.errors.map((item) => <li key={item.container}>{item.container}: {item.error}</li>)}</ul> : null}</div>{failure.retryable && onRetry ? <button className="outline-button" onClick={onRetry} type="button">Try again</button> : null}</div>;
}

const STATUS_LABELS: Record<TailStatus, string> = {
  off: "Off",
  connecting: "Connecting…",
  live: "Live",
  ended: "Ended",
  dropped: "Disconnected",
  hidden: "Stopped (tab was hidden)",
  failed: "Not connected",
};

export function LogsView({ apps }: { apps: LogApp[] }) {
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const appIds = useMemo(() => apps.map((app) => app.id), [apps]);
  const validation = validateFilters(filters, appIds);

  // The URL is the source of truth for the filters. These are only what is typed in the two
  // text boxes before it is applied.
  const [qDraft, setQDraft] = useState(filters.q);
  const [idDraft, setIdDraft] = useState(filters.requestId);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  /** Changes some filters in the URL. Next's router follows `pushState` and `replaceState`. */
  const update = useCallback((patch: Partial<LogFilters>, how: "push" | "replace" = "push") => {
    const before = currentFilters();
    const after = { ...before, ...patch };
    if (sameFilters(before, after)) return;
    window.history[how === "push" ? "pushState" : "replaceState"](null, "", filtersToHref(after));
  }, []);

  // A bare /logs opens the first app, so the URL always says what is shown.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current) return;
    defaulted.current = true;
    const now = currentFilters();
    if (!now.container && !now.requestId && apps.length && !new URLSearchParams(window.location.search).has("container")) update({ container: apps[0].id }, "replace");
  }, [apps, update]);

  // Typing applies after a pause; a link, back or forward changes the boxes.
  useEffect(() => {
    setQDraft((draft) => (draft.trim() === filters.q ? draft : filters.q));
  }, [filters.q]);
  useEffect(() => {
    setIdDraft((draft) => (draft.trim() === filters.requestId ? draft : filters.requestId));
  }, [filters.requestId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (qDraft.trim() !== currentFilters().q) update({ q: qDraft.trim().slice(0, 100) }, "replace");
    }, TEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qDraft, update]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (idDraft.trim() !== currentFilters().requestId) update({ requestId: idDraft.trim() }, "replace");
    }, TEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [idDraft, update]);

  const live = validation.ok && validation.mode === "app" && isLive(filters);
  const fetchQuery = validation.ok && validation.mode !== "idle" && !live ? readQuery(filters) : null;
  const liveQuery = live ? streamQuery(filters) : null;
  const { state, reload } = useLogsResult(fetchQuery);
  const tail = useLiveTail(liveQuery);

  useEffect(() => {
    setExpanded(new Set());
  }, [fetchQuery, liveQuery]);
  const toggle = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const fetchedRows = useMemo<Row[]>(() => {
    const lines = state.status === "ok" ? state.data.lines : state.status === "loading" ? state.previous?.lines ?? [] : [];
    return lines.map((line, index) => ({ id: index, line }));
  }, [state]);
  const rows = live ? tail.tail.rows : fetchedRows;
  const showApp = !filters.container;
  const allApps = validation.ok && validation.mode === "all";
  const loading = state.status === "loading";

  const appName = apps.find((app) => app.id === filters.container)?.name;
  const since = effectiveSince(filters);
  const customSince = !SINCE_PRESETS.some((preset) => preset.value === since);

  return <>
    <div className="page-heading"><div><p className="eyebrow">Observability</p><h1>Logs</h1><p className="subheading">Search an app&apos;s recent log lines, follow them live, or find one request by its id across every app.</p></div><div className="heading-actions">{live ? <div className={`live-indicator${tail.status === "live" ? "" : " is-idle"}`}>{tail.status === "live" ? <span className="pulse-dot" /> : null}{STATUS_LABELS[tail.status]}</div> : state.status === "ok" ? <div className="last-updated"><span className="pulse-dot" />Fetched {new Date(state.fetchedAt).toLocaleTimeString()}</div> : null}{!live && fetchQuery ? <button className="outline-button" disabled={loading} onClick={reload} type="button"><Icon name="refresh" size={15} />Refresh</button> : null}</div></div>

    <section aria-label="Filters" className="panel logs-filters">
      <div className="logs-filter-row">
        <label className="logs-field"><span>App</span>
          <select onChange={(event) => update({ container: event.target.value, live: event.target.value ? filters.live : false })} value={filters.container}>
            <option value="">All apps (needs a request id)</option>
            {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        </label>
        <label className="logs-field"><span>Level</span>
          <select onChange={(event) => update({ level: event.target.value as LogFilters["level"] })} value={filters.level}>
            {LEVEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <div className="logs-field"><span>Time range</span>
          <div aria-label="Time range" className="process-tabs logs-range" role="group">
            {SINCE_PRESETS.map((preset) => <button aria-pressed={since === preset.value} className={since === preset.value ? "process-tab active" : "process-tab"} disabled={live} key={preset.value} onClick={() => update({ since: preset.value })} type="button">{preset.label}</button>)}
            {customSince ? <button aria-pressed className="process-tab active" disabled title={since} type="button">Custom</button> : null}
          </div>
        </div>
        <button aria-pressed={filters.live} className={filters.live && canGoLive(filters) ? "live-toggle on" : "live-toggle"} disabled={!canGoLive(filters)} onClick={() => update({ live: !filters.live })} title={canGoLive(filters) ? "Follow new lines as they are written" : "Live tail follows one app: pick an app first"} type="button"><span className="live-toggle-dot" />Live</button>
      </div>
      <div className="logs-filter-row">
        <label className="logs-field logs-field-grow"><span>Search text</span>
          <input maxLength={100} onChange={(event) => setQDraft(event.target.value)} placeholder="Any text in the line, e.g. timeout or a route" spellCheck={false} type="search" value={qDraft} />
        </label>
        <label className="logs-field logs-field-id"><span>Request id</span>
          <input aria-invalid={Boolean(idDraft.trim()) && !validation.ok} className="mono" maxLength={64} onChange={(event) => setIdDraft(event.target.value)} placeholder="e.g. 3fK9xQ2mBv0a" spellCheck={false} type="text" value={idDraft} />
        </label>
        {filters.event ? <button className="logs-chip" onClick={() => update({ event: "" })} type="button" title="Remove this filter">event: {filters.event} ×</button> : null}
      </div>
    </section>

    {!validation.ok ? <div className="error-banner logs-error" role="alert"><Icon name="alert" size={16} /><div><strong>{validation.error}</strong></div></div> : null}
    {allApps ? <div className="logs-note">Searching every app{filters.since ? "" : " over the last 3 days"} for this request id. Pick an app to narrow it down.</div> : null}

    {validation.ok && validation.mode === "app" && !live ? <RouteMetrics container={filters.container} /> : null}

    {live ? <LivePanel
      appName={appName ?? filters.container}
      expanded={expanded}
      onToggle={toggle}
      rows={rows}
      showApp={showApp}
      tail={tail}
    /> : <section className="panel logs-panel" aria-busy={loading}>
      <div className="panel-heading logs-panel-heading"><div><h2>{validation.ok && validation.mode === "idle" ? "Nothing to show yet" : allApps ? "Request search" : appName ?? "Log lines"}</h2><p>{state.status === "ok" ? `${plural(state.data.lines.length, "line")}, newest first · ${plural(state.data.scanned, "line")} scanned` : loading ? "Loading…" : "Newest first"}</p></div></div>
      {state.status === "ok" && state.data.truncated ? <div className="logs-note">There are more matching lines than the {plural(state.data.lines.length, "line")} shown (or the read hit its time limit). Narrow the time range or add a filter to see the rest.</div> : null}
      {state.status === "ok" && state.data.errors.length ? <FailureNotice failure={{ status: 200, message: "Some apps could not be read, so this search is incomplete.", errors: state.data.errors, retryable: true }} onRetry={reload} /> : null}
      {state.status === "error" ? <FailureNotice failure={state.failure} onRetry={reload} /> : null}
      {validation.ok && validation.mode === "idle" ? <div className="notice"><div className="notice-icon"><Icon name="logs" size={18} /></div><div><strong>Pick an app, or paste a request id</strong><p>A request id from an error message (the code after “ref”) finds its lines in every app over the last 3 days.</p></div></div> : null}
      {state.status === "ok" && !rows.length ? <div className="notice"><div className="notice-icon"><Icon name="logs" size={18} /></div><div><strong>No lines match</strong><p>{filters.requestId ? "No app wrote a line with that request id in this time range. Logs are kept for 5 days." : "Try a wider time range, a lower level, or clear the search text."}</p></div></div> : null}
      {rows.length ? <RowList expanded={expanded} loading={loading} onToggle={toggle} rows={rows} showApp={showApp} /> : null}
    </section>}
  </>;
}

function LivePanel({ appName, tail, rows, expanded, onToggle, showApp }: { appName: string; tail: ReturnType<typeof useLiveTail>; rows: Row[]; expanded: Set<number>; onToggle: (id: number) => void; showApp: boolean }) {
  const { status, failure } = tail;
  const paused = tail.tail.paused;
  const active = status === "live" || status === "connecting";
  return <section className="panel logs-panel">
    <div className="panel-heading logs-panel-heading"><div><h2>{appName}</h2><p>{status === "live" ? (paused ? `Paused · ${plural(tail.tail.pending.length, "new line")} waiting` : "New lines appear at the top · the newest 1,000 are kept") : STATUS_LABELS[status]}</p></div>
      <div className="logs-live-actions">
        {active ? <button className="outline-button" onClick={paused ? tail.resume : tail.pause} type="button">{paused ? "Resume" : "Pause"}</button> : status === "failed" || status === "dropped" ? null : <button className="outline-button" onClick={tail.reconnect} type="button">Reconnect</button>}
        <button className="outline-button" disabled={!rows.length} onClick={tail.clear} type="button">Clear</button>
      </div>
    </div>
    {status === "failed" && failure ? <FailureNotice failure={failure} onRetry={tail.reconnect} /> : null}
    {status === "dropped" ? <div className="error-banner logs-error" role="alert"><Icon name="alert" size={16} /><div><strong>{failure?.message ?? "The live connection closed unexpectedly."}</strong></div><button className="outline-button" onClick={tail.reconnect} type="button">Reconnect</button></div> : null}
    {status === "ended" ? <div className="logs-note">{describeEnd(tail.tail.ended ?? "unknown")}</div> : null}
    {status === "hidden" ? <div className="logs-note">The live tail stopped because this tab was hidden for over a minute. It reconnects when you come back; lines written in between are not shown (use a time range to see them).</div> : null}
    {status === "live" && !rows.length ? <div className="notice"><div className="notice-icon"><Icon name="logs" size={18} /></div><div><strong>Waiting for new lines…</strong><p>Only lines written after you switched to Live are shown. Switch it off to read the past hour.</p></div></div> : null}
    {rows.length ? <RowList expanded={expanded} loading={false} onToggle={onToggle} rows={rows} showApp={showApp} /> : null}
  </section>;
}

function RowList({ rows, expanded, onToggle, showApp, loading }: { rows: Row[]; expanded: Set<number>; onToggle: (id: number) => void; showApp: boolean; loading: boolean }) {
  return <div className={loading ? "log-table is-loading" : "log-table"}>
    <div className="log-table-header" aria-hidden="true"><div className="log-row-main"><span>Time</span><span>Level</span><span>Event</span><span>Route / detail</span><span>Status</span><span>Duration</span><span>User</span></div><span className="log-ref">Request id</span></div>
    <div role="list">{rows.map((row) => <LogRow expanded={expanded.has(row.id)} key={row.id} onToggle={onToggle} row={row} showApp={showApp} />)}</div>
  </div>;
}
