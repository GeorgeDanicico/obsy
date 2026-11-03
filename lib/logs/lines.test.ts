import { describe, expect, it } from "vitest";
import { LineSplitter, matchesFilter, MAX_LINE_CHARS, mergeNewest, mightMatch, NewestEntries, normalizeLevel, parseDockerLine, type LogEntry, type LogFilter } from "./lines";
import { dockerLine } from "./testing";

function entry(text: string, seq = 1, stream: "stdout" | "stderr" = "stdout", container = "expense-tracker"): LogEntry {
  const parsed = parseDockerLine(text, stream, container, seq);
  if (parsed.kind !== "log") throw new Error("not a log line");
  return parsed.entry;
}

describe("parseDockerLine", () => {
  it("parses a JSON line from the app", () => {
    const fields = { time: "2026-11-03T09:14:07.512Z", level: "warn", event: "request", requestId: "3fK9xQ2mBv0a", route: "/api/expenses/:id", status: 429, ms: 38 };
    const parsed = entry(dockerLine("2026-11-03T09:14:07.513456789Z", fields), 7, "stderr");
    expect(parsed.line).toEqual({ ts: "2026-11-03T09:14:07.513456789Z", container: "expense-tracker", stream: "stderr", level: "warn", event: "request", requestId: "3fK9xQ2mBv0a", fields });
    expect(parsed.seconds).toBe(Date.parse("2026-11-03T09:14:07Z"));
    expect(parsed.nanos).toBe(513456789);
    expect(parsed.seq).toBe(7);
  });

  it("keeps non-JSON lines as raw info lines", () => {
    expect(entry(dockerLine("2026-11-03T09:00:00.1Z", "   ▲ Next.js 16.3.5")).line).toEqual({
      ts: "2026-11-03T09:00:00.1Z",
      container: "expense-tracker",
      stream: "stdout",
      level: "info",
      event: "raw",
      message: "   ▲ Next.js 16.3.5",
    });
    for (const content of ["{not json", "[1,2]", "null", '"text"', "42"]) {
      expect(entry(dockerLine("2026-11-03T09:00:00Z", content)).line.event, content).toBe("raw");
    }
  });

  it("names JSON lines without an event and normalises foreign levels", () => {
    expect(entry(dockerLine("2026-11-03T09:00:00Z", { msg: "hi", level: 50 })).line).toMatchObject({ event: "json", level: "error" });
    expect(normalizeLevel("WARNING")).toBe("warn");
    expect(normalizeLevel("trace")).toBe("debug");
    expect(normalizeLevel("fatal")).toBe("error");
    expect(normalizeLevel(undefined)).toBe("info");
    expect(normalizeLevel(30)).toBe("info");
  });

  it("reads Docker timestamps with an offset and nanoseconds", () => {
    const parsed = entry("2026-11-03T11:14:07.000000001+02:00 hello");
    expect(parsed.seconds).toBe(Date.parse("2026-11-03T09:14:07Z"));
    expect(parsed.nanos).toBe(1);
  });

  it("treats a line without a Docker timestamp as a docker CLI message", () => {
    expect(parseDockerLine("Error response from daemon: No such container: x", "stderr", "x", 1)).toEqual({ kind: "cli", text: "Error response from daemon: No such container: x" });
  });

  it("clips long lines, and a clipped JSON line becomes raw", () => {
    const long = JSON.stringify({ level: "error", event: "request_failed", stack: "x".repeat(MAX_LINE_CHARS) });
    const parsed = entry(dockerLine("2026-11-03T09:00:00Z", long));
    expect(parsed.line.clipped).toBe(true);
    expect(parsed.line.event).toBe("raw");
    expect(parsed.line.message).toHaveLength(MAX_LINE_CHARS);
    expect(entry(dockerLine("2026-11-03T09:00:00Z", "short")).line.clipped).toBeUndefined();
  });
});

