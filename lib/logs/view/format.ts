// How a log line is shown as a row. Pure; every value comes from untrusted log text, so each
// field is type-checked and bounded before the page renders it (as text, never as HTML).
import { LOG_LEVELS, type LogLine } from "../lines";
import { isValidRequestId } from "./filters";

const pad = (value: number, length = 2) => String(value).padStart(length, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_TEXT = 200;
const MAX_SPANS = 40;

function clip(value: string, max = MAX_TEXT) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Docker timestamps carry nanoseconds; `Date` is only sure about milliseconds. */
function parseTimestamp(ts: string) {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, "$1"));
}

/**
 * The line's time in the viewer's time zone: `09:14:07.512` for today, `Nov 2 09:14:07` for an
 * earlier day.
 */
export function formatTime(ts: string, now = Date.now()) {
  const ms = parseTimestamp(ts);
  if (!Number.isFinite(ms)) return clip(ts, 24);
  const date = new Date(ms);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? `${time}.${pad(date.getMilliseconds(), 3)}` : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

/** A user id (a UUID) shortened to its first block, with an ellipsis. */
export function shortUserId(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  return value.length > 9 ? `${value.slice(0, 8)}…` : value;
}

export type RowSummary = {
  time: string;
  level: LogLine["level"];
  event: string;
  /** App id, shown when rows from several apps are mixed. */
  app: string;
  method?: string;
  route?: string;
  status?: number;
  ms?: number;
  slow: boolean;
  user?: string;
  /** A short text for lines that are not `request` lines. */
  text?: string;
  requestId?: string;
  relatedRequestId?: string;
};

function textOf(line: LogLine) {
  if (line.event === "raw") return typeof line.message === "string" ? clip(line.message) : undefined;
  const fields = line.fields;
  if (!fields) return undefined;
  for (const key of ["message", "error", "errorMessage", "reason"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return clip(value);
  }
  return undefined;
}

export function summarize(line: LogLine, now = Date.now()): RowSummary {
  const fields = line.fields ?? {};
  const isRequest = line.event === "request";
  const status = fields.status;
  const ms = fields.ms;
  return {
    time: formatTime(line.ts, now),
    level: (LOG_LEVELS as readonly string[]).includes(line.level) ? line.level : "info",
    event: clip(line.event, 64),
    app: line.container,
    ...(typeof fields.method === "string" ? { method: clip(fields.method, 10) } : {}),
    ...(isRequest && typeof fields.route === "string" ? { route: clip(fields.route, 120) } : {}),
    ...(isRequest && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
    slow: fields.slow === true,
    ...(shortUserId(fields.userId) ? { user: shortUserId(fields.userId) } : {}),
    ...(isRequest ? {} : { text: textOf(line) }),
    ...(isValidRequestId(line.requestId) ? { requestId: line.requestId } : {}),
    ...(isValidRequestId(fields.relatedRequestId) ? { relatedRequestId: fields.relatedRequestId } : {}),
  };
}

/** The request ids in a line that may become links, without repeats. */
export function linkableRequestIds(line: LogLine): string[] {
  const { requestId, relatedRequestId } = summarize(line);
  return [...new Set([requestId, relatedRequestId].filter((id): id is string => id !== undefined))];
}

export function formatMs(ms: number) {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export type SpanBar = { name: string; ms: number; /** 0 to 1, relative to the slowest span. */ share: number };

/** The `spans` of a request line, slowest first. Anything that is not a `{ name, ms }` pair is skipped. */
export function spanBars(fields: Record<string, unknown> | undefined): SpanBar[] {
  const spans = fields?.spans;
  if (!Array.isArray(spans)) return [];
  const valid: { name: string; ms: number }[] = [];
  for (const span of spans) {
    if (!span || typeof span !== "object") continue;
    const { name, ms } = span as Record<string, unknown>;
    if (typeof name === "string" && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) valid.push({ name: clip(name, 80), ms });
  }
  valid.sort((a, b) => b.ms - a.ms);
  const top = valid.slice(0, MAX_SPANS);
  const max = top[0]?.ms || 1;
  return top.map((span) => ({ ...span, share: span.ms / max }));
}

/** The whole line for the expanded view: the parsed JSON, or the raw text. */
export function prettyLine(line: LogLine) {
  if (line.fields) return JSON.stringify(line.fields, null, 2);
  return line.message ?? "";
}

/** Colour group of an HTTP status, for the status badge. */
export function statusTone(status: number): "ok" | "redirect" | "client" | "server" {
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  if (status >= 300) return "redirect";
  return "ok";
}
