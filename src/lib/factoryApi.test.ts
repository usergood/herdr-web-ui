import { expect, test } from "bun:test";
import { accountRequest } from "./accountsApi.ts";
import { factoryRead, factoryRequest } from "./factoryApi.ts";

test("overlapping reads share a request, later reads and mutations do not reuse it", async () => {
  const original = globalThis.fetch;
  const originalWindow = globalThis.window;
  const pending: ((response: Response) => void)[] = [];
  let calls = 0;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
  globalThis.fetch = (() => { calls++; return new Promise<Response>(resolve => pending.push(resolve)); }) as unknown as typeof fetch;
  const reply = (value: unknown) => pending.shift()!(Response.json(value));
  try {
    const first = factoryRead("/owned-read"), joined = factoryRead("/owned-read");
    expect(calls).toBe(1);
    reply({ value: 1 }); expect(await first).toEqual(await joined);
    const stale = factoryRead("/owned-read");
    const mutation = factoryRequest("/owned-mutation", {});
    pending.pop()!(Response.json({ saved: true })); await mutation;
    const fresh = factoryRead("/owned-read");
    expect(calls).toBe(4);
    reply({ value: "old" }); await stale;
    expect(factoryRead("/owned-read")).toBe(fresh);
    reply({ value: "new" }); expect(await fresh).toEqual({ value: "new" });
    const beforeAccount = factoryRead("/owned-read");
    const accountMutation = accountRequest("/fixture", {});
    pending.pop()!(Response.json({ saved: true })); await accountMutation;
    const afterAccount = factoryRead("/owned-read");
    expect(afterAccount).not.toBe(beforeAccount);
    reply({ value: "before account" }); await beforeAccount;
    reply({ value: "after account" }); await afterAccount;
    const retryable = factoryRead("/owned-read");
    pending.shift()!(Response.json({ error: { message: "retry", code: "unavailable" } }, { status: 503 }));
    await expect(retryable).rejects.toThrow("retry");
    const retry = factoryRead("/owned-read"); reply({ value: 2 }); expect(await retry).toEqual({ value: 2 });
  } finally { globalThis.fetch = original; globalThis.window = originalWindow; }
});