describe("LineSplitter", () => {
  it("splits chunks across boundaries and drops CRs and blank lines", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((text) => lines.push(text));
    splitter.push("one\r\ntw");
    splitter.push("o\n\nthr");
    splitter.push("ee");
    splitter.end();
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("keeps only the start of a huge line and marks it clipped", () => {
    const lines: [string, boolean][] = [];
    const splitter = new LineSplitter((text, clipped) => lines.push([text, clipped]), 10);
    splitter.push("0123456789abc");
    splitter.push("def\nnext\n");
    expect(lines).toEqual([["0123456789", true], ["next", false]]);
  });
});

describe("filtering", () => {
  const request = entry(dockerLine("2026-11-03T09:00:00Z", { level: "warn", event: "request", requestId: "3fK9xQ2mBv0a", route: "/api/Expenses" }));
  const report = entry(dockerLine("2026-11-03T09:00:01Z", { level: "warn", event: "client_error", requestId: "zzzzzzzzzzzz", relatedRequestId: "3fK9xQ2mBv0a" }));
  const raw = entry(dockerLine("2026-11-03T09:00:02Z", "Ready in 120ms"));

  const matches = (candidate: LogEntry, filter: LogFilter) => mightMatch(candidate.raw, filter) && matchesFilter(candidate, filter);

  it("filters by lowest level", () => {
    expect(matches(request, { level: "warn" })).toBe(true);
    expect(matches(request, { level: "error" })).toBe(false);
    expect(matches(raw, { level: "info" })).toBe(true);
    expect(matches(raw, { level: "warn" })).toBe(false);
  });

  it("matches q case-insensitively against the raw line", () => {
    expect(matches(request, { q: "api/expenses" })).toBe(true);
    expect(matches(raw, { q: "ready in" })).toBe(true);
    expect(matches(raw, { q: "error" })).toBe(false);
  });

  it("matches requestId exactly, including a browser report's relatedRequestId", () => {
    expect(matches(request, { requestId: "3fK9xQ2mBv0a" })).toBe(true);
    expect(matches(report, { requestId: "3fK9xQ2mBv0a" })).toBe(true);
    expect(matches(request, { requestId: "3fK9xQ2mBv0" })).toBe(false);
    // In the text but not the id field.
    expect(matches(entry(dockerLine("2026-11-03T09:00:00Z", { event: "x", note: "3fK9xQ2mBv0a" })), { requestId: "3fK9xQ2mBv0a" })).toBe(false);
  });

  it("matches event exactly", () => {
    expect(matches(request, { event: "request" })).toBe(true);
    expect(matches(entry(dockerLine("2026-11-03T09:00:00Z", { event: "request_failed" })), { event: "request" })).toBe(false);
    expect(matches(raw, { event: "raw" })).toBe(true);
  });
});

describe("ordering", () => {
  it("keeps the newest lines, newest first, with ties in arrival order", () => {
    const newest = new NewestEntries(3);
    const times = ["09:00:05", "09:00:01", "09:00:03", "09:00:04", "09:00:02", "09:00:04"];
    times.forEach((time, index) => newest.add(entry(dockerLine(`2026-11-03T${time}Z`, `line ${index}`), index)));
    expect(newest.result().map((item) => item.raw)).toEqual(["line 0", "line 5", "line 3"]);
    expect(newest.matched).toBe(6);
  });

  it("orders by nanoseconds within a second", () => {
    const newest = new NewestEntries(10);
    newest.add(entry("2026-11-03T09:00:00.000000002Z b", 1));
    newest.add(entry("2026-11-03T09:00:00.000000010Z c", 2));
    newest.add(entry("2026-11-03T09:00:00.000000001Z a", 3));
    expect(newest.result().map((item) => item.raw)).toEqual(["c", "b", "a"]);
  });

  it("merges containers by time", () => {
    const web = [entry(dockerLine("2026-11-03T09:00:03Z", "web 3"), 3, "stdout", "web"), entry(dockerLine("2026-11-03T09:00:01Z", "web 1"), 1, "stdout", "web")];
    const worker = [entry(dockerLine("2026-11-03T09:00:04Z", "worker 4"), 4, "stdout", "worker"), entry(dockerLine("2026-11-03T09:00:02Z", "worker 2"), 2, "stdout", "worker")];
    expect(mergeNewest([web, worker], 3).map((item) => item.raw)).toEqual(["worker 4", "web 3", "worker 2"]);
  });
});
