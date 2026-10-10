import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryBackupManifest } from "../shared/protocol.ts";
import { FactoryArtifacts } from "./factory-artifacts.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

type BackupManifest = FactoryBackupManifest;

/** Immutable blobs and the database are captured under one SQLite write reservation. */
export class FactoryBackup {
  constructor(private readonly store: FactoryStore, private readonly artifacts: FactoryArtifacts) {}
  create(): BackupManifest {
    const record = this.store.record();
    const staging = join(this.store.root, "backups", record.id + ".tmp");
    mkdirSync(staging, { mode: 0o700 }); mkdirSync(join(staging, "blobs"), { mode: 0o700 });
    const manifest = this.store.db.transaction(() => {
      const database = this.store.db.serialize();
      const seen = new Set<string>(); const blobs: BackupManifest["blobs"] = [];
      const retained = this.artifacts.retained();
      for (const artifact of retained) {
        if (seen.has(artifact.hash)) continue;
        const bytes = this.artifacts.read(artifact);
        writeFileSync(join(staging, "blobs", artifact.hash), bytes, { flag: "wx", mode: 0o600 });
        seen.add(artifact.hash); blobs.push({ hash: artifact.hash, size: artifact.size });
      }
      writeFileSync(join(staging, "records.sqlite"), database, { flag: "wx", mode: 0o600 });
      return { id: record.id, created_at: record.created_at, format_version: 1 as const, schema_version: 1 as const, database_hash: hash(database), blobs };
    }).immediate();
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    renameSync(staging, join(this.store.root, "backups", record.id));
    this.store.db.transaction(() => { this.store.put("backups", manifest); this.store.event(null, "backup_created", { backup_id: record.id, blob_count: manifest.blobs.length }); })();
    return manifest;
  }
  restore(id: string): { id: string; state_dir: string; execution_enabled: false } {
    const manifest = this.store.get<BackupManifest>("backups", id);
    if (!manifest) throw new FactoryError("not_found", "Backup not found", 404);
    const source = join(this.store.root, "backups", manifest.id);
    if (lstatSync(source).isSymbolicLink() || realpathSync(source) !== source) throw new FactoryError("backup_corrupt", "The backup directory was changed", 409);
    const read = (name: string, digest: string): Buffer => {
      const path = join(source, name);
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new FactoryError("backup_corrupt", "A backup file was changed", 409);
      const bytes = readFileSync(path);
      if (hash(bytes) !== digest) throw new FactoryError("backup_corrupt", "A backup hash failed verification", 409);
      return bytes;
    };
    const database = read("records.sqlite", manifest.database_hash);
    const check = Database.deserialize(database, { readonly: true });
    try {
      if (check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok" || check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 1) throw new FactoryError("backup_incompatible", "The backup failed its schema or integrity check", 409);
    } finally { check.close(); }
    const record = this.store.record();
    const state = join(this.store.root, "backups", "restore-" + record.id);
    const staging = state + ".tmp";
    mkdirSync(join(staging, "factory", "blobs"), { recursive: true, mode: 0o700 });
    for (const blob of manifest.blobs) {
      if (!/^[a-f0-9]{64}$/.test(blob.hash)) throw new FactoryError("backup_corrupt", "Invalid backup blob identity", 409);
      const bytes = read(join("blobs", blob.hash), blob.hash);
      if (bytes.length !== blob.size) throw new FactoryError("backup_corrupt", "A backup blob size failed verification", 409);
      writeFileSync(join(staging, "factory", "blobs", blob.hash), bytes, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(staging, "factory", "records.sqlite"), database, { flag: "wx", mode: 0o600 });
    writeFileSync(join(staging, "factory", "recovery-copy.json"), JSON.stringify({ backup_id: id, execution_enabled: false }), { flag: "wx", mode: 0o600 });
    if (existsSync(state)) throw new FactoryError("restore_conflict", "The restore destination already exists", 409);
    renameSync(staging, state);
    this.store.event(null, "backup_restored_to_copy", { backup_id: id, restore_id: record.id });
    return { id: record.id, state_dir: state, execution_enabled: false };
  }
}
