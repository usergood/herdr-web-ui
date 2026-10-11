import { AsyncLocalStorage } from "node:async_hooks";

/** Immutable per-operation credential context; concurrent Machines never share a mutable target. */
const accountEnvironment = new AsyncLocalStorage<Readonly<Record<string, string>>>();
export function withAccountEnvironment<T>(environment: Record<string, string>, operation: () => Promise<T>): Promise<T> { return accountEnvironment.run(Object.freeze({ ...environment }), operation); }
export function currentAccountEnvironment(): Readonly<Record<string, string>> { return accountEnvironment.getStore() ?? {}; }
