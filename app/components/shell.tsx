"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export type NavKey = "overview" | "apps" | "processes" | "logs";
export type DashboardTab = Exclude<NavKey, "logs">;

const tabs: { key: DashboardTab; label: string; icon: IconName }[] = [
  { key: "overview", label: "Overview", icon: "grid" },
  { key: "apps", label: "Applications", icon: "box" },
  { key: "processes", label: "Processes", icon: "cpu" },
];

type AppShellProps = {
  active: NavKey;
  /** The dashboard switches its own tabs; other pages leave this out and the tabs link to `/`. */
  onSelectTab?: (tab: DashboardTab) => void;
  hostname?: string;
  /** Shows the refresh button in the top bar. */
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
};

/** The sidebar and top bar shared by the dashboard and the Logs page. */
export function AppShell({ active, onSelectTab, hostname, onRefresh, refreshing = false, children }: AppShellProps) {
  const className = (key: NavKey) => (active === key ? "nav-item active" : "nav-item");
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><span /></div><span>obsy</span><small>beta</small></div><div className="sidebar-label">Workspace</div><nav className="main-nav" aria-label="Main navigation">{tabs.map((tab) => onSelectTab
      ? <button className={className(tab.key)} key={tab.key} onClick={() => onSelectTab(tab.key)} type="button"><Icon name={tab.icon} size={18} />{tab.label}</button>
      : <Link className={className(tab.key)} href="/" key={tab.key}><Icon name={tab.icon} size={18} />{tab.label}</Link>)}<Link aria-current={active === "logs" ? "page" : undefined} className={className("logs")} href="/logs"><Icon name="logs" size={18} />Logs</Link></nav><div className="sidebar-bottom"><button className="nav-item" type="button"><Icon name="settings" size={18} />Settings</button><button className="nav-item" type="button"><Icon name="help" size={18} />Help center</button><div className="sidebar-divider" /><div className="account"><div className="account-avatar">G</div><div><strong>George</strong><span>Administrator</span></div><span className="account-dots">•••</span></div></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>Production VPS</strong></div><div className="topbar-actions"><div className="server-chip"><span className="pulse-dot" />{hostname ?? "production-vps"}</div>{onRefresh ? <button aria-label="Refresh metrics" className={`icon-button ${refreshing ? "spinning" : ""}`} onClick={onRefresh} type="button"><Icon name="refresh" size={17} /></button> : null}<div className="top-avatar">G</div></div></header><div className="content-wrap">{children}</div></main>
  </div>;
}
