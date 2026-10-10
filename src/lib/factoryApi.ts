import type { FactoryDetail, FactoryOverview } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

/** Factory records always live on the connection server. Pane operations keep useMachineApi. */
export async function factoryRequest<T>(path = "", body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const url = `/api/factory${path}`;
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(url, response.status, result.error?.message ?? response.statusText, result.error?.code ?? null);
  return result as T;
}
export function factoryOverview(): Promise<FactoryOverview> { return factoryRequest(); }
export function factoryDetail(id: string): Promise<FactoryDetail> { return factoryRequest(`/implementations/${encodeURIComponent(id)}`); }
