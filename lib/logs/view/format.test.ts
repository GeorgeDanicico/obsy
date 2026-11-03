import { describe, expect, it } from "vitest";
import type { LogLine } from "../lines";
import { formatMs, formatTime, linkableRequestIds, prettyLine, shortUserId, spanBars, statusTone, summarize } from "./format";

function line(fields: Record<string, unknown>, extra: Partial<LogLine> = {}): LogLine {
  return {
    ts: "2026-11-03T09:14:07.512345678Z",
    container: "expense-tracker",
    stream: "stdout",
    level: (fields.level as LogLine["level"]) ?? "info",
    event: (fields.event as string) ?? "request",
    ...(typeof fields.requestId === "string" ? { requestId: fields.requestId } : {}),
    fields,
    ...extra,
  };
}

describe("formatTime", () => {
  // Built from local fields so the test does not depend on the machine's time zone.
  const at = (y: number, m: number, d: number, h: number, min: number, s: number, ms: number) => new Date(y, m, d, h, min, s, ms);

  it("shows the local time with milliseconds for today", () => {
    const stamp = at(2026, 10, 3, 9, 14, 7, 512);
    expect(formatTime(stamp.toISOString().replace("Z", "345678Z"), at(2026, 10, 3, 18, 0, 0, 0).getTime())).toBe("09:14:07.512");
  });

  it("adds the day for an earlier day", () => {
    const stamp = at(2026, 10, 2, 23, 5, 9, 1);
    expect(formatTime(stamp.toISOString(), at(2026, 10, 3, 8, 0, 0, 0).getTime())).toBe("Nov 2 23:05:09");
  });

  it("returns an unparseable timestamp as text", () => {
    expect(formatTime("garbage")).toBe("garbage");
  });
});

describe("shortUserId", () => {
  it("keeps the first block of a UUID", () => {
    expect(shortUserId("6f1c2d3e-aaaa-bbbb-cccc-111122223333")).toBe("6f1c2d3e…");
    expect(shortUserId("abc")).toBe("abc");
    expect(shortUserId(undefined)).toBeUndefined();
    expect(shortUserId(42)).toBeUndefined();
    expect(shortUserId("")).toBeUndefined();
  });
});

describe("summarize", () => {
  it("reads route, status, ms and user from a request line", () => {
    const summary = summarize(line({ event: "request", requestId: "3fK9xQ2mBv0a", method: "GET", route: "/api/expenses/:id", status: 200, ms: 38, userId: "6f1c2d3e-aaaa-bbbb-cccc-111122223333" }));
    expect(summary).toMatchObject({ event: "request", method: "GET", route: "/api/expenses/:id", status: 200, ms: 38, slow: false, user: "6f1c2d3e…", requestId: "3fK9xQ2mBv0a", app: "expense-tracker" });
    expect(summary.text).toBeUndefined();
  });

  it("marks slow requests", () => {
    expect(summarize(line({ level: "warn", event: "request", status: 200, ms: 1500, slow: true })).slow).toBe(true);
    expect(summarize(line({ event: "request", status: 200, ms: 1500, slow: "yes" })).slow).toBe(false);
  });

  it("ignores values of the wrong type", () => {
    const summary = summarize(line({ event: "request", route: 5, status: "200", ms: "fast", userId: { id: 1 }, method: 3 }));
    expect(summary.route).toBeUndefined();
    expect(summary.status).toBeUndefined();
    expect(summary.ms).toBeUndefined();
    expect(summary.user).toBeUndefined();
    expect(summary.method).toBeUndefined();
    expect(summarize(line({ event: "request", status: 99 })).status).toBeUndefined();
    expect(summarize(line({ event: "request", ms: -1 })).ms).toBeUndefined();
  });

  it("shows route and status only for request lines", () => {
    const summary = summarize(line({ event: "tick", route: "/x", status: 200, ms: 40, message: "tick done" }));
    expect(summary.route).toBeUndefined();
    expect(summary.status).toBeUndefined();
    expect(summary.ms).toBe(40);
    expect(summary.text).toBe("tick done");
  });

  it("uses the message of a raw line, shortened", () => {
    const raw: LogLine = { ts: "2026-11-03T09:00:00Z", container: "x", stream: "stderr", level: "info", event: "raw", message: "m".repeat(500) };
    expect(summarize(raw).text).toHaveLength(201);
  });

  it("only keeps request ids that match the API's pattern", () => {
    const summary = summarize(line({ event: "client_error", requestId: "ok_id-1", relatedRequestId: "<img src=x>" }));
    expect(summary.requestId).toBe("ok_id-1");
    expect(summary.relatedRequestId).toBeUndefined();
    expect(linkableRequestIds(line({ event: "client_error", requestId: "aaa", relatedRequestId: "bbb" }))).toEqual(["aaa", "bbb"]);
    expect(linkableRequestIds(line({ event: "client_error", requestId: "aaa", relatedRequestId: "aaa" }))).toEqual(["aaa"]);
    expect(linkableRequestIds(line({ event: "x", requestId: "a b" }, { requestId: "a b" }))).toEqual([]);
  });
});

describe("spanBars", () => {
  it("sorts spans by ms, slowest first, with widths relative to the slowest", () => {
    const bars = spanBars({ spans: [{ name: "db.expenses", ms: 12 }, { name: "rpc.move_todo", ms: 30 }, { name: "push", ms: 6 }] });
    expect(bars.map((bar) => bar.name)).toEqual(["rpc.move_todo", "db.expenses", "push"]);
    expect(bars.map((bar) => bar.share)).toEqual([1, 0.4, 0.2]);
  });

  it("skips malformed spans and handles missing ones", () => {
    expect(spanBars(undefined)).toEqual([]);
    expect(spanBars({ spans: "nope" })).toEqual([]);
    expect(spanBars({ spans: [null, 3, { name: 4, ms: 1 }, { name: "a", ms: "x" }, { name: "b", ms: -2 }, { name: "ok", ms: 0 }] })).toEqual([{ name: "ok", ms: 0, share: 0 }]);
  });

  it("limits how many spans are listed", () => {
    const spans = Array.from({ length: 100 }, (_, index) => ({ name: `s${index}`, ms: index }));
    expect(spanBars({ spans })).toHaveLength(40);
  });
});

describe("other formatting", () => {
  it("formats durations", () => {
    expect(formatMs(38.4)).toBe("38 ms");
    expect(formatMs(1500)).toBe("1.50 s");
    expect(formatMs(12_345)).toBe("12.3 s");
  });

  it("pretty-prints the JSON or shows the raw text", () => {
    expect(prettyLine(line({ event: "tick", n: 1 }))).toBe('{\n  "event": "tick",\n  "n": 1\n}');
    expect(prettyLine({ ts: "t", container: "c", stream: "stdout", level: "info", event: "raw", message: "hello <b>" })).toBe("hello <b>");
  });

  it("groups statuses", () => {
    expect([200, 204, 301, 404, 429, 500, 503].map(statusTone)).toEqual(["ok", "ok", "redirect", "client", "client", "server", "server"]);
  });
});
