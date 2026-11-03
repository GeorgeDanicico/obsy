// The Logs page's filter state and how it maps to the page URL and to the logs API.
// Pure: no React, no browser APIs.
import { LOG_LEVELS, type LogLevel } from "../lines";
import { MAX_Q_CHARS, REQUEST_ID } from "../params";

export const SINCE_PRESETS = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "today", label: "Today" },
  { value: "3d", label: "3 days" },
] as const;

export const DEFAULT_SINCE = "1h";
/** What the API uses for a request-id search across apps when `since` is not given. */
export const ALL_APPS_SINCE = "3d";

const SINCE_VALUE = /^(?:\d{1,4}[mhd]|today|\d{4}-\d{2}-\d{2}T[0-9:.]{4,30}(?:Z|[+-]\d{2}:\d{2}))$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const APP_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export type LogFilters = {
  /** An app id, or "" for every app (only allowed with a request id). */
  container: string;
  /** "" means "the default for this search" (see `effectiveSince`). */
  since: string;
  level: LogLevel | "";
  q: string;
  requestId: string;
  event: string;
  live: boolean;
};

export const EMPTY_FILTERS: LogFilters = { container: "", since: "", level: "", q: "", requestId: "", event: "", live: false };

/** Reads filters from a URL query. Anything unusable is dropped rather than rejected. */
export function parseFilters(params: URLSearchParams): LogFilters {
  const container = params.get("container")?.trim() ?? "";
  const since = params.get("since")?.trim() ?? "";
  const level = params.get("level") ?? "";
  const event = params.get("event")?.trim() ?? "";
  return {
    container: APP_ID.test(container) ? container : "",
    since: SINCE_VALUE.test(since) ? since : "",
    // "debug" is the lowest level, so filtering by it keeps every line, the same as no filter.
    level: level !== "debug" && (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : "",
    q: (params.get("q") ?? "").trim().slice(0, MAX_Q_CHARS),
    requestId: (params.get("requestId") ?? "").trim().slice(0, 200),
    event: EVENT_NAME.test(event) ? event : "",
    live: params.get("live") === "1",
  };
}

/** The URL query for a set of filters, leaving out everything that is empty. */
export function filtersToParams(filters: LogFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.container) params.set("container", filters.container);
  if (filters.since) params.set("since", filters.since);
  if (filters.level) params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  if (filters.requestId) params.set("requestId", filters.requestId);
  if (filters.event) params.set("event", filters.event);
  if (filters.live) params.set("live", "1");
  return params;
}

export function filtersToHref(filters: LogFilters) {
  const query = filtersToParams(filters).toString();
  return query ? `/logs?${query}` : "/logs";
}

export function sameFilters(a: LogFilters, b: LogFilters) {
  return filtersToParams(a).toString() === filtersToParams(b).toString();
}

export function effectiveSince(filters: LogFilters) {
  if (filters.since) return filters.since;
  return filters.requestId && !filters.container ? ALL_APPS_SINCE : DEFAULT_SINCE;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export type Validation =
  | { ok: true; mode: "app" | "all" | "idle" }
  | { ok: false; error: string };

/**
 * `app`: one container. `all`: a request-id search across every app. `idle`: nothing to run yet
 * (no app and no request id).
 */
export function validateFilters(filters: LogFilters, appIds: readonly string[]): Validation {
  if (filters.requestId && !isValidRequestId(filters.requestId)) {
    return { ok: false, error: "That is not a request id. Use the 12 characters from an error message's (ref …)." };
  }
  if (filters.container && !appIds.includes(filters.container)) {
    return { ok: false, error: `"${filters.container}" is not one of the configured apps.` };
  }
  if (filters.container) return { ok: true, mode: "app" };
  return { ok: true, mode: filters.requestId ? "all" : "idle" };
}

/** Live tail needs one container; a search across apps cannot be followed. */
export function canGoLive(filters: LogFilters) {
  return filters.container !== "";
}

export function isLive(filters: LogFilters) {
  return filters.live && canGoLive(filters);
}

/** The query string for `GET /api/logs`. */
export function readQuery(filters: LogFilters): string {
  const params = new URLSearchParams();
  if (filters.container) params.set("container", filters.container);
  params.set("since", effectiveSince(filters));
  if (filters.level) params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  if (filters.requestId) params.set("requestId", filters.requestId);
  if (filters.event) params.set("event", filters.event);
  return params.toString();
}

/** The query string for `GET /api/logs/stream` (a tail has no time range). */
export function streamQuery(filters: LogFilters): string {
  const params = new URLSearchParams();
  params.set("container", filters.container);
  if (filters.level) params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  if (filters.requestId) params.set("requestId", filters.requestId);
  if (filters.event) params.set("event", filters.event);
  return params.toString();
}

/** The dashboard's link from a container card. */
export function containerLogsHref(appId: string) {
  return filtersToHref({ ...EMPTY_FILTERS, container: appId, since: "1h" });
}

/**
 * A link that searches every app for one request id. Returns null unless the value matches the
 * API's id pattern, so text from a log line can never become part of a link otherwise.
 */
export function requestSearchHref(id: unknown): string | null {
  return isValidRequestId(id) ? filtersToHref({ ...EMPTY_FILTERS, requestId: id }) : null;
}
