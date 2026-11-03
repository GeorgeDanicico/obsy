import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { isValidContainerName } from "./params";

/** What the logs code needs from a child process; a fake in tests. */
export type LogsProcess = {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type SpawnLogs = (command: "docker", args: string[], options: { stdio: ["ignore", "pipe", "pipe"]; shell: false }) => LogsProcess;

export const defaultSpawn: SpawnLogs = (command, args, options) => nodeSpawn(command, args, options);

/** How long a stopped process gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;

/** `docker logs` over a time window. Times must already be RFC 3339 (see `params.ts`). */
export function buildReadArgs(container: string, since: string, until?: string) {
  return ["logs", "--timestamps", "--since", since, ...(until ? ["--until", until] : []), container];
}

/** `docker logs --follow` from one second ago. */
export function buildFollowArgs(container: string) {
  return ["logs", "--follow", "--timestamps", "--since", "1s", container];
}

/**
 * The only place Obsy starts `docker logs`. It refuses anything that isn't the `logs`
 * subcommand with a valid container name last, and never uses a shell.
 */
export function startDockerLogs(spawn: SpawnLogs, args: string[]) {
  const container = args[args.length - 1];
  if (args[0] !== "logs" || args.length < 2 || !isValidContainerName(container)) {
    throw new Error("Refusing to run a docker command other than logs");
  }
  return spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
}

export function isRunning(child: LogsProcess) {
  return child.exitCode === null && child.signalCode === null;
}

/** SIGTERM now, SIGKILL if it is still running after a short grace period. */
export function stopProcess(child: LogsProcess) {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (isRunning(child)) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref?.();
}
