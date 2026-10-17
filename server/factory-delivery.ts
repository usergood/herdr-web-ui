import { hasIssueSource } from "./issue-delivery.ts";
import type { FactoryRun, FactoryWorker, FactoryCheck, FactoryQuestion, ReviewSnapshot, Implementation, DeliveryChange } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";

/** Exact intended Git content, including mode changes, deletions and renamed paths. */
export interface DeliveryTree { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] }
export function containsDeliveryChange(tree: DeliveryTree, file: DeliveryChange): boolean {
  const entry = tree.tree.find(entry => entry.path === file.path);
  return file.oid === null ? !entry : entry?.sha === file.oid && entry.mode === file.mode && (!file.old_path || !tree.tree.some(entry => entry.path === file.old_path));
}

/** A later owner question cannot revive execution already accepted and stopped.
 * This observes physical retirement only; completion and delivery keep their gates. */
export function deliveryExecutionEnded(store: FactoryStore, run: FactoryRun): boolean {
  if (["completed", "cancelled", "failed"].includes(run.condition)) return !run.implementation_completion_pending;
  if (run.condition !== "needs_you" || run.implementation_completion_pending || run.scope_pause || run.issue_pause || !run.accepted_result) return false;
  const retirement = store.get<{ completion?: FactoryRun["implementation_completion"]; rework_requested?: boolean }>("implementation_retirement", run.id);
  const proof = retirement?.completion, accepted = run.accepted_result;
  if (retirement?.rework_requested || !proof || proof.head !== accepted.head || proof.workspace_hash !== accepted.workspace_hash || proof.check_id !== accepted.check_id
    || accepted.review_ids.length !== 2 || proof.standards_id !== accepted.review_ids[0] || proof.spec_id !== accepted.review_ids[1]) return false;
  return store.list<FactoryQuestion>("questions", run.implementation_id).some(question => question.answer === null && (!question.run_id || store.get<FactoryRun>("runs", question.run_id)?.action !== "verify-provider"));
}

/** Only admission-recorded bounded work retains the manual compatibility path. */
export function manualCompletionAllowed(store: FactoryStore, idea: Implementation): boolean {
  if (idea.delivery_scope) return false;
  const runs = store.list<FactoryRun>("runs", idea.id).filter(run => run.checkout);
  return runs.length > 0 && runs.every(run => {
    const receipt = store.get<{ id: string; project_id: string; contract_hash: string }>("manual_completion_scopes", run.id);
    return !!receipt && receipt.id === run.id && receipt.project_id === idea.project_id && receipt.contract_hash === (run.manifest as { contract_hash?: string }).contract_hash;
  });
}

/** Completion evidence spans every retained attempt, including committed repository work. */
export class FactoryDelivery {
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime) {}
  async inspect(id: string): Promise<NonNullable<Implementation["completion_evidence"]>> {
    const idea = this.store.get<Implementation>("implementations", id)!;
    const runs = this.store.list<FactoryRun>("runs", id);
    let changes: "none" | "changes" | "unknown" = this.store.list<ReviewSnapshot>("snapshots", id).some(snapshot => snapshot.files.length > 0) ? "changes" : "none";
    let quiescent = true;
    let failed = false;
    try {
      for (const run of runs) {
        const observed = await this.runtime.reconcile(run.id);
        if (observed.condition !== "ready" && !deliveryExecutionEnded(this.store, observed)) quiescent = false;
        if (!run.checkout) continue;
        const base = idea.delivery_scope?.base ?? run.base;
        const repository = idea.delivery_scope?.repository ?? (run.manifest as { checkout?: { repository?: string } }).checkout?.repository;
        if (!run.worktree || !base || !repository) throw new Error("Missing repository baseline");
        const workers = this.store.list<FactoryWorker>("workers", run.id);
        if (workers.some(worker => !["completed", "cancelled", "failed"].includes(worker.condition)) || this.store.list<FactoryCheck>("checks", run.id).some(check => ["working", "interrupted"].includes(check.condition))) quiescent = false;
        if (workers.some(worker => !worker.worktree)) throw new Error("Missing child worktree");
        for (const path of new Set([run.checkout, run.worktree, ...workers.map(worker => worker.worktree!)])) {
          for (const mode of ["branch", "workspace"] as const) {
            const snapshot = await this.runtime.capture(run.machine_id, path, base, mode);
            if (snapshot.repository !== repository) throw new Error("Repository identity changed");
            if (snapshot.files.length) changes = "changes";
          }
        }
      }
    } catch { changes = changes === "changes" ? "changes" : "unknown"; quiescent = false; failed = true; }
    const evidence: NonNullable<Implementation["completion_evidence"]> = { repository_changes: changes, quiescent, reason_is_error: failed, reason: failed ? "Repository change evidence is unavailable. Reconnect the Machine and inspect the retained work before accepting research." : changes === "changes" && (!manualCompletionAllowed(this.store, idea) || hasIssueSource(this.store, id)) ? "Repository changes require verified PR delivery. Link the delivery evidence before completing this Assignment." : changes === "unknown" ? "Repository change evidence is unavailable. Reconnect the Machine and inspect the retained work before accepting research." : !quiescent ? "Owned work is still active or uncertain. Reconcile it before accepting research." : null, checked_at: new Date().toISOString() };
    const current = this.store.get<Implementation>("implementations", id)!;
    this.store.put("implementations", { ...current, completion_evidence: evidence });
    return evidence;
  }
}
