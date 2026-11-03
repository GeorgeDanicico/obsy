import { LOG_LEVELS, type LogFilter, type LogLevel } from "./lines";

/** A container Obsy may read logs from: an app id from the apps config and its container name. */
export type LogSource = { id: string; container: string };

export type ConfiguredApp = { id: string; container: string };

export type ReadQuery = {
  /** One source, or every configured one for a request-id search without `container`. */
  sources: LogSource[];
  /** RFC 3339. */
  since: string;
  /** RFC 3339. */
  until?: string;
  filter: LogFilter;
  limit: number;
};

export type TailQuery = { source: LogSource; filter: LogFilter };

export type ParseResult<T> = { ok: true; query: T } | { ok: false; error: string };

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 2000;
export const MAX_Q_CHARS = 100;
export const DEFAULT_SINCE = "1h";
/** A request-id search looks this far back unless `since` says otherwise. */
export const REQUEST_ID_SINCE = "3d";
/** Nothing older is read (the VPS keeps 5 days of logs). */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Docker's own rule for container names, so a config value can never be read as a flag.
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const APP_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT = /^[A-Za-z0-9_.:-]{1,64}$/;
const RELATIVE = /^(\d{1,4})([mhd])$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function isValidContainerName(name: unknown): name is string {
  return typeof name === "string" && CONTAINER_NAME.test(name);
}

/** The allowlist: configured apps with a usable id and container name, one entry per container. */
export function logSources(apps: ConfiguredApp[]): LogSource[] {
  const seenIds = new Set<string>();
  const seenContainers = new Set<string>();
  const sources: LogSource[] = [];
  for (const app of apps) {
    if (!app || typeof app.id !== "string" || !APP_ID.test(app.id) || !isValidContainerName(app.container)) continue;
    if (seenIds.has(app.id) || seenContainers.has(app.container)) continue;
    seenIds.add(app.id);
    seenContainers.add(app.container);
    sources.push({ id: app.id, container: app.container });
  }
  return sources;
}

export function toRfc3339(ms: number) {
  return new Date(ms).toISOString();
}

/** Parses `since`: `15m`, `1h`, `3d`, `today` (local midnight of the Obsy process) or an ISO time. */
export function parseSince(value: string, now: number): ParseResult<number> {
  const relative = RELATIVE.exec(value);
  let ms: number;
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    if (amount <= 0) return { ok: false, error: "since must be a positive duration" };
    ms = now - amount * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
  } else if (value === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    ms = midnight.getTime();
  } else {
    const parsed = parseIsoTime(value);
    if (parsed === null) return { ok: false, error: "since must be like 15m, 1h, 3d, today, or an ISO time with a time zone" };
    ms = parsed;
  }
  if (ms < now - MAX_LOOKBACK_MS) return { ok: false, error: "since can be at most 7 days ago" };
  if (ms > now) return { ok: false, error: "since is in the future" };
  return { ok: true, query: ms };
}

export function parseIsoTime(value: string) {
  if (!ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseFilter(params: URLSearchParams): ParseResult<LogFilter> {
  const filter: LogFilter = {};

  const level = params.get("level");
  if (level !== null && level !== "") {
    if (!(LOG_LEVELS as readonly string[]).includes(level)) return { ok: false, error: "level must be debug, info, warn or error" };
    filter.level = level as LogLevel;
  }

  const q = params.get("q")?.trim();
  if (q) {
    if (q.length > MAX_Q_CHARS) return { ok: false, error: `q can be at most ${MAX_Q_CHARS} characters` };
    filter.q = q.toLowerCase();
  }

  const requestId = params.get("requestId")?.trim();
  if (requestId) {
    if (!REQUEST_ID.test(requestId)) return { ok: false, error: "requestId is not a valid request id" };
    filter.requestId = requestId;
  }

  const event = params.get("event")?.trim();
  if (event) {
    if (!EVENT.test(event)) return { ok: false, error: "event is not a valid event name" };
    filter.event = event;
  }

  return { ok: true, query: filter };
}

function findSource(params: URLSearchParams, sources: LogSource[]): ParseResult<LogSource | null> {
  const id = params.get("container");
  if (id === null || id === "") return { ok: true, query: null };
  const source = APP_ID.test(id) ? sources.find((candidate) => candidate.id === id) : undefined;
  if (!source) return { ok: false, error: "container must be the id of a configured app" };
  return { ok: true, query: source };
}

export function parseReadQuery(params: URLSearchParams, apps: ConfiguredApp[], now: number): ParseResult<ReadQuery> {
  const allowed = logSources(apps);
  const source = findSource(params, allowed);
  if (!source.ok) return source;
  const filter = parseFilter(params);
  if (!filter.ok) return filter;

  let sources: LogSource[];
  if (source.query) {
    sources = [source.query];
  } else if (filter.query.requestId) {
    sources = allowed;
    if (!sources.length) return { ok: false, error: "no apps are configured" };
  } else {
    return { ok: false, error: "container is required unless searching by requestId" };
  }

  const sinceValue = params.get("since") || (filter.query.requestId ? REQUEST_ID_SINCE : DEFAULT_SINCE);
  const since = parseSince(sinceValue, now);
  if (!since.ok) return since;

  let until: number | undefined;
  const untilValue = params.get("until");
  if (untilValue) {
    const parsed = parseIsoTime(untilValue);
    if (parsed === null) return { ok: false, error: "until must be an ISO time with a time zone" };
    if (parsed <= since.query) return { ok: false, error: "until must be after since" };
    until = parsed;
  }

  let limit = DEFAULT_LIMIT;
  const limitValue = params.get("limit");
  if (limitValue !== null && limitValue !== "") {
    if (!/^\d{1,5}$/.test(limitValue)) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
    limit = Number.parseInt(limitValue, 10);
    if (limit < 1 || limit > MAX_LIMIT) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
  }

  return {
    ok: true,
    query: {
      sources,
      since: toRfc3339(since.query),
      ...(until !== undefined ? { until: toRfc3339(until) } : {}),
      filter: filter.query,
      limit,
    },
  };
}

export function parseTailQuery(params: URLSearchParams, apps: ConfiguredApp[]): ParseResult<TailQuery> {
  const source = findSource(params, logSources(apps));
  if (!source.ok) return source;
  if (!source.query) return { ok: false, error: "container is required" };
  const filter = parseFilter(params);
  if (!filter.ok) return filter;
  return { ok: true, query: { source: source.query, filter: filter.query } };
}
