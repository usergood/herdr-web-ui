import { ApiError } from "./api.ts";

/** Account operations target an explicit Machine; credentials never enter browser storage. */
export async function accountRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = `/api/factory${path}`;
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  const value = await response.json();
  if (!response.ok) throw new ApiError(url, response.status, value.error?.message ?? response.statusText, value.error?.code ?? null);
  if (body !== undefined && typeof window !== "undefined") window.dispatchEvent(new Event("factory-changed"));
  return value as T;
}
