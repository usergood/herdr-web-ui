import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import type { AssignmentDelivery, FactoryDetail, FactoryOverview, Implementation } from "../shared/factory.ts";

const stamp = "2026-09-01T12:00:00Z";
const record = (id: string) => ({ id, created_at: stamp, updated_at: stamp });

export const historicalMerge: AssignmentDelivery = {
  revision: "retained-delivery-revision", machine_id: "local", account_profile_id: "owned-gh-account", repository: "fictional/history", branch: "main", pull_numbers: [12], condition: "merged",
  changes: [{ path: "findings.md", oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", mode: "100644" }],
  pulls: [{ number: 12, url: "https://github.com/fictional/history/pull/12", head: "cccccccccccccccccccccccccccccccccccccccc", merge_commit: "dddddddddddddddddddddddddddddddddddddddd", covered_paths: ["findings.md"] }],
  branch_head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", problem: null, checked_at: stamp,
};
export const historicalDeliveryScope = { milestone: "merge" as const, repository: "owned-history-repository", branch: "main", base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", github_repository: "fictional/history" };
export const historicalChangeEvidence = { repository_changes: "changes" as const, quiescent: true, reason: null, checked_at: stamp };
export const historicalRelease: AssignmentDelivery = { ...historicalMerge, condition: "released", release: { id: 42, tag: "v1.0.0", url: "https://github.com/fictional/history/releases/tag/v1.0.0", commit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", published_at: stamp, merge_commits: ["dddddddddddddddddddddddddddddddddddddddd"] } };

/** Owned v1 export: seed only before supported startup, observe only through HTTP. */
export function factoryHistoryFixture(ideas: Partial<Implementation>[] = [{}], records: { kind: string; data: { id: string; [field: string]: unknown }; parent: string | null }[] = [], priorBackup = false) {
  const state = mkdtempSync(join(tmpdir(), "saurons-history-"));
  const root = join(state, "factory"); mkdirSync(join(root, "blobs"), { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "records.sqlite"));
  db.exec("CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX records_parent ON records(kind,parent); PRAGMA user_version=1;");
  const put = (kind: string, data: { id: string; [field: string]: unknown }, parent: string | null = null) => db.query("INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent=excluded.parent,data=excluded.data").run(kind, data.id, parent, JSON.stringify(data));
  put("projects", { ...record("history-project"), name: "Historical Project", repository: "owned-history-repository", machine_id: "local", provider: "codex", tracker: "app", tracker_reference: "" });
  for (const [index, fields] of ideas.entries()) {
    const id = fields.id ?? "historical-done";
    put("implementations", { ...record(id), title: "Historical work", description: "Retained owner request", project_id: "history-project", provider: "codex", machine_id: "local", stage: "done", position: index, outcome: "implementation_complete", ...fields });
    put("chats", { ...record(id + "-chat"), implementation_id: id, title: "Retained conversation" }, id);
    put("messages", { ...record(id + "-message"), implementation_id: id, chat_id: id + "-chat", role: "owner", content: "Keep my historical context", source_id: null, sequence: null }, id);
    put("runs", { ...record(id + "-run"), implementation_id: id, action: "work", provider: "codex", machine_id: "local", condition: "completed", waiting_reason: null, idempotency_key: id + "-attempt", specification_id: null, graph_hash: null, base: null, checkout: null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { implementation_id: id } }, id);
    put("workers", { ...record(id + "-worker"), run_id: id + "-run", ticket_id: id + "-ticket", role: "implementer", condition: "completed", base: "retained-base", head: "retained-head", integration_tip: "retained-tip", worktree: null, branch: null, workspace_id: null, pane_id: null, shared_paths: [], waiting_reason: null, rework_batch_id: null }, id + "-run");
    put("events", { ...record(id + "-event"), implementation_id: id, kind: "historical_outcome_accepted", data: { run_id: id + "-run" } }, id);
    const bytes = Buffer.from("Retained research artifact\n"), hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(root, "blobs", hash), bytes, { mode: 0o600 });
    put("artifacts", { ...record(id + "-artifact"), implementation_id: id, chat_id: id + "-chat", name: "research.md", media_type: "text/markdown", hash, size: bytes.length, version: 1, origin: "owned-prior-version", note: "" }, id);
  }
  for (const row of records) put(row.kind, row.data, row.parent);
  if (priorBackup) {
    const backup = join(root, "backups", "prior-version-backup"); mkdirSync(join(backup, "blobs"), { recursive: true, mode: 0o700 });
    const database = db.serialize(), bytes = Buffer.from("Retained research artifact\n"), hash = createHash("sha256").update(bytes).digest("hex");
    const manifest = { id: "prior-version-backup", created_at: stamp, format_version: 1, schema_version: 1, database_hash: createHash("sha256").update(database).digest("hex"), blobs: [{ hash, size: bytes.length }] };
    writeFileSync(join(backup, "records.sqlite"), database, { mode: 0o600 });
    writeFileSync(join(backup, "blobs", hash), bytes, { mode: 0o600 });
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    put("backups", manifest);
  }
  db.close();
  const starts: string[] = [];
  const boot = (stateDir = state) => createServer({ port: 0, stateDir, token: "", machines: false, factory: { accountDiscoveryHome: state, native: {
    version: async () => "owned-prior-version",
    modelCatalog: async provider => ({ protocol: 1, provider, models: [], problem: null }),
    createWorkspace: async () => { starts.push("workspace"); throw new Error("Historical work must not restart"); },
    startAgent: async () => { starts.push("agent"); throw new Error("Historical work must not restart"); },
  } } });
  let app = boot();
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { state, starts, get app() { return app; }, request,
    detail: (id = "historical-done"): Promise<FactoryDetail> => request(`/implementations/${id}`).then(r => r.json()),
    overview: (): Promise<FactoryOverview> => request("").then(r => r.json()),
    restart: (stateDir = state) => { app.stop(); app = boot(stateDir); },
    close: () => { app.stop(); rmSync(state, { recursive: true, force: true }); },
  };
}
