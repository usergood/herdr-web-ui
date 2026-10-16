import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FactoryBackupManifest } from "../shared/protocol.ts";
import { FactoryArtifacts } from "./factory-artifacts.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { purgeAssignmentRecords } from "./factory-purge-records.ts";

type BackupManifest = FactoryBackupManifest;

/** Snapshot publication, restoration and deletion share one SQLite write reservation. */
export class FactoryBackup {
  constructor(private readonly store: FactoryStore, private readonly artifacts: FactoryArtifacts) {}
  purge(assignmentId: string): void {
    this.reserve(() => {
      this.assertDirectory(join(this.store.root, "backups"));
      for (const name of readdirSync(join(this.store.root, "backups"))) {
        const directory = join(this.store.root, "backups", name);
        this.assertDirectory(directory);
        if (!/^(restore-)?[a-f0-9-]{36}(\.tmp)?$/.test(name)) throw new FactoryError("backup_cleanup_pending", "An app-managed backup has an unknown identity; cleanup remains pending", 409);
        // Create/restore keep this reservation through publication. An unpublished
        // private staging tree found under it belongs to an interrupted operation.
        if (/^(restore-)?[a-f0-9-]{36}\.tmp$/.test(name)) { rmSync(directory, { recursive: true }); continue; }
        if (name.startsWith("restore-")) {
          const root = join(directory, "factory");
          this.assertDirectory(root); this.assertDirectory(join(root, "blobs"));
          this.readFile(join(root, "records.sqlite"));
          const copy = new FactoryStore(dirname(root));
          try {
            copy.db.transaction(() => {
              this.purgeRecords(copy.db, assignmentId);
              new FactoryBackup(copy, new FactoryArtifacts(copy)).purge(assignmentId);
              const retained = copy.db.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('backups','assignment_deletions','deleted_assignments')").all().map(row => row.data).join("\n");
              for (const digest of readdirSync(join(root, "blobs"))) {
                if (!/^[a-f0-9]{64}$/.test(digest) || retained.includes(`\"${digest}\"`)) continue;
                const path = join(root, "blobs", digest);
                if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new FactoryError("backup_cleanup_pending", "App-managed recovery blob identity changed; cleanup remains pending", 409);
                unlinkSync(path);
              }
            }).immediate();
          } finally { copy.close(); }
          continue;
        }
        this.finishRewrite(directory);
        const manifest = JSON.parse(this.readFile(join(directory, "manifest.json")).toString("utf8")) as BackupManifest;
        this.verifyManifest(manifest, name);
        this.assertDirectory(join(directory, "blobs"));
        const path = join(directory, "records.sqlite");
        const bytes = this.readFile(path);
        if (hash(bytes) !== manifest.database_hash) throw new FactoryError("backup_corrupt", "App-managed backup hash failed verification; cleanup remains pending", 409);
        const database = Database.deserialize(bytes);
        let sanitized: Buffer;
        let retained: string;
        try {
          this.verifyDatabase(database);
          database.exec("PRAGMA secure_delete=ON");
          this.purgeRecords(database, assignmentId);
          database.exec("VACUUM");
          sanitized = database.serialize();
          retained = database.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('backups','assignment_deletions','deleted_assignments')").all().map(row => row.data).join("\n");
        } finally { database.close(); }
        const next = { ...manifest, database_hash: hash(sanitized), blobs: manifest.blobs.filter(blob => retained.includes(`\"${blob.hash}\"`)) };
        for (const blob of next.blobs) {
          const content = this.readFile(join(directory, "blobs", blob.hash));
          if (hash(content) !== blob.hash || content.length !== blob.size) throw new FactoryError("backup_corrupt", "A retained app-managed backup blob failed verification; cleanup remains pending", 409);
        }
        this.writeFile(path + ".purge", sanitized);
        this.writeFile(join(directory, "purge.json.tmp"), JSON.stringify({ previous_hash: manifest.database_hash, manifest: next }));
        renameSync(join(directory, "purge.json.tmp"), join(directory, "purge.json"));
        this.finishRewrite(directory);
        this.store.put("backups", next);
      }
    });
  }
  private purgeRecords(database: Database, assignmentId: string): void {
    purgeAssignmentRecords(database, assignmentId);
    // Old snapshots predate Delete's source fences. Carry only content-free
    // identities into every sanitized copy so stale sync cannot recreate work.
    for (const source of this.store.list<{ id: string; repository: string; external_id?: string; number?: number; kind: string; branch?: string }>("github_suppressions")) {
      const { id, repository, external_id, number, kind, branch } = source;
      database.query("INSERT OR REPLACE INTO records(kind,id,parent,data) VALUES('github_suppressions',?,NULL,?)").run(id, JSON.stringify({ id, repository, external_id, number, kind, branch }));
    }
  }
  private assertDirectory(path: string): void {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new FactoryError("backup_cleanup_pending", "App-managed backup directory identity changed; cleanup remains pending", 409);
  }
  private verifyDatabase(database: Database): void {
    if (database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== 1) throw new FactoryError("backup_incompatible", "The backup failed its schema or integrity check", 409);
  }
  private verifyManifest(manifest: BackupManifest, id: string): void {
    if (manifest.id !== id || manifest.format_version !== 1 || manifest.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.database_hash) || !Array.isArray(manifest.blobs) || manifest.blobs.some(blob => !/^[a-f0-9]{64}$/.test(blob.hash) || !Number.isSafeInteger(blob.size) || blob.size < 0)) throw new FactoryError("backup_corrupt", "The app-managed backup manifest failed verification; cleanup remains pending", 409);
  }
  private reserve<T>(operation: () => T): T {
    try { return this.store.db.transaction(operation).immediate(); }
    catch (error) {
      if (error instanceof FactoryError) throw error;
      const code = (error as NodeJS.ErrnoException).code ?? "unavailable";
      throw new FactoryError("backup_cleanup_pending", `App-managed backup/recovery operation could not finish (${code}); automatic Delete reconciliation will retry`, 409);
    }
  }
  private readFile(path: string): Buffer {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(path) !== path) throw new FactoryError("backup_corrupt", "An app-managed backup file changed identity; cleanup remains pending", 409);
    return readFileSync(path);
  }
  private writeFile(path: string, content: string | Uint8Array): void {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(path) !== path)) throw new FactoryError("backup_cleanup_pending", "An app-managed backup rewrite destination changed identity; cleanup remains pending", 409);
    writeFileSync(path, content, { mode: 0o600 });
  }
  private finishRewrite(directory: string): void {
    const journal = join(directory, "purge.json");
    if (!existsSync(journal)) return;
    const pending = JSON.parse(this.readFile(journal).toString("utf8")) as { previous_hash: string; manifest: BackupManifest };
    this.verifyManifest(pending.manifest, basename(directory));
    const path = join(directory, "records.sqlite");
    const current = hash(this.readFile(path));
    if (current !== pending.manifest.database_hash) {
      if (current !== pending.previous_hash || hash(this.readFile(path + ".purge")) !== pending.manifest.database_hash) throw new FactoryError("backup_corrupt", "An interrupted app-managed backup rewrite failed hash verification; cleanup remains pending", 409);
      renameSync(path + ".purge", path);
    }
    this.writeFile(join(directory, "manifest.json.tmp"), JSON.stringify(pending.manifest));
    renameSync(join(directory, "manifest.json.tmp"), join(directory, "manifest.json"));
    this.assertDirectory(join(directory, "blobs"));
    for (const digest of readdirSync(join(directory, "blobs"))) {
      if (!/^[a-f0-9]{64}$/.test(digest) || pending.manifest.blobs.some(blob => blob.hash === digest)) continue;
      const blob = join(directory, "blobs", digest); this.readFile(blob); unlinkSync(blob);
    }
    if (existsSync(path + ".purge")) { this.readFile(path + ".purge"); unlinkSync(path + ".purge"); }
    unlinkSync(journal);
  }
  private deletedIds(): string[] {
    return [...new Set([
      ...this.store.list<{ id: string }>("deleted_assignments").map(row => row.id),
      ...this.store.list<{ id: string; deletion?: unknown }>("implementations").filter(row => row.deletion).map(row => row.id),
      ...["host_delete_requests", "host_deleted_runs"].flatMap(kind => this.store.list<{ implementation_id?: string }>(kind).flatMap(row => row.implementation_id ? [row.implementation_id] : [])),
    ])];
  }
  create(): BackupManifest {
    return this.reserve(() => {
      const deleted = this.deletedIds();
      for (const id of deleted) this.purge(id);
      const record = this.store.record();
      const staging = join(this.store.root, "backups", record.id + ".tmp");
      mkdirSync(staging, { mode: 0o700 }); mkdirSync(join(staging, "blobs"), { mode: 0o700 });
      const manifest = this.store.db.transaction(() => {
        let database = this.store.db.serialize();
        let references: string | undefined;
        if (deleted.length) {
          const copy = Database.deserialize(database);
          try {
            copy.exec("PRAGMA secure_delete=ON");
            for (const id of deleted) this.purgeRecords(copy, id);
            copy.exec("VACUUM"); database = copy.serialize();
            references = copy.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('backups','assignment_deletions','deleted_assignments')").all().map(row => row.data).join("\n");
          } finally { copy.close(); }
        }
        const seen = new Set<string>(); const blobs: BackupManifest["blobs"] = [];
        const retained = this.artifacts.retained();
        for (const artifact of retained) {
          if (references !== undefined && !references.includes(`\"${artifact.hash}\"`)) continue;
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
    });
  }
  restore(id: string): { id: string; state_dir: string; execution_enabled: false } {
    return this.reserve(() => {
      for (const deleted of this.deletedIds()) this.purge(deleted);
      const manifest = this.store.get<BackupManifest>("backups", id);
      if (!manifest) throw new FactoryError("not_found", "Backup not found", 404);
      this.verifyManifest(manifest, id);
      const source = join(this.store.root, "backups", manifest.id);
      this.assertDirectory(source); this.assertDirectory(join(source, "blobs"));
      const read = (name: string, digest: string): Buffer => {
        const path = join(source, name);
        const bytes = this.readFile(path);
        if (hash(bytes) !== digest) throw new FactoryError("backup_corrupt", "A backup hash failed verification", 409);
        return bytes;
      };
      const database = read("records.sqlite", manifest.database_hash);
      const check = Database.deserialize(database, { readonly: true });
      try {
        this.verifyDatabase(check);
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
    });
  }
}
