import type { FactoryDetail, FactoryOverview, FactoryRequestBody } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

/** Factory records always live on the connection server. Pane operations keep useMachineApi. */
export async function factoryRequest<T>(path = "", body?: FactoryRequestBody, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const url = `/api/factory${path}`;
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(url, response.status, result.error?.message ?? response.statusText, result.error?.code ?? null);
  if (method !== "GET") { factoryChanged(); }
  return result as T;
}
export function factoryOverview(): Promise<FactoryOverview> { return factoryRead("?navigation=1"); }
export function factoryDetail(id: string): Promise<FactoryDetail> { return factoryRead(`/implementations/${encodeURIComponent(id)}`); }
export function factoryCurrent(id: string): Promise<import("../../shared/factory.ts").FactoryCurrent> { return factoryRead(`/implementations/${encodeURIComponent(id)}?view=current`); }

/** Join overlapping reads only. Mutations and later polls always observe the server anew. */
const reads = new Map<string, Promise<unknown>>();
export function factoryRead<T>(path: string): Promise<T> {
  let read = reads.get(path);
  if (!read) {
    read = factoryRequest(path).finally(() => { if (reads.get(path) === read) reads.delete(path); });
    reads.set(path, read);
  }
  return read as Promise<T>;
}

export function factoryChanged(): void { reads.clear(); if (typeof window !== "undefined") window.dispatchEvent(new Event("factory-changed")); }
