import type { FactoryCheck, FactoryDetail, FactoryHumanApproval, FactoryHumanReview, FactoryMergeResult, FactoryProject, FactoryPullRequest, FactoryReviewEvidence, FactoryRun, Implementation, ReviewSnapshot } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Owner control operations do not allocate an Agent context. */
export class FactoryHumanApprovalService {
  private stopped = false;
  stop(): void { this.stopped = true; }
  private readonly busy = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime) {}
  private candidate(id: string, review: FactoryHumanReview) {
    if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping", 409);
    this.runtime.assertExecuting(id);
    const run = this.store.get<FactoryRun>("runs", review.run_id);
    const snapshot = review.snapshot_id ? this.store.get<ReviewSnapshot>("snapshots", review.snapshot_id) : null;
    const pr = this.store.get<FactoryPullRequest>("pull_requests", review.run_id);
    const frozen = run?.manifest as { project?: FactoryProject } | undefined;
    if (!run || run.implementation_id !== id || run.action !== "implement-spec" || review.condition !== "ready" || !snapshot || snapshot.head !== review.head || !pr || pr.head !== review.head || frozen?.project?.pull_request?.repository !== pr.repository || frozen.project.pull_request.base_branch !== pr.base_branch) throw new FactoryError("review_stale", "Select the current captured and published Human Review candidate", 409);
    if (this.store.list<FactoryRun>("runs", id).filter(r => r.action === "implement-spec").at(-1)?.id !== run.id) throw new FactoryError("review_stale", "A newer implementation attempt supersedes this review", 409);
    if (this.store.list<FactoryDetail["comments"][number]>("comments", id).some(c => c.status !== "resolved")) throw new FactoryError("review_comments_pending", "Submit or resolve all retained review comments before approving without comments", 409);
    const check = this.store.list<FactoryCheck>("checks", run.id).filter(c => c.worker_id === null).at(-1);
    const reports = pr.evidence_ids.map(key => this.store.get<FactoryReviewEvidence>("review_evidence", key));
    const latestReports = this.store.list<FactoryReviewEvidence>("review_evidence", run.id);
    const recipes = [...frozen.project.setup ?? [], ...frozen.project.checks ?? []];
    if (!check || check.id !== pr.check_id || check.run_id !== run.id || check.worker_id !== null || check.condition !== "passed" || check.head !== pr.head || !recipes.length || JSON.stringify(check.commands.map(c => c.args)) !== JSON.stringify(recipes) || check.commands.some(c => c.exit_code !== 0) || reports.length !== 2 || !["standards", "spec"].every(axis => reports.some(r => r?.id === latestReports.filter(latest => latest.axis === axis).at(-1)?.id && r?.run_id === run.id && r.axis === axis && r.head === pr.head && r.outcome === "passed"))) throw new FactoryError("fresh_evidence_required", "Retain passing configured checks and independent Standards and Spec reports for this candidate", 409);
    return { run, pr, check, reports: reports as FactoryReviewEvidence[] };
  }
  async approve(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryHumanApproval> {
    if (typeof body.idempotency_key !== "string" || !/^[\w-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_approval", "Send the displayed candidate and a stable approval identity");
    const review = typeof body.review_id === "string" ? this.store.get<FactoryHumanReview>("human_reviews", body.review_id) : null;
    if (!review || review.implementation_id !== id || review.snapshot_id !== body.snapshot_id || review.head !== body.head) throw new FactoryError("review_stale", "Approval must name the displayed snapshot and head", 409);
    let receipt = this.store.list<FactoryHumanApproval>("human_review_approvals", id).find(a => a.idempotency_key === body.idempotency_key || a.review_id === review.id);
    if (receipt && (receipt.review_id !== review.id || receipt.head !== body.head || receipt.snapshot_id !== body.snapshot_id)) throw new FactoryError("approval_conflict", "This approval identity belongs to another candidate", 409);
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
  async maintain(): Promise<void> {
    if (this.stopped) return;
    for (const receipt of this.store.list<FactoryHumanApproval>("human_review_approvals")) if (["pending", "uncertain", "awaiting_release"].includes(receipt.condition) && (receipt.next_observation_at ?? 0) <= Date.now()) await this.reconcile(receipt);
  }
  private async reconcile(receipt: FactoryHumanApproval): Promise<void> {
    if (this.stopped || this.busy.has(receipt.id) || ["merged", "released"].includes(receipt.condition)) return;
    this.busy.add(receipt.id);
    try {
      const review = this.store.get<FactoryHumanReview>("human_reviews", receipt.review_id)!;
      const { run, pr, check, reports } = this.candidate(receipt.implementation_id, review);
      const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
      if (head.head !== receipt.head || head.workspace_hash !== check.workspace_hash) throw new FactoryError("review_stale", "The checked workspace changed after Human Review capture", 409);
      this.candidate(receipt.implementation_id, review);
      const result = await this.runtime.operation<FactoryMergeResult>(run, "merge", { approval: receipt, pull_request: pr, head: pr.head, workspace_hash: check.workspace_hash, check_id: check.id, evidence_ids: pr.evidence_ids, reports: reports.map(r => ({ worker_id: r.worker_id, source_id: r.source_id })) } satisfies import("../shared/factory.ts").FactoryMergeRequest);
      this.runtime.assertExecuting(receipt.implementation_id);
      if (result.run_id !== run.id || result.head !== receipt.head || result.repository !== pr.repository || result.base_branch !== pr.base_branch || result.number !== pr.number || !["merged", "awaiting_release", "released", "uncertain"].includes(result.condition) || result.condition !== "uncertain" && !/^[a-f0-9]{40}$/.test(result.merge_sha ?? "")) throw new FactoryError("merge_uncertain", "The Machine did not verify this exact merge and target", 409);
      const observations = result.condition === "uncertain" ? (receipt.observations ?? 0) + 1 : 0;
      this.store.db.transaction(() => {
        this.store.put("human_review_approvals", { ...receipt, ...result, observations, next_observation_at: Date.now() + (result.condition === "awaiting_release" ? 30000 : Math.min(30000, 1000 * 2 ** observations)), ...(observations >= 6 ? { condition: "blocked" as const } : {}), id: receipt.id, reason: observations >= 6 ? `${result.reason}; six observations could not confirm the outcome. Inspect the PR and use the same approval to observe again` : result.reason, updated_at: new Date().toISOString() }, receipt.implementation_id);
        const idea = this.store.get<Implementation>("implementations", receipt.implementation_id)!;
        if (result.condition !== "uncertain") this.store.put("implementations", { ...idea, stage: result.condition === "awaiting_release" ? "review" : "done", outcome: result.condition === "released" ? "released" : "merged" });
      }).immediate();
    } catch (error) {
      if (this.stopped) return;
      const retry = !(error instanceof FactoryError) || ["machine_offline", "machine_disconnected", "remote_factory_unavailable", "merge_uncertain", "merge_busy"].includes(error.code);
      const observations = (receipt.observations ?? 0) + 1;
      this.store.put("human_review_approvals", { ...receipt, observations, next_observation_at: Date.now() + Math.min(30000, 1000 * 2 ** observations), condition: retry && observations < 6 ? "uncertain" : "blocked", reason: error instanceof FactoryError ? error.message : "Merge outcome is unknown; reconcile the retained approval before further action" }, receipt.implementation_id);
    } finally { this.busy.delete(receipt.id); }
  }
}
