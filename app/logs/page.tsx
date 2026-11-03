import os from "node:os";
import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/app/components/shell";
import { logApps } from "@/lib/logs/view/apps";
import { readConfiguredApps } from "@/lib/metrics";
import { LogsView } from "./logs-view";

// The apps come from a config file read at run time, so this page can't be built ahead of time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Logs — Obsy",
};

export default async function LogsPage() {
  // Only ids and display names reach the browser, not ports, health URLs or container names.
  const apps = logApps(await readConfiguredApps());
  return <AppShell active="logs" hostname={process.env.OBSY_HOSTNAME ?? os.hostname()}>
    <Suspense fallback={<div className="loading-state"><div className="loading-mark"><span /></div><strong>Loading logs</strong></div>}>
      <LogsView apps={apps} />
    </Suspense>
  </AppShell>;
}
