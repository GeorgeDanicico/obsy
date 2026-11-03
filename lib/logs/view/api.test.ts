import { describe, expect, it } from "vitest";
import { describeFailure, parseLogLine, parseLogsResult, toLogLine } from "./api";

const valid = { ts: "2026-11-03T09:00:00Z", container: "expense-tracker", stream: "stdout", level: "warn", event: "request", requestId: "abc", fields: { ms: 5 } };

describe("toLogLine", () => {
  it("accepts a line from the API", () => {
    expect(toLogLine(valid)).toEqual(valid);
    expect(toLogLine({ ...valid, clipped: true, message: "m" })).toMatchObject({ clipped: true, message: "m" });
  });

  it("rejects lines that are not the right shape and drops unknown properties", () => {
    for (const bad of [null, "x", 3, [], {}, { ...valid, level: "loud" }, { ...valid, stream: "other" }, { ...valid, ts: 5 }, { ...valid, event: undefined }]) {
      expect(toLogLine(bad)).toBeNull();
    }
    expect(toLogLine({ ...valid, extra: "<b>" })).not.toHaveProperty("extra");
    expect(toLogLine({ ...valid, fields: [1] })).not.toHaveProperty("fields");
    expect(toLogLine({ ...valid, requestId: 5 })).not.toHaveProperty("requestId");
  });

  it("parses a stream message", () => {
    expect(parseLogLine(JSON.stringify(valid))).toEqual(valid);
    expect(parseLogLine("{")).toBeNull();
  });
});

describe("parseLogsResult", () => {
  it("reads lines, flags and per-app errors", () => {
    const result = parseLogsResult({ lines: [valid, { bad: true }], truncated: true, scanned: 12, errors: [{ container: "worker", error: "Container not found" }, { container: 1 }] });
    expect(result).toEqual({ lines: [valid], truncated: true, scanned: 12, errors: [{ container: "worker", error: "Container not found" }] });
  });

  it("defaults the optional parts and rejects a body without lines", () => {
    expect(parseLogsResult({ lines: [] })).toEqual({ lines: [], truncated: false, scanned: 0, errors: [] });
    expect(parseLogsResult({ nope: 1 })).toBeNull();
    expect(parseLogsResult(null)).toBeNull();
  });
});

describe("describeFailure", () => {
  it("gives a retry hint for 429 from Retry-After", () => {
    const failure = describeFailure(429, { error: "Too many log reads at once; try again in a moment" }, "2");
    expect(failure).toMatchObject({ status: 429, retryAfter: 2, retryable: true });
    expect(failure.message).toContain("Try again in 2 seconds.");
    expect(describeFailure(429, { error: "x" }, "1").message).toContain("1 second.");
    expect(describeFailure(429, {}, null).message).toContain("Try again in a moment.");
  });

  it("explains 503 and keeps the apps a search could not read", () => {
    const failure = describeFailure(503, { error: "No container could be read", errors: [{ container: "a", error: "Docker is not available" }] });
    expect(failure.message).toBe("No container could be read");
    expect(failure.retryable).toBe(true);
    expect(failure.errors).toEqual([{ container: "a", error: "Docker is not available" }]);
    expect(describeFailure(503, null).message).toBe("Logs are temporarily unavailable.");
  });

  it("does not offer a retry for 400 and 404, and survives odd bodies", () => {
    expect(describeFailure(404, { error: "Container not found" })).toMatchObject({ message: "Container not found", retryable: false });
    expect(describeFailure(400, { error: "level must be debug, info, warn or error" }).retryable).toBe(false);
    expect(describeFailure(502, "<html>").message).toBe("The request failed (HTTP 502).");
    expect(describeFailure(429, { error: 5 }, "99999999").retryAfter).toBeUndefined();
  });
});
