"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeFailure, type Failure } from "@/lib/logs/view/api";
import { applyMessages, createSseParser, initialTail, pauseTail, resumeTail, type SseMessage, type TailState } from "@/lib/logs/view/tail";

/** A hidden tab keeps its tail for this long, then closes it so it doesn't hold one of the 3 slots. */
export const HIDDEN_CLOSE_MS = 60_000;
/** Lines are applied in batches so a busy container doesn't re-render the page for every line. */
const FLUSH_MS = 200;

export type TailStatus = "off" | "connecting" | "live" | "ended" | "dropped" | "hidden" | "failed";

export type LiveTail = {
  status: TailStatus;
  tail: TailState;
  failure: Failure | null;
  pause: () => void;
  resume: () => void;
  clear: () => void;
  reconnect: () => void;
};

type Snapshot = { status: TailStatus; tail: TailState; failure: Failure | null };

const OFF: Snapshot = { status: "off", tail: initialTail(), failure: null };

/**
 * Follows `/api/logs/stream?<query>` while `query` is set. It reads the stream with `fetch`
 * rather than `EventSource` so an error response (429 for too many tails, 400, 404) arrives with
 * its status and message, and nothing reconnects behind the page's back: the stream stays closed
 * after an `end` event, a drop or an error until the user asks, except that a tail closed
 * because its tab was hidden reopens when the tab is shown again.
 */
export function useLiveTail(query: string | null): LiveTail {
  const [snapshot, setSnapshot] = useState<Snapshot>(OFF);
  const tailRef = useRef<TailState>(initialTail());
  const statusRef = useRef<TailStatus>("off");
  const connectRef = useRef<() => void>(() => {});
  const failureRef = useRef<Failure | null>(null);
  const publishRef = useRef<() => void>(() => {});

  const publish = useCallback(() => {
    setSnapshot({ status: statusRef.current, tail: tailRef.current, failure: failureRef.current });
  }, []);
  publishRef.current = publish;

  useEffect(() => {
    tailRef.current = initialTail();
    failureRef.current = null;
    if (!query) {
      statusRef.current = "off";
      publishRef.current();
      return;
    }

    let controller: AbortController | null = null;
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer: SseMessage[] = [];
    let disposed = false;

    const setStatus = (status: TailStatus) => {
      statusRef.current = status;
      publishRef.current();
    };

    /** Applies the buffered messages; an `end` event closes the stream. */
    const flush = () => {
      if (!buffer.length) return;
      const messages = buffer;
      buffer = [];
      const result = applyMessages(tailRef.current, messages);
      tailRef.current = result.state;
      if (result.close) {
        stop();
        setStatus("ended");
      } else {
        publishRef.current();
      }
    };

    /** Aborts the request and its timers. Safe to call more than once. */
    const stop = () => {
      clearInterval(flushTimer);
      flushTimer = undefined;
      controller?.abort();
      controller = null;
    };

    const connect = () => {
      stop();
      buffer = [];
      failureRef.current = null;
      tailRef.current = { ...tailRef.current, ended: null };
      const current = new AbortController();
      controller = current;
      setStatus("connecting");

      const parser = createSseParser((message) => {
        buffer.push(message);
        // The end of the stream is acted on at once: the connection is closed on `end`.
        if (message.event === "end") flush();
      });

      void (async () => {
        try {
          const response = await fetch(`/api/logs/stream?${query}`, { signal: current.signal, cache: "no-store", headers: { Accept: "text/event-stream" } });
          if (!response.ok || !response.body) {
            let body: unknown = null;
            try {
              body = await response.json();
            } catch {
              // Not JSON: describeFailure falls back to a generic message.
            }
            failureRef.current = describeFailure(response.status, body, response.headers.get("Retry-After"));
            stop();
            setStatus("failed");
            return;
          }
          setStatus("live");
          flushTimer = setInterval(flush, FLUSH_MS);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
          // The server closed without an `end` event (it always sends one first), so the
          // connection was cut: say so instead of looking live.
          if (controller === current) {
            flush();
            if (statusRef.current === "live") {
              stop();
              setStatus("dropped");
            }
          }
        } catch {
          if (current.signal.aborted || disposed) return;
          flush();
          failureRef.current = { status: 0, message: "The connection to Obsy was lost.", errors: [], retryable: true };
          stop();
          setStatus("dropped");
        }
      })();
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (statusRef.current !== "live" && statusRef.current !== "connecting") return;
        clearTimeout(hiddenTimer);
        hiddenTimer = setTimeout(() => {
          flush();
          stop();
          setStatus("hidden");
        }, HIDDEN_CLOSE_MS);
        return;
      }
      clearTimeout(hiddenTimer);
      if (statusRef.current === "hidden") connect();
    };

    connectRef.current = connect;
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    if (document.hidden) onVisibility();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(hiddenTimer);
      stop();
    };
  }, [query]);

  const pause = useCallback(() => {
    tailRef.current = pauseTail(tailRef.current);
    publish();
  }, [publish]);
  const resume = useCallback(() => {
    tailRef.current = resumeTail(tailRef.current);
    publish();
  }, [publish]);
  const clear = useCallback(() => {
    tailRef.current = { ...tailRef.current, rows: [], pending: [] };
    publish();
  }, [publish]);
  const reconnect = useCallback(() => connectRef.current(), []);

  return { ...snapshot, pause, resume, clear, reconnect };
}
