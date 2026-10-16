import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";

async function fixture() {
  const state = mkdtempSync(join(tmpdir(), "factory-remote-backup-delete-"));
  const token = "owned-remote-backup-delete";
  const options = { port: 0, stateDir: state, token, machines: false as const, factory: { accountDiscoveryHome: state, native: { snapshot: async () => ({ panes: [], workspaces: [] }) as any } } };
  let app = createServer(options);
  const copies: ReturnType<typeof createServer>[] = [];
  const request = (server: typeof app, path: string, body?: unknown) => fetch(`http://localhost:${server.port}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = (path: string, body?: unknown) => request(app, `factory${path}`, body);
  const assignment = async (title: string) => api("/implementations", { title, description: "Owned remote backup fixture" }).then(r => r.json());
  const erased = await assignment("Remote Assignment to erase");
  const retained = await assignment("Remote sibling to recover");
  const attach = async (id: string, text: string) => {
    const detail = await api(`/implementations/${id}`).then(r => r.json());
    return api(`/implementations/${id}/artifacts`, { chat_id: detail.chats[0].id, name: "evidence.txt", media_type: "text/plain", content_base64: Buffer.from(text).toString("base64") }).then(r => r.json());
  };
  const exclusive = await attach(erased.id, "Private remote exclusive bytes");
  await attach(erased.id, "Shared remote retained bytes");
  const shared = await attach(retained.id, "Shared remote retained bytes");
  // A fictional restored Machine lease with durable proof that native allocation
  // was never attempted. Arrange only owned state; assertions use HTTP/recovery.
  const store = new FactoryStore(state);
  const record = store.record(); const runId = record.id;
  store.put("host_leases", { id: runId, native_attempted: false, signature: "owned", run: { ...record, action: "work", implementation_id: erased.id, provider: "codex", machine_id: "local", condition: "failed", workspace_id: null, pane_id: null, checkout: null, worktree: null, branch: null, base: null, manifest: { frozen_scope: "Private frozen remote scope" } } });
  store.close();
  const body = { implementation_id: erased.id, deletion_id: crypto.randomUUID() };
  const remove = () => request(app, `factory-host/runs/${runId}/operations/delete`, body);
  const recover = async (server: typeof app, id: string) => {
    const response = await request(server, `factory/backups/${id}/restore`, {});
    expect(response.status).toBe(201);
    const recovery = await response.json();
    const copy = createServer({ port: 0, stateDir: recovery.state_dir, token, machines: false, factory: { accountDiscoveryHome: state } }); copies.push(copy);
    return { app: copy, state: recovery.state_dir };
  };
  const file = (path: string) => request(app, `fs/file?path=${encodeURIComponent(path)}`);
  return { state, api, request, remove, recover, file, erased, retained, runId, exclusive, shared, get app() { return app; }, restart: () => { app.stop(); app = createServer(options); }, close: () => { for (const copy of copies.reverse()) copy.stop(); app.stop(); rmSync(state, { recursive: true, force: true }); } };
}

it("Machine Delete purges its snapshots and existing recovery copies before acknowledging, preserving sibling recovery", async () => {
  const f = await fixture();
  try {
    const backup = await f.api("/backups", {}).then(r => r.json());
    const existing = await f.recover(f.app, backup.id);
    const nested = await f.request(existing.app, "factory/backups", {}).then(r => r.json());
    const response = await f.remove();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toEqual({ run_id: f.runId, deletion_id: expect.any(String), condition: "deleted" });
    for (const path of [join(f.state, "factory", "backups", backup.id, "records.sqlite"), join(existing.state, "factory", "records.sqlite")]) {
      const bytes = Buffer.from(await (await f.file(path)).arrayBuffer());
      expect(bytes.includes(Buffer.from("Private frozen remote scope"))).toBe(false);
    }
    const current = await f.recover(f.app, backup.id);
    const nestedCopy = await f.recover(existing.app, nested.id);
    for (const copy of [existing, current, nestedCopy]) {
      expect((await f.request(copy.app, `factory/implementations/${f.erased.id}`)).status).toBe(404);
      expect((await f.request(copy.app, `factory/artifacts/${f.exclusive.id}/source`)).status).toBe(404);
      expect((await f.request(copy.app, `factory/implementations/${f.retained.id}`).then(r => r.json())).implementation.title).toBe("Remote sibling to recover");
      expect(await f.request(copy.app, `factory/artifacts/${f.shared.id}/source`).then(r => r.text())).toBe("Shared remote retained bytes");
    }
    const recent = await f.api("/backups", {}).then(r => r.json());
    const recentCopy = await f.recover(f.app, recent.id);
    expect((await f.request(recentCopy.app, `factory/implementations/${f.erased.id}`)).status).toBe(404);
    expect(await f.remove().then(r => r.json())).toEqual(receipt);
  } finally { f.close(); }
});

it("Machine Delete retains its fence across a failed backup rewrite and restart, then safely retries", async () => {
  const f = await fixture();
  try {
    const backup = await f.api("/backups", {}).then(r => r.json());
    const obstacle = join(f.state, "factory", "backups", backup.id, "manifest.json.tmp");
    mkdirSync(obstacle);
    const response = await f.remove();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("backup_cleanup_pending");
    const head = () => f.request(f.app, `factory-host/runs/${f.runId}/operations/head`, {});
    expect((await head().then(r => r.json())).error.code).toBe("assignment_deleting");
    expect((await f.api("/backups", {})).status).toBe(409);
    expect((await f.api(`/backups/${backup.id}/restore`, {})).status).toBe(409);
    f.restart();
    expect((await head().then(r => r.json())).error.code).toBe("assignment_deleting");
    rmSync(obstacle, { recursive: true });
    expect((await f.remove()).status).toBe(200);
    const recovery = await f.recover(f.app, backup.id);
    expect((await f.request(recovery.app, `factory/implementations/${f.erased.id}`)).status).toBe(404);
    expect((await f.request(recovery.app, `factory/implementations/${f.retained.id}`).then(r => r.json())).implementation.title).toBe("Remote sibling to recover");
    const recent = await f.api("/backups", {}).then(r => r.json());
    const recentCopy = await f.recover(f.app, recent.id);
    expect((await f.request(recentCopy.app, `factory/implementations/${f.erased.id}`)).status).toBe(404);
  } finally { f.close(); }
});
