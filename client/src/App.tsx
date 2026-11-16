import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FlowResponse } from "../../server/src/flow.ts";
import { getFlow } from "./api";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Level } from "./settings";

type WinStats = Extract<FlowResponse, { status: "ok" }>["windows"][number];

type ScenarioKey = "sell" | "balance" | "buy";
type HorizonKey = "1h" | "4h" | "target";
type Band = { low: number; high: number };
type MethodSim = {
  totalVolume: number;
  buyOneWay: number;
  sellOneWay: number;
  reachUp: number;
  reachDown: number;
  bands: Record<ScenarioKey, Band>;
};

const SCENARIOS: { key: ScenarioKey; name: string; color: string }[] = [
  { key: "sell", name: "売り継続", color: "var(--sell)" },
  { key: "balance", name: "拮抗", color: "#8a97a8" },
  { key: "buy", name: "買い継続", color: "var(--buy)" },
];

const WINDOW_LABELS: Record<number, string> = {
  15: "15分",
  30: "30分",
  60: "1時間",
  240: "4時間",
};
const TILT_WEIGHTS: Record<number, number> = { 15: 1, 30: 2, 60: 3, 240: 4 };

// ---------------------------------------------------------------------------
// Formatting helpers (all displayed times are JST)

const jstTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const jstTimeSec = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const jstHourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  hour: "numeric",
  hourCycle: "h23",
});

function fmtPrice(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}
function fmtSigned(n: number): string {
  const r = Math.round(n);
  return `${r > 0 ? "+" : ""}${r.toLocaleString("ja-JP")}`;
}
function fmtBtc(n: number): string {
  return n.toLocaleString("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function jstHour(d: Date): number {
  return parseInt(jstHourFmt.format(d), 10) % 24;
}
function minutesToTarget(fromMs: number): number {
  const jstMs = fromMs + 9 * 3600 * 1000;
  const jst = new Date(jstMs);
  const startOfDay = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
  );
  const target = startOfDay + 6 * 3600 * 1000;
  const next = target > jstMs ? target : target + 24 * 3600 * 1000;
  return Math.ceil((next - jstMs) / 60000);
}
function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Simulation

function computeTilt(windows: WinStats[]) {
  let wSum = 0;
  let acc = 0;
  for (const w of windows) {
    const weight = TILT_WEIGHTS[w.minutes] ?? 0;
    wSum += weight;
    acc += weight * w.buyRatio;
  }
  const score = wSum > 0 ? acc / wSum : 50;
  const buyPct = Math.round(clamp((score - 50) * 1.6, 0, 80));
  const sellPct = Math.round(clamp((50 - score) * 1.6, 0, 80));
  return { score, buyPct, sellPct, balancePct: 100 - buyPct - sellPct };
}

function computeSim(
  win: WinStats,
  price: number,
  horizonMinutes: number,
  atr5: number,
  weights: number[],
  fromMs: number,
): { pace: MethodSim; session: MethodSim; atrFloor: number } {
  const atrFloor = atr5 * Math.sqrt(horizonMinutes / 5);
  const pacePerMin = win.volume / win.minutes;
  const buyShare = win.volume > 0 ? win.buyVolume / win.volume : 0;
  const sellShare = win.volume > 0 ? win.sellVolume / win.volume : 0;

  let weightedMinutes = 0;
  const wholeMinutes = Math.max(1, Math.floor(horizonMinutes));
  for (let i = 0; i < wholeMinutes; i++) {
    weightedMinutes += weights[jstHour(new Date(fromMs + i * 60000))] ?? 1;
  }

  const build = (totalVolume: number): MethodSim => {
    const buyOneWay = totalVolume * buyShare;
    const sellOneWay = totalVolume * sellShare;
    const reachUp = win.buyEffTotal * buyOneWay;
    const reachDown = win.sellEffTotal * sellOneWay;
    const balanceHalf = Math.max(atrFloor, (win.high - win.low) * 0.5);
    return {
      totalVolume,
      buyOneWay,
      sellOneWay,
      reachUp,
      reachDown,
      bands: {
        sell: {
          low: Math.max(0, price - Math.max(reachDown, atrFloor)),
          high: price + atrFloor,
        },
        buy: {
          low: Math.max(0, price - atrFloor),
          high: price + Math.max(reachUp, atrFloor),
        },
        balance: { low: Math.max(0, price - balanceHalf), high: price + balanceHalf },
      },
    };
  };

  return {
    pace: build(pacePerMin * horizonMinutes),
    session: build(pacePerMin * weightedMinutes),
    atrFloor,
  };
}

