import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";
import type { FactoryRun, Implementation } from "../shared/factory.ts";

/** Deterministic synthetic history, never a copy of the owner's live factory database. */
export function factoryLoadingFixture(seedBeforeStartup?: (store: FactoryStore) => void) {
  const root = mkdtempSync(join(tmpdir(), "factory-loading-"));
  const store = new FactoryStore(root);
  const record = (id: string) => ({ id, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  const text = (size: number) => "Synthetic evidence. ".repeat(Math.ceil(size / 20)).slice(0, size);
  for (let a = 0; a < 8; a++) {
    const id = `assignment-${a}`;
    store.put<Implementation>("implementations", { ...record(id), title: `Assignment ${a}`, description: text(10_000), project_id: null, provider: "codex", machine_id: "local", stage: "review", position: a, outcome: "none" });
    const spec = { ...record(`spec-${a}`), implementation_id: id, revision: 1, content: text(39_200), hash: "spec-hash" };
    store.put("specifications", spec, id);
    store.put("graphs", { id, specification_id: spec.id, hash: "graph-hash", tickets: [] }, id);
    for (let r = 0; r < 4; r++) {
      const runId = `run-${a}-${r}`;
      store.put<FactoryRun>("runs", { ...record(runId), implementation_id: id, action: "implement-spec", provider: "codex", machine_id: "local", condition: "completed", waiting_reason: null, idempotency_key: runId, specification_id: spec.id, graph_hash: "graph-hash", base: "base", checkout: null, worktree: null, branch: null, workspace_id: null, pane_id: `pane-${a}-${r}`, manifest: { tickets: [], execution_preset: { model: "fixture-model", reasoning: "high" }, frozen_context: text(435_447) } }, id);
      store.put("checks", { ...record(`check-${a}-${r}`), run_id: runId, worker_id: null, head: "head", workspace_hash: "hash", condition: "passed", commands: [{ args: ["fixture-check"], exit_code: 0, output: text(100_000) }] }, runId);
      store.put("review_evidence", { ...record(`report-${a}-${r}`), run_id: runId, worker_id: "reviewer", axis: "spec", head: "head", source_id: "fixture", content: text(50_000), outcome: "passed" }, runId);
      store.put("native_snapshots", { ...record(`native-${a}-${r}`), run_id: runId, source_id: "fixture", sequence: r, version: "1", cursor: null, turns: [{ role: "assistant", ts: 1, parts: [{ kind: "text", text: text(100_000) }] }] }, runId);
      store.put("snapshots", { ...record(`snapshot-${a}-${r}`), implementation_id: id, run_id: runId, machine_id: "local", repository: "fixture", mode: "workspace", base: "base", head: "head", hash: "hash", files: [{ path: "fixture.txt", status: "M", diff: text(100_000), binary: false, oversized: false }] }, id);
      store.put("messages", { ...record(`message-${a}-${r}`), implementation_id: id, chat_id: "notes", role: "agent", content: text(50_000), source_id: "fixture", sequence: r }, id);
      store.put("events", { ...record(`event-${a}-${r}`), implementation_id: id, kind: "fixture_history", data: { evidence: text(50_000) } }, id);
    }
  }
  seedBeforeStartup?.(store);
  let observedRuns = store.list<{ run: FactoryRun }>("host_leases").map(lease => lease.run); store.close();
  const token = "owned-loading-token";
  const options = { port: 0, token, stateDir: root, machines: false as const, factory: { accountDiscoveryHome: root, native: {
    snapshot: async () => ({ panes: observedRuns.map(run => ({ pane_id: run.pane_id, workspace_id: run.workspace_id, terminal_id: `owned-${run.id}`, cwd: run.worktree, agent: run.provider, agent_status: "blocked" })), workspaces: observedRuns.map(run => ({ workspace_id: run.workspace_id, label: `saurons-eye-run-${run.id}` })) }) as any,
  } } };
  let app: ReturnType<typeof createServer> | null = createServer(options);
  const stop = () => { app?.stop(); app = null; };
  const origin = () => { if (!app) throw new Error("Owned loading fixture is stopped"); return `http://localhost:${app.port}`; };
  return { root, id: "assignment-0", origin,
    request(path: string, body?: unknown) {
      return fetch(origin() + "/api/factory" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    // Restore owned fixture state only while its server is stopped. Assertions
    // always read the product's authenticated public HTTP boundary.
    restart(seed: (store: FactoryStore) => void) {
      stop(); const restored = new FactoryStore(root);
      try { seed(restored); observedRuns = restored.list<{ run: FactoryRun }>("host_leases").map(lease => lease.run); } finally { restored.close(); }
      app = createServer(options);
    },
    stop, close() { stop(); rmSync(root, { recursive: true, force: true }); },
  };
}
