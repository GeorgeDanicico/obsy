import { describe, expect, it } from "vitest";
import { applyMessages, createSseParser, describeEnd, endReason, initialTail, pauseTail, resumeTail, TAIL_CAP, type SseMessage, type TailState } from "./tail";

function data(n: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ts: `2026-11-03T09:00:00.${String(n).padStart(3, "0")}Z`, container: "expense-tracker", stream: "stdout", level: "info", event: "request", fields: { n }, ...extra });
}
const message = (n: number): SseMessage => ({ event: "message", data: data(n) });
const numbers = (state: TailState) => state.rows.map((row) => (row.line.fields as { n: number }).n);

describe("createSseParser", () => {
  function run(chunks: string[]) {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    for (const chunk of chunks) parser.push(chunk);
    return messages;
  }

  it("parses data events, comments and the end event", () => {
    expect(run([": connected\n\ndata: {\"a\":1}\n\n: ping\n\nevent: end\ndata: {\"reason\":\"timeout\"}\n\n"])).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "end", data: '{"reason":"timeout"}' },
    ]);
  });

  it("handles events split across chunks, at any byte", () => {
    const text = 'data: {"a":1}\n\nevent: end\ndata: {"reason":"exited"}\n\n';
    const whole = run([text]);
    for (let cut = 1; cut < text.length; cut += 1) expect(run([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
    expect(run([...text].map((char) => char))).toEqual(whole);
  });

  it("accepts CRLF and joins multi-line data", () => {
    expect(run(["data: a\r\ndata: b\r\n\r\n"])).toEqual([{ event: "message", data: "a\nb" }]);
    expect(run(["data: a\r", "\n\r", "\ndata: c\n\n"])).toEqual([{ event: "message", data: "a" }, { event: "message", data: "c" }]);
  });

  it("drops events without data and ignores unknown fields", () => {
    expect(run(["event: end\n\nid: 5\nretry: 10\ndata: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("gives up on an event that never ends instead of growing without bound", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.push("data: " + "x".repeat(300 * 1024));
    parser.push("\n\ndata: ok\n\n");
    expect(messages).toEqual([{ event: "message", data: "ok" }]);
  });
});

describe("applyMessages", () => {
  it("puts new lines on top", () => {
    const { state, close } = applyMessages(initialTail(), [message(1), message(2), message(3)]);
    expect(numbers(state)).toEqual([3, 2, 1]);
    expect(close).toBe(false);
    const next = applyMessages(state, [message(4)]).state;
    expect(numbers(next)).toEqual([4, 3, 2, 1]);
    expect(new Set(next.rows.map((row) => row.id)).size).toBe(4);
  });

  it("keeps at most 1000 rows, dropping the oldest", () => {
    let state = initialTail();
    for (let batch = 0; batch < 3; batch += 1) {
      state = applyMessages(state, Array.from({ length: 400 }, (_, i) => message(batch * 400 + i))).state;
    }
    expect(state.rows).toHaveLength(TAIL_CAP);
    expect(numbers(state)[0]).toBe(1199);
    expect(numbers(state)[TAIL_CAP - 1]).toBe(200);
  });

  it("caps a single batch larger than the limit", () => {
    const { state } = applyMessages(initialTail(), Array.from({ length: 1500 }, (_, i) => message(i)));
    expect(state.rows).toHaveLength(TAIL_CAP);
    expect(numbers(state)[0]).toBe(1499);
  });

  it("an end event closes the stream, records the reason and ignores what follows", () => {
    const { state, close } = applyMessages(initialTail(), [message(1), { event: "end", data: '{"reason":"timeout"}' }, message(2)]);
    expect(close).toBe(true);
    expect(state.ended).toBe("timeout");
    expect(numbers(state)).toEqual([1]);
  });

  it("skips malformed lines and unknown events", () => {
    const { state, close } = applyMessages(initialTail(), [
      { event: "message", data: "not json" },
      { event: "message", data: '{"ts":1}' },
      { event: "message", data: '"text"' },
      { event: "other", data: data(9) },
      message(1),
    ]);
    expect(numbers(state)).toEqual([1]);
    expect(close).toBe(false);
  });

  it("collects lines while paused and shows them on resume", () => {
    let state = applyMessages(initialTail(), [message(1)]).state;
    state = pauseTail(state);
    state = applyMessages(state, [message(2), message(3)]).state;
    expect(numbers(state)).toEqual([1]);
    expect(state.pending).toHaveLength(2);
    state = resumeTail(state);
    expect(numbers(state)).toEqual([3, 2, 1]);
    expect(state.pending).toEqual([]);
    expect(state.paused).toBe(false);
  });

  it("caps what is held while paused and after resuming", () => {
    let state = pauseTail(applyMessages(initialTail(), [message(0)]).state);
    state = applyMessages(state, Array.from({ length: 1200 }, (_, i) => message(i + 1))).state;
    expect(state.pending).toHaveLength(TAIL_CAP);
    state = resumeTail(state);
    expect(state.rows).toHaveLength(TAIL_CAP);
    expect(numbers(state)[0]).toBe(1200);
  });

  it("an end event while paused still ends it", () => {
    const state = pauseTail(initialTail());
    expect(applyMessages(state, [{ event: "end", data: '{"reason":"exited"}' }]).close).toBe(true);
  });
});

describe("end reasons", () => {
  it("reads the reason and falls back to unknown", () => {
    expect(endReason('{"reason":"not_found"}')).toBe("not_found");
    expect(endReason("{}")).toBe("unknown");
    expect(endReason("nope")).toBe("unknown");
    expect(endReason('{"reason":"<script>"}')).toBe("unknown");
  });

  it("describes each reason", () => {
    for (const reason of ["timeout", "exited", "not_found", "failed", "unknown"]) expect(describeEnd(reason)).toMatch(/\S/);
    expect(describeEnd("timeout")).toMatch(/15 minutes/);
  });
});