// Shade tier for a level inside a scenario band.
// 3 = 濃 (ratio <= 1/3), 2 = 中 (<= 2/3), 1 = 薄 (<= 1, pace band),
// 0 = さらに薄 (session band only), -1 = outside both bands.
function shadeTier(
  levelPrice: number,
  price: number,
  scenario: ScenarioKey,
  sim: { pace: MethodSim; session: MethodSim },
  win: WinStats,
): number {
  const inBand = (b: Band) => levelPrice >= b.low && levelPrice <= b.high;
  const paceBand = sim.pace.bands[scenario];
  const sessionBand = sim.session.bands[scenario];
  if (inBand(paceBand)) {
    const isDown = levelPrice < price;
    const eff = isDown ? win.sellEffTotal : win.buyEffTotal;
    const oneWay = isDown ? sim.pace.sellOneWay : sim.pace.buyOneWay;
    let ratio = 1;
    if (eff > 0 && oneWay > 0) {
      ratio = Math.abs(levelPrice - price) / eff / oneWay;
    }
    if (ratio <= 1 / 3) return 3;
    if (ratio <= 2 / 3) return 2;
    return 1;
  }
  if (inBand(sessionBand)) return 0;
  return -1;
}
const TIER_OPACITY = [0.16, 0.34, 0.6, 0.95];

// ---------------------------------------------------------------------------
// Price-scale band chart

