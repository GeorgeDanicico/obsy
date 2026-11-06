import type { ReactNode } from "react";

export type IconName = "grid" | "box" | "settings" | "server" | "cpu" | "memory" | "network" | "disk" | "refresh" | "arrow" | "external" | "check" | "alert" | "clock" | "logs";

const iconPaths: Record<IconName, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.3 7.6 7.7 4.3 7.7-4.3M12 12v9" /></>,
  settings: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.3a2 2 0 0 1-4 0v-.2A2 2 0 0 0 5.8 18l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 12a2 2 0 0 1 2-2h.2A2 2 0 0 0 5.2 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 12 2.4a2 2 0 0 1 2 2v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1A2 2 0 0 0 19.6 12a2 2 0 0 1 2 2 2 2 0 0 1-2.2 2Z" /></>,
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
  logs: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" className="icon" fill="none" height={size} viewBox="0 0 24 24" width={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{iconPaths[name]}</svg>;
}
