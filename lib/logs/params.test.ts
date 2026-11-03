import { describe, expect, it } from "vitest";
import { buildFollowArgs, buildReadArgs, startDockerLogs } from "./docker";
import { logSources, parseReadQuery, parseSince, parseTailQuery } from "./params";
import { fakeSpawn } from "./testing";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const apps = [
  { id: "expense-tracker", container: "expense-tracker-web" },
  { id: "expense-tracker-worker", container: "expense-tracker-web-worker" },
];

const read = (query: string, configured = apps) => parseReadQuery(new URLSearchParams(query), configured, now);

function readOk(query: string) {
  const result = read(query);
  if (!result.ok) throw new Error(result.error);
  return result.query;
}

describe("container allowlist", () => {
  it("maps an app id to its container name", () => {
    expect(readOk("container=expense-tracker").sources).toEqual([{ id: "expense-tracker", container: "expense-tracker-web" }]);
  });

  it("rejects a container name, an unknown id and anything flag-like", () => {
    for (const container of ["expense-tracker-web", "nope", "--help", "-f", "expense-tracker;ls", "../x", "a b"]) {
      expect(read(`container=${encodeURIComponent(container)}`)).toEqual({ ok: false, error: "container must be the id of a configured app" });
    }
  });

  it("skips configured apps whose container name Docker would read as a flag", () => {
    expect(logSources([{ id: "bad", container: "--privileged" }, { id: "ok", container: "ok-1" }, { id: "dup", container: "ok-1" }])).toEqual([{ id: "ok", container: "ok-1" }]);
    expect(read("container=bad", [{ id: "bad", container: "--privileged" }]).ok).toBe(false);
  });

  it("requires a container unless searching by request id", () => {
    expect(read("")).toEqual({ ok: false, error: "container is required unless searching by requestId" });
    expect(readOk("requestId=3fK9xQ2mBv0a").sources.map((source) => source.id)).toEqual(["expense-tracker", "expense-tracker-worker"]);
  });
});

describe("time parsing", () => {
  it("turns relative times and today into RFC 3339", () => {
    expect(readOk("container=expense-tracker&since=15m").since).toBe("2026-11-03T11:45:00.000Z");
    expect(readOk("container=expense-tracker&since=1h").since).toBe("2026-11-03T11:00:00.000Z");
    expect(readOk("container=expense-tracker&since=3d").since).toBe("2026-10-31T12:00:00.000Z");
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    expect(readOk("container=expense-tracker&since=today").since).toBe(today.toISOString());
  });

  it("normalises ISO times with an offset", () => {
    const query = readOk(`container=expense-tracker&since=${encodeURIComponent("2026-11-03T10:30:00+02:00")}&until=2026-11-03T08:45:00.5Z`);
    expect(query.since).toBe("2026-11-03T08:30:00.000Z");
    expect(query.until).toBe("2026-11-03T08:45:00.500Z");
  });

  it("defaults to the last hour, or 3 days for a request id", () => {
    expect(readOk("container=expense-tracker").since).toBe("2026-11-03T11:00:00.000Z");
    expect(readOk("container=expense-tracker&requestId=abc").since).toBe("2026-10-31T12:00:00.000Z");
  });

  it("rejects bad times", () => {
    for (const since of ["0m", "5y", "1w", "-1h", "yesterday", "2026-11-03", "2026-11-03T10:00:00", "8d", "2026-10-01T00:00:00Z", "2026-11-04T00:00:00Z", "1h; rm -rf /"]) {
      expect(parseSince(since, now).ok, since).toBe(false);
    }
    expect(read("container=expense-tracker&since=1h&until=2026-11-03T10:00:00Z")).toEqual({ ok: false, error: "until must be after since" });
    expect(read("container=expense-tracker&until=soon").ok).toBe(false);
  });
});

describe("filters and limit", () => {
  it("parses every filter", () => {
    const query = readOk("container=expense-tracker&level=warn&q=%20Expenses%20&requestId=tick-AbC_123&event=request&limit=20");
    expect(query.filter).toEqual({ level: "warn", q: "expenses", requestId: "tick-AbC_123", event: "request" });
    expect(query.limit).toBe(20);
    expect(readOk("container=expense-tracker").limit).toBe(500);
    expect(readOk("container=expense-tracker&limit=2000").limit).toBe(2000);
  });

  it("rejects bad filters and limits", () => {
    for (const query of ["level=fatal", `q=${"x".repeat(101)}`, "requestId=a%20b", "requestId=a.b", "event=a%20b", "limit=0", "limit=2001", "limit=1.5", "limit=-3", "limit=abc"]) {
      expect(read(`container=expense-tracker&${query}`).ok, query).toBe(false);
    }
  });

  it("parses a tail query and ignores the time window", () => {
    expect(parseTailQuery(new URLSearchParams("container=expense-tracker-worker&level=error&since=bogus"), apps)).toEqual({
      ok: true,
      query: { source: { id: "expense-tracker-worker", container: "expense-tracker-web-worker" }, filter: { level: "error" } },
    });
    expect(parseTailQuery(new URLSearchParams("requestId=abc"), apps)).toEqual({ ok: false, error: "container is required" });
  });
});

describe("docker arguments", () => {
  it("builds logs arguments with no shell and the container last", () => {
    expect(buildReadArgs("expense-tracker-web", "2026-11-03T11:00:00.000Z")).toEqual(["logs", "--timestamps", "--since", "2026-11-03T11:00:00.000Z", "expense-tracker-web"]);
    expect(buildReadArgs("c", "a", "b")).toEqual(["logs", "--timestamps", "--since", "a", "--until", "b", "c"]);
    expect(buildFollowArgs("c")).toEqual(["logs", "--follow", "--timestamps", "--since", "1s", "c"]);

    const { spawn, calls } = fakeSpawn();
    startDockerLogs(spawn, buildFollowArgs("c"));
    expect(calls).toEqual([{ command: "docker", args: ["logs", "--follow", "--timestamps", "--since", "1s", "c"], shell: false }]);
  });

  it("refuses any other docker command", () => {
    const { spawn, calls } = fakeSpawn();
    expect(() => startDockerLogs(spawn, ["rm", "-f", "c"])).toThrow();
    expect(() => startDockerLogs(spawn, ["logs"])).toThrow();
    expect(() => startDockerLogs(spawn, ["logs", "--since", "1s", "--help"])).toThrow();
    expect(calls).toEqual([]);
  });
});
