export type Level = { price: number; label: string };
type Settings = { levels: Level[]; weights: number[] };

const STORAGE_KEY = "btc-jpy-flow-simulator.settings.v1";
export const DEFAULT_SETTINGS: Settings = {
  levels: [],
  weights: Array<number>(24).fill(1),
};

export function validateSettings(value: unknown): asserts value is Settings {
  const settings = value as Partial<Settings> | null;
  if (!Array.isArray(settings?.levels) || settings.levels.length > 60 ||
      settings.levels.some((level) =>
        !level || !Number.isSafeInteger(level.price) || level.price <= 0 ||
        typeof level.label !== "string" || level.label.length > 40,
      )) {
    throw new Error("構造レベルは60件までで、価格は正の整数、ラベルは40文字以内です。");
  }
  if (!Array.isArray(settings.weights) || settings.weights.length !== 24 ||
      settings.weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 50) ||
      !settings.weights.some((weight) => weight > 0)) {
    throw new Error("ウェイトは24件すべてに0〜50を入力し、少なくとも1件は0より大きくしてください。");
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const value: unknown = JSON.parse(raw);
    validateSettings(value);
    return value;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  validateSettings(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    throw new Error("ブラウザーに保存できませんでした。ブラウザーの保存設定を確認してください。");
  }
}
