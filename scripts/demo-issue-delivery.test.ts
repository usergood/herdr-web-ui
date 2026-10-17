import { expect, test } from "bun:test";
import { factoryDemo } from "../site/demo/factory.ts";

test("the demo exposes conservative coverage applicability and refuses real delivery verification", async () => {
  const request = (path: string, method = "GET", body: Record<string, unknown> = {}) => factoryDemo(new URL("https://demo.invalid/api/factory" + path), method, body, []);
  const project = await (await request("/projects", "POST", { name: "Fictional coverage Project", path: "/fictional/project", provider: "codex", tracker: "app", machine_id: "local" })).json();
  const route = `/projects/${project.id}/github`;
  await request(route + "/configure", "POST", { expected_revision: null, repository: "fictional/project", account_profile_id: "fictional-account", import_issues: true });
  const synced = await (await request(route + "/sync", "POST")).json();
  expect(synced.sources[0]).toMatchObject({ kind: "issue", delivery_scope_current: false });
  expect(synced.sources[0].delivery).toBeUndefined();
  const response = await request(route + "/issues/12/delivery", "POST", { source_revision: synced.sources[0].revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "demo_unavailable", message: "Delivery verification requires owned repository evidence; the demo keeps fictional records only" } });
  const current = await (await request(route)).json();
  expect(current.sources[0].delivery_scope_current).toBe(false);
  expect(current.sources[0].delivery).toBeUndefined();
});

test("the demo preserves typed workflow faults through current reads and board progress", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
    const seedModule = "../site/demo/factory.ts?reason-seed";
    const seed = (await import(seedModule)).factoryDemo;
    const route = new URL("https://demo.invalid/api/factory/implementations");
    const idea = await (await seed(route, "POST", { title: "Fictional typed workflow reasons" }, [])).json();
    const saved = JSON.parse(storage.get("saurons-eye:demo-factory")!);
    const detail = saved.details.find(([id]: [string]) => id === idea.id)[1];
    const run = { id: "owned-demo-reason-run", implementation_id: idea.id, action: "implement-spec", condition: "ready", manifest: {}, machine_id: "local", provider: "codex", checkout: "/fictional/project", worktree: "/fictional/project/run", created_at: idea.created_at, updated_at: idea.updated_at };
    detail.runs = [run];
    detail.human_reviews = [{ id: run.id, run_id: run.id, implementation_id: idea.id, condition: "waiting", reason: "Fictional snapshot unavailable", reason_is_error: true }];
    detail.automatic_review = [{ id: run.id, run_id: run.id, condition: "waiting", reason: "Fictional review observation failed", reason_is_error: true }];
    detail.automatic_execution = [{ id: run.id, run_id: run.id, condition: "waiting", reason: "Waiting for fictional capacity", reason_is_error: false }];
    storage.set("saurons-eye:demo-factory", JSON.stringify(saved));
    const readModule = "../site/demo/factory.ts?reason-read";
    const read = (await import(readModule)).factoryDemo;
    const current = await (await read(new URL(`${route}/${idea.id}?view=current`), "GET", {}, [])).json();
    expect(current.human_reviews[0].reason_is_error).toBe(true);
    expect(current.automatic_review[0].reason_is_error).toBe(true);
    expect(current.automatic_execution[0].reason_is_error).toBe(false);
    const overview = await (await read(new URL("https://demo.invalid/api/factory"), "GET", {}, [])).json();
    expect(overview.progress.find((progress: any) => progress.implementation_id === idea.id).error_reasons).toEqual(["Fictional review observation failed", "Fictional snapshot unavailable"]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete (globalThis as any).localStorage;
  }
});
