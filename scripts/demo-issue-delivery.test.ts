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
