import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogService } from "./service";
import type { MetricsResponse } from "./metrics";
import { dockerLine, fakeSpawn, waitFor, type FakeProcess } from "./testing";

const start = Date.parse("2026-11-03T12:00:00.000Z");
const apps = [
  { id: "expense-tracker", name: "Expense Tracker", container: "expense-tracker-web" },
  { id: "expense-tracker-worker", name: "Worker", container: "expense-tracker-web-worker" },
  { id: "db", name: "Database", container: "postgres" },
];

// Only Date is faked, so the fake docker processes keep their real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

function service(onSpawn: (child: FakeProcess) => void, options: Parameters<typeof createLogService>[0] = {}) {
  const fake = fakeSpawn(onSpawn);
  const logs = createLogService({ spawn: fake.spawn, readApps: async () => apps, ...options });
  return { ...fake, logs };
}

const get = (path = "/api/logs/metrics") => new Request(`http://obsy.test${path}`);
const containerOf = (child: FakeProcess) => child.args[child.args.length - 1];

async function metrics(response: Response) {
  return (await response.json()) as MetricsResponse & { error?: string };
}

const req = (ts: string, route: string, status: number, ms: number) => dockerLine(ts, { level: "info", event: "request", route, status, ms });
const tick = (ts: string) => dockerLine(ts, { level: "info", event: "tick", ms: 20 });

/** A web app with 10 requests, a worker with ticks, and a database that writes plain text. */
function fakeApps(child: FakeProcess) {
  const container = containerOf(child);
  if (container === "expense-tracker-web") {
    child.write("stdout", [
      ...Array.from({ length: 8 }, (_, index) => req("2026-11-03T11:50:00Z", "/api/expenses", 200, 10 * (index + 1))),
      req("2026-11-03T11:55:00Z", "/api/expenses", 500, 400),
      req("2026-11-03T11:56:00Z", "/api/expenses", 429, 1),
      dockerLine("2026-11-03T11:40:00Z", "   ▲ Next.js"),
    ]);
  } else if (container === "expense-tracker-web-worker") {
    child.write("stdout", [tick("2026-11-03T11:59:00Z"), tick("2026-11-03T11:59:30Z")]);
  } else {
    child.write("stdout", [dockerLine("2026-11-03T11:00:00Z", "LOG:  database system is ready")]);
  }
  void child.close(0);
}

