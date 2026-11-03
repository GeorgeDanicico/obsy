import { describe, expect, it } from "vitest";
import { logApps } from "./apps";

describe("logApps", () => {
  it("keeps only ids and names of apps the logs API accepts", () => {
    const apps = logApps([
      { id: "expense-tracker", name: "Expense Tracker", container: "expense-tracker-web", port: 3000, healthUrl: "http://internal:3000/health" } as never,
      { id: "worker", container: "expense-tracker-worker" },
      { id: "bad id", name: "Nope", container: "x" },
      { id: "expense-tracker", name: "Duplicate", container: "other" },
      { id: "flag", name: "Flag", container: "--all" },
    ]);
    expect(apps).toEqual([
      { id: "expense-tracker", name: "Expense Tracker" },
      { id: "worker", name: "worker" },
    ]);
  });
});
