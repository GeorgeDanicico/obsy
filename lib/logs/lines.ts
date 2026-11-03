export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Longest line content kept, in characters. Longer lines are cut and marked `clipped`. */
export const MAX_LINE_CHARS = 16 * 1024;
// Room for Docker's timestamp prefix on top of the content limit.
const MAX_RAW_CHARS = MAX_LINE_CHARS + 64;

export type LogStream = "stdout" | "stderr";

/** One container log line as the API returns it. */
export type LogLine = {
  /** Docker's timestamp for the line (RFC 3339 with nanoseconds). */
  ts: string;
  /** The app id from the apps config, never the raw container name. */
  container: string;
  stream: LogStream;
  level: LogLevel;
  event: string;
  requestId?: string;
  /** The line's text, for lines that are not a JSON object (`event: "raw"`). */
  message?: string;
  /** The whole parsed object, for JSON lines. */
  fields?: Record<string, unknown>;
  /** Set when the line was longer than `MAX_LINE_CHARS` and was cut. */
  clipped?: true;
};

/** A parsed line plus what sorting and filtering need. */
export type LogEntry = {
  line: LogLine;
  /** The line's content without Docker's timestamp, used for `q`. */
  raw: string;
  /** Milliseconds since the epoch of `ts`, whole seconds. */
  seconds: number;
  /** Fraction of the second in nanoseconds. */
  nanos: number;
  /** Arrival order, to keep ties stable. */
  seq: number;
};

export type LogFilter = {
  level?: LogLevel;
  /** Lowercased; matched as a substring of the raw line. */
  q?: string;
  requestId?: string;
  event?: string;
};

const DOCKER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) /;

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function normalizeLevel(value: unknown): LogLevel {
  if (typeof value === "number") {
    // pino-style numeric levels.
    if (value >= 50) return "error";
    if (value >= 40) return "warn";
    if (value >= 30) return "info";
    return "debug";
  }
  if (typeof value !== "string") return "info";
  switch (value.toLowerCase()) {
    case "trace":
    case "debug":
      return "debug";
    case "warn":
    case "warning":
      return "warn";
    case "error":
    case "fatal":
    case "critical":
    case "panic":
      return "error";
    default:
      return "info";
  }
}

/**
 * Splits a stream of text into lines. A line longer than the limit keeps only its start, so one
 * huge line can't hold an unbounded string in memory.
 */
export class LineSplitter {
  private buffer = "";
  private clipped = false;

  constructor(private readonly onLine: (text: string, clipped: boolean) => void, private readonly maxChars = MAX_RAW_CHARS) {}

  push(chunk: string) {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        this.append(chunk.slice(start));
        return;
      }
      this.append(chunk.slice(start, newline));
      this.flush();
      start = newline + 1;
    }
  }

  end() {
    if (this.buffer || this.clipped) this.flush();
  }

  private append(part: string) {
    if (this.clipped || !part) return;
    const room = this.maxChars - this.buffer.length;
    if (part.length > room) {
      this.buffer += part.slice(0, room);
      this.clipped = true;
    } else {
      this.buffer += part;
    }
  }

  private flush() {
    const text = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    const clipped = this.clipped;
    this.buffer = "";
    this.clipped = false;
    if (text) this.onLine(text, clipped);
  }
}

export type DockerLine =
  | { kind: "log"; entry: LogEntry }
  // A line without Docker's timestamp comes from the docker CLI itself (an error message).
  | { kind: "cli"; text: string };

/** Parses one line of `docker logs --timestamps` output. */
export function parseDockerLine(text: string, stream: LogStream, container: string, seq: number, clippedBefore = false): DockerLine {
  const match = DOCKER_TIMESTAMP.exec(text);
  if (!match) return { kind: "cli", text: text.slice(0, 500) };

  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return { kind: "cli", text: text.slice(0, 500) };
  const nanos = match[2] ? Number.parseInt(match[2].padEnd(9, "0"), 10) : 0;

  let raw = text.slice(match[0].length);
  let clipped = clippedBefore;
  if (raw.length > MAX_LINE_CHARS) {
    raw = raw.slice(0, MAX_LINE_CHARS);
    clipped = true;
  }

  const line = parseContent(raw, clipped);
  return {
    kind: "log",
    entry: {
      line: { ts: match[0].slice(0, -1), container, stream, ...line, ...(clipped ? { clipped: true as const } : {}) },
      raw,
      seconds,
      nanos,
      seq,
    },
  };
}

function parseContent(raw: string, clipped: boolean): Pick<LogLine, "level" | "event" | "requestId" | "message" | "fields"> {
  // A clipped JSON line can't parse; it is kept as a raw line.
  if (!clipped && raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>;
        return {
          level: normalizeLevel(fields.level),
          event: typeof fields.event === "string" && fields.event ? fields.event.slice(0, 200) : "json",
          ...(typeof fields.requestId === "string" ? { requestId: fields.requestId } : {}),
          fields,
        };
      }
    } catch {
      // Not JSON after all: kept as a raw line.
    }
  }
  return { level: "info", event: "raw", message: raw };
}

/** Cheap checks on the raw text, so most lines are rejected before `JSON.parse`. */
export function mightMatch(raw: string, filter: LogFilter) {
  if (filter.requestId && !raw.includes(filter.requestId)) return false;
  if (filter.event && filter.event !== "raw" && filter.event !== "json" && !raw.includes(filter.event)) return false;
  if (filter.q && !raw.toLowerCase().includes(filter.q)) return false;
  return true;
}

export function matchesFilter(entry: LogEntry, filter: LogFilter) {
  const { line } = entry;
  if (filter.level && levelRank[line.level] < levelRank[filter.level]) return false;
  if (filter.event && line.event !== filter.event) return false;
  if (filter.requestId) {
    // The browser's report about a failed request carries that request's id as `relatedRequestId`.
    const related = line.fields?.relatedRequestId;
    if (line.requestId !== filter.requestId && related !== filter.requestId) return false;
  }
  if (filter.q && !entry.raw.toLowerCase().includes(filter.q)) return false;
  return true;
}

/** Newest first: by Docker timestamp, then by arrival. */
export function compareNewestFirst(a: LogEntry, b: LogEntry) {
  return b.seconds - a.seconds || b.nanos - a.nanos || b.seq - a.seq;
}

/** Keeps the newest `limit` entries seen, in memory proportional to `limit`. */
export class NewestEntries {
  private entries: LogEntry[] = [];
  matched = 0;

  constructor(private readonly limit: number) {}

  add(entry: LogEntry) {
    this.matched += 1;
    this.entries.push(entry);
    if (this.entries.length >= this.limit + Math.max(50, Math.ceil(this.limit / 4))) this.compact();
  }

  /** The newest `limit` entries, newest first. */
  result() {
    this.compact();
    return this.entries;
  }

  private compact() {
    this.entries.sort(compareNewestFirst);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }
}

/** Merges per-container results into the newest `limit` lines overall, newest first. */
export function mergeNewest(lists: LogEntry[][], limit: number) {
  return lists.flat().sort(compareNewestFirst).slice(0, limit);
}
