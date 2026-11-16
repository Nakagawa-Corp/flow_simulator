import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAtr5, computeWindow, fetchExecutions, getFlow } from "../server/src/flow.ts";

const minute = 60_000;
const end = Date.UTC(2026, 10, 16, 6);
const execution = (t: number, id: number, price: number, side: "BUY" | "SELL" | "" = "BUY") =>
  ({ t, id, price, side, size: 1 });

test("a short tape does not count as a complete 4-hour window", () => {
  const rows = [execution(end - 60 * minute, 1, 100), execution(end, 2, 120)];
  assert.equal(computeWindow(rows, 240, end)?.complete, false);
  assert.equal(computeWindow(rows, 60, end)?.complete, true);
});

test("tied buckets and directionless executions do not inflate sell efficiency", () => {
  const rows = [
    execution(end - 15 * minute, 1, 100),
    execution(end - 4 * minute, 2, 100),
    execution(end - 3 * minute, 3, 98, "SELL"),
    execution(end - 2 * minute, 4, 97, ""),
  ];
  const window = computeWindow(rows, 15, end);
  assert.equal(window?.buyRatio, 50);
  assert.equal(window?.volume, 2);
  assert.equal(window?.sellEffMedian, null);
});

test("ATR needs prior coverage and excludes the running 5-minute bar", () => {
  const rows = [execution(end - 75 * minute, 0, 100)];
  for (let i = 0; i < 14; i++) {
    rows.push(execution(end - (70 - i * 5) * minute, i + 1, 101 + i));
  }
  rows.push(execution(end, 15, 999));
  assert.equal(computeAtr5(rows, end), 1);
  assert.equal(computeAtr5(rows.slice(1), end), null);
});

test("pagination stops at the hard cap even with an overlapping execution", async (context) => {
  let pages = 0;
  context.mock.method(globalThis, "fetch", async () => {
    const highestId = 20000 - pages++ * 499;
    return Response.json(Array.from({ length: 500 }, (_, index) => ({
      id: highestId - index, side: "BUY", price: 100, size: 1,
      exec_date: new Date(end - (pages * 500 + index) * 10).toISOString(),
    })));
  });
  const rows = await fetchExecutions(AbortSignal.timeout(5_000));
  assert.equal(pages, 24);
  assert.equal(rows.length, 12000 - 23);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test("concurrent clients share one upstream request pair and get the cached result", async (context) => {
  const now = new Date().toISOString();
  const fetchMock = context.mock.method(globalThis, "fetch", async (path: string) => (
    path.includes("/ticker")
      ? Response.json({ ltp: 100, best_bid: 99, best_ask: 101, timestamp: now })
      : Response.json([{ id: 1, price: 100, size: 1, side: "BUY", exec_date: now }])
  ));
  const [first, second] = await Promise.all([getFlow(), getFlow()]);
  assert.equal(first.status, "ok");
  assert.equal(second, first);
  assert.equal(await getFlow(), first);
  assert.equal(fetchMock.mock.callCount(), 2);
});
