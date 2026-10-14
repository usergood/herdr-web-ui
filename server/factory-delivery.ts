import type { FactoryRun, FactoryWorker, FactoryCheck, ReviewSnapshot, Implementation } from "../shared/factory.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryRuntime } from "./factory-runtime.ts";

/** Completion evidence spans every retained attempt, including committed repository work. */
export class FactoryDelivery {
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime) {}
  async inspect(id: string): Promise<NonNullable<Implementation["completion_evidence"]>> {
    const idea = this.store.get<Implementation>("implementations", id)!;
    const runs = this.store.list<FactoryRun>("runs", id);
    let changes: "none" | "changes" | "unknown" = this.store.list<ReviewSnapshot>("snapshots", id).some(snapshot => snapshot.files.length > 0) ? "changes" : "none";
    let quiescent = true;
    try {
      for (const run of runs) {
        const observed = await this.runtime.reconcile(run.id);
        if (!["ready", "completed", "cancelled", "failed"].includes(observed.condition)) quiescent = false;
        if (!run.checkout) continue;
        if (!run.worktree || !idea.delivery_scope?.base || !idea.delivery_scope.repository) throw new Error("Missing repository baseline");
        const workers = this.store.list<FactoryWorker>("workers", run.id);
        if (workers.some(worker => !["completed", "cancelled", "failed"].includes(worker.condition)) || this.store.list<FactoryCheck>("checks", run.id).some(check => ["working", "interrupted"].includes(check.condition))) quiescent = false;
        if (workers.some(worker => !worker.worktree)) throw new Error("Missing child worktree");
        for (const path of new Set([run.checkout, run.worktree, ...workers.map(worker => worker.worktree!)])) {
          for (const mode of ["branch", "workspace"] as const) {
            const snapshot = await this.runtime.capture(run.machine_id, path, idea.delivery_scope.base, mode);
            if (snapshot.repository !== idea.delivery_scope.repository) throw new Error("Repository identity changed");
            if (snapshot.files.length) changes = "changes";
          }
        }
      }
    } catch { changes = changes === "changes" ? "changes" : "unknown"; quiescent = false; }
    const evidence: NonNullable<Implementation["completion_evidence"]> = { repository_changes: changes, quiescent, reason: changes === "changes" ? "Repository changes require verified PR delivery. Link the delivery evidence before completing this Assignment." : changes === "unknown" ? "Repository change evidence is unavailable. Reconnect the Machine and inspect the retained work before accepting research." : !quiescent ? "Owned work is still active or uncertain. Reconcile it before accepting research." : null, checked_at: new Date().toISOString() };
    const current = this.store.get<Implementation>("implementations", id)!;
    this.store.put("implementations", { ...current, completion_evidence: evidence });
    return evidence;
  }
}
