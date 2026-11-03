// Checking what the logs API sends back before the page uses it. Pure.
import { LOG_LEVELS, type LogLine } from "../lines";

export type AppError = { container: string; error: string };

export type LogsResult = {
  lines: LogLine[];
  truncated: boolean;
  scanned: number;
  errors: AppError[];
};

/** A log line from the API (or one stream message), or null if it does not have the right shape. */
export function toLogLine(value: unknown): LogLine | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (typeof line.ts !== "string" || typeof line.container !== "string" || typeof line.event !== "string") return null;
  if (line.stream !== "stdout" && line.stream !== "stderr") return null;
  if (typeof line.level !== "string" || !(LOG_LEVELS as readonly string[]).includes(line.level)) return null;
  const fields = line.fields;
  return {
    ts: line.ts,
    container: line.container,
    stream: line.stream,
    level: line.level as LogLine["level"],
    event: line.event,
    ...(typeof line.requestId === "string" ? { requestId: line.requestId } : {}),
    ...(typeof line.message === "string" ? { message: line.message } : {}),
    ...(fields && typeof fields === "object" && !Array.isArray(fields) ? { fields: fields as Record<string, unknown> } : {}),
    ...(line.clipped === true ? { clipped: true as const } : {}),
  };
}

export function parseLogLine(data: string): LogLine | null {
  try {
    return toLogLine(JSON.parse(data));
  } catch {
    return null;
  }
}

function toAppErrors(value: unknown): AppError[] {
  if (!Array.isArray(value)) return [];
  const errors: AppError[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { container, error } = item as Record<string, unknown>;
    if (typeof container === "string" && typeof error === "string") errors.push({ container: container.slice(0, 64), error: error.slice(0, 300) });
  }
  return errors;
}

/** The body of a successful `GET /api/logs`, or null if it is not one. */
export function parseLogsResult(body: unknown): LogsResult | null {
  if (!body || typeof body !== "object") return null;
  const { lines, truncated, scanned, errors } = body as Record<string, unknown>;
  if (!Array.isArray(lines)) return null;
  return {
    lines: lines.map(toLogLine).filter((line): line is LogLine => line !== null),
    truncated: truncated === true,
    scanned: typeof scanned === "number" && Number.isFinite(scanned) ? scanned : 0,
    errors: toAppErrors(errors),
  };
}

export type Failure = {
  status: number;
  message: string;
  /** Seconds the server asked the client to wait (429). */
  retryAfter?: number;
  /** Apps a search across apps could not read (503 with `errors`). */
  errors: AppError[];
  /** Worth offering a retry button: the cause may be temporary. */
  retryable: boolean;
};

function parseRetryAfter(value: string | null | undefined) {
  if (!value || !/^\d{1,4}$/.test(value)) return undefined;
  const seconds = Number.parseInt(value, 10);
  return seconds > 0 ? seconds : undefined;
}

/** A readable message for an error response of `/api/logs` or `/api/logs/stream`. */
export function describeFailure(status: number, body: unknown, retryAfterHeader?: string | null): Failure {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const serverMessage = typeof record.error === "string" && record.error ? record.error.slice(0, 300) : undefined;
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const errors = toAppErrors(record.errors);

  if (status === 429) {
    const hint = retryAfter ? `Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.` : "Try again in a moment.";
    return { status, message: `${serverMessage ?? "Too many requests."} ${hint}`, retryAfter, errors, retryable: true };
  }
  if (status === 503) {
    return { status, message: serverMessage ?? "Logs are temporarily unavailable.", retryAfter, errors, retryable: true };
  }
  if (status === 404) return { status, message: serverMessage ?? "Container not found.", errors, retryable: false };
  if (status === 400) return { status, message: serverMessage ?? "The server did not accept these filters.", errors, retryable: false };
  return { status, message: serverMessage ?? `The request failed (HTTP ${status}).`, errors, retryable: status >= 500 };
}
