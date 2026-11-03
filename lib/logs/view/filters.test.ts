import { describe, expect, it } from "vitest";
import {
  canGoLive,
  containerLogsHref,
  EMPTY_FILTERS,
  effectiveSince,
  filtersToHref,
  filtersToParams,
  isLive,
  parseFilters,
  readQuery,
  requestSearchHref,
  sameFilters,
  streamQuery,
  validateFilters,
} from "./filters";

const parse = (query: string) => parseFilters(new URLSearchParams(query));

describe("parseFilters and filtersToParams", () => {
  it("reads every filter from the URL", () => {
    expect(parse("container=expense-tracker&since=15m&level=warn&q=timeout&requestId=3fK9xQ2mBv0a&event=request&live=1")).toEqual({
      container: "expense-tracker",
      since: "15m",
      level: "warn",
      q: "timeout",
      requestId: "3fK9xQ2mBv0a",
      event: "request",
      live: true,
    });
  });

  it("round-trips through the URL", () => {
    const filters = { container: "expense-tracker", since: "today", level: "error" as const, q: "a b&c=d", requestId: "tick-AbC123_-xyz", event: "tick", live: true };
    expect(parseFilters(filtersToParams(filters))).toEqual(filters);
  });

  it("leaves empty filters out of the URL", () => {
    expect(filtersToHref(EMPTY_FILTERS)).toBe("/logs");
    expect(filtersToHref({ ...EMPTY_FILTERS, container: "expense-tracker" })).toBe("/logs?container=expense-tracker");
  });

  it("drops values that cannot be valid instead of passing them on", () => {
    expect(parse("container=a/b&since=yesterday&level=loud&event=has space&live=yes")).toEqual(EMPTY_FILTERS);
    expect(parse("since=1h;rm")).toEqual(EMPTY_FILTERS);
    expect(parse("level=")).toEqual(EMPTY_FILTERS);
    expect(parse("level=debug").level).toBe("");
  });

  it("accepts relative, today and ISO since values", () => {
    expect(parse("since=3d").since).toBe("3d");
    expect(parse("since=today").since).toBe("today");
    expect(parse("since=2026-11-03T09:00:00Z").since).toBe("2026-11-03T09:00:00Z");
    expect(parse("since=2026-11-03T09:00:00%2B02:00").since).toBe("2026-11-03T09:00:00+02:00");
  });

  it("caps the text search at the API's limit and trims", () => {
    expect(parse(`q=${"x".repeat(150)}`).q).toHaveLength(100);
    expect(parse("q=%20%20spaced%20%20").q).toBe("spaced");
  });

  it("compares filters by their URL", () => {
    expect(sameFilters(parse("container=a&since=1h"), { ...EMPTY_FILTERS, container: "a", since: "1h" })).toBe(true);
    expect(sameFilters(parse("container=a"), parse("container=b"))).toBe(false);
  });
});

describe("effectiveSince", () => {
  it("defaults to an hour for an app and to 3 days for a request-id search across apps", () => {
    expect(effectiveSince({ ...EMPTY_FILTERS, container: "a" })).toBe("1h");
    expect(effectiveSince({ ...EMPTY_FILTERS, requestId: "abc" })).toBe("3d");
    expect(effectiveSince({ ...EMPTY_FILTERS, container: "a", requestId: "abc" })).toBe("1h");
    expect(effectiveSince({ ...EMPTY_FILTERS, requestId: "abc", since: "15m" })).toBe("15m");
  });
});

describe("validateFilters", () => {
  const apps = ["expense-tracker", "expense-tracker-worker"];

  it("tells an app search, a search across apps and nothing-to-run apart", () => {
    expect(validateFilters({ ...EMPTY_FILTERS, container: "expense-tracker" }, apps)).toEqual({ ok: true, mode: "app" });
    expect(validateFilters({ ...EMPTY_FILTERS, requestId: "3fK9xQ2mBv0a" }, apps)).toEqual({ ok: true, mode: "all" });
    expect(validateFilters(EMPTY_FILTERS, apps)).toEqual({ ok: true, mode: "idle" });
  });

  it("rejects an unknown app and a malformed request id", () => {
    expect(validateFilters({ ...EMPTY_FILTERS, container: "nope" }, apps).ok).toBe(false);
    expect(validateFilters({ ...EMPTY_FILTERS, container: "expense-tracker", requestId: "bad id!" }, apps).ok).toBe(false);
  });
});

describe("queries for the API", () => {
  it("builds the read query with an explicit since", () => {
    expect(readQuery({ ...EMPTY_FILTERS, container: "expense-tracker", level: "error", q: "a&b" })).toBe("container=expense-tracker&since=1h&level=error&q=a%26b");
    expect(readQuery({ ...EMPTY_FILTERS, requestId: "3fK9xQ2mBv0a" })).toBe("since=3d&requestId=3fK9xQ2mBv0a");
  });

  it("builds the stream query without a time range", () => {
    expect(streamQuery({ ...EMPTY_FILTERS, container: "expense-tracker", since: "3d", level: "warn", requestId: "abc" })).toBe("container=expense-tracker&level=warn&requestId=abc");
  });

  it("only goes live for a single container", () => {
    expect(canGoLive({ ...EMPTY_FILTERS, requestId: "abc" })).toBe(false);
    expect(isLive({ ...EMPTY_FILTERS, requestId: "abc", live: true })).toBe(false);
    expect(isLive({ ...EMPTY_FILTERS, container: "expense-tracker", live: true })).toBe(true);
  });
});

describe("links", () => {
  it("links the dashboard card to the last hour of that app", () => {
    expect(containerLogsHref("expense-tracker")).toBe("/logs?container=expense-tracker&since=1h");
    expect(containerLogsHref("a b")).toBe("/logs?container=a+b&since=1h");
  });

  it("builds a request search link only from ids matching the API's pattern", () => {
    expect(requestSearchHref("3fK9xQ2mBv0a")).toBe("/logs?requestId=3fK9xQ2mBv0a");
    expect(requestSearchHref("tick-AbC123_-xyz")).toBe("/logs?requestId=tick-AbC123_-xyz");
    for (const bad of ["", "has space", "a/b", "a&b=c", "javascript:alert(1)", "<script>", "x".repeat(65), undefined, null, 42, {}, ["abc"]]) {
      expect(requestSearchHref(bad)).toBeNull();
    }
  });
});
