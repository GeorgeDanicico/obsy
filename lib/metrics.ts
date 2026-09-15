import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MonitoredApp = {
  id: string;
  name: string;
  container: string;
  port?: number;
  healthUrl?: string;
  accent?: string;
};

type DockerHealthStatus = "healthy" | "unhealthy" | "starting" | "none" | "unknown";

type DockerInspect = {
  State?: {
    Running?: boolean;
    StartedAt?: string;
    Status?: string;
    Health?: { Status?: DockerHealthStatus };
  };
  RestartCount?: number;
  Config?: { Image?: string };
};

type DockerStat = {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
  BlockIO?: string;
};

export type AppMetrics = MonitoredApp & {
  status: "live" | "degraded" | "offline" | "unknown";
  health: DockerHealthStatus;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  uptimeSeconds: number;
  restartCount: number;
  image: string;
  lastChecked: string;
  error?: string;
};

export type DashboardMetrics = {
  generatedAt: string;
  hostname: string;
  dockerAvailable: boolean;
  system: {
    cpuPercent: number;
    cpuCores: number;
    loadAverage: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    memoryPercent: number;
    networkRxBytesPerSecond: number;
    networkTxBytesPerSecond: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    diskPercent: number;
  };
  apps: AppMetrics[];
};

type CpuSample = { idle: number; total: number };
type NetworkSample = { rx: number; tx: number; at: number };

let previousCpuSample: CpuSample | undefined;
let previousNetworkSample: NetworkSample | undefined;

const procRoot = process.env.OBSY_PROC_PATH ?? "/proc";

const fallbackApps: MonitoredApp[] = [
  { id: "web", name: "Web app", container: "my-web", port: 3000, accent: "violet" },
  { id: "worker", name: "Background worker", container: "my-worker", port: 8080, accent: "orange" },
  { id: "database", name: "Database", container: "postgres", port: 5432, accent: "blue" },
];

function numberOrZero(value: string | undefined) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseHumanBytes(value: string | undefined) {
  if (!value) return 0;
  const match = value.trim().match(/^([\d.]+)\s*([kmgtpe]?i?b)?$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
    pb: 5,
    pib: 5,
  };
  return amount * 1024 ** (powers[unit] ?? 0);
}

function parsePair(value: string | undefined) {
  const [first = "", second = ""] = (value ?? "").split("/").map((part) => part.trim());
  return [parseHumanBytes(first), parseHumanBytes(second)] as const;
}