function BandChart({
  price,
  levels,
  scenario,
  sim,
  win,
}: {
  price: number;
  levels: Level[];
  scenario: ScenarioKey;
  sim: { pace: MethodSim; session: MethodSim };
  win: WinStats;
}) {
  const color =
    SCENARIOS.find((s) => s.key === scenario)?.color ?? "#8a97a8";
  const paceBand = sim.pace.bands[scenario];
  const sessionBand = sim.session.bands[scenario];
  const bandLow = Math.min(paceBand.low, sessionBand.low);
  const bandHigh = Math.max(paceBand.high, sessionBand.high);
  const span = Math.max(bandHigh - bandLow, 1);
  const near = levels.filter(
    (l) =>
      l.price >= bandLow - span * 0.3 &&
      l.price <= bandHigh + span * 0.3,
  );
  let domainLow = Math.min(bandLow, ...near.map((l) => l.price));
  let domainHigh = Math.max(bandHigh, ...near.map((l) => l.price));
  const pad = (domainHigh - domainLow) * 0.06 || 10000;
  domainLow -= pad;
  domainHigh += pad;
  const HEIGHT = 460;
  const y = (p: number) =>
    ((domainHigh - p) / (domainHigh - domainLow)) * HEIGHT;

  return (
    <div
      className="relative w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
      style={{ height: HEIGHT }}
      role="img"
      aria-label={`${SCENARIOS.find((s) => s.key === scenario)?.name ?? ""}シナリオの到達帯チャート`}
    >
      {/* session-corrected band (outer, lighter) */}
      <div
        className="absolute inset-x-0"
        style={{
          top: y(sessionBand.high),
          height: Math.max(2, y(sessionBand.low) - y(sessionBand.high)),
          backgroundColor: color,
          opacity: 0.09,
        }}
      />
      {/* pace band */}
      <div
        className="absolute inset-x-0"
        style={{
          top: y(paceBand.high),
          height: Math.max(2, y(paceBand.low) - y(paceBand.high)),
          backgroundColor: color,
          opacity: 0.2,
        }}
      />
      {/* band edge labels */}
      <span
        className="num absolute right-2 text-[11px]"
        style={{ top: y(paceBand.high) - 16, color }}
      >
        {fmtPrice(paceBand.high)}
      </span>
      <span
        className="num absolute right-2 text-[11px]"
        style={{ top: y(paceBand.low) + 3, color }}
      >
        {fmtPrice(paceBand.low)}
      </span>
      {/* levels */}
      {near.map((l) => {
        const tier = shadeTier(l.price, price, scenario, sim, win);
        const opacity = tier >= 0 ? (TIER_OPACITY[tier] ?? 0.22) : 0.22;
        return (
          <div key={`${l.price}-${l.label}`} className="absolute inset-x-0" style={{ top: y(l.price) }}>
            <div
              className="h-px w-full"
              style={{
                backgroundColor: tier >= 0 ? color : "var(--border)",
                opacity,
              }}
            />
            <div
              className="absolute left-2 flex -translate-y-1/2 items-baseline gap-2"
              style={{ opacity: tier >= 0 ? Math.max(opacity, 0.55) : 0.55 }}
            >
              <span className="num text-[12px] font-semibold text-[var(--text)]">
                {fmtPrice(l.price)}
              </span>
              {l.label && (
                <span className="text-[11px] text-[var(--dim)]">{l.label}</span>
              )}
            </div>
          </div>
        );
      })}
      {/* current price line */}
      <div className="absolute inset-x-0" style={{ top: y(price) }}>
        <div className="h-[2px] w-full bg-[var(--accent)]" />
        <span className="num absolute right-2 -translate-y-1/2 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[11px] font-bold text-black">
          現在 {fmtPrice(price)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App

export function App() {
  const [measureMinutes, setMeasureMinutes] = useState(60);
  const [horizon, setHorizon] = useState<HorizonKey>("target");
  const [chartScenario, setChartScenario] = useState<ScenarioKey | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const { levels, weights } = settings;
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [draftLevels, setDraftLevels] = useState(() =>
    levels.map((level) => ({ price: String(level.price), label: level.label })),
  );
  const [draftWeights, setDraftWeights] = useState(() => weights.map(String));

  const flow = useQuery({
    queryKey: ["flow"],
    queryFn: ({ signal }) => getFlow(signal),
    refetchInterval: 60000,
    retry: false,
  });
  const flowData = flow.isError ? undefined : flow.data;
  const availableFlow = flowData?.status === "ok" ? flowData : undefined;

  const simBundle = useMemo(() => {
    if (!availableFlow || availableFlow.atr5 === null) return null;
    const win = availableFlow.windows.find((w) => w.minutes === measureMinutes && w.complete);
    if (!win) return null;
    const price = availableFlow.ticker.ltp;
    const fromMs = new Date(availableFlow.ticker.timestampIso).getTime();
    const horizonMinutes =
      horizon === "1h" ? 60 : horizon === "4h" ? 240 : minutesToTarget(fromMs);
    const sim = computeSim(win, price, horizonMinutes, availableFlow.atr5, weights, fromMs);
    const tilt = computeTilt(availableFlow.windows.filter((window) => window.complete));
    return { win, price, horizonMinutes, sim, tilt };
  }, [availableFlow, measureMinutes, horizon, weights]);

  const activeScenario: ScenarioKey = useMemo(() => {
    if (chartScenario) return chartScenario;
    if (!simBundle) return "sell";
    const { tilt } = simBundle;
    if (tilt.sellPct >= tilt.buyPct && tilt.sellPct >= tilt.balancePct)
      return "sell";
    if (tilt.buyPct >= tilt.balancePct) return "buy";
    return "balance";
  }, [chartScenario, simBundle]);

  const sortedLevels = useMemo(
    () => [...levels].sort((a, b) => b.price - a.price),
    [levels],
  );

  const handleSaveSettings = () => {
    const next = {
      levels: draftLevels.map((level) => ({
        price: /^\d+$/.test(level.price.trim()) ? Number(level.price) : NaN,
        label: level.label.trim(),
      })),
      weights: draftWeights.map((value) => value.trim() === "" ? NaN : Number(value)),
    };
    try {
      saveSettings(next);
      setSettings(next);
      setSaveStatus({ ok: true, message: "このブラウザーに保存しました。" });
    } catch (error) {
      setSaveStatus({ ok: false, message: error instanceof Error ? error.message : "保存に失敗しました。" });
    }
  };

  return (
    <div className="app-shell min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <main className="mx-auto w-full max-w-5xl px-4 pb-10">
        {/* ------------------------------------------------ header */}
        <header className="flex flex-wrap items-end justify-between gap-3 pt-4">
          <div>
            <p className="text-[11px] tracking-wider text-[var(--dim)]">
              BTC/JPY · bitFlyer 約定フロー
            </p>
            {availableFlow?.ticker ? (
              <p className="num text-4xl font-bold text-[var(--accent)]">
                {fmtPrice(availableFlow.ticker.ltp)}
              </p>
            ) : (
              <p className="num text-4xl font-bold text-[var(--dim)]">—</p>
            )}
            {availableFlow?.ticker && (
              <p className="num mt-1 text-xs text-[var(--dim)]">
                買い気配 {fmtPrice(availableFlow.ticker.bestBid)} / 売り気配{" "}
                {fmtPrice(availableFlow.ticker.bestAsk)}
              </p>
            )}
          </div>
          <div className="text-right">
            <button
              type="button"
              aria-label="約定データを更新"
              onClick={() => void flow.refetch()}
              disabled={flow.isFetching}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {flow.isFetching ? "取得中…" : "更新"}
            </button>
            <p className="mt-1.5 text-[11px] text-[var(--dim)]">
              自動更新 60秒
              {flowData && (
                <>
                  {" · "}最終更新{" "}
                  {jstTimeSec.format(new Date(flowData.fetchedAtIso))} JST
                </>
              )}
            </p>
            {availableFlow?.coverage && (
              <p className="num text-[11px] text-[var(--dim)]">
                約定 {availableFlow.coverage.count.toLocaleString("ja-JP")}件 /{" "}
                {jstTime.format(new Date(availableFlow.coverage.fromIso))}〜
                {jstTime.format(new Date(availableFlow.coverage.toIso))} JST（
                {fmtDuration(
                  (new Date(availableFlow.coverage.toIso).getTime() -
                    new Date(availableFlow.coverage.fromIso).getTime()) /
                    60000,
                )}
                ）
              </p>
            )}
          </div>
        </header>

        {/* ------------------------------------------------ states */}
        {flow.isPending && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            bitFlyerの約定を取得中…
          </p>
        )}
        {flowData?.status === "unavailable" && (
          <section className="mt-6 rounded-[var(--radius)] border border-[var(--sell)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-bold text-[var(--sell)]">
              フロー取得不可
            </h2>
            <p className="mt-2 text-sm text-[var(--dim)]">
              {flowData.message ??
                "bitFlyerから約定データを取得できませんでした。"}
              代替データは表示していません。
            </p>
            <button
              type="button"
              aria-label="取得を再試行"
              onClick={() => void flow.refetch()}
              disabled={flow.isFetching}
              className="mt-4 rounded-[var(--radius)] bg-[var(--sell)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              再試行
            </button>
          </section>
        )}
        {flow.isError && (
          <section className="mt-6 rounded-[var(--radius)] border border-[var(--sell)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-bold text-[var(--sell)]">
              フロー取得不可
            </h2>
            <p className="mt-2 text-sm text-[var(--dim)]">
              サーバーへの接続に失敗しました。
            </p>
            <button
              type="button"
              aria-label="取得を再試行"
              onClick={() => void flow.refetch()}
              disabled={flow.isFetching}
              className="mt-4 rounded-[var(--radius)] bg-[var(--sell)] px-4 py-2 text-sm font-bold text-white"
            >
              再試行
            </button>
          </section>
        )}

        {availableFlow && (
          <>
            {/* ------------------------------------------------ controls */}
            <section className="mt-5 flex flex-wrap gap-x-6 gap-y-3">
              <div>
                <p className="mb-1 text-[11px] text-[var(--dim)]">
                  計測ウィンドウ
                </p>
                <div className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
                  {[15, 30, 60, 240].map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-label={`計測ウィンドウ ${WINDOW_LABELS[m]}`}
                      aria-pressed={measureMinutes === m}
                      onClick={() => setMeasureMinutes(m)}
                      className={`px-3.5 py-1.5 text-sm ${
                        measureMinutes === m
                          ? "bg-[var(--accent)] font-bold text-black"
                          : "bg-[var(--surface)] text-[var(--dim)]"
                      }`}
                    >
                      {WINDOW_LABELS[m]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-[var(--dim)]">
                  ホライズン
                </p>
                <div className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
                  {(
                    [
                      { key: "1h", label: "1時間" },
                      { key: "4h", label: "4時間" },
                      { key: "target", label: "06:00 JSTまで" },
                    ] as { key: HorizonKey; label: string }[]
                  ).map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      aria-label={`ホライズン ${h.label}`}
                      aria-pressed={horizon === h.key}
                      onClick={() => setHorizon(h.key)}
                      className={`px-3.5 py-1.5 text-sm ${
                        horizon === h.key
                          ? "bg-[var(--accent)] font-bold text-black"
                          : "bg-[var(--surface)] text-[var(--dim)]"
                      }`}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              </div>
              {simBundle && <div className="text-[11px] leading-5 text-[var(--dim)]">
                <p>
                  ホライズン残り{" "}
                  <span className="num text-[var(--text)]">
                    {fmtDuration(simBundle.horizonMinutes)}
                  </span>

                </p>
                <p>
                  ATR(5分,14本){" "}
                  <span className="num text-[var(--text)]">
                    {availableFlow.atr5 != null ? fmtPrice(availableFlow.atr5) : "—"}円
                  </span>
                  {" · "}ATR下限{" "}
                  <span className="num text-[var(--text)]">
                    ±{fmtPrice(simBundle.sim.atrFloor)}円
                  </span>
                </p>
                <p>
                  想定出来高 ペース{" "}
                  <span className="num text-[var(--text)]">
                    {fmtBtc(simBundle.sim.pace.totalVolume)} BTC
                  </span>
                  {" / "}補正{" "}
                  <span className="num text-[var(--text)]">
                    {fmtBtc(simBundle.sim.session.totalVolume)} BTC
                  </span>
                </p>
              </div>}
            </section>
            {!simBundle && (
              <p role="status" className="mt-4 rounded border border-[var(--border)] p-3 text-sm">
                {availableFlow.windows.some((w) => w.minutes === measureMinutes && w.complete)
                  ? "確定した5分足14本と開始直前の終値が揃うまで、到達帯を表示できません。"
                  : `${WINDOW_LABELS[measureMinutes]}の集計に必要な約定履歴が不足しています。別の計測ウィンドウを選べます。`}
              </p>
            )}
          </>
        )}

        {availableFlow && simBundle && (
          <>
            {/* ------------------------------------------------ tilt */}
            <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-bold">流れの傾き</h2>
                <p className="num text-xs text-[var(--dim)]">
                  スコア{" "}
                  <span className="text-base font-bold text-[var(--text)]">
                    {simBundle.tilt.score.toFixed(1)}
                  </span>{" "}
                  （重み付き買い比率）
                </p>
              </div>
              <div
                className="mt-3 flex h-7 w-full overflow-hidden rounded"
                role="img"
                aria-label={`売り継続${simBundle.tilt.sellPct}%、拮抗${simBundle.tilt.balancePct}%、買い継続${simBundle.tilt.buyPct}%`}
              >
                {simBundle.tilt.sellPct > 0 && (
                  <div
                    style={{
                      width: `${simBundle.tilt.sellPct}%`,
                      backgroundColor: "var(--sell)",
                    }}
                    className="flex items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[11px] font-bold text-white"
                  >
                    {simBundle.tilt.sellPct > 14 &&
                      `売り ${simBundle.tilt.sellPct}%`}
                  </div>
                )}
                {simBundle.tilt.balancePct > 0 && (
                  <div
                    style={{
                      width: `${simBundle.tilt.balancePct}%`,
                      backgroundColor: "#5b6a7d",
                    }}
                    className="flex items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[11px] font-bold text-white"
                  >
                    {simBundle.tilt.balancePct > 14 &&
                      `拮抗 ${simBundle.tilt.balancePct}%`}
                  </div>
                )}
                {simBundle.tilt.buyPct > 0 && (
                  <div
                    style={{
                      width: `${simBundle.tilt.buyPct}%`,
                      backgroundColor: "var(--buy)",
                    }}
                    className="flex items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[11px] font-bold text-white"
                  >
                    {simBundle.tilt.buyPct > 14 &&
                      `買い ${simBundle.tilt.buyPct}%`}
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-[var(--dim)]">
                スコア = Σ(重み×買い比率) ÷ Σ重み（重み: 15分=1, 30分=2,
                1時間=3, 4時間=4。約定履歴が揃った窓を集計）。買い継続% =
                round(clamp((スコア−50)×1.6, 0, 80))、売り継続% =
                round(clamp((50−スコア)×1.6, 0, 80))、拮抗% = 残り。割合はシナリオ配分の目安です。
              </p>
            </section>

            {/* ------------------------------------------------ scenario cards */}
            <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {SCENARIOS.map((s) => {
                const pct =
                  s.key === "sell"
                    ? simBundle.tilt.sellPct
                    : s.key === "buy"
                      ? simBundle.tilt.buyPct
                      : simBundle.tilt.balancePct;
                const paceBand = simBundle.sim.pace.bands[s.key];
                const sessionBand = simBundle.sim.session.bands[s.key];
                const inLevels = sortedLevels
                  .map((l) => ({
                    level: l,
                    tier: shadeTier(
                      l.price,
                      simBundle.price,
                      s.key,
                      simBundle.sim,
                      simBundle.win,
                    ),
                  }))
                  .filter((x) => x.tier >= 0);
                const selected = activeScenario === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-label={`${s.name}シナリオをチャートに表示`}
                    aria-pressed={selected}
                    onClick={() => setChartScenario(s.key)}
                    className="rounded-[var(--radius)] border bg-[var(--surface)] p-4 text-left"
                    style={{
                      borderColor: selected ? s.color : "var(--border)",
                      borderWidth: selected ? 2 : 1,
                    }}
                  >
                    <div className="flex items-baseline justify-between">
                      <h3 className="font-bold" style={{ color: s.color }}>
                        {s.name}
                      </h3>
                      <span className="num text-2xl font-bold">{pct}%</span>
                    </div>
                    <p className="num mt-2 text-[13px] leading-6">
                      ペース {fmtPrice(paceBand.low)} 〜{" "}
                      {fmtPrice(paceBand.high)}
                      <br />
                      <span className="text-[var(--dim)]">
                        補正 {fmtPrice(sessionBand.low)} 〜{" "}
                        {fmtPrice(sessionBand.high)}
                      </span>
                    </p>
                    {inLevels.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {inLevels.map(({ level, tier }) => (
                          <li
                            key={`${level.price}-${level.label}`}
                            className="flex items-baseline gap-2 text-xs"
                          >
                            <span
                              className="inline-block h-2.5 w-2.5 shrink-0 translate-y-px rounded-sm"
                              style={{
                                backgroundColor: s.color,
                                opacity: TIER_OPACITY[tier] ?? 0.16,
                              }}
                            />
                            <span className="num font-semibold">
                              {fmtPrice(level.price)}
                            </span>
                            <span className="text-[var(--dim)]">
                              {level.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-[var(--dim)]">
                        帯内のレベルなし
                      </p>
                    )}
                  </button>
                );
              })}
            </section>

            {/* ------------------------------------------------ chart */}
            <section className="mt-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-bold">
                  価格スケール —{" "}
                  {SCENARIOS.find((s) => s.key === activeScenario)?.name}
                  の到達帯
                </h2>
                <p className="text-[11px] text-[var(--dim)]">
                  濃い帯 = ペース継続 / 薄い帯 = セッション補正。レベルの濃淡
                  = 到達に必要な出来高の比率（入口ほど濃い）
                </p>
              </div>
              <BandChart
                price={simBundle.price}
                levels={levels}
                scenario={activeScenario}
                sim={simBundle.sim}
                win={simBundle.win}
              />
              <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {sortedLevels.map((l) => {
                  const tier = shadeTier(
                    l.price,
                    simBundle.price,
                    activeScenario,
                    simBundle.sim,
                    simBundle.win,
                  );
                  const color =
                    SCENARIOS.find((s) => s.key === activeScenario)?.color ??
                    "#8a97a8";
                  return (
                    <li
                      key={`${l.price}-${l.label}`}
                      className="flex items-baseline gap-3 px-3 py-2"
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 translate-y-px rounded-sm"
                        style={{
                          backgroundColor: tier >= 0 ? color : "var(--border)",
                          opacity: tier >= 0 ? TIER_OPACITY[tier] : 0.5,
                        }}
                      />
                      <span className="num w-28 shrink-0 font-semibold">
                        {fmtPrice(l.price)}
                      </span>
                      <span className="flex-1 text-sm">{l.label}</span>
                      <span className="num text-xs text-[var(--dim)]">
                        {fmtSigned(l.price - simBundle.price)}円
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

          </>
        )}

        {availableFlow && (
          <>
            {/* ------------------------------------------------ windows */}
            <section className="mt-6">
              <h2 className="text-sm font-bold">ウィンドウ別 約定指標</h2>
              <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                カードを選ぶと計測ウィンドウが切り替わります。効率は5分バケットの価格変化を主導側へ帰属（合計ベース主
                / 中央値参考）。
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {availableFlow.windows.map((w) => {
                  const selected = measureMinutes === w.minutes;
                  return (
                    <article
                      key={w.minutes}
                      className="rounded-[var(--radius)] border bg-[var(--surface)] p-4"
                      style={{
                        borderColor: selected
                          ? "var(--accent)"
                          : "var(--border)",
                        borderWidth: selected ? 2 : 1,
                      }}
                    >
                      <button
                        type="button"
                        aria-label={`${WINDOW_LABELS[w.minutes] ?? `${w.minutes}分`}を計測ウィンドウにする`}
                        aria-pressed={selected}
                        onClick={() => setMeasureMinutes(w.minutes)}
                        className="flex w-full items-baseline justify-between text-left"
                      >
                        <span className="font-bold">
                          {WINDOW_LABELS[w.minutes] ?? `${w.minutes}分`}
                        </span>
                        {!w.complete && (
                          <span className="text-xs text-[var(--accent)]">取得範囲のみ</span>
                        )}
                        {selected && (
                          <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold text-black">
                            計測中
                          </span>
                        )}
                      </button>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span
                          className="num text-2xl font-bold"
                          style={{
                            color:
                              w.buyRatio >= 50
                                ? "var(--buy)"
                                : "var(--sell)",
                          }}
                        >
                          {w.buyRatio.toFixed(1)}%
                        </span>
                        <span className="text-[11px] text-[var(--dim)]">
                          買い比率
                        </span>
                      </div>
                      <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded">
                        <div
                          style={{
                            width: `${w.buyRatio}%`,
                            backgroundColor: "var(--buy)",
                          }}
                        />
                        <div
                          style={{
                            width: `${100 - w.buyRatio}%`,
                            backgroundColor: "var(--sell)",
                          }}
                        />
                      </div>
                      <dl className="num mt-3 space-y-1.5 text-xs leading-5">
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">出来高</dt>
                          <dd>{fmtBtc(w.volume)} BTC</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">
                            買い / 売り
                          </dt>
                          <dd>
                            {fmtBtc(w.buyVolume)} / {fmtBtc(w.sellVolume)}
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">
                            買い効率
                          </dt>
                          <dd>
                            {fmtSigned(w.buyEffTotal)} 円/BTC
                            <span className="text-[var(--dim)]">
                              {" "}
                              （中央値{" "}
                              {w.buyEffMedian != null
                                ? fmtSigned(w.buyEffMedian)
                                : "—"}
                              ）
                            </span>
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">
                            売り効率
                          </dt>
                          <dd>
                            {fmtSigned(w.sellEffTotal)} 円/BTC
                            <span className="text-[var(--dim)]">
                              {" "}
                              （中央値{" "}
                              {w.sellEffMedian != null
                                ? fmtSigned(w.sellEffMedian)
                                : "—"}
                              ）
                            </span>
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">高値</dt>
                          <dd>{fmtPrice(w.high)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">安値</dt>
                          <dd>{fmtPrice(w.low)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">
                            レンジ内位置
                          </dt>
                          <dd>{(w.rangePosition * 100).toFixed(0)}%</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="font-sans text-[var(--dim)]">
                            安値から反発
                          </dt>
                          <dd>+{fmtPrice(w.reboundFromLow)}円</dd>
                        </div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* ------------------------------------------------ settings */}
        <section className="mt-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          <button
            type="button"
            aria-label="設定を開閉"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-sm font-bold">
              設定 — 構造レベル / セッションウェイト / 算出式
            </span>
            <span className="text-[var(--dim)]">{settingsOpen ? "−" : "+"}</span>
          </button>
          {settingsOpen && (
            <div className="border-t border-[var(--border)] px-4 py-4">
              <h3 className="text-sm font-bold">構造レベル</h3>
              <p className="mt-1 text-xs text-[var(--dim)]">監視したい価格を追加できます。設定はこのブラウザーに保存します。</p>
              <div className="mt-2 space-y-2">
                {draftLevels.map((l, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      aria-label={`レベル${i + 1}の価格`}
                      inputMode="numeric"
                      maxLength={16}
                      value={l.price}
                      onChange={(e) =>
                        setDraftLevels((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, price: e.target.value } : x,
                          ),
                        )
                      }
                      className="num w-32 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                    />
                    <input
                      aria-label={`レベル${i + 1}のラベル`}
                      maxLength={40}
                      value={l.label}
                      onChange={(e) =>
                        setDraftLevels((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, label: e.target.value } : x,
                          ),
                        )
                      }
                      className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                      placeholder="ラベル"
                    />
                    <button
                      type="button"
                      aria-label={`レベル${i + 1}を削除`}
                      onClick={() =>
                        setDraftLevels((prev) =>
                          prev.filter((_, j) => j !== i),
                        )
                      }
                      className="rounded border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--sell)]"
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label="レベルを追加"
                disabled={draftLevels.length >= 60}
                onClick={() =>
                  setDraftLevels((prev) => [
                    ...prev,
                    { price: "", label: "" },
                  ])
                }
                className="mt-2 rounded border border-[var(--border)] px-3 py-1.5 text-sm"
              >
                レベルを追加
              </button>

              <h3 className="mt-6 text-sm font-bold">
                セッションウェイト（JST時別）
              </h3>
              <p className="mt-1 text-[11px] text-[var(--dim)]">
                初期値は全時間帯1.00。セッション補正 = ペース ×
                （ウェイト付き残り時間 ÷ 残り時間）。
              </p>
              <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                {draftWeights.map((w, h) => (
                  <label key={h} className="block">
                    <span className="text-[11px] text-[var(--dim)]">
                      {h}時
                    </span>
                    <input
                      aria-label={`${h}時のウェイト`}
                      inputMode="decimal"
                      value={w}
                      onChange={(e) =>
                        setDraftWeights((prev) =>
                          prev.map((x, j) =>
                            j === h ? e.target.value : x,
                          ),
                        )
                      }
                      className="num mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                    />
                  </label>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  aria-label="設定を保存"
                  onClick={handleSaveSettings}
                  className="rounded-[var(--radius)] bg-[var(--accent)] px-5 py-2 text-sm font-bold text-black disabled:opacity-50"
                >
                  保存
                </button>
                <button
                  type="button"
                  aria-label="設定を初期値に戻す"
                  onClick={() => {
                    setDraftLevels([]);
                    setDraftWeights(DEFAULT_SETTINGS.weights.map(String));
                    setSaveStatus(null);
                  }}
                  className="rounded border border-[var(--border)] px-3 py-2 text-sm"
                >
                  初期値に戻す（保存で確定）
                </button>
                {saveStatus && (
                  <span role="status" className={saveStatus.ok ? "text-sm text-[var(--buy)]" : "text-sm text-[var(--sell)]"}>
                    {saveStatus.message}
                  </span>
                )}
              </div>

              <h3 className="mt-7 text-sm font-bold">算出式の注記</h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-6 text-[var(--dim)]">
                <li>
                  買い比率 = テイカー買い数量 ÷
                  売買方向のある約定数量。買い/売り効率はウィンドウを5分バケットに分け、各バケットの価格変化（末値−初値）を主導側（バケットの買い比率
                  50%超なら買い側、50%未満なら売り側、同量は除外）へ帰属。合計ベース = Σ帰属Δ ÷
                  Σ主導側出来高、中央値 =
                  バケット効率（帰属Δ÷主導側出来高）の中央値。
                </li>
                <li>
                  想定出来高（ペース継続） = 計測ウィンドウの BTC/分 ×
                  ホライズン分。一方通行の想定出来高 = 想定総出来高 ×
                  計測ウィンドウの側別シェア。到達幅 = 側別効率（合計ベース）
                  × その側の一方通行想定出来高。
                </li>
                <li>
                  ATR下限 = ATR(5分, 14本) × √(ホライズン分 ÷
                  5)。売り継続の帯 = 下側 max(売り到達幅, ATR下限)・上側
                  ATR下限（買い継続はその逆）。拮抗の帯 = ±max(ATR下限,
                  計測ウィンドウのレンジ幅 × 0.5)。
                </li>
                <li>
                  レベルの濃淡: 必要出来高比率 = (|レベル − 現在値| ÷
                  側別効率) ÷
                  一方通行想定出来高（ペース継続を基準）。比率 1/3以下 =
                  濃、2/3以下 = 中、1以下 =
                  薄。セッション補正の帯内のみにあるレベルはさらに薄く表示。必要出来高の数値自体は表示しません。
                </li>
                <li>
                  bitFlyerの約定履歴を約4時間、上限12,000件まで取得します。超過時は取得範囲を表示します。
                  06:00 JSTは毎日の固定時刻です。
                </li>
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
