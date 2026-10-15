import { existsSync, lstatSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FactoryDeleteResult, FactoryRun, Implementation } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { purgeAssignmentReferences } from "./factory-purge-records.ts";

/** Durable ownership fence and cleanup journal. External obligations finish separately. */
export class FactoryDeletion {
  private stopped = false;
  private readonly pending = new Map<string, Promise<FactoryDeleteResult>>();
  constructor(private readonly store: FactoryStore, private readonly cleanup: (run: FactoryRun, deletionId: string) => Promise<void>, private readonly purgeBackups: (id: string) => void) {}
  async request(id: string): Promise<FactoryDeleteResult> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Delete is disabled on a restored copy", 409);
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea) {
      if (this.store.get("deleted_assignments", id)) return { id, condition: "deleted" };
      throw new FactoryError("not_found", "Assignment not found", 404);
    }
    const next = { ...idea, deletion: idea.deletion ?? { id: this.store.record().id, condition: "pending" as const, reasons: [] } };
    this.store.put("implementations", next);
    return this.reconcile(id);
  }
  reconcile(id: string): Promise<FactoryDeleteResult> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const operation = this.perform(id).catch(error => {
      const reasons = [error instanceof FactoryError ? error.message : "Owned cleanup failed; deletion remains pending for automatic reconciliation"];
      if (!this.stopped) {
        const idea = this.store.get<Implementation>("implementations", id);
        if (idea?.deletion) this.store.put("implementations", { ...idea, deletion: { ...idea.deletion, reasons } });
      }
      return { id, condition: "pending" as const, reasons };
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, operation); return operation;
  }
  private async perform(id: string): Promise<FactoryDeleteResult> {
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea?.deletion) return { id, condition: "deleted" };
    if (!/^[a-f0-9-]{36}$/.test(idea.deletion.id)) throw new FactoryError("delete_identity_uncertain", "The restored Delete identity requires reconciliation before cleanup", 409);
    const reasons: string[] = [];
    let journal = this.store.get<{ id: string; backups: boolean; github: boolean; local_done: boolean; blobs: string[] }>("assignment_deletions", id);
    if (!journal) {
      journal = { id, backups: true, github: this.store.list<{ implementation_id: string }>("github_sources").some(source => source.implementation_id === id), local_done: false, blobs: [] };
      this.store.put("assignment_deletions", journal);
    }
    for (const run of this.store.list<FactoryRun>("runs", id)) {
      if (this.store.get("deletion_attempts", run.id)) continue;
      try {
        await this.cleanup(run, idea.deletion.id);
        if (this.stopped) return { id, condition: "pending", reasons: ["Deletion will reconcile after restart"] };
        this.store.db.transaction(() => {
          this.store.put("deletion_attempts", { id: run.id }, id);
          this.store.put("runs", { ...run, condition: "cancelled" }, id);
          for (const kind of ["workers", "checks"]) for (const target of this.store.list<{ id: string }>(kind, run.id)) this.store.put(kind, { ...target, condition: kind === "checks" ? "failed" : "cancelled" }, run.id);
        }).immediate();
      } catch (error) { reasons.push(`${run.machine_id} / ${run.id}: ${error instanceof FactoryError ? error.message : "Machine cleanup could not be confirmed"}`); }
    }
    if (this.stopped) return { id, condition: "pending", reasons };
    if (reasons.length) {
      this.store.put("implementations", { ...idea, deletion: { ...idea.deletion, reasons } });
      return { id, condition: "pending", reasons };
    }
    try { this.purgeBackups(id); journal.backups = false; }
    catch (error) { journal.backups = true; reasons.push(error instanceof FactoryError ? error.message : "App-managed backup and recovery cleanup failed; deletion remains pending"); }
    const inbox = join(this.store.root, "inbox", id);
    const inboxInfo = lstatSync(inbox, { throwIfNoEntry: false });
    if (inboxInfo) {
      if (!inboxInfo.isDirectory() || inboxInfo.isSymbolicLink() || realpathSync(inbox) !== inbox) {
        const reason = "Owned Assignment data changed filesystem identity; cleanup remains pending";
        this.store.put("implementations", { ...idea, deletion: { ...idea.deletion, reasons: [reason] } });
        return { id, condition: "pending", reasons: [reason] };
      }
      rmdirSync(inbox); // Each owned attempt removed its own tree; unexpected siblings remain pending.
    }
    this.store.db.transaction(() => {
      const runs = this.store.list<FactoryRun>("runs", id);
      const contextIds = [...runs.map(run => run.id), ...runs.flatMap(run => this.store.list<{ id: string }>("workers", run.id).map(worker => worker.id))];
      const ids = new Set([id]);
      const keep = new Set(["assignment_deletions", "deleted_assignments", "host_deleted_runs", "github_sources"]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of this.store.db.query<{ kind: string; id: string; parent: string | null; data: string }, []>("SELECT kind,id,parent,data FROM records").all()) {
          if (keep.has(row.kind)) continue;
          const data = JSON.parse(row.data);
          if (!(row.parent && ids.has(row.parent)) && ![data.implementation_id, data.run_id, data.worker_id].some(value => ids.has(value)) && !(ids.has(row.id) && row.kind !== "implementations")) continue;
          for (const match of row.data.matchAll(/"hash":"([a-f0-9]{64})"/g)) if (!journal!.blobs.includes(match[1]!)) journal!.blobs.push(match[1]!);
          this.store.remove(row.kind, row.id); ids.add(row.id); changed = true;
        }
      }
      purgeAssignmentReferences(this.store.db, ids);
      this.store.put("deleted_assignments", { id, context_ids: [...new Set([...(this.store.get<{ context_ids: string[] }>("deleted_assignments", id)?.context_ids ?? []), ...contextIds, ...ids].filter(contextId => contextId !== id))] });
      this.store.put("implementations", { ...idea, title: "Delete pending", description: "", outcome: "none", pause: undefined, deletion: { ...idea.deletion!, reasons: [], local_cleanup: undefined } });
      this.store.put("assignment_deletions", { ...journal!, local_done: true });
    }).immediate();
    const retained = this.store.db.query<{ data: string }, []>("SELECT data FROM records WHERE kind NOT IN ('assignment_deletions','deleted_assignments')").all();
    for (const digest of journal.blobs) {
      if (retained.some(row => row.data.includes(`"${digest}"`))) continue;
      const path = join(this.store.root, "blobs", digest);
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !lstatSync(path).isFile()) {
        reasons.push("An exclusive attachment changed filesystem identity; cleanup remains pending"); continue;
      }
      unlinkSync(path);
    }
    const localCleanup = reasons.length ? undefined : "complete" as const;
    if (journal.backups && !reasons.length) reasons.push("App-managed backup and recovery cleanup has not been confirmed");
    if (journal.github) reasons.push("Linked GitHub issue deletion and source suppression have not been confirmed");
    if (reasons.length) {
      this.store.put("implementations", { ...idea, title: "Delete pending", description: "", outcome: "none", pause: undefined, deletion: { ...idea.deletion, reasons, local_cleanup: localCleanup } });
      return { id, condition: "pending", reasons };
    }
    this.store.db.transaction(() => { this.store.remove("implementations", id); this.store.remove("assignment_deletions", id); }).immediate();
    return { id, condition: "deleted" };
  }
  stop(): void { this.stopped = true; }
}
