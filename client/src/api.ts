import type { FlowResponse } from "../../server/src/flow.ts";

export async function getFlow(signal: AbortSignal): Promise<FlowResponse> {
  const response = await fetch("/api/flow", { signal });
  if (!response.ok) throw new Error("サーバーへの接続に失敗しました。");
  return response.json();
}
