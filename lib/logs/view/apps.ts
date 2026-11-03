import { logSources, type ConfiguredApp } from "../params";

/** What the Logs page may know about an app: its id and a display name, nothing else from the config. */
export type LogApp = { id: string; name: string };

/** The apps the logs API will serve, in config order, with the id as the name when there is none. */
export function logApps(configured: (ConfiguredApp & { name?: unknown })[]): LogApp[] {
  const names = new Map<string, unknown>();
  for (const app of configured) if (app && typeof app.id === "string" && !names.has(app.id)) names.set(app.id, app.name);
  return logSources(configured).map(({ id }) => {
    const name = names.get(id);
    return { id, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : id };
  });
}
