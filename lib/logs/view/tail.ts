// Live tail: reading the server's event stream and keeping the rows the page shows. Pure.
import type { LogLine } from "../lines";
import { parseLogLine } from "./api";

/** Rows kept on the page; older ones fall off the bottom. */
export const TAIL_CAP = 1000;
/** Longest unfinished event kept while waiting for its end; a stream that exceeds it is cut off. */
const MAX_EVENT_CHARS = 256 * 1024;

export type SseMessage = { event: string; data: string };

/**
 * A parser for `text/event-stream`: feed it text as it arrives and it calls `onMessage` for every
 * complete event. Comments (`: ping`) are ignored, `data` lines of one event are joined by
 * newlines, and an event without `data` is dropped, as in the SSE specification.
 */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let pending = "";
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length) onMessage({ event: event || "message", data: data.join("\n") });
    event = "";
    data = [];
  };

  const handleLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };

  return {
    push(chunk: string) {
      let text = pending + chunk;
      // A trailing CR may be the first half of CRLF; wait for the next chunk to know.
      let held = "";
      if (text.endsWith("\r")) {
        held = "\r";
        text = text.slice(0, -1);
      }
      const lines = text.replace(/\r\n?/g, "\n").split("\n");
      pending = (lines.pop() ?? "") + held;
      for (const line of lines) handleLine(line);
      if (pending.length > MAX_EVENT_CHARS) {
        pending = "";
        event = "";
        data = [];
      }
    },
  };
}

export type Row = { id: number; line: LogLine };

export type TailState = {
  /** Newest first, at most `TAIL_CAP`. */
  rows: Row[];
  /** Lines that arrived while paused, newest first, at most `TAIL_CAP`. */
  pending: Row[];
  paused: boolean;
  nextId: number;
  /** Why the server ended the stream, once it has. */
  ended: string | null;
};

export function initialTail(): TailState {
  return { rows: [], pending: [], paused: false, nextId: 1, ended: null };
}

/** Reason text from an `end` event's data (`{ "reason": "timeout" }`), or "unknown". */
export function endReason(data: string) {
  try {
    const parsed: unknown = JSON.parse(data);
    const reason = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).reason : undefined;
    if (typeof reason === "string" && /^[a-z_]{1,32}$/.test(reason)) return reason;
  } catch {
    // Fall through.
  }
  return "unknown";
}

export function describeEnd(reason: string) {
  switch (reason) {
    case "timeout":
      return "The server stops a live tail after 15 minutes. Start it again to keep following.";
    case "exited":
      return "The container's log stream ended. It may have stopped or restarted.";
    case "not_found":
      return "That container was not found.";
    case "failed":
      return "The server could not keep reading the container's logs.";
    default:
      return "The server ended the live tail.";
  }
}

/**
 * Applies a batch of stream messages: log lines go on top (or into `pending` while paused), the
 * cap is enforced, and an `end` event stops the batch and sets `close` so the caller closes the
 * stream. Malformed lines and unknown events are ignored.
 */
export function applyMessages(state: TailState, messages: SseMessage[]): { state: TailState; close: boolean } {
  let { rows, pending, nextId } = state;
  let ended: string | null = state.ended;
  let close = false;
  let added: Row[] = [];

  for (const message of messages) {
    if (message.event === "end") {
      ended = endReason(message.data);
      close = true;
      break;
    }
    if (message.event !== "message") continue;
    const line = parseLogLine(message.data);
    if (!line) continue;
    // Newest first: later messages go in front of earlier ones.
    added = [{ id: nextId, line }, ...added];
    nextId += 1;
    if (added.length > TAIL_CAP) added.length = TAIL_CAP;
  }

  if (added.length) {
    if (state.paused) pending = [...added, ...pending].slice(0, TAIL_CAP);
    else rows = [...added, ...rows].slice(0, TAIL_CAP);
  }
  return { state: { ...state, rows, pending, nextId, ended }, close };
}

export function pauseTail(state: TailState): TailState {
  return { ...state, paused: true };
}

/** Resuming shows what arrived while paused, newest on top. */
export function resumeTail(state: TailState): TailState {
  return { ...state, paused: false, rows: [...state.pending, ...state.rows].slice(0, TAIL_CAP), pending: [] };
}
