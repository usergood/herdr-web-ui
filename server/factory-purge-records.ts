import type { Database } from "bun:sqlite";
import { hash } from "./factory-host.ts";

/** Remove owned rows by their durable parent/context identities, retaining shared data. */
export function purgeAssignmentRecords(database: Database, assignmentId: string): void {
  const rows = database.query<{ kind: string; id: string; parent: string | null; data: string }, []>("SELECT kind,id,parent,data FROM records").all();
  const ids = new Set([assignmentId]);
  const previous = rows.find(row => row.kind === "deleted_assignments" && row.id === assignmentId);
  const contextIds = new Set<string>(previous ? JSON.parse(previous.data).context_ids ?? [] : []);
  for (const id of contextIds) ids.add(id);
  const removed = new Set<typeof rows[number]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (removed.has(row) || row.kind === "deleted_assignments") continue;
      const data = JSON.parse(row.data);
      if (!ids.has(row.id) && !(row.parent && ids.has(row.parent)) && ![data.implementation_id, data.run_id, data.worker_id].some(value => ids.has(value))) continue;
      if (["runs", "workers"].includes(row.kind)) contextIds.add(row.id);
      removed.add(row); ids.add(row.id); changed = true;
    }
  }
  for (const row of removed) database.query("DELETE FROM records WHERE kind=? AND id=?").run(row.kind, row.id);
  purgeAssignmentReferences(database, ids);
  database.query("INSERT OR REPLACE INTO records(kind,id,parent,data) VALUES('deleted_assignments',?,NULL,?)").run(assignmentId, JSON.stringify({ id: assignmentId, context_ids: [...contextIds] }));
}

/** Shared records can embed owned evidence; remove those copies and invalidate its approval. */
export function purgeAssignmentReferences(database: Database, ids: Set<string>): void {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return ids.has(value) ? undefined : value;
    if (Array.isArray(value)) return value.map(scrub).filter(item => item !== undefined);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ([record.id, record.implementation_id, record.run_id, record.worker_id].some(id => typeof id === "string" && ids.has(id))) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, scrub(item) ?? null]));
  };
  for (const row of database.query<{ kind: string; id: string; data: string }, []>("SELECT kind,id,data FROM records").all()) {
    if (["assignment_deletions", "deleted_assignments", "host_deleted_runs", "github_sources", "implementations"].includes(row.kind)) continue;
    const next = JSON.stringify(scrub(JSON.parse(row.data)));
    if (next !== row.data) database.query("UPDATE records SET data=? WHERE kind=? AND id=?").run(next, row.kind, row.id);
  }
  const evidence = database.query<{ id: string; data: string }, []>("SELECT id,data FROM records WHERE kind='retro_evidence'").all();
  for (const row of evidence) {
    const record = database.query<{ data: string }, [string]>("SELECT data FROM records WHERE kind='retrospectives' AND id=?").get(row.id);
    if (!record) continue;
    const retro = JSON.parse(record.data);
    const scopeHash = hash(JSON.stringify(JSON.parse(row.data).records));
    if (retro.scope_hash !== scopeHash) database.query("UPDATE records SET data=? WHERE kind='retrospectives' AND id=?").run(JSON.stringify({ ...retro, scope_hash: scopeHash, approved: false, applied_run_id: null }), row.id);
  }
  const retained = database.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('backups','assignment_deletions','deleted_assignments')").all().map(row => row.data).join("\n");
  for (const row of database.query<{ id: string; data: string }, []>("SELECT id,data FROM records WHERE kind='backups'").all()) {
    const manifest = JSON.parse(row.data);
    const next = { ...manifest, blobs: manifest.blobs.filter((blob: { hash: string }) => retained.includes(`\"${blob.hash}\"`)) };
    database.query("UPDATE records SET data=? WHERE kind='backups' AND id=?").run(JSON.stringify(next), row.id);
  }
}
