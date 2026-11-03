"use client";

import { useCallback, useEffect, useState } from "react";
import { describeFailure, parseLogsResult, type Failure, type LogsResult } from "@/lib/logs/view/api";

export type ResultState =
  | { status: "idle" }
  | { status: "loading"; previous: LogsResult | null }
  | { status: "ok"; data: LogsResult; fetchedAt: number }
  | { status: "error"; failure: Failure };

/** Fetches `/api/logs?<query>` whenever `query` changes (null: nothing to fetch). `reload` fetches again. */
export function useLogsResult(query: string | null) {
  const [state, setState] = useState<ResultState>({ status: "idle" });
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!query) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ status: "loading", previous: current.status === "ok" ? current.data : current.status === "loading" ? current.previous : null }));

    void (async () => {
      try {
        const response = await fetch(`/api/logs?${query}`, { signal: controller.signal, cache: "no-store" });
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // Not JSON: handled below.
        }
        if (!response.ok) {
          setState({ status: "error", failure: describeFailure(response.status, body, response.headers.get("Retry-After")) });
          return;
        }
        const data = parseLogsResult(body);
        if (!data) {
          setState({ status: "error", failure: { status: 502, message: "Obsy sent a reply the page could not read.", errors: [], retryable: true } });
          return;
        }
        setState({ status: "ok", data, fetchedAt: Date.now() });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "error", failure: { status: 0, message: "Could not reach Obsy. Check the connection and try again.", errors: [], retryable: true } });
      }
    })();

    return () => controller.abort();
  }, [query, reloadCount]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  return { state, reload };
}
