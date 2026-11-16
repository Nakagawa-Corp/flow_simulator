// bitFlyer BTC/JPY execution windows. Times are UTC internally.
type Side = "BUY" | "SELL" | "";
type Execution = { id: number; side: Side; price: number; size: number; t: number };

const WINDOWS = [15, 30, 60, 240] as const;
const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const MAX_PAGES = 24;
const PAGE_SIZE = 500;
const API = "https://api.bitflyer.com/v1";

function utcMillis(value: unknown): number {
  if (typeof value !== "string") return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value + "Z");
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function fetchJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(API + path, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`bitFlyer HTTP ${response.status}`);
  return response.json();
}

export async function fetchExecutions(signal: AbortSignal): Promise<Execution[]> {
  const executions = new Map<number, Execution>();
  let before: number | undefined;
  let oldest = Infinity;
  let latest = -Infinity;

  for (let index = 0; index < MAX_PAGES; index++) {
    const path = `/executions?product_code=BTC_JPY&count=${PAGE_SIZE}` +
      (before === undefined ? "" : `&before=${before}`);
    const page = await fetchJson(path, signal);
    if (!Array.isArray(page) || page.length > PAGE_SIZE) {
      throw new Error("bitFlyerの約定応答が不正です。");
    }
    if (page.length === 0) break;

    let cursor = Infinity;
    for (const raw of page) {
      const e = raw as { id?: number; side?: unknown; price?: unknown; size?: unknown; exec_date?: unknown } | null;
      const t = utcMillis(e?.exec_date);
      if (!e || !positiveNumber(e.id) || !Number.isSafeInteger(e.id) ||
          (e.side !== "BUY" && e.side !== "SELL" && e.side !== "") ||
          !positiveNumber(e.price) || !positiveNumber(e.size) || !Number.isFinite(t)) {
        throw new Error("bitFlyerの約定に不正な値があります。");
      }
      cursor = Math.min(cursor, e.id);
      executions.set(e.id, { id: e.id, side: e.side, price: e.price, size: e.size, t });
      oldest = Math.min(oldest, t);
      latest = Math.max(latest, t);
    }
    if (before !== undefined && cursor >= before) {
      throw new Error("bitFlyerのページングが進みませんでした。");
    }
    if (latest - oldest >= 240 * MINUTE + BUCKET || page.length < PAGE_SIZE) break;
    before = cursor;
  }

  return [...executions.values()].sort((a, b) => a.t - b.t || a.id - b.id);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) return null;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2;
}

type WindowStats = {
  minutes: number;
  complete: boolean;
  buyRatio: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  buyEffTotal: number;
  sellEffTotal: number;
  buyEffMedian: number | null;
  sellEffMedian: number | null;
  high: number;
  low: number;
  firstPrice: number;
  lastPrice: number;
  rangePosition: number;
  reboundFromLow: number;
  dropFromHigh: number;
};

export function computeWindow(execs: Execution[], minutes: number, endT: number): WindowStats | null {
  const startT = endT - minutes * MINUTE;
  const w = execs.filter((e) => e.t > startT && e.t <= endT);
  if (w.length === 0) return null;

  let buyVolume = 0;
  let sellVolume = 0;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const e of w) {
    if (e.side === "BUY") buyVolume += e.size;
    else if (e.side === "SELL") sellVolume += e.size;
    if (e.price > high) high = e.price;
    if (e.price < low) low = e.price;
  }
  const volume = buyVolume + sellVolume;
  const first = w[0];
  const last = w[w.length - 1];
  if (!first || !last || volume <= 0) return null;

  // 5-minute buckets: attribute each bucket's price change to its dominant
  // side (bucket taker buy ratio > 50% -> buy side).
  type Bucket = {
    firstPrice: number;
    lastPrice: number;
    buyVolume: number;
    sellVolume: number;
  };
  const buckets = new Map<number, Bucket>();
  for (const e of w) {
    const key = Math.floor(e.t / (BUCKET));
    let b = buckets.get(key);
    if (!b) {
      b = { firstPrice: e.price, lastPrice: e.price, buyVolume: 0, sellVolume: 0 };
      buckets.set(key, b);
    }
    b.lastPrice = e.price;
    if (e.side === "BUY") b.buyVolume += e.size;
    else if (e.side === "SELL") b.sellVolume += e.size;
  }
  let buyDeltaSum = 0;
  let buyDomVol = 0;
  let sellDeltaSum = 0;
  let sellDomVol = 0;
  const buyBucketEffs: number[] = [];
  const sellBucketEffs: number[] = [];
  for (const b of buckets.values()) {
    const delta = b.lastPrice - b.firstPrice;
    const bVol = b.buyVolume + b.sellVolume;
    if (bVol <= 0 || b.buyVolume === b.sellVolume) continue;
    if (b.buyVolume / bVol > 0.5) {
      buyDeltaSum += delta;
      buyDomVol += b.buyVolume;
      if (b.buyVolume > 0) buyBucketEffs.push(delta / b.buyVolume);
    } else {
      sellDeltaSum += delta;
      sellDomVol += b.sellVolume;
      if (b.sellVolume > 0) sellBucketEffs.push(-delta / b.sellVolume);
    }
  }

  const range = high - low;
  return {
    minutes,
    complete: (execs[0]?.t ?? Infinity) <= startT,
    buyRatio: (buyVolume / volume) * 100,
    volume,
    buyVolume,
    sellVolume,
    buyEffTotal: buyDomVol > 0 ? buyDeltaSum / buyDomVol : 0,
    sellEffTotal: sellDomVol > 0 ? -sellDeltaSum / sellDomVol : 0,
    buyEffMedian: median(buyBucketEffs),
    sellEffMedian: median(sellBucketEffs),
    high,
    low,
    firstPrice: first.price,
    lastPrice: last.price,
    rangePosition: range > 0 ? (last.price - low) / range : 0.5,
    reboundFromLow: last.price - low,
    dropFromHigh: high - last.price,
  };
}

