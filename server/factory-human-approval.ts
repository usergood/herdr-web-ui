import type { FactoryCheck, FactoryDetail, FactoryHumanApproval, FactoryHumanFeedbackBatch, FactoryHumanReview, FactoryMergeResult, FactoryProject, FactoryPullRequest, FactoryReviewEvidence, FactoryRun, Implementation, ReviewSnapshot } from "../shared/factory.ts";
import { FactoryError, hash } from "./factory-host.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Owner control operations do not allocate an Agent context. */
export class FactoryHumanApprovalService {
  private stopped = false;
  stop(): void { this.stopped = true; }
  private readonly busy = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly workflow: import("./factory-workflow.ts").FactoryWorkflow, private readonly retainBeforeDelivery: (id: string) => Promise<unknown>) {}
  private candidate(id: string, review: FactoryHumanReview, submitting = false) {
    if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping", 409);
    this.runtime.assertExecuting(id);
    const run = this.store.get<FactoryRun>("runs", review.run_id);
    const snapshot = review.snapshot_id ? this.store.get<ReviewSnapshot>("snapshots", review.snapshot_id) : null;
    const pr = this.store.get<FactoryPullRequest>("pull_requests", review.run_id);
    const frozen = run?.manifest as { project?: FactoryProject } | undefined;
    if (!run || run.implementation_id !== id || run.action !== "implement-spec" || review.condition !== "ready" || !snapshot || snapshot.head !== review.head || !pr || pr.head !== review.head || frozen?.project?.pull_request?.repository !== pr.repository || frozen.project.pull_request.base_branch !== pr.base_branch) throw new FactoryError("review_stale", "Select the current captured and published Human Review candidate", 409);
    if (this.store.list<FactoryRun>("runs", id).filter(r => r.action === "implement-spec").at(-1)?.id !== run.id) throw new FactoryError("review_stale", "A newer implementation attempt supersedes this review", 409);
    if (!submitting && this.store.list<FactoryDetail["comments"][number]>("comments", id).some(c => c.status !== "resolved")) throw new FactoryError("review_comments_pending", "Submit or resolve all retained review comments before approving without comments", 409);
    const check = this.store.list<FactoryCheck>("checks", run.id).filter(c => c.worker_id === null).at(-1);
    const reports = pr.evidence_ids.map(key => this.store.get<FactoryReviewEvidence>("review_evidence", key));
    const latestReports = this.store.list<FactoryReviewEvidence>("review_evidence", run.id);
    const recipes = [...frozen.project.setup ?? [], ...frozen.project.checks ?? []];
    if (!check || check.id !== pr.check_id || check.run_id !== run.id || check.worker_id !== null || check.condition !== "passed" || check.head !== pr.head || !recipes.length || JSON.stringify(check.commands.map(c => c.args)) !== JSON.stringify(recipes) || check.commands.some(c => c.exit_code !== 0) || reports.length !== 2 || !["standards", "spec"].every(axis => reports.some(r => r?.id === latestReports.filter(latest => latest.axis === axis).at(-1)?.id && r?.run_id === run.id && r.axis === axis && r.head === pr.head && r.outcome === "passed"))) throw new FactoryError("fresh_evidence_required", "Retain passing configured checks and independent Standards and Spec reports for this candidate", 409);
    return { run, pr, check, reports: reports as FactoryReviewEvidence[] };
  }
  private repairScope(id: string, runId: string): string {
    const pr = this.store.get<FactoryPullRequest>("pull_requests", runId);
    return hash(JSON.stringify({ manifest: this.store.get<FactoryRun>("runs", runId)?.manifest, plan: this.store.get("execution_plans", runId), context: this.workflow.questionRevision(id, runId), target: pr && { repository: pr.repository, base_branch: pr.base_branch, branch: pr.branch, number: pr.number } }));
  }
  /** Feedback may retire only authority positively blocked before a merge send. */
  supersedeForFeedback(id: string, review: FactoryHumanReview, batchId: string): void {
    const receipts = this.store.list<FactoryHumanApproval>("human_review_approvals", id).filter(a => a.review_id === review.id && !a.superseded_by_batch_id);
    if (receipts.some(a => a.condition !== "blocked" || !a.merge_not_sent || this.busy.has(a.id))) throw new FactoryError("approval_conflict", "Reconcile retained merge authority before submitting different feedback", 409);
    for (const receipt of receipts) this.store.put("human_review_approvals", { ...receipt, superseded_by_batch_id: batchId }, id);
  }
  /** Called inside the same transaction that claims the complete comment batch. */
  authorizeRepairs(id: string, review: FactoryHumanReview, batch: FactoryHumanFeedbackBatch, origin: string): void {
    this.candidate(id, review, true);
    if (!batch.comment_ids.length || this.store.list<FactoryHumanApproval>("human_review_approvals", id).some(a => a.review_id === review.id && !a.superseded_by_batch_id)) throw new FactoryError("approval_conflict", "This review already has merge authority or has no comments to repair", 409);
    const receipt: FactoryHumanApproval = { ...this.store.record(), implementation_id: id, review_id: review.id, run_id: review.run_id, snapshot_id: review.snapshot_id!, head: review.head, original_candidate: { head: review.head, snapshot_id: review.snapshot_id! }, repair_batch_id: batch.id, repair_scope: this.repairScope(id, review.run_id), repair_signature: batch.signature, idempotency_key: batch.key, provenance: { kind: "owner_button", origin }, condition: "repairing", reason: null, merge_sha: null, release_tag: null };
    this.store.put("human_review_approvals", receipt, id);
  }
  private assertRepairLineage(receipt: FactoryHumanApproval, batch: FactoryHumanFeedbackBatch, finalHead: string): void {
    if (batch.signature !== receipt.repair_signature || !receipt.original_candidate || batch.run_id !== receipt.run_id || batch.head !== receipt.original_candidate.head || batch.snapshot_id !== receipt.original_candidate.snapshot_id || batch.disposition !== "approve" || !batch.merge_authorized) throw new FactoryError("review_stale", "Conditional authority no longer matches the submitted review and comments", 409);
    const batches = new Set([batch.id, ...this.store.list<import("../shared/factory.ts").FactoryAutomaticReviewBatch>("automatic_review_batches", receipt.implementation_id).filter(b => b.run_id === receipt.run_id && b.human_batch_id === batch.id).map(b => b.id)]);
    const workers = this.store.list<import("../shared/factory.ts").FactoryWorker>("workers", receipt.run_id).filter(w => w.rework_batch_id && batches.has(w.rework_batch_id) && w.condition === "completed");
    let tip = batch.head;
    const remaining = [...workers];
    // Completed Machine integration receipts are durable authority. Events are
    // display history and can be absent after a crash between retained writes.
    while (remaining.length) {
      const index = remaining.findIndex(w => w.integration_tip === tip && w.head === tip);
      const next = index >= 0 ? index : remaining.findIndex(w => w.integration_tip === tip && w.head);
      if (next < 0) throw new FactoryError("review_stale", "The candidate changed outside the submitted Human Review repair lineage", 409);
      tip = remaining.splice(next, 1)[0]!.head!;
    }
    if (!batch.ticket_ids.every(id => workers.some(w => w.ticket_id === id && w.rework_batch_id === batch.id)) || tip !== finalHead) throw new FactoryError("review_stale", "The candidate changed outside the submitted Human Review repair lineage", 409);
  }
  async approve(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryHumanApproval> {
    if (typeof body.idempotency_key !== "string" || !/^[\w-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_approval", "Send the displayed candidate and a stable approval identity");
    const review = typeof body.review_id === "string" ? this.store.get<FactoryHumanReview>("human_reviews", body.review_id) : null;
    if (!review || review.implementation_id !== id || review.snapshot_id !== body.snapshot_id || review.head !== body.head) throw new FactoryError("review_stale", "Approval must name the displayed snapshot and head", 409);
    const receipts = this.store.list<FactoryHumanApproval>("human_review_approvals", id);
    let receipt = receipts.find(a => a.idempotency_key === body.idempotency_key) ?? receipts.find(a => a.review_id === review.id && !a.superseded_by_batch_id);
    if (receipt && (receipt.superseded_by_batch_id || receipt.review_id !== review.id || receipt.head !== body.head || receipt.snapshot_id !== body.snapshot_id)) throw new FactoryError("approval_conflict", "This approval identity belongs to another candidate", 409);
    if (!receipt) {
      this.candidate(id, review);
      receipt = { ...this.store.record(), implementation_id: id, review_id: review.id, run_id: review.run_id, snapshot_id: review.snapshot_id!, head: review.head, idempotency_key: body.idempotency_key, provenance: { kind: "owner_button", origin }, condition: "pending", reason: null, merge_sha: null, release_tag: null };
      this.store.put("human_review_approvals", receipt, id);
      this.store.event(id, "human_review_merge_authorized", { approval_id: receipt.id, review_id: review.id, head: review.head });
    }
    await this.reconcile(receipt);
    if (this.stopped) throw new FactoryError("stopping", "Approval is retained for reconciliation after restart", 409);
    return this.store.get<FactoryHumanApproval>("human_review_approvals", receipt.id)!;
  }
  /** Called only within the validated, confirmed-Pause recovery transaction. */
  resumeRepairRecovery(run: FactoryRun, progress: import("../shared/factory.ts").FactoryAutomaticReview): void {
    if (progress.condition !== "blocked" || progress.attempts < 6 || progress.next_attempt_at <= 0 || !progress.human_batch_id) return;
    const batch = this.store.get<FactoryHumanFeedbackBatch>("review_batches", progress.human_batch_id);
    if (!batch || batch.run_id !== run.id || batch.resolution || batch.disposition !== "approve" || !batch.merge_authorized) return;
    const review = this.store.get<FactoryHumanReview>("human_reviews", batch.review_id);
    if (!review || review.condition !== "repairing" || review.run_id !== run.id || review.head !== batch.head || review.snapshot_id !== batch.snapshot_id) return;
    for (const receipt of this.store.list<FactoryHumanApproval>("human_review_approvals", run.implementation_id)) {
      // Matching the exhausted workflow reason and its unresolved original batch
      // distinguishes repair observation failure from a later merge/policy stop.
      if (receipt.condition !== "blocked" || receipt.superseded_by_batch_id || this.busy.has(receipt.id)
        || receipt.run_id !== run.id || receipt.review_id !== review.id || receipt.repair_batch_id !== batch.id
        || receipt.repair_signature !== batch.signature || receipt.reason !== progress.reason
        || receipt.merge_sha || receipt.release_tag || receipt.head !== batch.head || receipt.snapshot_id !== batch.snapshot_id
        || receipt.original_candidate?.head !== batch.head || receipt.original_candidate.snapshot_id !== batch.snapshot_id
        || receipt.repair_scope !== this.repairScope(run.implementation_id, run.id)) continue;
      this.store.put("human_review_approvals", { ...receipt, condition: "repairing", reason: null, observations: 0, next_observation_at: 0 }, run.implementation_id);
      this.store.event(run.implementation_id, "human_review_repair_recovery_resumed", { approval_id: receipt.id, run_id: run.id, batch_id: batch.id, reason: progress.reason, attempts: progress.attempts });
    }
  }
  async maintain(): Promise<void> {
    if (this.stopped) return;
    for (const receipt of this.store.list<FactoryHumanApproval>("human_review_approvals")) if (!this.store.get<Implementation>("implementations", receipt.implementation_id)?.pause && ["repairing", "pending", "uncertain", "awaiting_release", "merged", "released"].includes(receipt.condition) && (!["merged", "released"].includes(receipt.condition) || this.store.get<FactoryRun>("runs", receipt.run_id)?.condition !== "completed") && (receipt.next_observation_at ?? 0) <= Date.now()) await this.reconcile(receipt);
  }
  /** Delivery evidence survives unavailable cleanup; only verified shutdown releases execution. */
  private async finishDelivery(receipt: FactoryHumanApproval): Promise<void> {
    const run = this.store.get<FactoryRun>("runs", receipt.run_id);
    if (!run || run.condition === "completed") return;
    try {
      this.runtime.assertExecuting(receipt.implementation_id);
      const identity = JSON.stringify([run.id, run.worktree, run.workspace_id, run.pane_id]);
      const retained = this.store.list<{ kind: string; data: { run_id?: string; identity?: string } }>("events", receipt.implementation_id).some(event => event.kind === "delivery_history_retained" && event.data.run_id === run.id && event.data.identity === identity);
      if (!retained) {
        await this.retainBeforeDelivery(run.id);
        if (this.stopped) return;
        this.runtime.assertExecuting(receipt.implementation_id);
        this.store.event(receipt.implementation_id, "delivery_history_retained", { run_id: run.id, identity, approval_id: receipt.id });
      }
      await this.runtime.completeDelivery(run.id);
    } catch (error) {
      if (this.stopped || error instanceof FactoryError && ["assignment_paused", "assignment_deleting"].includes(error.code)) return;
      const current = this.store.get<FactoryRun>("runs", run.id);
      const reason = error instanceof FactoryError ? error.message : "Delivery is verified; owned native shutdown remains unconfirmed";
      if (current && current.condition !== "completed") this.store.put("runs", { ...current, waiting_reason: reason }, receipt.implementation_id);
      this.store.put("human_review_approvals", { ...receipt, next_observation_at: Date.now() + 2000 }, receipt.implementation_id);
      this.store.event(receipt.implementation_id, "delivery_completion_pending", { run_id: run.id, approval_id: receipt.id, reason });
    }
  }
  private async reconcile(receipt: FactoryHumanApproval): Promise<void> {
    if (this.stopped || receipt.superseded_by_batch_id || this.busy.has(receipt.id)) return;
    this.busy.add(receipt.id);
    try {
      if (["merged", "released"].includes(receipt.condition)) { await this.finishDelivery(receipt); return; }
      const review = this.store.get<FactoryHumanReview>("human_reviews", receipt.review_id)!;
      if (receipt.repair_batch_id && receipt.repair_scope !== this.repairScope(receipt.implementation_id, receipt.run_id)) throw new FactoryError("repair_scope_changed", "The owner context changed; review the repair scope before granting new merge authority", 409);
      if (receipt.condition === "repairing") {
        const batch = this.store.get<FactoryHumanFeedbackBatch>("review_batches", receipt.repair_batch_id!);
        const progress = this.store.get<import("../shared/factory.ts").FactoryAutomaticReview>("automatic_review", receipt.run_id);
        if (progress?.condition === "blocked") throw new FactoryError("repair_blocked", progress.reason ?? "Submitted repairs require an owner decision", 409);
        if (!batch?.resolution || review.condition !== "ready") return;
        this.assertRepairLineage(receipt, batch, review.head);
        if (!batch.merge_authorized || batch.review_id !== review.id || batch.resolution.head !== review.head) throw new FactoryError("review_stale", "Conditional authority requires this submitted repair batch's final candidate", 409);
        receipt = { ...receipt, head: review.head, snapshot_id: review.snapshot_id!, condition: "pending" };
        this.store.put("human_review_approvals", receipt, receipt.implementation_id);
      }
      const { run, pr, check, reports } = this.candidate(receipt.implementation_id, review);
      const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
      if (head.head !== receipt.head || head.workspace_hash !== check.workspace_hash) throw new FactoryError("review_stale", "The checked workspace changed after Human Review capture", 409);
      this.candidate(receipt.implementation_id, review);
      if (receipt.repair_batch_id) {
        if (receipt.repair_scope !== this.repairScope(receipt.implementation_id, receipt.run_id)) throw new FactoryError("repair_scope_changed", "The owner context changed; review the repair scope before granting new merge authority", 409);
        this.assertRepairLineage(receipt, this.store.get<FactoryHumanFeedbackBatch>("review_batches", receipt.repair_batch_id)!, receipt.head);
      }
      receipt = { ...receipt, merge_not_sent: false };
      this.store.put("human_review_approvals", receipt, receipt.implementation_id);
      const result = await this.runtime.operation<FactoryMergeResult>(run, "merge", { approval: receipt, pull_request: pr, head: pr.head, workspace_hash: check.workspace_hash, check_id: check.id, evidence_ids: pr.evidence_ids, reports: reports.map(r => ({ worker_id: r.worker_id, source_id: r.source_id })) } satisfies import("../shared/factory.ts").FactoryMergeRequest);
      this.runtime.assertExecuting(receipt.implementation_id);
      if (result.run_id !== run.id || result.head !== receipt.head || result.repository !== pr.repository || result.base_branch !== pr.base_branch || result.number !== pr.number || !["merged", "awaiting_release", "released", "uncertain"].includes(result.condition) || result.condition !== "uncertain" && !/^[a-f0-9]{40}$/.test(result.merge_sha ?? "")) throw new FactoryError("merge_uncertain", "The Machine did not verify this exact merge and target", 409);
      const observations = result.condition === "uncertain" ? (receipt.observations ?? 0) + 1 : 0;
      this.store.db.transaction(() => {
        this.store.put("human_review_approvals", { ...receipt, ...result, observations, next_observation_at: Date.now() + (result.condition === "awaiting_release" ? 30000 : Math.min(30000, 1000 * 2 ** observations)), ...(observations >= 6 ? { condition: "blocked" as const } : {}), id: receipt.id, reason: observations >= 6 ? `${result.reason}; six observations could not confirm the outcome. Inspect the PR and use the same approval to observe again` : result.reason, updated_at: new Date().toISOString() }, receipt.implementation_id);
        const idea = this.store.get<Implementation>("implementations", receipt.implementation_id)!;
        if (result.condition !== "uncertain") this.store.put("implementations", { ...idea, stage: result.condition === "awaiting_release" ? "review" : "done", outcome: result.condition === "released" ? "released" : "merged" });
      }).immediate();
      if (["merged", "released"].includes(result.condition)) await this.finishDelivery(this.store.get<FactoryHumanApproval>("human_review_approvals", receipt.id)!);
    } catch (error) {
      if (this.stopped || error instanceof FactoryError && error.code === "assignment_paused") return;
      if (error instanceof FactoryError && error.code === "merge_waiting") {
        this.store.put("human_review_approvals", { ...receipt, condition: "pending", observations: 0, next_observation_at: Date.now() + 2000, reason: error.message }, receipt.implementation_id);
        return;
      }
      const retry = !(error instanceof FactoryError) || ["machine_offline", "machine_disconnected", "remote_factory_unavailable", "merge_uncertain", "merge_busy"].includes(error.code);
      const observations = (receipt.observations ?? 0) + 1;
      this.store.put("human_review_approvals", { ...receipt, merge_not_sent: error instanceof FactoryError && error.code === "merge_blocked", observations, next_observation_at: Date.now() + Math.min(30000, 1000 * 2 ** observations), condition: retry && observations < 6 ? "uncertain" : "blocked", reason: error instanceof FactoryError ? error.message : "Merge outcome is unknown; reconcile the retained approval before further action" }, receipt.implementation_id);
    } finally { this.busy.delete(receipt.id); }
  }
}