async function readConfiguredApps(): Promise<MonitoredApp[]> {
  const inlineConfig = process.env.OBSY_APPS_CONFIG;
  if (inlineConfig) {
    try {
      const parsed = JSON.parse(inlineConfig);
      if (Array.isArray(parsed)) return parsed as MonitoredApp[];
    } catch {
      // Fall through to the mounted file and built-in examples.
    }
  }

  const configPath = process.env.OBSY_APPS_CONFIG_PATH ?? "/etc/obsy/apps.json";
  try {
    const resolvedConfigPath = path.resolve(/* turbopackIgnore: true */ configPath);
    const raw = await readFile(/* turbopackIgnore: true */ resolvedConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as MonitoredApp[];
  } catch {
    // A missing config is valid for a first run.
  }

  return fallbackApps;
}

function readCpuSample(): CpuSample {
  try {
    const firstLine = fs.readFileSync(/* turbopackIgnore: true */ path.join(procRoot, "stat"), "utf8").split("\n")[0];
    const values = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    return { idle, total: values.reduce((sum, value) => sum + value, 0) };
  } catch {
    const loadAverage = os.loadavg()[0] ?? 0;
    return { idle: 0, total: Math.max(1, loadAverage * (os.cpus().length || 1)) };
  }
}

function getCpuPercent() {
  const current = readCpuSample();
  const previous = previousCpuSample;
  previousCpuSample = current;
  if (!previous) {
    return Math.min(99, ((os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length)) * 100);
  }
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function readNetworkTotals() {
  try {
    const rows = fs.readFileSync(/* turbopackIgnore: true */ path.join(procRoot, "net/dev"), "utf8").split("\n").slice(2);
    return rows.reduce(
      (totals, row) => {
        const [interfaceName, stats] = row.split(":");
        if (!stats || interfaceName.trim() === "lo") return totals;
        const values = stats.trim().split(/\s+/).map(Number);
        return { rx: totals.rx + (values[0] || 0), tx: totals.tx + (values[8] || 0) };
      },
      { rx: 0, tx: 0 },
    );
  } catch {
    return { rx: 0, tx: 0 };
  }
}

function getMemoryUsage() {
  try {
    const entries = fs.readFileSync(/* turbopackIgnore: true */ path.join(procRoot, "meminfo"), "utf8").split("\n");
    const values = new Map(entries.map((entry) => {
      const [key, rawValue = ""] = entry.split(":");
      return [key, Number.parseFloat(rawValue) * 1024];
    }));
    const total = values.get("MemTotal") ?? 0;
    const available = values.get("MemAvailable") ?? values.get("MemFree") ?? 0;
    if (total > 0) return { total, used: Math.max(0, total - available) };
  } catch {
    // Fall back to the Node process view when /proc is unavailable.
  }
  const total = os.totalmem();
  return { total, used: total - os.freemem() };
}

function getNetworkRate() {
  const current = readNetworkTotals();
  const at = Date.now();
  const previous = previousNetworkSample;
  previousNetworkSample = { ...current, at };
  if (!previous) return { rx: 0, tx: 0 };
  const elapsedSeconds = Math.max(1, (at - previous.at) / 1000);
  return {
    rx: Math.max(0, (current.rx - previous.rx) / elapsedSeconds),
    tx: Math.max(0, (current.tx - previous.tx) / elapsedSeconds),
  };
}

function getDiskUsage() {
  try {
    const diskPath = process.env.OBSY_DISK_PATH ?? "/";
    const stats = fs.statfsSync(diskPath);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const free = Number(stats.bfree) * blockSize;
    return { used: Math.max(0, total - free), total };
  } catch {
    return { used: 0, total: 0 };
  }
}

async function inspectContainer(container: string) {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", container], { timeout: 4000 });
    const parsed = JSON.parse(stdout) as DockerInspect[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

async function readDockerStats(containers: string[]) {
  if (!containers.length) return new Map<string, DockerStat>();
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", ...containers],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const stats = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerStat);
    return new Map(stats.map((stat) => [stat.Name ?? "", stat]));
  } catch {
    return new Map<string, DockerStat>();
  }
}

async function probeApp(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function getUptimeSeconds(startedAt?: string) {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : 0;
}

function createUnknownApp(app: MonitoredApp, error = "Docker is not available") : AppMetrics {
  return {
    ...app,
    status: "unknown",
    health: "unknown",
    cpuPercent: 0,
    memoryBytes: 0,
    memoryLimitBytes: 0,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    uptimeSeconds: 0,
    restartCount: 0,
    image: "—",
    lastChecked: new Date().toISOString(),
    error,
  };
}

async function getAppMetrics(app: MonitoredApp, stat: DockerStat | undefined, inspected: DockerInspect | null) {
  if (!inspected) return createUnknownApp(app, "Container not found");

  const state = inspected.State;
  const running = Boolean(state?.Running);
  const health = state?.Health?.Status ?? "none";
  let live = running && health !== "unhealthy";
  if (app.healthUrl && running) live = await probeApp(app.healthUrl);
  const memory = parsePair(stat?.MemUsage);
  const network = parsePair(stat?.NetIO);
  const block = parsePair(stat?.BlockIO);
  const memoryPercent = numberOrZero(stat?.MemPerc);

  return {
    ...app,
    status: !running ? "offline" : live ? "live" : "degraded",
    health,
    cpuPercent: numberOrZero(stat?.CPUPerc),
    memoryBytes: memory[0],
    memoryLimitBytes: memory[1],
    memoryPercent,
    networkRxBytes: network[0],
    networkTxBytes: network[1],
    blockReadBytes: block[0],
    blockWriteBytes: block[1],
    uptimeSeconds: getUptimeSeconds(state?.StartedAt),
    restartCount: inspected.RestartCount ?? 0,
    image: inspected.Config?.Image ?? "—",
    lastChecked: new Date().toISOString(),
  } satisfies AppMetrics;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const apps = await readConfiguredApps();
  const cpuPercent = getCpuPercent();
  const networkRate = getNetworkRate();
  const memory = getMemoryUsage();
  const memoryTotalBytes = memory.total;
  const memoryUsedBytes = memory.used;
  const disk = getDiskUsage();

  let dockerAvailable = false;
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 2500 });
    dockerAvailable = true;
  } catch {
    // The dashboard also works as a host-only monitor without Docker.
  }

  const inspected = dockerAvailable
    ? await Promise.all(apps.map(async (app) => [app, await inspectContainer(app.container)] as const))
    : [];
  const inspectById = new Map(inspected.map(([app, info]) => [app.id, info]));
  const runningContainers = inspected.filter(([, info]) => info?.State?.Running).map(([app]) => app.container);
  const dockerStats = await readDockerStats(runningContainers);
  const appMetrics = dockerAvailable
    ? await Promise.all(apps.map((app) => getAppMetrics(app, dockerStats.get(app.container), inspectById.get(app.id) ?? null)))
    : apps.map((app) => createUnknownApp(app));

  return {
    generatedAt: new Date().toISOString(),
    hostname: process.env.OBSY_HOSTNAME ?? os.hostname(),
    dockerAvailable,
    system: {
      cpuPercent,
      cpuCores: os.cpus().length,
      loadAverage: os.loadavg()[0] ?? 0,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent: memoryTotalBytes ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0,
      networkRxBytesPerSecond: networkRate.rx,
      networkTxBytesPerSecond: networkRate.tx,
      diskUsedBytes: disk.used,
      diskTotalBytes: disk.total,
      diskPercent: disk.total ? (disk.used / disk.total) * 100 : 0,
    },
    apps: appMetrics,
  };
}