// ATR is the simple mean of 14 true ranges of completed 5-minute bars.
export function computeAtr5(execs: Execution[], endT: number): number | null {
  const end = Math.floor(endT / BUCKET) * BUCKET;
  const start = end - 14 * BUCKET;
  const bars = new Map<number, { high: number; low: number; close: number }>();
  let previousClose: number | undefined;
  for (const e of execs) {
    if (e.t < start) {
      previousClose = e.price;
      continue;
    }
    if (e.t >= end) break;
    const key = Math.floor(e.t / BUCKET) * BUCKET;
    const bar = bars.get(key);
    bars.set(key, {
      high: Math.max(bar?.high ?? e.price, e.price),
      low: Math.min(bar?.low ?? e.price, e.price),
      close: e.price,
    });
  }
  if (previousClose === undefined) return null;

  let total = 0;
  for (let t = start; t < end; t += BUCKET) {
    const bar = bars.get(t);
    if (!bar) continue; // No executions: carry the previous close forward (true range = 0).
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    previousClose = bar.close;
  }
  return total / 14;
}

type Ticker = { ltp: number; bestBid: number; bestAsk: number; timestampIso: string };
type Coverage = { fromIso: string; toIso: string; count: number };

export type FlowResponse =
  | { status: "ok"; fetchedAtIso: string; ticker: Ticker; coverage: Coverage; windows: WindowStats[]; atr5: number | null }
  | { status: "unavailable"; fetchedAtIso: string; message: string };

async function loadFlow(): Promise<FlowResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const [raw, execs] = await Promise.all([
      fetchJson("/ticker?product_code=BTC_JPY", controller.signal),
      fetchExecutions(controller.signal),
    ]);
    const ticker = raw as { ltp?: unknown; best_bid?: unknown; best_ask?: unknown; timestamp?: unknown } | null;
    const tickerTime = utcMillis(ticker?.timestamp);
    const first = execs[0];
    const last = execs.at(-1);
    const now = Date.now();
    if (!ticker || !positiveNumber(ticker.ltp) || !positiveNumber(ticker.best_bid) ||
        !positiveNumber(ticker.best_ask) || !Number.isFinite(tickerTime) || !first || !last) {
      throw new Error("bitFlyerから有効な価格・約定を取得できませんでした。");
    }
    if (Math.abs(now - tickerTime) > BUCKET || Math.abs(now - last.t) > BUCKET) {
      throw new Error("bitFlyerの価格または最新約定が現在時刻から5分以上離れています。");
    }
    const windows = WINDOWS.flatMap((minutes) => computeWindow(execs, minutes, last.t) ?? []);
    return {
      status: "ok",
      fetchedAtIso: new Date(now).toISOString(),
      ticker: {
        ltp: ticker.ltp,
        bestBid: ticker.best_bid,
        bestAsk: ticker.best_ask,
        timestampIso: new Date(tickerTime).toISOString(),
      },
      coverage: {
        fromIso: new Date(first.t).toISOString(),
        toIso: new Date(last.t).toISOString(),
        count: execs.length,
      },
      windows,
      atr5: computeAtr5(execs, last.t),
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      status: "unavailable",
      fetchedAtIso: new Date().toISOString(),
      message: timedOut ? "bitFlyerへの接続がタイムアウトしました。"
        : error instanceof Error ? error.message : "bitFlyerへの接続に失敗しました。",
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

let inFlight: Promise<FlowResponse> | undefined;
let cache: { data: FlowResponse; expires: number } | undefined;

export function getFlow(): Promise<FlowResponse> {
  if (cache && cache.expires > Date.now()) return Promise.resolve(cache.data);
  inFlight ??= loadFlow().then((data) => {
    cache = { data, expires: Date.now() + 55_000 };
    return data;
  }).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
