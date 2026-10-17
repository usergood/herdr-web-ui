import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryAutomaticExecution, FactoryAutomaticReview, FactoryCheck, FactoryExecutionPlan, FactoryProject, FactoryReviewEvidence, FactoryRun, FactoryWorker, Implementation } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryPipeline } from "./factory-pipeline.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";
import type { FactoryStore } from "./factory-store.ts";
import type { FactoryWorkflow } from "./factory-workflow.ts";

/** The connection server drives accepted plans; native agents never own integration.
 * Stable request keys and retained checks make observation safe after a lost reply. */
export class FactoryExecution {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly running = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly runtime: FactoryRuntime, private readonly pipeline: FactoryPipeline, private readonly handoff: (run: FactoryRun) => Promise<void>) { this.schedule(); }
  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      if (!existsSync(join(this.store.root, "recovery-copy.json"))) for (const plan of this.store.list<FactoryExecutionPlan>("execution_plans")) {
        if (this.running.has(plan.run_id)) continue;
        this.running.add(plan.run_id);
        void this.advance(plan).catch(() => {}).finally(() => this.running.delete(plan.run_id));
      }
      this.schedule();
    }, 250);
    this.timer.unref();
  }
  private live(plan: FactoryExecutionPlan): FactoryRun | null {
    if (this.stopped) return null;
    const run = this.store.get<FactoryRun>("runs", plan.run_id);
    const assignment = run ? this.store.get<Implementation>("implementations", run.implementation_id) : null;
    if (!assignment || assignment.pause || assignment.deletion || run?.suspension) return null;
    const frozen = run?.manifest as { planning_authority?: { id: string; automatic_execution?: boolean }; contract_hash?: string } | undefined;
    return run?.action === "implement-spec" && !["completed", "cancelled", "failed"].includes(run.condition) && frozen?.planning_authority?.automatic_execution && frozen.planning_authority.id === plan.authority.approval_id && frozen.contract_hash === plan.authority.contract_hash && run.specification_id === plan.specification_id ? run : null;
  }
  private save(plan: FactoryExecutionPlan, condition: FactoryAutomaticExecution["condition"], reason: string | null, attempts = 0, nextAttempt = 0, reasonIsError = false): void {
    if (!this.live(plan)) return;
    const previous = this.store.get<FactoryAutomaticExecution>("automatic_execution", plan.run_id);
    if (previous?.condition === condition && previous.reason === reason && previous.attempts === attempts && (previous.reason_is_error ?? false) === reasonIsError) return;
    const record: FactoryAutomaticExecution = { ...(previous ?? this.store.record()), id: plan.run_id, run_id: plan.run_id, plan_hash: plan.hash, condition, reason, reason_is_error: reasonIsError, attempts, next_attempt_at: nextAttempt, updated_at: new Date().toISOString() };
    this.store.put("automatic_execution", record, this.store.get<FactoryRun>("runs", plan.run_id)!.implementation_id);
  }
  private async advance(plan: FactoryExecutionPlan): Promise<void> {
    let run = this.live(plan);
    if (!run) return;
    const progress = this.store.get<FactoryAutomaticExecution>("automatic_execution", run.id);
    if (progress?.condition === "checked") { await this.reviewed(plan); return; }
    if (progress?.condition === "blocked" || (progress?.next_attempt_at ?? 0) > Date.now()) return;
    try {
      run = await this.runtime.reconcile(run.id);
      if (!this.live(plan)) return;
      if (["accepted", "disconnected", "interrupted"].includes(run.condition)) throw new FactoryError("execution_uncertain", run.waiting_reason ?? "Orchestrator identity is uncertain", 409);
      const question = this.workflow.questions(run.implementation_id, run.id).find(q => q.answer === null);
      if (question || ["needs_you", "blocked"].includes(run.condition)) {
        this.save(plan, "waiting", question?.question ?? run.waiting_reason ?? "The Orchestrator is waiting for a native permission or owner decision"); return;
      }
      this.save(plan, "executing", null);
      const shared = (run.manifest as { project: FactoryProject }).project.shared_paths ?? [];
      // Claim configured shared documents conservatively. Disjoint, unshared work
      // still runs concurrently; the admission queue serializes shared writers.
      for (const ticket of this.pipeline.frontier(run)) {
        await this.pipeline.requestWorker(run.id, { role: "implementer", ticket_id: ticket.id, idempotency_key: `automatic-${ticket.id}`, shared_paths: shared });
        if (!this.live(plan)) return;
      }
      const workers = this.store.list<FactoryWorker>("workers", run.id).filter(w => w.role === "implementer" && plan.tickets.some(t => t.id === w.ticket_id));
      for (let worker of workers) {
        if (worker.condition === "completed") continue;
        if (worker.suspension) continue;
        if (["failed", "cancelled"].includes(worker.condition)) throw new FactoryError("worker_stopped", worker.waiting_reason ?? `Ticket worker ${worker.id} stopped before integration`, 409);
        worker = await this.pipeline.workerAction(run.id, worker.id, "reconcile") as FactoryWorker;
        if (!this.live(plan)) return;
        if (["accepted", "disconnected", "interrupted"].includes(worker.condition)) throw new FactoryError("execution_uncertain", worker.waiting_reason ?? `Worker ${worker.id} remains uncertain`, 409);
        if (worker.condition !== "ready") {
          if (["needs_you", "blocked"].includes(worker.condition)) this.save(plan, "waiting", worker.waiting_reason ?? `Worker ${worker.id} is waiting for native permission`);
          continue;
        }
        // A Machine-confirmed merge may already have closed its native pane.
        // Retain that receipt directly; ordinary candidates still verify rest
        // and their current commit through the host's refresh boundary.
        if (!worker.integration_pending) worker = await this.pipeline.workerAction(run.id, worker.id, "refresh") as FactoryWorker;
        if (!this.live(plan)) return;
        if (this.workflow.questions(run.implementation_id, run.id).length && !this.store.list<{ worker_id: string; revision: string }>("answer_consumption", run.id).some(r => r.worker_id === worker.id && r.revision === this.workflow.questionRevision(run!.implementation_id, run!.id))) {
          this.save(plan, "waiting", `Worker ${worker.id} must consume the exact answered context before integration`); continue;
        }
        const check = await this.checked(plan, worker);
        if (!check || !this.live(plan)) return;
        await this.pipeline.integrate(run.id, worker.id);
        if (!this.live(plan)) return;
      }
      const completed = new Set(this.store.list<FactoryWorker>("workers", run.id).filter(w => w.role === "implementer" && w.condition === "completed").map(w => w.ticket_id));
      if (!plan.tickets.every(t => completed.has(t.id))) return;
      if (!await this.checked(plan, null) || !this.live(plan)) return;
      this.save(plan, "checked", null);
    } catch (error) {
      if (!this.live(plan)) return;
      const code = error instanceof FactoryError ? error.code : "execution_uncertain";
      const reason = error instanceof FactoryError ? error.message : "Automatic execution could not be verified; retained identities must be reconciled";
      if (["capacity_exhausted", "build_capacity_exhausted", "shared_writer_owned", "worker_busy", "integration_busy", "answers_unready", "answers_unconsumed", "continuation_waiting"].includes(code)) { this.save(plan, "waiting", reason); return; }
      const retry = ["execution_uncertain", "machine_offline", "machine_disconnected", "remote_factory_unavailable", "integration_uncertain"].includes(code);
      const attempts = (progress?.attempts ?? 0) + 1;
      this.save(plan, retry && attempts < 6 ? "waiting" : "blocked", `${reason}${retry && attempts >= 6 ? "; automatic recovery exhausted after six observations" : ""}`, attempts, retry ? Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) : 0, true);
    }
  }
  private async reviewed(plan: FactoryExecutionPlan): Promise<void> {
    const live = this.live(plan);
    if (!live) return;
    let run: FactoryRun = live;
    const previous = this.store.get<FactoryAutomaticReview>("automatic_review", run.id);
    if (previous?.condition === "published" && previous.context_revision === this.workflow.questionRevision(run.implementation_id, run.id) && !this.workflow.questions(run.implementation_id, run.id).some(question => question.answer === null)) { await this.handoff(run); return; }
    if (["blocked"].includes(previous?.condition ?? "") || (previous?.next_attempt_at ?? 0) > Date.now()) return;
    const lastCheck = this.store.list<FactoryCheck>("checks", run.id).filter(c => c.worker_id === null).at(-1);
    let state: FactoryAutomaticReview = { ...(previous ?? { ...this.store.record(), id: run.id, run_id: run.id, head: lastCheck?.head ?? "", round: 0, condition: "reviewing", reason: null, attempts: 0, next_attempt_at: 0, check_id: lastCheck?.id ?? "", evidence_ids: [], batch_id: null }), reason_is_error: false };
    try {
      run = await this.runtime.reconcile(run.id);
      if (!this.live(plan)) return;
      const question = this.workflow.questions(run.implementation_id, run.id).find(q => q.answer === null);
      if (question || ["needs_you", "blocked"].includes(run.condition)) { this.store.put("automatic_review", { ...state, condition: "waiting", reason: question?.question ?? run.waiting_reason ?? "The Orchestrator is waiting for native permission" }, run.implementation_id); return; }
      if (["accepted", "disconnected", "interrupted"].includes(run.condition)) throw new FactoryError("execution_uncertain", "Orchestrator identity is uncertain; retain its reservation", 409);
      const revision = this.workflow.questionRevision(run.implementation_id, run.id);
      if (state.context_revision && state.context_revision !== revision) {
        for (const worker of this.store.list<FactoryWorker>("workers", run.id).filter(w => w.role !== "implementer" && !["completed", "cancelled", "failed"].includes(w.condition))) { await this.pipeline.workerAction(run.id, worker.id, "stop"); if (!this.live(plan)) return; }
        const batch = state.human_batch_id ? this.store.get<import("../shared/factory.ts").FactoryHumanFeedbackBatch>("review_batches", state.human_batch_id) : null;
        // Bind a durable fresh-check boundary to this context. An accepted check
        // after it is reconciled by identity after a lost reply, never replayed.
        const baseline = this.store.list<FactoryCheck>("checks", run.id).filter(check => check.worker_id === null).at(-1)?.id ?? state.check_id;
        state = { ...state, context_revision: revision, generation: (state.generation ?? 0) + 1, evidence_ids: [], condition: state.batch_id && !batch?.resolution ? state.condition : "reviewing", attempts: 0, next_attempt_at: 0, reason: null, ...(batch?.resolution ? { human_batch_id: undefined, batch_id: null } : {}) };
        this.store.db.transaction(() => {
          this.store.put("automatic_review_refresh", { id: run.id, run_id: run.id, implementation_id: run.implementation_id, revision, baseline_check_id: baseline }, run.implementation_id);
          this.store.put("automatic_review", state!, run.implementation_id);
        }).immediate();
      }
      state = { ...state, context_revision: revision };
      if (state?.condition === "repairing" || state?.batch_id) { await this.repair(plan, state); return; }
      const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
      if (!this.live(plan)) return;
      const refresh = this.store.get<{ revision: string; baseline_check_id: string }>("automatic_review_refresh", run.id);
      const latest = this.store.list<FactoryCheck>("checks", run.id).filter(check => check.worker_id === null).at(-1);
      if (refresh?.revision === revision && (!latest || latest.id === refresh.baseline_check_id)) await this.pipeline.check(run.id);
      if (!this.live(plan)) return;
      const check = refresh?.revision === revision ? await this.checked(plan, null) : latest;
      if (!this.live(plan)) return;
      if (!check && refresh?.revision === revision) { this.store.put("automatic_review", { ...state, condition: "waiting", reason: "Waiting for the retained fresh-context check to finish" }, run.implementation_id); return; }
      if (!check || check.condition !== "passed" || check.head !== head.head || check.workspace_hash !== head.workspace_hash) throw new FactoryError("review_stale", "Final checks must cover the current integration workspace", 409);
      if (state.head !== head.head) throw new FactoryError("review_stale", "The candidate changed outside the automatic repair lineage", 409);
      state = { ...state, condition: "reviewing", reason: null, check_id: check.id };
      this.store.put("automatic_review", state, run.implementation_id);
      for (const axis of ["standards", "spec"] as const) {
        const key = `automatic-review-${state.round}-${state.generation ?? 0}-${axis}`;
        let worker: FactoryWorker | undefined = this.store.list<FactoryWorker & { key: string }>("workers", run.id).find(w => w.key === key);
        if (!worker) {
          const request = await this.pipeline.requestWorker(run.id, { role: axis, idempotency_key: key });
          if (this.live(plan) && "reason" in request) this.store.put("automatic_review", { ...state, condition: "waiting", reason: request.reason }, run.implementation_id);
          return;
        }
        let evidence = this.store.list<FactoryReviewEvidence>("review_evidence", run.id).find(r => r.worker_id === worker!.id);
        if (!evidence) {
          worker = await this.pipeline.workerAction(run.id, worker.id, "reconcile") as FactoryWorker;
          if (!this.live(plan)) return;
          if (["needs_you", "blocked"].includes(worker.condition)) { this.store.put("automatic_review", { ...state, condition: "waiting", reason: worker.waiting_reason ?? "Independent review is waiting for native permission" }, run.implementation_id); return; }
          if (["accepted", "disconnected", "interrupted"].includes(worker.condition)) throw new FactoryError("execution_uncertain", "Independent review identity is uncertain; its reservation is retained", 409);
          if (worker.condition === "working") return;
          if (worker.condition !== "ready") throw new FactoryError("review_stopped", "Independent reviewer stopped before retaining its report", 409);
          if (this.workflow.questions(run.implementation_id, run.id).length && !this.store.list<{ worker_id: string; revision: string }>("answer_consumption", run.id).some(r => r.worker_id === worker!.id && r.revision === revision)) throw new FactoryError("answers_unconsumed", "Independent reviewer must consume the exact answered context before reporting", 409);
          evidence = await this.pipeline.workerAction(run.id, worker.id, "review-evidence") as FactoryReviewEvidence;
          if (!this.live(plan)) return;
        }
        if (evidence && worker.condition !== "completed") { evidence = await this.pipeline.workerAction(run.id, worker.id, "review-evidence") as FactoryReviewEvidence; if (!this.live(plan)) return; }
        if (evidence.head !== state.head) throw new FactoryError("review_stale", "Independent reports must cover the checked head", 409);
        state = { ...state, condition: "reviewing", reason: null, attempts: 0, evidence_ids: [...new Set([...state.evidence_ids, evidence.id])] };
        this.store.put("automatic_review", state, run.implementation_id);
      }
      const reports = this.store.list<FactoryReviewEvidence>("review_evidence", run.id).filter(r => state!.evidence_ids.includes(r.id));
      if (reports.some(r => r.outcome === "failed")) {
        if (state.round >= 3) throw new FactoryError("repair_exhausted", "Automatic repair exhausted after three rounds; inspect the retained independent findings", 409);
        const batch: import("../shared/factory.ts").FactoryAutomaticReviewBatch = { ...this.store.record(), implementation_id: run.implementation_id, run_id: run.id, origin: "automatic", ...(state.human_batch_id ? { human_batch_id: state.human_batch_id } : {}), status: "sent", head: state.head, round: state.round, reports, ticket_ids: plan.tickets.map(t => t.id) };
        this.store.db.transaction(() => {
          this.store.put("automatic_review_batches", batch, run.implementation_id);
          this.store.put("automatic_review", { ...state!, condition: "repairing", batch_id: batch.id }, run.implementation_id);
          this.store.event(run.implementation_id, "automatic_findings_retained", { run_id: run.id, batch_id: batch.id, head: state!.head });
        }).immediate();
      } else {
        for (const batch of this.store.list<import("../shared/factory.ts").FactoryAutomaticReviewBatch>("automatic_review_batches", run.implementation_id).filter(b => b.run_id === run.id && !b.resolution)) this.store.put("automatic_review_batches", { ...batch, resolution: { head: state.head, check_id: state.check_id, evidence_ids: state.evidence_ids } }, run.implementation_id);
        const policy = (run.manifest as { project: FactoryProject }).project.pull_request;
        if (!policy) { this.store.put("automatic_review", { ...state, condition: "waiting", reason: "Configure a PR repository and target branch before accepting the Specification for publication" }, run.implementation_id); return; }
        this.store.put("automatic_review", { ...state, condition: "publishing", reason: null }, run.implementation_id);
        const result = await this.runtime.operation<import("../shared/factory.ts").FactoryPullRequest>(run, "publish", { ...(state.human_batch_id ? { previous_head: this.store.get<import("../shared/factory.ts").FactoryPullRequest>("pull_requests", run.id)?.head } : {}), head: head.head, workspace_hash: check.workspace_hash, check_id: check.id, evidence_ids: state.evidence_ids, reports: reports.map(r => ({ worker_id: r.worker_id, source_id: r.source_id })) } satisfies import("../shared/factory.ts").FactoryPublicationRequest);
        if (!this.live(plan)) return;
        if (result.run_id !== run.id || result.head !== head.head || result.repository !== policy.repository || result.base_branch !== policy.base_branch || result.branch !== run.branch || !Number.isSafeInteger(result.number) || result.number < 1 || result.url !== `https://github.com/${policy.repository}/pull/${result.number}`) throw new FactoryError("publication_changed", "The PR does not match the authorized checked candidate and target", 409);
        const current = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
        if (!this.live(plan)) return;
        if (current.head !== head.head || current.workspace_hash !== check.workspace_hash) throw new FactoryError("review_stale", "The workspace changed during publication; inspect the retained PR", 409);
        this.store.db.transaction(() => {
          const pr = { ...this.store.record(), ...result, id: run.id, check_id: check.id, evidence_ids: state.evidence_ids };
          this.store.put("pull_requests", pr, run.implementation_id);
          if (state.human_batch_id) {
            const batch = this.store.get<import("../shared/factory.ts").FactoryHumanFeedbackBatch>("review_batches", state.human_batch_id)!;
            const resolution = { head: state.head, check_id: state.check_id, evidence_ids: state.evidence_ids };
            this.store.put("review_batches", { ...batch, resolution }, run.implementation_id);
            for (const comment of this.store.list<import("../shared/factory.ts").ReviewComment>("comments", run.implementation_id).filter(c => c.batch_id === batch.id)) this.store.put("comments", { ...comment, status: "resolved", resolution: { ...resolution, summary: batch.merge_authorized ? "Approved feedback repaired and independently reviewed; conditional merge authorized" : "Feedback repaired and independently reviewed; awaiting owner approval" } }, run.implementation_id);
          }
          this.store.put("automatic_review", { ...state, condition: "published", reason: null, attempts: 0 }, run.implementation_id);
          const assignment = this.store.get<Implementation>("implementations", run.implementation_id)!;
          this.store.put("implementations", { ...assignment, stage: "review", outcome: "pr_open" });
          this.store.event(run.implementation_id, "pull_request_published", { run_id: run.id, head: head.head, number: pr.number, check_id: check.id, evidence_ids: state.evidence_ids });
        }).immediate();
      }
    } catch (error) {
      if (!this.live(plan) || !state) return;
      const code = error instanceof FactoryError ? error.code : "execution_uncertain";
      const waiting = ["capacity_exhausted", "build_capacity_exhausted", "shared_writer_owned", "integration_busy", "publication_busy", "worker_busy", "answers_unready", "answers_unconsumed", "continuation_waiting"].includes(code);
      const retry = ["execution_uncertain", "machine_offline", "machine_disconnected", "remote_factory_unavailable", "publication_uncertain", "review_evidence_required", "native_evidence_required", "check_interrupted"].includes(code);
      const attempts = (previous?.attempts ?? 0) + 1;
      this.store.put("automatic_review", { ...state, condition: waiting || retry && attempts < 6 ? "waiting" : "blocked", reason_is_error: !waiting, reason: `${error instanceof FactoryError ? error.message : "Automatic review could not be verified"}${retry && attempts >= 6 ? "; automatic recovery exhausted after six observations" : ""}`, attempts: waiting ? 0 : attempts, next_attempt_at: retry ? Date.now() + Math.min(30000, 1000 * 2 ** (attempts - 1)) : 0 }, run.implementation_id);
    }
  }
  private async repair(plan: FactoryExecutionPlan, state: FactoryAutomaticReview): Promise<void> {
    const run = this.live(plan);
    if (!run || !state.batch_id) return;
    const batch = this.store.get<import("../shared/factory.ts").FactoryAutomaticReviewBatch>("automatic_review_batches", state.batch_id) ?? this.store.get<import("../shared/factory.ts").FactoryHumanFeedbackBatch>("review_batches", state.batch_id)!;
    for (const ticketId of batch.ticket_ids) {
      let worker = this.store.list<FactoryWorker>("workers", run.id).find(w => w.rework_batch_id === batch.id && w.ticket_id === ticketId);
      if (worker?.condition === "completed") continue;
      if (batch.origin === "human" && !worker?.integration_pending) {
        const integrated = this.store.list<FactoryWorker>("workers", run.id).filter(w => w.rework_batch_id === batch.id && w.condition === "completed").at(-1);
        const current = await this.runtime.operation<{ head: string }>(run, "head");
        if (!this.live(plan)) return;
        if (current.head !== (integrated?.head ?? batch.head)) throw new FactoryError("review_stale", "The candidate changed outside the submitted Human Review repair lineage", 409);
      }
      if (!worker) {
        const request = await this.pipeline.requestWorker(run.id, { role: "implementer", ticket_id: ticketId, review_batch_id: batch.id, idempotency_key: `fix-${batch.id}-${ticketId}`, shared_paths: (run.manifest as { project: FactoryProject }).project.shared_paths ?? [] });
        if (this.live(plan) && "reason" in request) this.store.put("automatic_review", { ...state, condition: "waiting", reason: request.reason }, run.implementation_id);
        return;
      }
      worker = await this.pipeline.workerAction(run.id, worker.id, "reconcile") as FactoryWorker;
      if (!this.live(plan)) return;
      if (["needs_you", "blocked"].includes(worker.condition)) { this.store.put("automatic_review", { ...state, condition: "waiting", reason: worker.waiting_reason ?? "Review-fixes is waiting for native permission" }, run.implementation_id); return; }
      if (["accepted", "disconnected", "interrupted"].includes(worker.condition)) throw new FactoryError("execution_uncertain", "Review-fixes identity is uncertain; retain its reservation", 409);
      if (worker.condition === "working" || worker.suspension) { this.store.put("automatic_review", { ...state, condition: "repairing", reason: null }, run.implementation_id); return; }
      if (worker.condition !== "ready") throw new FactoryError("repair_stopped", "Review-fixes stopped before integration", 409);
      if (!worker.integration_pending) worker = await this.pipeline.workerAction(run.id, worker.id, "refresh") as FactoryWorker;
      if (!this.live(plan) || !await this.checked(plan, worker) || !this.live(plan)) return;
      await this.pipeline.integrate(run.id, worker.id);
      if (!this.live(plan)) return;
    }
    const check = await this.checked(plan, null);
    if (!check || !this.live(plan)) return;
    this.store.put("automatic_review", { ...state, condition: "reviewing", reason: null, attempts: 0, next_attempt_at: 0, head: check.head, check_id: check.id, round: state.round + 1, evidence_ids: [], batch_id: null }, run.implementation_id);
  }
  private async checked(plan: FactoryExecutionPlan, worker: FactoryWorker | null): Promise<FactoryCheck | null> {
    const run = this.live(plan);
    if (!run) return null;
    const current = worker ? { head: worker.head, workspace_hash: undefined } : await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    if (!this.live(plan)) return null;
    let check = this.store.list<FactoryCheck>("checks", run.id).filter(c => c.worker_id === (worker?.id ?? null)).at(-1);
    if (check && ["working", "interrupted"].includes(check.condition)) {
      check = await this.pipeline.reconcileCheck(run.id, check.id);
      if (!this.live(plan)) return null;
      if (check.condition === "working") return null;
      if (check.condition === "interrupted") throw new FactoryError("check_interrupted", `Check ${check.id} remains interrupted; its build reservation is retained`, 409);
    }
    if (!check || check.condition === "cancelled" && check.pause_id || check.head !== current.head || current.workspace_hash !== undefined && check.workspace_hash !== current.workspace_hash) check = await this.pipeline.check(run.id, worker?.id ?? null);
    if (!this.live(plan)) return null;
    if (["working", "interrupted"].includes(check.condition)) return null;
    if (check.condition !== "passed") throw new FactoryError("checks_failed", `Check ${check.id} failed: ${check.commands.filter(c => c.exit_code !== 0).map(c => c.args.join(" ")).join(", ") || "the checked workspace changed"}`, 409);
    return check;
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
