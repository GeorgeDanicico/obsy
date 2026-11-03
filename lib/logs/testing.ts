// Test helpers: a fake `docker logs` process and a fake `spawn`. Not imported by the app.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { LogsProcess, SpawnLogs } from "./docker";

export class FakeProcess extends EventEmitter implements LogsProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  private closing = false;

  constructor(readonly args: string[], private readonly exitOnKill = true) {
    super();
  }

  get running() {
    return this.exitCode === null && this.signalCode === null;
  }

  /** Writes lines to stdout or stderr, each ended with a newline. */
  write(stream: "stdout" | "stderr", lines: string[]) {
    this[stream].write(lines.map((line) => `${line}\n`).join(""));
  }

  /** Ends both streams, then reports the exit like Node's `close` event. */
  async close(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.closing) return;
    this.closing = true;
    const ended = Promise.all([once(this.stdout, "end"), once(this.stderr, "end")]);
    this.stdout.end();
    this.stderr.end();
    // Streams that nobody reads never end; don't wait for them forever.
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 50))]);
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (this.exitOnKill) void this.close(null, signal);
    return true;
  }
}

export function fakeSpawn(onSpawn: (child: FakeProcess) => void = () => {}, options: { exitOnKill?: boolean } = {}) {
  const children: FakeProcess[] = [];
  const calls: { command: string; args: string[]; shell: unknown }[] = [];
  const spawn: SpawnLogs = (command, args, spawnOptions) => {
    calls.push({ command, args, shell: spawnOptions.shell });
    const child = new FakeProcess(args, options.exitOnKill ?? true);
    children.push(child);
    // Like a real process, output starts after spawn returns.
    setImmediate(() => onSpawn(child));
    return child;
  };
  return { spawn, children, calls };
}

/** A `docker logs --timestamps` line. */
export function dockerLine(ts: string, content: string | Record<string, unknown>) {
  return `${ts} ${typeof content === "string" ? content : JSON.stringify(content)}`;
}

export const waitFor = async (check: () => boolean, timeoutMs = 1000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
