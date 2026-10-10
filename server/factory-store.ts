import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { FactoryRecord } from "../shared/factory.ts";

/** One transactional record/event store, never a provider's native transcript database. */
export class FactoryStore {
  readonly root: string;
  readonly db: Database;
  constructor(stateDir: string) {
    const root = join(stateDir, "factory");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.root = realpathSync(root);
    for (const name of ["blobs", "inbox", "worktrees", "backups"]) mkdirSync(join(this.root, name), { recursive: true, mode: 0o700 });
    const path = join(this.root, "records.sqlite");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 1) { this.db.close(); throw new Error("Factory database requires a newer application; preserve it for recovery"); }
    this.db.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_parent ON records(kind,parent); PRAGMA user_version=1;");
    })();
  }
  list<T>(kind: string, parent?: string): T[] {
    const rows = parent === undefined
      ? this.db.query<{ data: string }, [string]>("SELECT data FROM records WHERE kind=? ORDER BY rowid").all(kind)
      : this.db.query<{ data: string }, [string, string]>("SELECT data FROM records WHERE kind=? AND parent=? ORDER BY rowid").all(kind, parent);
    return rows.map((row) => JSON.parse(row.data) as T);
  }
  get<T>(kind: string, id: string): T | null {
    const row = this.db.query<{ data: string }, [string, string]>("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(row.data) as T : null;
  }
  put<T extends { id: string }>(kind: string, record: T, parent: string | null = null): T {
    this.db.query("INSERT INTO records(kind,id,parent,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent=excluded.parent,data=excluded.data").run(kind, record.id, parent, JSON.stringify(record));
    return record;
  }
  remove(kind: string, id: string): void { this.db.query("DELETE FROM records WHERE kind=? AND id=?").run(kind, id); }
  record(): FactoryRecord { const now = new Date().toISOString(); return { id: randomUUID(), created_at: now, updated_at: now }; }
  event(parent: string | null, kind: string, data: unknown): void {
    const record = this.record();
    this.put("events", { ...record, implementation_id: parent, kind, data }, parent);
    const implementation = parent ? this.get<{ id: string; updated_at: string }>("implementations", parent) : null;
    if (implementation) this.put("implementations", { ...implementation, updated_at: record.created_at });
  }
  close(): void { this.db.close(); }
}
