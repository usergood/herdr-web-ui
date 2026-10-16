import type { Database } from "bun:sqlite";

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
      if (!ids.has(row.id) && !(row.parent && ids.has(row.parent)) && ![data.implementation_id, data.run_id, data.worker_id, row.kind === "host_leases" ? data.run?.implementation_id : undefined].some(value => ids.has(value))) continue;
      if (["runs", "workers", "host_leases", "host_workers"].includes(row.kind)) contextIds.add(row.id);
      removed.add(row); ids.add(row.id); changed = true;
    }
  }
  for (const row of removed) database.query("DELETE FROM records WHERE kind=? AND id=?").run(row.kind, row.id);
  purgeBackupBlobReferences(database);
  database.query("INSERT OR REPLACE INTO records(kind,id,parent,data) VALUES('deleted_assignments',?,NULL,?)").run(assignmentId, JSON.stringify({ id: assignmentId, context_ids: [...contextIds] }));
}

/** Backup catalogues do not independently own blobs; Project evidence does. */
function purgeBackupBlobReferences(database: Database): void {
  const retained = database.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('backups','assignment_deletions','deleted_assignments')").all().map(row => row.data).join("\n");
  for (const row of database.query<{ id: string; data: string }, []>("SELECT id,data FROM records WHERE kind='backups'").all()) {
    const manifest = JSON.parse(row.data);
    const next = { ...manifest, blobs: manifest.blobs.filter((blob: { hash: string }) => retained.includes(`\"${blob.hash}\"`)) };
    database.query("UPDATE records SET data=? WHERE kind='backups' AND id=?").run(JSON.stringify(next), row.id);
  }
}
