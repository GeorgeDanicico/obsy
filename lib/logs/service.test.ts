import { describe, expect, it } from "vitest";
import { createLimiter } from "./limits";
import { createLogService, type LogsResponse } from "./service";
import { dockerLine, fakeSpawn, waitFor, type FakeProcess } from "./testing";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const apps = [
  { id: "expense-tracker", name: "Expense Tracker", container: "expense-tracker-web" },
  { id: "expense-tracker-worker", name: "Worker", container: "expense-tracker-web-worker" },
];

function service(onSpawn: (child: FakeProcess) => void, options: Parameters<typeof createLogService>[0] = {}, spawnOptions: { exitOnKill?: boolean } = {}) {
  const fake = fakeSpawn(onSpawn, spawnOptions);
  const logs = createLogService({ spawn: fake.spawn, readApps: async () => apps, now: () => now, ...options });
  return { ...fake, logs };
}

const get = (path: string, signal?: AbortSignal) => new Request(`http://obsy.test${path}`, { signal });

async function json(response: Response) {
  return (await response.json()) as LogsResponse & { error?: string };
}

const web = (child: FakeProcess) => child.args[child.args.length - 1] === "expense-tracker-web";

describe("GET /api/logs", () => {
  it("runs docker logs for the mapped container and returns filtered lines, newest first", async () => {
    const { logs, calls } = service((child) => {
      child.write("stdout", [
        dockerLine("2026-11-03T11:10:00.000000001Z", { level: "info", event: "request", requestId: "aaaaaaaaaaaa", status: 200 }),
        dockerLine("2026-11-03T11:20:00Z", "   ▲ Next.js 16.3.5"),
        dockerLine("2026-11-03T11:30:00Z", { level: "debug", event: "last_active_failed" }),
      ]);
      child.write("stderr", [dockerLine("2026-11-03T11:15:00Z", { level: "error", event: "request_failed", requestId: "bbbbbbbbbbbb" })]);
      void child.close(0);
    });

    const response = await logs.handleRead(get("/api/logs?container=expense-tracker&since=1h&level=info"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await json(response);
    expect(calls).toEqual([{ command: "docker", args: ["logs", "--timestamps", "--since", "2026-11-03T11:00:00.000Z", "expense-tracker-web"], shell: false }]);
    expect(body.scanned).toBe(4);
    expect(body.truncated).toBe(false);
    expect(body.lines.map((line) => [line.event, line.stream])).toEqual([["raw", "stdout"], ["request_failed", "stderr"], ["request", "stdout"]]);
    expect(body.lines[0].container).toBe("expense-tracker");
  });

  it("returns the last `limit` matching lines and says so", async () => {
    const { logs } = service((child) => {
      child.write("stdout", Array.from({ length: 50 }, (_, index) => dockerLine(`2026-11-03T11:${String(index).padStart(2, "0")}:00Z`, { event: "tick", n: index })));
      void child.close(0);
    });
    const body = await json(await logs.handleRead(get("/api/logs?container=expense-tracker&limit=3")));
    expect(body.lines.map((line) => line.fields?.n)).toEqual([49, 48, 47]);
    expect(body.truncated).toBe(true);
    expect(body.scanned).toBe(50);
  });

  it("rejects bad input without running docker", async () => {
    const { logs, calls } = service(() => {});
    const response = await logs.handleRead(get("/api/logs?container=expense-tracker-web"));
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("container must be the id of a configured app");
    expect((await logs.handleRead(get("/api/logs?container=expense-tracker&since=1y"))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("maps docker's own errors to 404 and 503", async () => {
    const missing = service((child) => {
      child.write("stderr", ["Error response from daemon: No such container: expense-tracker-web"]);
      void child.close(1);
    });
    const notFound = await missing.logs.handleRead(get("/api/logs?container=expense-tracker"));
    expect(notFound.status).toBe(404);
    expect((await json(notFound)).error).toBe("Container not found");

    const down = service((child) => {
      child.write("stderr", ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock."]);
      void child.close(1);
    });
    expect((await down.logs.handleRead(get("/api/logs?container=expense-tracker"))).status).toBe(503);

    const noDocker = service((child) => child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })));
    const unavailable = await noDocker.logs.handleRead(get("/api/logs?container=expense-tracker"));
    expect(unavailable.status).toBe(503);
    expect((await json(unavailable)).error).toBe("Docker is not available");
  });

  it("stops a read that runs past the timeout and returns what it had", async () => {
    const { logs, children } = service((child) => child.write("stdout", [dockerLine("2026-11-03T11:59:00Z", { event: "tick" })]), { readTimeoutMs: 30 });
    const body = await json(await logs.handleRead(get("/api/logs?container=expense-tracker")));
    expect(body.lines).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(children[0].running).toBe(false);
  });

  it("kills the read when the client goes away", async () => {
    const controller = new AbortController();
    const { logs, children } = service(() => controller.abort());
    await logs.handleRead(get("/api/logs?container=expense-tracker", controller.signal));
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(logs.stats().reads).toBe(0);
  });
});

describe("request-id search across containers", () => {
  it("searches every configured container over 3 days and merges by time", async () => {
    const { logs, calls } = service((child) => {
      if (web(child)) {
        child.write("stdout", [
          dockerLine("2026-11-02T10:00:01Z", { event: "request", requestId: "3fK9xQ2mBv0a", status: 500 }),
          dockerLine("2026-11-02T10:00:05Z", { event: "request", requestId: "other0000000" }),
        ]);
        child.write("stderr", [dockerLine("2026-11-02T10:00:00Z", { level: "error", event: "request_failed", requestId: "3fK9xQ2mBv0a" })]);
      } else {
        child.write("stdout", [dockerLine("2026-11-02T10:00:03Z", { event: "tick", requestId: "3fK9xQ2mBv0a" })]);
      }
      void child.close(0);
    });

    const body = await json(await logs.handleRead(get("/api/logs?requestId=3fK9xQ2mBv0a")));
    expect(calls.map((call) => call.args)).toEqual([
      ["logs", "--timestamps", "--since", "2026-10-31T12:00:00.000Z", "expense-tracker-web"],
      ["logs", "--timestamps", "--since", "2026-10-31T12:00:00.000Z", "expense-tracker-web-worker"],
    ]);
    expect(body.lines.map((line) => [line.container, line.event])).toEqual([
      ["expense-tracker-worker", "tick"],
      ["expense-tracker", "request"],
      ["expense-tracker", "request_failed"],
    ]);
    expect(body.scanned).toBe(4);
    expect(body.errors).toBeUndefined();
  });

  it("still answers when one container is missing", async () => {
    const { logs } = service((child) => {
      if (web(child)) child.write("stdout", [dockerLine("2026-11-02T10:00:01Z", { event: "request", requestId: "tick-abc" })]);
      else child.write("stderr", ["Error response from daemon: No such container: expense-tracker-web-worker"]);
      void child.close(web(child) ? 0 : 1);
    });
    const response = await logs.handleRead(get("/api/logs?requestId=tick-abc"));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.lines).toHaveLength(1);
    expect(body.errors).toEqual([{ container: "expense-tracker-worker", error: "Container not found" }]);
  });
});

describe("read concurrency", () => {
  it("runs at most 2 docker logs reads at once and queues the rest", async () => {
    let running = 0;
    let peak = 0;
    const { logs } = service((child) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        void child.close(0);
      }, 20);
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () => logs.handleRead(get("/api/logs?container=expense-tracker"))));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  it("answers 429 when the queue is full", async () => {
    const { logs, children } = service(() => {}, { maxQueuedReads: 1, readQueueWaitMs: 1000 });
    const pending = [1, 2, 3].map(() => logs.handleRead(get("/api/logs?container=expense-tracker")));
    const rejected = await logs.handleRead(get("/api/logs?container=expense-tracker"));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("2");
    await waitFor(() => children.length === 2);
    for (let index = 0; index < 3; index += 1) {
      await waitFor(() => children.length > index);
      void children[index].close(0);
    }
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([200, 200, 200]);
    expect(logs.stats()).toEqual({ reads: 0, queuedReads: 0, tails: 0 });
  });

  it("gives up waiting after the queue timeout", async () => {
    const limiter = createLimiter({ max: 1, maxQueue: 5, maxWaitMs: 20 });
    const first = await limiter.acquire();
    expect(first).not.toBeNull();
    expect(await limiter.acquire()).toBeNull();
    expect(limiter.waiting).toBe(0);
    first?.();
    first?.();
    expect(limiter.active).toBe(0);
  });
});

async function readEvents(response: Response, count: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length - 1 < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { reader, events: text.split("\n\n").filter(Boolean) };
}

describe("GET /api/logs/stream", () => {
  it("streams matching lines as server-sent events", async () => {
    const { logs, calls } = service((child) => {
      child.write("stdout", [
        dockerLine("2026-11-03T12:00:01Z", { level: "info", event: "request", requestId: "a" }),
        dockerLine("2026-11-03T12:00:02Z", { level: "error", event: "request_failed", requestId: "b" }),
      ]);
    });
    const controller = new AbortController();
    const response = await logs.handleStream(get("/api/logs/stream?container=expense-tracker&level=warn", controller.signal));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(calls[0].args).toEqual(["logs", "--follow", "--timestamps", "--since", "1s", "expense-tracker-web"]);

    const { events, reader } = await readEvents(response, 2);
    expect(events[0]).toBe(": connected");
    expect(events[1].startsWith("data: ")).toBe(true);
    expect(JSON.parse(events[1].slice(6))).toMatchObject({ event: "request_failed", requestId: "b", container: "expense-tracker" });
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it("kills docker logs and frees the slot when the client disconnects", async () => {
    const { logs, children } = service(() => {});
    const controller = new AbortController();
    const response = await logs.handleStream(get("/api/logs/stream?container=expense-tracker", controller.signal));
    await waitFor(() => children.length === 1);
    expect(logs.stats().tails).toBe(1);
    controller.abort();
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(logs.stats().tails).toBe(0);
    await waitFor(() => !children[0].running);
    await response.body?.cancel().catch(() => {});
  });

  it("kills docker logs when the stream is cancelled", async () => {
    const { logs, children } = service(() => {});
    const response = await logs.handleStream(get("/api/logs/stream?container=expense-tracker"));
    await response.body!.cancel();
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(logs.stats().tails).toBe(0);
  });

  it("follows up with SIGKILL when docker ignores SIGTERM", async () => {
    const { logs, children } = service(() => {}, {}, { exitOnKill: false });
    const controller = new AbortController();
    await logs.handleStream(get("/api/logs/stream?container=expense-tracker", controller.signal));
    controller.abort();
    expect(children[0].signals).toEqual(["SIGTERM"]);
    await waitFor(() => children[0].signals.length === 2, 3000);
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ends the tail after its maximum time and sends heartbeats meanwhile", async () => {
    const { logs, children } = service(() => {}, { tailMaxMs: 120, heartbeatMs: 30 });
    const response = await logs.handleStream(get("/api/logs/stream?container=expense-tracker"));
    const text = await response.text();
    expect(text).toContain(": ping\n\n");
    expect(text.endsWith('event: end\ndata: {"reason":"timeout"}\n\n')).toBe(true);
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(logs.stats().tails).toBe(0);
  });

  it("ends the stream when docker exits or fails", async () => {
    const exited = service((child) => {
      child.write("stderr", ["Error response from daemon: No such container: expense-tracker-web"]);
      void child.close(1);
    });
    expect(await (await exited.logs.handleStream(get("/api/logs/stream?container=expense-tracker"))).text()).toContain('"reason":"not_found"');
    expect(exited.logs.stats().tails).toBe(0);

    const failed = service((child) => child.emit("error", new Error("spawn docker ENOENT")));
    expect(await (await failed.logs.handleStream(get("/api/logs/stream?container=expense-tracker"))).text()).toContain('"reason":"failed"');
    expect(failed.logs.stats().tails).toBe(0);
  });

  it("allows 3 tails at once; the 4th gets 429 without spawning", async () => {
    const { logs, children } = service(() => {});
    const controllers = [0, 1, 2].map(() => new AbortController());
    for (const controller of controllers) {
      expect((await logs.handleStream(get("/api/logs/stream?container=expense-tracker", controller.signal))).status).toBe(200);
    }
    const fourth = await logs.handleStream(get("/api/logs/stream?container=expense-tracker"));
    expect(fourth.status).toBe(429);
    expect(children).toHaveLength(3);

    controllers[0].abort();
    const again = new AbortController();
    expect((await logs.handleStream(get("/api/logs/stream?container=expense-tracker", again.signal))).status).toBe(200);
    for (const controller of [...controllers, again]) controller.abort();
    expect(logs.stats().tails).toBe(0);
    expect(children.every((child) => child.signals.includes("SIGTERM"))).toBe(true);
  });

  it("rejects bad input and HEAD without spawning", async () => {
    const { logs, calls } = service(() => {});
    expect((await logs.handleStream(get("/api/logs/stream?container=nope"))).status).toBe(400);
    const head = await logs.handleStream(new Request("http://obsy.test/api/logs/stream?container=expense-tracker", { method: "HEAD" }));
    expect(head.status).toBe(405);
    expect((await logs.handleRead(new Request("http://obsy.test/api/logs?container=expense-tracker", { method: "HEAD" }))).status).toBe(405);
    expect((await logs.handleStream(get("/api/logs/stream?requestId=abc"))).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
