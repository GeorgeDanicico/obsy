import { buildFollowArgs, buildReadArgs, defaultSpawn, startDockerLogs, stopProcess, type LogsProcess, type SpawnLogs } from "./docker";
import { createLimiter, type Limiter } from "./limits";
import {
  LineSplitter,
  matchesFilter,
  mergeNewest,
  mightMatch,
  NewestEntries,
  parseDockerLine,
  type LogEntry,
  type LogFilter,
  type LogLine,
  type LogStream,
} from "./lines";
import { readConfiguredApps } from "../metrics";
import { parseReadQuery, parseTailQuery, type ConfiguredApp, type LogSource } from "./params";

export type LogsResponse = {
  /** Newest first. */
  lines: LogLine[];
  /** More lines matched than `limit`, or a read stopped early (timeout). */
  truncated: boolean;
  /** Lines read from Docker before filtering. */
  scanned: number;
  /** Only for a search across containers: the containers that could not be read. */
  errors?: { container: string; error: string }[];
};

export type LogServiceOptions = {
  spawn?: SpawnLogs;
  readApps?: () => Promise<ConfiguredApp[]>;
  now?: () => number;
  /** Concurrent non-streaming `docker logs` reads. */
  maxReads?: number;
  /** Reads that may wait for a slot, and for how long. */
  maxQueuedReads?: number;
  readQueueWaitMs?: number;
  readTimeoutMs?: number;
  /** Concurrent live tails, across all clients. */
  maxTails?: number;
  tailMaxMs?: number;
  heartbeatMs?: number;
};

type ReadOutcome =
  | { ok: true; entries: LogEntry[]; truncated: boolean; scanned: number }
  | { ok: false; status: 404 | 503; error: string };

class BusyError extends Error {}

const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };

function jsonError(status: number, error: string, extra?: Record<string, string>) {
  return Response.json({ error }, { status, headers: { ...jsonHeaders, ...extra } });
}

function methodNotAllowed() {
  return jsonError(405, "Only GET is supported", { Allow: "GET" });
}

function notFound(cliMessages: string[]) {
  return cliMessages.some((message) => /no such container/i.test(message));
}

function cliDetail(cliMessages: string[]) {
  return cliMessages.join(" ").slice(0, 300) || "docker logs failed";
}

/**
 * Feeds a `docker logs` process's stdout and stderr through line splitting and parsing.
 * Lines without Docker's timestamp are the CLI's own messages and go to `onCli`.
 */
function readLines(child: LogsProcess, source: LogSource, nextSeq: () => number, onEntry: (entry: LogEntry) => void, onCli: (text: string) => void) {
  const attach = (stream: LogStream) => {
    const readable = child[stream];
    if (!readable) return;
    readable.setEncoding("utf8");
    const splitter = new LineSplitter((text, clipped) => {
      const parsed = parseDockerLine(text, stream, source.id, nextSeq(), clipped);
      if (parsed.kind === "cli") {
        onCli(parsed.text);
        return;
      }
      onEntry(parsed.entry);
    });
    readable.on("data", (chunk: string) => splitter.push(chunk));
    readable.on("end", () => splitter.end());
  };
  attach("stdout");
  attach("stderr");
}

