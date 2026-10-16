import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const state = mkdtempSync(join(tmpdir(), "factory-late-deleted-machine-write-"));
  const token = "owned-late-deleted-machine-write";
  const panes: any[] = []; const workspaces: any[] = [];
  let observation: ReturnType<typeof gate> | undefined;
  const observed = gate();
  let shutdown: ReturnType<typeof gate> | undefined; const closing = gate();
  const options = { port: 0, stateDir: state, token, machines: false as const, factory: { accountDiscoveryHome: state, native: {
    snapshot: async () => ({ panes: [...panes], workspaces: [...workspaces] }) as any,
    paneState: async (id: string) => { const pane = panes.find(p => p.pane_id === id); if (observation) { const pending = observation; observation = undefined; observed.release(); await pending.promise; } return pane; },
    closeWorkspace: async (id: string) => { if (shutdown) { const pending = shutdown; shutdown = undefined; closing.release(); await pending.promise; } for (let i = panes.length - 1; i >= 0; i--) if (panes[i].workspace_id === id) panes.splice(i, 1); const index = workspaces.findIndex(w => w.workspace_id === id); if (index >= 0) workspaces.splice(index, 1); return {} as any; },
  } } };
  let app = createServer(options);
  const copies: ReturnType<typeof createServer>[] = [];
  const request = (server: typeof app, path: string, body?: unknown) => fetch(`http://localhost:${server.port}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = (path: string, body?: unknown) => request(app, path, body);
  const assignment = (title: string) => api("factory/implementations", { title, description: "Owned restored Machine fixture" }).then(r => r.json());
  const erased = await assignment("Private Assignment to erase");
  const retained = await assignment("Independent Assignment to preserve");
  // Arrange fictional restored Machine state only. Assertions observe authenticated HTTP
  // and the owned native boundary; this fixture never launches a paid provider.
  const store = new FactoryStore(state);
  const arrange = (implementationId: string, scope: string) => {
    const record = store.record();
    const worktree = join(store.root, "inbox", implementationId, record.id, "workspace"); mkdirSync(worktree, { recursive: true });
    const workspace = { workspace_id: `owned-${record.id}`, label: `saurons-eye-run-${record.id}` };
    const pane = { pane_id: `${workspace.workspace_id}:p1`, workspace_id: workspace.workspace_id, terminal_id: `${workspace.workspace_id}:terminal`, cwd: worktree, agent: "codex", agent_status: "idle" };
    panes.push(pane); workspaces.push(workspace);
    const run = { ...record, implementation_id: implementationId, action: "work", provider: "codex", machine_id: "local", condition: "working", waiting_reason: null, checkout: null, worktree, branch: null, base: null, workspace_id: workspace.workspace_id, pane_id: pane.pane_id, manifest: { frozen_scope: scope } };
    store.put("host_leases", { id: record.id, signature: "owned", run });
    return run;
  };
  const run = arrange(erased.id, "Private frozen scope must never return");
  const sibling = arrange(retained.id, "Independent frozen scope survives"); store.close();
  const body = { implementation_id: erased.id, deletion_id: crypto.randomUUID() };
  const reconcile = (server = app, id = run.id) => request(server, `factory-host/runs/${id}/reconcile`, {});
  return { state, api, request, run, sibling, body, panes, workspaces, reconcile, observed, closing,
    holdObservation: () => { observation = gate(); return observation; },
    holdShutdown: () => { shutdown = gate(); return shutdown; },
    remove: () => api(`factory-host/runs/${run.id}/operations/delete`, body),
    recover: async (id: string) => { const response = await api(`factory/backups/${id}/restore`, {}); expect(response.status).toBe(201); const recovery = await response.json(); const copy = createServer({ ...options, stateDir: recovery.state_dir }); copies.push(copy); return copy; },
    restart: () => { app.stop(); app = createServer(options); },
    close: () => { for (const copy of copies.reverse()) copy.stop(); app.stop(); rmSync(state, { recursive: true, force: true }); },
  };
}

it("Machine Delete rejects a late reconciliation result without restoring private scope, native identity or backup content", async () => {
  const f = await fixture(); const release = f.holdObservation(); let pending: Promise<Response> | undefined;
  try {
    const backup = await f.api("factory/backups", {}).then(r => r.json());
    pending = f.reconcile(); await f.observed.promise;
    expect(await f.remove().then(r => r.json())).toEqual({ run_id: f.run.id, deletion_id: f.body.deletion_id, condition: "deleted" });
    expect((await f.reconcile()).status).toBe(409);
    release.release();
    expect((await pending).status).toBe(409);
    expect((await f.reconcile()).status).toBe(409);
    expect(f.panes.some(p => p.pane_id === f.run.pane_id)).toBe(false);
    expect(await f.reconcile(undefined, f.sibling.id).then(r => r.json())).toMatchObject({ id: f.sibling.id, condition: "ready", manifest: { frozen_scope: "Independent frozen scope survives" } });
    f.restart();
    expect((await f.reconcile()).status).toBe(409);
    for (const id of [backup.id, (await f.api("factory/backups", {}).then(r => r.json())).id]) {
      const copy = await f.recover(id);
      expect((await f.reconcile(copy)).status).toBe(409);
      expect((await f.request(copy, `factory/implementations/${f.run.implementation_id}`)).status).toBe(404);
      expect(await f.request(copy, `factory/implementations/${f.sibling.implementation_id}`).then(r => r.json())).toMatchObject({ implementation: { title: "Independent Assignment to preserve" } });
    }
  } finally { release.release(); await pending; f.close(); }
}, 30_000);

it("Machine Delete fences an already-dispatched Stop callback while preserving the independent native Run", async () => {
  const f = await fixture(); const release = f.holdShutdown(); let pending: Promise<Response> | undefined;
  try {
    pending = f.api(`factory-host/runs/${f.run.id}/stop`, {}); await f.closing.promise;
    expect(await f.remove().then(r => r.json())).toEqual({ run_id: f.run.id, deletion_id: f.body.deletion_id, condition: "deleted" });
    release.release();
    expect((await pending).status).toBe(409);
    expect((await f.reconcile()).status).toBe(409);
    expect(f.workspaces.some(w => w.workspace_id === f.run.workspace_id)).toBe(false);
    expect(await f.reconcile(undefined, f.sibling.id).then(r => r.json())).toMatchObject({ id: f.sibling.id, condition: "ready" });
    expect(f.panes.some(p => p.pane_id === f.sibling.pane_id)).toBe(true);
    f.restart();
    expect((await f.reconcile()).status).toBe(409);
  } finally { release.release(); await pending; f.close(); }
}, 30_000);
