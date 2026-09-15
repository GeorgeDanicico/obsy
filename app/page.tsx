"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppMetrics, DashboardMetrics, ProcessMetrics } from "@/lib/metrics";

type Tab = "overview" | "apps" | "processes";
type ProcessSort = "cpu" | "memory";
type IconName = "grid" | "box" | "settings" | "help" | "server" | "cpu" | "memory" | "network" | "disk" | "refresh" | "arrow" | "external" | "check" | "alert" | "clock";

const REFRESH_INTERVAL = 5000;

const iconPaths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.3 7.6 7.7 4.3 7.7-4.3M12 12v9" /></>,
  settings: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.3a2 2 0 0 1-4 0v-.2A2 2 0 0 0 5.8 18l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 12a2 2 0 0 1 2-2h.2A2 2 0 0 0 5.2 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 12 2.4a2 2 0 0 1 2 2v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1A2 2 0 0 0 19.6 12a2 2 0 0 1 2 2 2 2 0 0 1-2.2 2Z" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.35 2.35 0 1 1 3.9 1.8c-1 .9-1.6 1.2-1.6 2.7M12 17h.01" /></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></>,
  cpu: <><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3M10 10h4v4h-4z" /></>,
  memory: <><path d="M5 6h14v12H5zM2 9v6M22 9v6M8 9h2v3H8zM14 9h2v3h-2zM8 15h8" /></>,
  network: <><rect x="3" y="14" width="6" height="6" rx="1" /><rect x="15" y="4" width="6" height="6" rx="1" /><path d="M9 17h3a3 3 0 0 0 3-3V7M12 7h3M12 7l2-2M12 7l2 2" /></>,
  disk: <><path d="M4 4h16v16H4zM8 4v5h8V4M8 16h8" /><circle cx="12" cy="18" r="1" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.9-3L3 11M3 5v6h6M4 13a8 8 0 0 0 14.9 3L21 13M21 19v-6h-6" /></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  alert: <><path d="M12 3 2.8 19a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" className="icon" fill="none" height={size} viewBox="0 0 24 24" width={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{iconPaths[name]}</svg>;
}

function formatBytes(bytes: number, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
}