describe("GET /api/logs/metrics", () => {
  it("reads each app once with --since 15m and aggregates request lines and the worker's ticks", async () => {
    const { logs, calls } = service(fakeApps);
    const response = await logs.handleMetrics(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    expect(calls.map((call) => call.args)).toEqual([
      ["logs", "--timestamps", "--since", "2026-11-03T11:45:00.000Z", "expense-tracker-web"],
      ["logs", "--timestamps", "--since", "2026-11-03T11:45:00.000Z", "expense-tracker-web-worker"],
      ["logs", "--timestamps", "--since", "2026-11-03T11:45:00.000Z", "postgres"],
    ]);
    expect(calls.every((call) => call.command === "docker" && call.shell === false)).toBe(true);

    const body = await metrics(response);
    expect(body).toMatchObject({ windowMinutes: 15, tickIntervalMs: 30_000 });
    const [web, worker, db] = body.apps;

    expect(web.ok && web.requests).toMatchObject({ requests: 10, errors: 1, rateLimited: 1, p50: 40, p95: 400 });
    // ms sorted: 1 10 20 30 40 50 60 70 80 400, so p50 is rank 5 (40) and p95 is rank 10 (400).
    // 10 requests in 15 minutes.
    expect(web.ok && web.requests?.perMinute).toBeCloseTo(10 / 15);
    expect(web.ok && web.heartbeat).toBeNull();

    expect(worker).toMatchObject({ ok: true, requests: null, heartbeat: { lastTickAt: "2026-11-03T11:59:30.000Z", ageSeconds: 30, stale: false } });
    expect(db).toMatchObject({ ok: true, requests: null, heartbeat: null });
  });

  it("reads one app with ?container= and refuses unknown ones", async () => {
    const { logs, calls } = service(fakeApps);
    const one = await metrics(await logs.handleMetrics(get("/api/logs/metrics?container=expense-tracker")));
    expect(one.apps.map((app) => app.id)).toEqual(["expense-tracker"]);
    expect(calls).toHaveLength(1);

    expect((await logs.handleMetrics(get("/api/logs/metrics?container=expense-tracker-web"))).status).toBe(400);
    expect((await logs.handleMetrics(new Request("http://obsy.test/api/logs/metrics", { method: "HEAD" }))).status).toBe(405);
    expect(calls).toHaveLength(1);
  });

  it("runs one docker read for callers that arrive together", async () => {
    const { logs, calls } = service(fakeApps);
    const responses = await Promise.all([1, 2, 3, 4].map(() => logs.handleMetrics(get("/api/logs/metrics?container=expense-tracker"))));
    expect(calls).toHaveLength(1);
    const bodies = await Promise.all(responses.map(metrics));
    expect(new Set(bodies.map((body) => JSON.stringify(body.apps))).size).toBe(1);
  });

  it("serves the cache for 30 seconds, then reads again", async () => {
    const { logs, calls } = service(fakeApps);
    const path = "/api/logs/metrics?container=expense-tracker";
    await logs.handleMetrics(get(path));
    vi.setSystemTime(start + 29_000);
    await logs.handleMetrics(get(path));
    expect(calls).toHaveLength(1);

    vi.setSystemTime(start + 30_500);
    await logs.handleMetrics(get(path));
    expect(calls).toHaveLength(2);
    // The window moves with the clock.
    expect(calls[1].args).toContain("2026-11-03T11:45:30.500Z");
  });

  it("works out the heartbeat age at answer time, so it grows while the read is cached", async () => {
    const { logs } = service(fakeApps);
    const path = "/api/logs/metrics?container=expense-tracker-worker";
    const heartbeat = async () => {
      const app = (await metrics(await logs.handleMetrics(get(path)))).apps[0];
      return app.ok ? app.heartbeat : null;
    };
    expect(await heartbeat()).toMatchObject({ ageSeconds: 30, stale: false });
    vi.setSystemTime(start + 25_000); // still cached; last tick 11:59:30 is now 55 s old
    expect(await heartbeat()).toMatchObject({ ageSeconds: 55, stale: false });
  });

  it("shows the heartbeat red past 3 tick intervals", async () => {
    const { logs } = service((child) => {
      child.write("stdout", [tick("2026-11-03T11:58:00Z")]); // 120 s old
      void child.close(0);
    });
    const body = await metrics(await logs.handleMetrics(get("/api/logs/metrics?container=expense-tracker-worker")));
    expect(body.apps[0]).toMatchObject({ ok: true, heartbeat: { ageSeconds: 120, stale: true } });
  });

  it("recognises a worker by its tick lines, whatever the app is called", async () => {
    const { logs } = service(
      (child) => {
        child.write("stdout", [tick("2026-11-03T11:59:50Z")]);
        void child.close(0);
      },
      { readApps: async () => [{ id: "jobs", name: "Jobs", container: "jobs-1" }] },
    );
    const body = await metrics(await logs.handleMetrics(get()));
    expect(body.apps[0]).toMatchObject({ id: "jobs", ok: true, heartbeat: { ageSeconds: 10, stale: false } });
  });

  it("shows a worker that wrote nothing in 15 minutes as red, when its name says it is a worker", async () => {
    const { logs } = service((child) => {
      void child.close(0);
    });
    const body = await metrics(await logs.handleMetrics(get()));
    expect(body.apps.find((app) => app.id === "expense-tracker-worker")).toMatchObject({ ok: true, heartbeat: { lastTickAt: null, ageSeconds: null, stale: true } });
    // Apps that don't look like workers show nothing.
    expect(body.apps.find((app) => app.id === "db")).toMatchObject({ ok: true, requests: null, heartbeat: null });
  });

  it("keeps showing zeros for an app that has written request lines, when it is quiet", async () => {
    let quiet = false;
    const { logs } = service((child) => {
      if (!quiet) child.write("stdout", [req("2026-11-03T11:59:00Z", "/api/x", 200, 5)]);
      void child.close(0);
    });
    const path = "/api/logs/metrics?container=expense-tracker";
    const first = (await metrics(await logs.handleMetrics(get(path)))).apps[0];
    expect(first.ok && first.requests?.requests).toBe(1);

    quiet = true;
    vi.setSystemTime(start + 60_000);
    const second = (await metrics(await logs.handleMetrics(get(path)))).apps[0];
    expect(second.ok && second.requests).toMatchObject({ requests: 0, perMinute: 0, errorRate: 0, p95: null });
  });

  it("marks a read that hit its time limit as partial", async () => {
    const { logs } = service(
      (child) => {
        child.write("stdout", [req("2026-11-03T11:59:00Z", "/api/x", 200, 5)]); // never closes
      },
      { readTimeoutMs: 20 },
    );
    const body = await metrics(await logs.handleMetrics(get("/api/logs/metrics?container=expense-tracker")));
    expect(body.apps[0]).toMatchObject({ ok: true, partial: true });
  });
});

describe("metrics failures", () => {
  it("answers 200 with 'unavailable' for an app when Docker is down, and retries on the next call", async () => {
    let down = true;
    const { logs, calls } = service((child) => {
      if (down) {
        child.write("stderr", ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock."]);
        void child.close(1);
      } else {
        child.write("stdout", [req("2026-11-03T11:59:00Z", "/api/x", 200, 5)]);
        void child.close(0);
      }
    });
    const path = "/api/logs/metrics?container=expense-tracker";
    const failed = await logs.handleMetrics(get(path));
    expect(failed.status).toBe(200);
    expect((await metrics(failed)).apps[0]).toMatchObject({ id: "expense-tracker", ok: false, error: expect.stringContaining("Cannot connect") });

    down = false;
    const recovered = (await metrics(await logs.handleMetrics(get(path)))).apps[0];
    expect(recovered.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports a missing docker binary and a missing container per app without failing the rest", async () => {
    const { logs } = service((child) => {
      if (containerOf(child) === "postgres") {
        child.emit("error", new Error("spawn docker ENOENT"));
      } else if (containerOf(child) === "expense-tracker-web-worker") {
        child.write("stderr", ["Error response from daemon: No such container: expense-tracker-web-worker"]);
        void child.close(1);
      } else {
        child.write("stdout", [req("2026-11-03T11:59:00Z", "/api/x", 200, 5)]);
        void child.close(0);
      }
    });
    const body = await metrics(await logs.handleMetrics(get()));
    expect(body.apps.map((app) => [app.id, app.ok, !app.ok && app.error])).toEqual([
      ["expense-tracker", true, false],
      ["expense-tracker-worker", false, "Container not found"],
      ["db", false, "Docker is not available"],
    ]);
  });

  it("says 'unavailable' when the read limiter turns the read away, without starting docker", async () => {
    const { logs, calls, children } = service(() => {}, { maxReads: 1, maxQueuedReads: 0 });
    // The first app takes the only slot and never finishes.
    const pending = logs.handleMetrics(get());
    await waitFor(() => children.length === 1);
    const body = await metrics(await logs.handleMetrics(get("/api/logs/metrics?container=db")));
    expect(body.apps[0]).toEqual({ id: "db", ok: false, error: "Too many log reads at once" });
    expect(calls).toHaveLength(1);

    for (const child of children) void child.close(0);
    await pending;
  });
});
