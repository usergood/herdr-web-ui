import type { FactoryRun, FactoryWorker, FactoryCheck, FactoryProject, Implementation, ProjectCheckout, ReviewSnapshot } from "../shared/factory.ts";
import { deliveryScopeCurrent } from "./issue-delivery.ts";
import type { FactoryStore } from "./factory-store.ts";

const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
function verifiedDelivery(idea: Implementation, requireRelease = idea.delivery_scope?.milestone === "release"): boolean {
  const scope = idea.delivery_scope, delivery = idea.delivery, evidence = idea.completion_evidence;
  const released = idea.outcome === "released" && delivery?.condition === "released" && !!delivery.release
    && oid(delivery.release.commit) && Number.isFinite(Date.parse(delivery.release.published_at))
    && delivery.pulls.every(pull => delivery.release!.merge_commits.includes(pull.merge_commit));
  return !!scope?.repository && !!scope.github_repository && oid(scope.base)
    && (!requireRelease && idea.outcome === "merged" && delivery?.condition === "merged" || released)
    && !!delivery && delivery.problem === null
    && delivery.repository.toLowerCase() === scope.github_repository.toLowerCase() && delivery.branch === scope.branch
    && oid(delivery.branch_head) && Number.isFinite(Date.parse(delivery.checked_at ?? ""))
    && evidence?.repository_changes === "changes" && evidence.quiescent && evidence.reason === null
    && delivery.pull_numbers.length > 0 && delivery.pulls.length === delivery.pull_numbers.length
    && delivery.pulls.every(pull => delivery.pull_numbers.includes(pull.number) && oid(pull.head) && oid(pull.merge_commit))
    && delivery.changes.length > 0 && delivery.changes.every(change => (change.oid === null || oid(change.oid)) && delivery.pulls.some(pull => pull.covered_paths.includes(change.path)));
}

/** Intake coverage is also verified delivery; retain its independent proof on upgrade. */
function verifiedIssueDelivery(store: FactoryStore, idea: Implementation): boolean {
  const proof = idea.delivery_evidence;
  if (!proof || !["merged", "released"].includes(idea.outcome)) return false;
  const source = store.get<import("../shared/github-project.ts").ProjectGitHubSource>("github_sources", proof.source_id);
  const link = source && store.get<import("../shared/github-project.ts").IssueDeliveryLink>("github_delivery_links", source.id);
  const requiresRelease = proof.requires === "release" || idea.delivery_scope?.milestone === "release";
  return !!source && source.implementation_id === idea.id && !!link && link.revision === proof.coverage_revision && deliveryScopeCurrent(store, source, link)
    && proof.merges.length > 0 && proof.merges.length === link.intended_prs.length
    && proof.merges.every(merge => oid(merge.head) && oid(merge.merge_commit) && merge.target_branch === link.target_branch && link.intended_prs.some(pull => pull.number === merge.number && pull.head === merge.head))
    && (!requiresRelease || idea.outcome === "released" && !!proof.release && proof.release.tag === link.release_tag && oid(proof.release.commit) && Number.isFinite(Date.parse(proof.release.published_at)));
}

function retainedScope(runs: FactoryRun[]): Implementation["delivery_scope"] {
  const run = runs.find(run => run.checkout);
  const manifest = run?.manifest as { project?: FactoryProject; checkout?: ProjectCheckout } | undefined;
  const checkout = manifest?.checkout, project = manifest?.project;
  if (!checkout?.repository || !oid(run?.base) || checkout.head !== run.base || project?.repository && project.repository !== checkout.repository) return;
  const branch = project?.delivery_branch ?? checkout.branch;
  if (!branch || branch === "HEAD") return;
  return { repository: checkout.repository, base: run.base, branch, milestone: project?.delivery_policy ?? "merge" };
}

/** Reconcile retained completion locally before any runtime or scheduler is constructed. */
export function migrateFactoryHistory(store: FactoryStore, restoredId?: string): void {
  store.db.transaction(() => {
    if (!restoredId && store.get("migrations", "delivery-completion-v1")) return;
    for (const idea of store.list<Implementation>("implementations")) {
      if (idea.stage !== "done" || idea.archived_at || restoredId && idea.id !== restoredId) continue;
      const runs = store.list<FactoryRun>("runs", idea.id);
      const retainedChanges = store.list<ReviewSnapshot>("snapshots", idea.id).some(snapshot => snapshot.files.length > 0);
      const quiescent = runs.every(run => ["completed", "cancelled", "failed"].includes(run.condition)
        && store.list<FactoryWorker>("workers", run.id).every(worker => ["completed", "cancelled", "failed"].includes(worker.condition))
        && store.list<FactoryCheck>("checks", run.id).every(check => !["working", "interrupted"].includes(check.condition)));
      if (quiescent && idea.outcome === "discarded" && Number.isFinite(Date.parse(idea.discard_requested_at ?? ""))) continue;
      if (quiescent && !retainedChanges && idea.outcome === "research_accepted" && idea.completion_evidence?.repository_changes === "none" && idea.completion_evidence.quiescent && idea.completion_evidence.reason === null && Number.isFinite(Date.parse(idea.completion_evidence.checked_at))) continue;
      if (quiescent && (verifiedDelivery(idea) || verifiedIssueDelivery(store, idea))) continue;
      const changes = retainedChanges || idea.completion_evidence?.repository_changes === "changes" ? "changes" : "unknown";
      const pendingRelease = verifiedDelivery(idea, false) && idea.delivery_scope?.milestone === "release";
      const reason = !quiescent
        ? "Historical completion has active or uncertain owned work. Reconcile retained work, correct delivery links or discard this Assignment."
        : pendingRelease
        ? "Historical completion requires a verified containing release. Sync delivery evidence, correct delivery links or discard this Assignment."
        : changes === "changes"
        ? "Historical completion includes repository changes without verified delivery. Inspect retained work, correct delivery links or discard this Assignment."
        : "Historical completion has no verified delivery or no-change acceptance evidence. Inspect retained work, correct delivery links or discard this Assignment.";
      const scope = idea.delivery_scope ?? retainedScope(runs);
      store.put("implementations", { ...idea, ...(scope ? { delivery_scope: scope } : {}), stage: "review", outcome: "none", ...(idea.delivery ? { delivery: { ...idea.delivery, condition: pendingRelease ? "merged" : "needs_you", release: undefined, problem: reason } } : {}), completion_evidence: { repository_changes: changes, quiescent, reason, checked_at: new Date().toISOString() } });
      store.event(idea.id, "historical_completion_reconciled", { previous_stage: idea.stage, previous_outcome: idea.outcome, previous_delivery: idea.delivery, previous_completion_evidence: idea.completion_evidence, reason });
    }
    if (!restoredId) store.put("migrations", { ...store.record(), id: "delivery-completion-v1" });
  }).immediate();
}