export function createLogService(options: LogServiceOptions = {}) {
  const spawn = options.spawn ?? defaultSpawn;
  const readApps = options.readApps ?? readConfiguredApps;
  const now = options.now ?? Date.now;
  const readTimeoutMs = options.readTimeoutMs ?? 10_000;
  const tailMaxMs = options.tailMaxMs ?? 15 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const reads: Limiter = createLimiter({ max: options.maxReads ?? 2, maxQueue: options.maxQueuedReads ?? 8, maxWaitMs: options.readQueueWaitMs ?? 15_000 });
  const tails: Limiter = createLimiter({ max: options.maxTails ?? 3 });
  let seq = 0;
  const nextSeq = () => (seq += 1);

  async function readSource(source: LogSource, since: string, until: string | undefined, filter: LogFilter, limit: number, signal?: AbortSignal): Promise<ReadOutcome> {
    const release = await reads.acquire(signal);
    if (!release) throw new BusyError();

    try {
      const child = startDockerLogs(spawn, buildReadArgs(source.container, since, until));
      return await new Promise<ReadOutcome>((resolve) => {
        const newest = new NewestEntries(limit);
        const cliMessages: string[] = [];
        let scanned = 0;
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          stopProcess(child);
        }, readTimeoutMs);
        const onAbort = () => stopProcess(child);
        signal?.addEventListener("abort", onAbort, { once: true });

        const finish = (outcome: ReadOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          stopProcess(child);
          resolve(outcome);
        };

        readLines(
          child,
          source,
          nextSeq,
          (entry) => {
            scanned += 1;
            // `raw` is only needed for matching; dropping it halves what a kept JSON line holds.
            if (mightMatch(entry.raw, filter) && matchesFilter(entry, filter)) newest.add({ ...entry, raw: "" });
          },
          (text) => {
            if (cliMessages.length < 5) cliMessages.push(text);
          },
        );

        child.on("error", () => finish({ ok: false, status: 503, error: "Docker is not available" }));
        child.on("close", (code) => {
          if (code !== 0 && !timedOut && !signal?.aborted) {
            finish(notFound(cliMessages)
              ? { ok: false, status: 404, error: "Container not found" }
              : { ok: false, status: 503, error: cliDetail(cliMessages) });
            return;
          }
          const entries = newest.result();
          finish({ ok: true, entries, truncated: timedOut || newest.matched > limit, scanned });
        });
      });
    } finally {
      release();
    }
  }

  /** `GET /api/logs` */
  async function handleRead(request: Request): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed();
    const params = new URL(request.url).searchParams;
    const parsed = parseReadQuery(params, await readApps(), now());
    if (!parsed.ok) return jsonError(400, parsed.error);
    const { sources, since, until, filter, limit } = parsed.query;

    let outcomes: ReadOutcome[];
    try {
      outcomes = await Promise.all(sources.map((source) => readSource(source, since, until, filter, limit, request.signal)));
    } catch (error) {
      if (error instanceof BusyError) return jsonError(429, "Too many log reads at once; try again in a moment", { "Retry-After": "2" });
      return jsonError(503, "Logs are temporarily unavailable");
    }

    if (sources.length === 1) {
      const outcome = outcomes[0];
      if (!outcome.ok) return jsonError(outcome.status, outcome.error);
      const body: LogsResponse = { lines: outcome.entries.map((entry) => entry.line), truncated: outcome.truncated, scanned: outcome.scanned };
      return Response.json(body, { headers: jsonHeaders });
    }

    // A search across containers: one missing container doesn't fail the search.
    const errors: { container: string; error: string }[] = [];
    const lists: LogEntry[][] = [];
    let truncated = false;
    let scanned = 0;
    let matched = 0;
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok) {
        errors.push({ container: sources[index].id, error: outcome.error });
        return;
      }
      lists.push(outcome.entries);
      truncated ||= outcome.truncated;
      scanned += outcome.scanned;
      matched += outcome.entries.length;
    });
    if (!lists.length) return Response.json({ error: "No container could be read", errors }, { status: 503, headers: jsonHeaders });

    const body: LogsResponse = {
      lines: mergeNewest(lists, limit).map((entry) => entry.line),
      truncated: truncated || matched > limit,
      scanned,
      ...(errors.length ? { errors } : {}),
    };
    return Response.json(body, { headers: jsonHeaders });
  }

  /** `GET /api/logs/stream`: Server-Sent Events from `docker logs --follow`. */
  async function handleStream(request: Request): Promise<Response> {
    // Next answers HEAD with the GET handler and drops the body without cancelling it, which
    // would hold a tail open; HEAD is refused before anything starts.
    if (request.method !== "GET") return methodNotAllowed();
    const params = new URL(request.url).searchParams;
    const parsed = parseTailQuery(params, await readApps());
    if (!parsed.ok) return jsonError(400, parsed.error);
    const { source, filter } = parsed.query;

    const release = await tails.acquire();
    if (!release) return jsonError(429, "Too many live tails are open; close one and try again", { "Retry-After": "10" });
    if (request.signal.aborted) {
      release();
      return jsonError(499, "Client closed the request");
    }

    let child: LogsProcess;
    try {
      child = startDockerLogs(spawn, buildFollowArgs(source.container));
    } catch {
      release();
      return jsonError(503, "Logs are temporarily unavailable");
    }

    const encoder = new TextEncoder();
    const cliMessages: string[] = [];
    let stopped = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

    const pause = () => {
      child.stdout?.pause();
      child.stderr?.pause();
    };
    const resume = () => {
      child.stdout?.resume();
      child.stderr?.resume();
    };

    const send = (text: string) => {
      if (stopped || !controllerRef) return;
      try {
        controllerRef.enqueue(encoder.encode(text));
        // Backpressure: a slow client pauses the docker process instead of growing a queue.
        if ((controllerRef.desiredSize ?? 1) <= 0) pause();
      } catch {
        stop(null);
      }
    };

    /** Ends the tail once: timers, the docker process, the slot, and the stream. */
    const stop = (reason: string | null) => {
      if (stopped) return;
      if (reason) send(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(maxTimer);
      request.signal.removeEventListener("abort", onAbort);
      stopProcess(child);
      resume();
      release();
      try {
        controllerRef?.close();
      } catch {
        // Already closed or cancelled by the client.
      }
    };
    const onAbort = () => stop(null);

    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controllerRef = controller;
          request.signal.addEventListener("abort", onAbort, { once: true });
          child.on("error", () => stop("failed"));
          child.on("close", () => stop(notFound(cliMessages) ? "not_found" : "exited"));
          readLines(
            child,
            source,
            nextSeq,
            (entry) => {
              if (mightMatch(entry.raw, filter) && matchesFilter(entry, filter)) send(`data: ${JSON.stringify(entry.line)}\n\n`);
            },
            (text) => {
              if (cliMessages.length < 5) cliMessages.push(text);
            },
          );
          send(": connected\n\n");
          heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
          maxTimer = setTimeout(() => stop("timeout"), tailMaxMs);
          if (request.signal.aborted) stop(null);
        },
        pull() {
          if (!stopped) resume();
        },
        cancel() {
          stop(null);
        },
      },
      { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform keeps Next's compression from buffering the events.
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return {
    handleRead,
    handleStream,
    /** For tests and diagnostics. */
    stats: () => ({ reads: reads.active, queuedReads: reads.waiting, tails: tails.active }),
  };
}

export type LogService = ReturnType<typeof createLogService>;

let defaultService: LogService | undefined;

/** The process-wide service the routes use, so the limits hold across requests. */
export function getLogService() {
  defaultService ??= createLogService();
  return defaultService;
}