function formatRate(bytesPerSecond: number) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, value))}%`;
}

function formatDuration(seconds: number) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function timeAgo(iso?: string) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function Sparkline({ data, color = "#7067f0" }: { data: number[]; color?: string }) {
  const safeData = data.length > 1 ? data : [data[0] ?? 0, data[0] ?? 0];
  const min = Math.min(...safeData);
  const max = Math.max(...safeData);
  const range = max - min || 1;
  const points = safeData.map((value, index) => `${(index / (safeData.length - 1)) * 100},${26 - ((value - min) / range) * 21}`).join(" ");
  return <svg aria-hidden="true" className="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline fill="none" points={points} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.3" /></svg>;
}

function Progress({ value, tone = "purple" }: { value: number; tone?: string }) {
  return <div className={`progress-track progress-${tone}`}><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

function StatusBadge({ status }: { status: AppMetrics["status"] }) {
  const labels = { live: "Live", degraded: "Degraded", offline: "Offline", unknown: "Unknown" };
  return <span className={`status-badge status-${status}`}><span className="status-dot" />{labels[status]}</span>;
}

function MetricCard({ icon, label, value, detail, series, tone, progress }: { icon: IconName; label: string; value: string; detail: string; series: number[]; tone: string; progress?: number }) {
  return <article className="metric-card">
    <div className="metric-card-top"><div className={`metric-icon metric-icon-${tone}`}><Icon name={icon} size={17} /></div><span className="metric-label">{label}</span><span className="metric-menu">•••</span></div>
    <div className="metric-value-row"><strong>{value}</strong><div className="metric-spark"><Sparkline color={tone === "blue" ? "#6c63e9" : tone === "green" ? "#1c9a72" : tone === "orange" ? "#df8a42" : "#708093"} data={series} /></div></div>
    {progress !== undefined ? <Progress tone={tone} value={progress} /> : null}
    <div className="metric-detail">{detail}</div>
  </article>;
}

function AppRow({ app, onOpen }: { app: AppMetrics; onOpen: () => void }) {
  return <button className="app-row" onClick={onOpen} type="button">
    <div className={`app-avatar avatar-${app.accent ?? "blue"}`}><Icon name="box" size={18} /></div>
    <div className="app-row-name"><strong>{app.name}</strong><span>{app.container}{app.port ? ` · :${app.port}` : ""}</span></div>
    <StatusBadge status={app.status} />
    <div className="app-row-metric"><span>CPU</span><strong>{formatPercent(app.cpuPercent)}</strong></div>
    <div className="app-row-metric"><span>Memory</span><strong>{app.memoryBytes ? formatBytes(app.memoryBytes) : "—"}</strong></div>
    <Icon name="arrow" size={17} />
  </button>;
}

function ProcessRow({ process, maxCpu, maxMemory }: { process: ProcessMetrics; maxCpu: number; maxMemory: number }) {
  const cpuBar = maxCpu ? (process.cpuPercent / maxCpu) * 100 : 0;
  const memoryBar = maxMemory ? (process.memoryBytes / maxMemory) * 100 : 0;
  return <div className="process-row">
    <div className="process-identity" title={process.command}><strong>{process.name}</strong><span>PID {process.pid} · {process.command}</span></div>
    <div className="process-metric"><div className="process-value"><strong>{process.cpuPercent.toFixed(1)}%</strong><span>CPU</span></div><Progress tone="purple" value={cpuBar} /></div>
    <div className="process-metric"><div className="process-value"><strong>{formatBytes(process.memoryBytes)}</strong><span>{formatPercent(process.memoryPercent)} RAM</span></div><Progress tone="green" value={memoryBar} /></div>
    <span className="process-pid">{process.pid}</span>
  </div>;
}

function EmptyNotice({ dockerAvailable }: { dockerAvailable: boolean }) {
  return <div className="notice"><div className="notice-icon"><Icon name={dockerAvailable ? "settings" : "server"} size={18} /></div><div><strong>{dockerAvailable ? "No apps configured yet" : "Host metrics are ready"}</strong><p>{dockerAvailable ? "Add containers to OBSY_APPS_CONFIG_PATH to start observing them." : "Connect the Docker socket to include container-level metrics and live checks."}</p></div></div>;
}

function Overview({ data, history, onSelectTab, onSelectProcesses, onOpenApp }: { data: DashboardMetrics; history: DashboardMetrics[]; onSelectTab: () => void; onSelectProcesses: () => void; onOpenApp: (id: string) => void }) {
  const { system } = data;
  const totalNetworkRate = system.networkRxBytesPerSecond + system.networkTxBytesPerSecond;
  const recentApps = data.apps.slice(0, 4);
  const liveCount = data.apps.filter((app) => app.status === "live").length;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Infrastructure</p><h1>VPS overview</h1><p className="subheading">A real-time pulse of your server and the workloads running on it.</p></div><div className="heading-actions"><div className="last-updated"><span className="pulse-dot" />Updated {timeAgo(data.generatedAt)}</div><button className="outline-button" onClick={onSelectProcesses} type="button">View processes <Icon name="arrow" size={15} /></button><button className="outline-button" onClick={onSelectTab} type="button">View applications <Icon name="arrow" size={15} /></button></div></div>

    <div className="metric-grid">
      <MetricCard icon="cpu" label="CPU usage" value={formatPercent(system.cpuPercent)} detail={`${system.cpuCores} vCPU cores · load ${system.loadAverage.toFixed(2)}`} series={history.map((item) => item.system.cpuPercent)} tone="blue" progress={system.cpuPercent} />
      <MetricCard icon="memory" label="Memory" value={formatPercent(system.memoryPercent)} detail={`${formatBytes(system.memoryUsedBytes)} of ${formatBytes(system.memoryTotalBytes)} used`} series={history.map((item) => item.system.memoryPercent)} tone="green" progress={system.memoryPercent} />
      <MetricCard icon="network" label="Network" value={formatRate(totalNetworkRate)} detail={`↓ ${formatRate(system.networkRxBytesPerSecond)}  ↑ ${formatRate(system.networkTxBytesPerSecond)}`} series={history.map((item) => item.system.networkRxBytesPerSecond + item.system.networkTxBytesPerSecond)} tone="orange" />
      <MetricCard icon="disk" label="Disk space" value={formatPercent(system.diskPercent)} detail={`${formatBytes(system.diskUsedBytes)} of ${formatBytes(system.diskTotalBytes)} used`} series={history.map((item) => item.system.diskPercent)} tone="slate" progress={system.diskPercent} />
    </div>

    <div className="section-grid">
      <section className="panel usage-panel"><div className="panel-heading"><div><h2>Resource usage</h2><p>Current allocation across the VPS</p></div><span className="live-indicator"><span className="pulse-dot" />Live</span></div><div className="usage-list">
        <div className="usage-line"><div className="usage-label"><span className="legend-dot dot-purple" /><span>CPU</span><strong>{formatPercent(system.cpuPercent)}</strong></div><Progress tone="purple" value={system.cpuPercent} /><Sparkline data={history.map((item) => item.system.cpuPercent)} /></div>
        <div className="usage-line"><div className="usage-label"><span className="legend-dot dot-green" /><span>Memory</span><strong>{formatPercent(system.memoryPercent)}</strong></div><Progress tone="green" value={system.memoryPercent} /><Sparkline color="#1c9a72" data={history.map((item) => item.system.memoryPercent)} /></div>
        <div className="usage-line"><div className="usage-label"><span className="legend-dot dot-orange" /><span>Disk</span><strong>{formatPercent(system.diskPercent)}</strong></div><Progress tone="orange" value={system.diskPercent} /><Sparkline color="#df8a42" data={history.map((item) => item.system.diskPercent)} /></div>
        <div className="usage-line"><div className="usage-label"><span className="legend-dot dot-slate" /><span>Network</span><strong>{formatRate(totalNetworkRate)}</strong></div><Progress tone="slate" value={Math.min(100, totalNetworkRate / (1024 * 1024) * 100)} /><Sparkline color="#708093" data={history.map((item) => item.system.networkRxBytesPerSecond + item.system.networkTxBytesPerSecond)} /></div>
      </div></section>

      <section className="panel status-panel"><div className="panel-heading"><div><h2>System status</h2><p>Health at a glance</p></div><div className="server-icon"><Icon name="server" size={18} /></div></div><div className="system-status-main"><div className="status-orb"><Icon name="check" size={27} /></div><div><strong>{data.dockerAvailable ? "Everything is online" : "Host is online"}</strong><span>{data.dockerAvailable ? `${liveCount} of ${data.apps.length} apps reporting live` : "Docker connection not detected"}</span></div></div><div className="status-details"><div><span>Hostname</span><strong>{data.hostname}</strong></div><div><span>Docker engine</span><strong className={data.dockerAvailable ? "text-green" : "text-muted"}>{data.dockerAvailable ? "Connected" : "Not connected"}</strong></div><div><span>Polling interval</span><strong>5 seconds</strong></div></div></section>
    </div>

    <section className="panel apps-preview"><div className="panel-heading"><div><h2>Applications</h2><p>Containers configured for observation</p></div><button className="text-button" onClick={onSelectTab} type="button">See all <Icon name="arrow" size={15} /></button></div>{recentApps.length ? <div className="app-list">{recentApps.map((app) => <AppRow key={app.id} app={app} onOpen={() => onOpenApp(app.id)} />)}</div> : <EmptyNotice dockerAvailable={data.dockerAvailable} />}</section>
  </>;
}

function AppDetails({ app }: { app: AppMetrics }) {
  return <aside className="panel app-details"><div className="panel-heading"><div><h2>Container details</h2><p>Live snapshot</p></div><span className="details-kebab">•••</span></div><div className="details-identity"><div className={`app-avatar avatar-${app.accent ?? "blue"}`}><Icon name="box" size={20} /></div><div><strong>{app.name}</strong><span>{app.container}</span></div><StatusBadge status={app.status} /></div><div className="detail-stat-grid"><div><span>CPU</span><strong>{formatPercent(app.cpuPercent)}</strong><Progress tone="purple" value={app.cpuPercent} /></div><div><span>Memory</span><strong>{app.memoryBytes ? formatBytes(app.memoryBytes) : "—"}</strong><Progress tone="green" value={app.memoryPercent} /></div><div><span>Network in</span><strong>{formatBytes(app.networkRxBytes)}</strong></div><div><span>Network out</span><strong>{formatBytes(app.networkTxBytes)}</strong></div><div><span>Block read</span><strong>{formatBytes(app.blockReadBytes)}</strong></div><div><span>Block write</span><strong>{formatBytes(app.blockWriteBytes)}</strong></div></div><div className="detail-meta"><div><span>Image</span><strong title={app.image}>{app.image}</strong></div><div><span>Uptime</span><strong>{formatDuration(app.uptimeSeconds)}</strong></div><div><span>Restarts</span><strong>{app.restartCount}</strong></div><div><span>Health</span><strong className={app.health === "healthy" ? "text-green" : "text-muted"}>{app.health}</strong></div></div>{app.error ? <div className="detail-error"><Icon name="alert" size={15} />{app.error}</div> : null}</aside>;
}

function Applications({ data, selectedId, onSelect }: { data: DashboardMetrics; selectedId: string; onSelect: (id: string) => void }) {
  const selectedApp = data.apps.find((app) => app.id === selectedId) ?? data.apps[0];
  const liveCount = data.apps.filter((app) => app.status === "live").length;
  const cpuTotal = data.apps.reduce((total, app) => total + app.cpuPercent, 0);
  return <>
    <div className="page-heading"><div><p className="eyebrow">Workloads</p><h1>Applications</h1><p className="subheading">Monitor the Docker containers that power your services.</p></div><div className="heading-actions"><div className="config-hint"><Icon name="settings" size={15} />Configured externally</div><div className="last-updated"><span className="pulse-dot" />Updated {timeAgo(data.generatedAt)}</div></div></div>
    <div className="app-summary"><div><span>Observed apps</span><strong>{data.apps.length}</strong></div><div><span>Reporting live</span><strong className="text-green">{liveCount}</strong></div><div><span>Combined CPU</span><strong>{formatPercent(cpuTotal)}</strong></div><div><span>Docker engine</span><strong className={data.dockerAvailable ? "text-green" : "text-muted"}>{data.dockerAvailable ? "Connected" : "Unavailable"}</strong></div></div>
    {!data.dockerAvailable ? <EmptyNotice dockerAvailable={false} /> : null}
    {data.apps.length ? <div className="applications-layout"><section className="panel all-apps"><div className="panel-heading"><div><h2>All applications</h2><p>Auto-refreshing every 5 seconds</p></div><span className="app-count">{data.apps.length} total</span></div><div className="app-list">{data.apps.map((app) => <AppRow key={app.id} app={app} onOpen={() => onSelect(app.id)} />)}</div></section>{selectedApp ? <AppDetails app={selectedApp} /> : null}</div> : null}
  </>;
}

function Processes({ data }: { data: DashboardMetrics }) {
  const [sortBy, setSortBy] = useState<ProcessSort>("cpu");
  const processes = useMemo(() => [...data.processes].sort((a, b) => sortBy === "cpu" ? b.cpuPercent - a.cpuPercent : b.memoryBytes - a.memoryBytes), [data.processes, sortBy]);
  const topCpu = data.processes.reduce<ProcessMetrics | undefined>((top, process) => !top || process.cpuPercent > top.cpuPercent ? process : top, undefined);
  const topMemory = data.processes.reduce<ProcessMetrics | undefined>((top, process) => !top || process.memoryBytes > top.memoryBytes ? process : top, undefined);
  const maxCpu = processes.reduce((max, process) => Math.max(max, process.cpuPercent), 0);
  const maxMemory = processes.reduce((max, process) => Math.max(max, process.memoryBytes), 0);

  return <>
    <div className="page-heading"><div><p className="eyebrow">Host activity</p><h1>Processes</h1><p className="subheading">The processes using the most CPU time and memory on your VPS.</p></div><div className="heading-actions"><div className="last-updated"><span className="pulse-dot" />Updated {timeAgo(data.generatedAt)}</div></div></div>
    <div className="process-summary"><div><span>Displayed processes</span><strong>{data.processes.length}</strong></div><div><span>Highest CPU</span><strong>{topCpu ? `${topCpu.cpuPercent.toFixed(1)}%` : "—"}</strong></div><div><span>Highest memory</span><strong>{topMemory ? formatBytes(topMemory.memoryBytes) : "—"}</strong></div><div><span>Refresh rate</span><strong>5 seconds</strong></div></div>
    <section className="panel process-panel"><div className="panel-heading process-panel-heading"><div><h2>Top processes</h2><p>Live readings from the last polling interval</p></div><div aria-label="Sort processes" className="process-tabs" role="tablist"><button aria-selected={sortBy === "cpu"} className={sortBy === "cpu" ? "process-tab active" : "process-tab"} onClick={() => setSortBy("cpu")} role="tab" type="button">CPU usage</button><button aria-selected={sortBy === "memory"} className={sortBy === "memory" ? "process-tab active" : "process-tab"} onClick={() => setSortBy("memory")} role="tab" type="button">Memory usage</button></div></div>{processes.length ? <div className="process-table"><div className="process-table-header"><span>Process</span><span>CPU</span><span>Memory</span><span>PID</span></div>{processes.map((process) => <ProcessRow key={process.pid} maxCpu={maxCpu} maxMemory={maxMemory} process={process} />)}</div> : <div className="notice"><div className="notice-icon"><Icon name="server" size={18} /></div><div><strong>Process metrics are unavailable</strong><p>Obsy could not read the host process list. Make sure the host /proc filesystem is mounted and readable.</p></div></div>}</section>
  </>;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [history, setHistory] = useState<DashboardMetrics[]>([]);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/metrics", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load metrics");
      const nextData = (await response.json()) as DashboardMetrics;
      setData(nextData);
      setHistory((current) => [...current, nextData].slice(-18));
      setSelectedAppId((current) => current || nextData.apps[0]?.id || "");
      setError("");
    } catch {
      setError("Metrics could not be refreshed. Retrying automatically.");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const displayHistory = useMemo(() => history.length ? history : data ? [data] : [], [data, history]);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><span /></div><span>obsy</span><small>beta</small></div><div className="sidebar-label">Workspace</div><nav className="main-nav" aria-label="Main navigation"><button className={activeTab === "overview" ? "nav-item active" : "nav-item"} onClick={() => setActiveTab("overview")} type="button"><Icon name="grid" size={18} />Overview</button><button className={activeTab === "apps" ? "nav-item active" : "nav-item"} onClick={() => setActiveTab("apps")} type="button"><Icon name="box" size={18} />Applications</button><button className={activeTab === "processes" ? "nav-item active" : "nav-item"} onClick={() => setActiveTab("processes")} type="button"><Icon name="cpu" size={18} />Processes</button></nav><div className="sidebar-bottom"><button className="nav-item" type="button"><Icon name="settings" size={18} />Settings</button><button className="nav-item" type="button"><Icon name="help" size={18} />Help center</button><div className="sidebar-divider" /><div className="account"><div className="account-avatar">G</div><div><strong>George</strong><span>Administrator</span></div><span className="account-dots">•••</span></div></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>Production VPS</strong></div><div className="topbar-actions"><div className="server-chip"><span className="pulse-dot" />{data?.hostname ?? "production-vps"}</div><button aria-label="Refresh metrics" className={`icon-button ${isRefreshing ? "spinning" : ""}`} onClick={() => void refresh()} type="button"><Icon name="refresh" size={17} /></button><div className="top-avatar">G</div></div></header><div className="content-wrap">{error ? <div className="error-banner"><Icon name="alert" size={16} />{error}</div> : null}{data ? activeTab === "overview" ? <Overview data={data} history={displayHistory} onSelectProcesses={() => setActiveTab("processes")} onSelectTab={() => setActiveTab("apps")} onOpenApp={(id) => { setSelectedAppId(id); setActiveTab("apps"); }} /> : activeTab === "apps" ? <Applications data={data} selectedId={selectedAppId} onSelect={setSelectedAppId} /> : <Processes data={data} /> : <div className="loading-state"><div className="loading-mark"><span /></div><strong>Connecting to your VPS</strong><span>Collecting the first snapshot…</span></div>}</div></main>
  </div>;
}
