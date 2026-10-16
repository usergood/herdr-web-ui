import { hasIssueSource } from "./issue-delivery.ts";
import { assertFactoryBuildPlatform } from "./factory-command.ts";
import { agentCapacityPool, factoryCapacity } from "./factory-capacity.ts";
import type { FactoryApproval, FactoryCheck, FactoryProject, FactoryReviewEvidence, FactoryRun, FactorySettings, FactoryTicket, FactoryWorker, Implementation } from "../shared/protocol.ts";
import type { FactoryAutomaticReview, FactoryHumanFeedbackBatch, ReviewComment } from "../shared/factory.ts";
import { CLEAN_WORKSPACE_HASH, FactoryError } from "./factory-host.ts";
import { FactoryRuntime } from "./factory-runtime.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryDelivery, manualCompletionAllowed } from "./factory-delivery.ts";

const owns = (condition: string): boolean => !["completed", "cancelled", "failed"].includes(condition);
type ReworkBatch = { id: string; run_id: string; status: string; origin?: string; head?: string; resolution?: unknown; ticket_ids?: string[]; report_ids?: string[]; reports?: FactoryReviewEvidence[] };
type CompletionCleanup = { id: string; machine_id: string; worktree: string; branch: string | null; completion: NonNullable<FactoryRun["implementation_completion"]> };
/** Admission reservations cover all native contexts and builds, including uncertain remote work. */
export class FactoryPipeline {
  private stopped = false;
  stop(): void { this.stopped = true; }
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly workflow: FactoryWorkflow, private readonly settings: () => FactorySettings, private readonly retainBeforeStop: (id: string) => Promise<void>, private readonly retainWorkerHistory: (id: string, before: string | undefined, workerId: string) => Promise<import("../shared/protocol.ts").NativeConversationSnapshot>) {
    runtime.queue.worker = (id, body) => this.startWorker(id, body);
  }
  private selectedRework(run: FactoryRun, body: Record<string, unknown>): { batch: ReworkBatch; ticket: FactoryTicket } | null {
    if (body.role !== "implementer" || body.review_batch_id === undefined) return null;
    const batch = typeof body.review_batch_id === "string" ? this.store.get<ReworkBatch>("review_batches", body.review_batch_id) ?? this.store.get<ReworkBatch>("automatic_review_batches", body.review_batch_id) : null;
    const ticket = batch?.run_id === run.id && batch.status === "sent" && !batch.resolution && (!batch.ticket_ids || batch.ticket_ids.includes(String(body.ticket_id))) ? this.workflow.executionTickets(run).find(entry => entry.id === body.ticket_id) : null;
    if (!batch || !ticket) throw new FactoryError("rework_batch_unavailable", "Select an unresolved delivered rework batch for this Run and Ticket", 409);
    if (batch.reports && this.store.list<FactoryWorker>("workers", run.id).some(worker => worker.rework_batch_id === batch.id && (batch.origin !== "automatic" || worker.ticket_id === ticket.id) || worker.role === "implementer" && owns(worker.condition))) throw new FactoryError("rework_batch_unavailable", "Use the current delivered batch without a prior repair writer", 409);
    return { batch, ticket };
  }
  private automaticRepairHead(run: FactoryRun, batch: ReworkBatch): string {
    let head = batch.head;
    if (!head) throw new FactoryError("review_stale", "The automatic review batch has no retained candidate", 409);
    const integrated = this.store.list<FactoryWorker>("workers", run.id).filter(worker => worker.rework_batch_id === batch.id && worker.condition === "completed");
    const receipts = this.store.list<{ kind: string; data: { worker_id?: string; ticket_id?: string; head?: string } }>("events", run.implementation_id).filter(event => event.kind === "ticket_integrated");
    for (const worker of integrated) {
      if (!worker.head || worker.base !== head || worker.integration_tip !== head || !receipts.some(receipt => receipt.data.worker_id === worker.id && receipt.data.ticket_id === worker.ticket_id && receipt.data.head === worker.head)) throw new FactoryError("review_stale", "The automatic repair integration lineage is unverified", 409);
      head = worker.head;
    }
    return head;
  }
  async requestWorker(id: string, body: Record<string, unknown>): Promise<FactoryWorker | import("../shared/factory.ts").FactoryCapacityWait> {
    const run = this.run(id, body.role === "implementer");
    if (!["implementer", "standards", "spec"].includes(String(body.role)) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_worker", "Select a worker role and explicit request key");
    if (this.store.list<FactoryWorker & { key: string }>("workers", id).some(worker => worker.key === body.idempotency_key)) return this.startWorker(id, body);
    this.selectedRework(run, body);
    const idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    return this.runtime.queue.start({ ...this.store.record(), id: `${id}:${body.idempotency_key}`, implementation_id: idea.id, assignment_title: idea.title, action: run.action, machine_id: run.machine_id, provider: run.provider, idempotency_key: body.idempotency_key, purpose: "execution", condition: "queued", run_id: id, reason: "Waiting for agent capacity" }, body, "");
  }
  private run(id: string, factoryRequired = true, completedAllowed = false): FactoryRun {
    const run = this.store.get<FactoryRun>("runs", id);
    if (run) this.runtime.assertExecuting(run.implementation_id);
    if (run && this.store.get<Implementation>("implementations", run.implementation_id)?.discard_requested_at) throw new FactoryError("assignment_discarded", "This Assignment is waiting for its owned work to stop", 409);
    if (run?.scope_pause) throw new FactoryError("issue_scope_paused", run.scope_pause.reason, 409);
    if (run?.implementation_completion_pending) throw new FactoryError("execution_finishing", "Reconcile the retained implementation retirement before allocating more work", 409);
    if (!completedAllowed && (run?.implementation_completion || this.store.get("implementation_retirement", id))) throw new FactoryError("execution_retired", "This native lease is retired. Stop the invalidated attempt, then use explicit Retry to repair its retained work", 409);
    if (run?.issue_pause) throw new FactoryError("issue_pause_required", "Controlled pause requested; preserve work and reconcile owned workers before a new attempt", 409);
    if (!run || factoryRequired && run.action !== "implement-spec" || !run.checkout || !["working", "ready", "needs_you", "blocked"].includes(run.condition) && !(completedAllowed && run.condition === "completed" && run.implementation_completion)) throw new FactoryError("factory_run_required", "Reconcile an admitted repository Run first", 409);
    return run;
  }
  frontier(run: FactoryRun): FactoryTicket[] {
    if (run.issue_pause || this.workflow.questions(run.implementation_id, run.id).some(question => question.answer === null)) return [];
    const tickets = this.workflow.executionTickets(run);
    const workers = this.store.list<FactoryWorker>("workers", run.id);
    const done = new Set(workers.filter((worker) => worker.role === "implementer" && worker.condition === "completed").map((worker) => worker.ticket_id));
    return tickets.filter((ticket) => !done.has(ticket.id) && !workers.some((worker) => worker.ticket_id === ticket.id && owns(worker.condition)) && ticket.dependencies.every((dependency) => done.has(dependency)));
  }
  async startWorker(id: string, body: Record<string, unknown>): Promise<FactoryWorker> {
    const run = this.run(id, body.role === "implementer");
    if (!["implementer", "standards", "spec"].includes(String(body.role)) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_worker", "Select a worker role and explicit request key");
    const role = body.role as FactoryWorker["role"];
    if (this.workflow.questions(run.implementation_id).some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Answer pending owner questions before allocating more work", 409);
    const previous = this.store.list<FactoryWorker & { key: string }>("workers", id).find((worker) => worker.key === body.idempotency_key);
    if (previous) { if (previous.role !== role || role === "implementer" && previous.ticket_id !== body.ticket_id) throw new FactoryError("worker_conflict", "This key already belongs to another worker", 409); return previous; }
    await this.runtime.reconcileCapacity();
    const tip = await this.runtime.operation<{ head: string }>(run, "head");
    const claimed = this.store.db.transaction(() => {
      const raced = this.store.list<FactoryWorker & { key: string }>("workers", id).find((worker) => worker.key === body.idempotency_key);
      if (raced) return { worker: raced, fresh: false };
      this.run(id, role === "implementer");
      const ticket = role === "implementer" ? this.frontier(run).find((entry) => entry.id === body.ticket_id) : null;
      const selected = this.selectedRework(run, body);
      const batch = selected?.batch;
      const rework = selected?.ticket;
      if (role === "implementer" && batch?.reports) {
        if (batch.origin === "automatic" && this.automaticRepairHead(run, batch) !== tip.head) throw new FactoryError("review_stale", "The candidate changed outside the automatic review repair lineage", 409);
        if (batch.origin !== "automatic" && batch.head !== tip.head) throw new FactoryError("rework_batch_unavailable", "Use the current delivered batch without a prior repair writer", 409);
      }
      if (role === "implementer" && !ticket && !rework) throw new FactoryError("ticket_not_ready", "Select a ready Ticket or an explicitly delivered rework batch", 409);
      if (rework && batch?.origin === "human") {
        const integrated = this.store.list<FactoryWorker>("workers", id).filter(w => w.rework_batch_id === batch.id && w.condition === "completed").at(-1);
        if (tip.head !== (integrated?.head ?? batch.head)) throw new FactoryError("review_stale", "The candidate changed outside the submitted Human Review repair lineage", 409);
      }
      if (rework && this.store.list<FactoryWorker>("workers", id).some((worker) => worker.ticket_id === rework.id && owns(worker.condition))) throw new FactoryError("ticket_owned", "This Ticket already has an active or uncertain writer", 409);
      if (role !== "implementer" && this.store.list<FactoryWorker>("workers", id).some((worker) => worker.role === "implementer" && owns(worker.condition))) throw new FactoryError("writers_active", "Quiesce repository writers before independent final reviews", 409);
      agentCapacityPool(this.store, this.settings());
      this.runtime.assertProjectCapacity(run);
      const shared = body.shared_paths ?? [];
      const configured = (run.manifest as { project: FactoryProject }).project.shared_paths ?? [];
      if (!Array.isArray(shared) || shared.some((path) => typeof path !== "string" || !configured.includes(path))) throw new FactoryError("invalid_shared_paths", "Claim only configured shared document paths");
      if (this.store.list<FactoryWorker>("workers", id).some((worker) => owns(worker.condition) && worker.shared_paths.some((path) => shared.includes(path)))) throw new FactoryError("shared_writer_owned", "Another worker owns a selected shared document", 409);
      const worker: FactoryWorker & { key: string } = { ...this.store.record(), run_id: id, ticket_id: (ticket ?? rework)?.id ?? id, role, condition: "accepted", base: tip.head, head: null, integration_tip: tip.head, worktree: null, branch: null, workspace_id: null, pane_id: null, shared_paths: shared as string[], waiting_reason: null, rework_batch_id: rework ? batch!.id : null, ...(rework && (batch?.origin === "automatic" || batch?.origin === "human") ? { review_origin: batch.origin } : {}), key: body.idempotency_key as string };
      this.store.put("workers", worker, id); this.store.event(run.implementation_id, "worker_accepted", { worker_id: worker.id, role, ticket_id: worker.ticket_id }); return { worker, fresh: true };
    }).immediate();
    if (!claimed.fresh) return claimed.worker;
    const feedbackId = role === "implementer" ? null : this.store.get<FactoryAutomaticReview>("automatic_review", id)?.human_batch_id;
    const feedbackBatch = feedbackId ? this.store.get<FactoryHumanFeedbackBatch>("review_batches", feedbackId) : null;
    const humanFeedback = feedbackBatch ? { batch: feedbackBatch, comments: this.store.list<ReviewComment>("comments", run.implementation_id).filter(c => c.batch_id === feedbackBatch.id) } : null;
    const retainedBatch = claimed.worker.rework_batch_id ? this.store.get<ReworkBatch>("automatic_review_batches", claimed.worker.rework_batch_id) ?? this.store.get<ReworkBatch>("review_batches", claimed.worker.rework_batch_id) : null;
    const reviewBatch = retainedBatch?.reports ? { id: retainedBatch.id, run_id: retainedBatch.run_id, head: retainedBatch.head, report_ids: retainedBatch.report_ids ?? retainedBatch.reports.map(report => report.id), instructions: "Before repair, run bun .saurons-eye-tracker.mjs contract and read the exact review_batches entry matching this ID. Preserve its full reports and original findings." } : retainedBatch;
    let worker: FactoryWorker;
    try { worker = await this.runtime.operation(run, "worker", { worker: claimed.worker, context: { human_feedback: humanFeedback, review_batch: reviewBatch, manifest: { ...(run.manifest as object), tickets: this.workflow.executionTickets(run) }, execution_plan: this.store.get("execution_plans", run.id), ticket: this.workflow.executionTickets(run).find((ticket) => ticket.id === claimed.worker.ticket_id), questions: this.workflow.questions(run.implementation_id), findings: this.store.list<import("../shared/protocol.ts").ReviewComment>("comments", run.implementation_id).filter((comment) => comment.batch_id === claimed.worker.rework_batch_id && claimed.worker.rework_batch_id !== null) } }); }
    catch { worker = { ...claimed.worker, condition: "disconnected", waiting_reason: "Worker dispatch is uncertain; preserve its reservation and reconcile" }; }
    if (worker.id !== claimed.worker.id || worker.run_id !== run.id || worker.ticket_id !== claimed.worker.ticket_id || worker.role !== role || worker.base !== tip.head) throw new FactoryError("worker_identity_changed", "The Machine returned a different worker identity; preserve the accepted reservation", 409);
    const parent = this.store.get<FactoryRun>("runs", id);
    if (!parent || this.store.get<Implementation>("implementations", run.implementation_id)?.deletion) throw new FactoryError("assignment_deleting", "The Assignment was deleted while its child allocation settled", 409);
    if (!owns(parent.condition) && owns(worker.condition)) {
      try { await this.runtime.operation(run, "stop-worker", { worker_id: worker.id }); worker = { ...worker, condition: "cancelled", waiting_reason: "The owner stopped the parent Run" }; }
      catch { worker = { ...worker, condition: "disconnected", waiting_reason: "The parent stopped; reconcile this retained child identity before release" }; }
    }
    const current = this.store.get<FactoryWorker>("workers", worker.id);
    if (current && !owns(current.condition)) worker = current;
    if (current?.suspension) worker = { ...worker, suspension: current.suspension, condition: current.condition, waiting_reason: current.waiting_reason };
    if (current?.suspension?.condition === "stopped") worker = current;
    worker = { ...worker, continuation: current?.continuation ?? worker.continuation, ...(current?.continuation && ["working", "ready"].includes(worker.condition) ? { condition: current.condition, waiting_reason: current.waiting_reason } : {}) };
    this.store.put("workers", { ...worker, key: claimed.worker.key }, id);
    if (run.action === "implement-spec" && role === "implementer" && owns(parent.condition) && owns(worker.condition)) {
      const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
      this.store.put("implementations", { ...implementation, stage: "running" });
    }
    this.store.event(run.implementation_id, "worker_observed", { worker_id: worker.id, condition: worker.condition }); return worker;
  }
  private async retainChild(run: FactoryRun, worker: FactoryWorker): Promise<void> {
    const identity = (context: FactoryWorker) => JSON.stringify([context.id, context.run_id, context.role, context.ticket_id, context.base, context.head, context.worktree, context.workspace_id, context.pane_id]);
    const receipt = this.store.list<{ kind: string; data: { worker_id?: string; identity?: string } }>("events", run.implementation_id).filter(event => ["worker_history_retained", "worker_history_unavailable"].includes(event.kind) && event.data.worker_id === worker.id).at(-1);
    if (receipt?.kind === "worker_history_retained" && receipt.data.identity === identity(worker)) {
      const observed = await this.runtime.operation<FactoryWorker>(run, "reconcile-worker", { worker_id: worker.id });
      if (identity(observed) !== identity(worker)) throw new FactoryError("native_identity_changed", "The retained child's native identity changed", 409);
      if (!owns(observed.condition)) return;
    }
    const deadline = Date.now() + 30_000;
    const snapshotIds: string[] = [];
    const cursors = new Set<string>();
    let before: string | undefined;
    let source: string | undefined;
    let latestVersion: string | undefined;
    let turns = 0;
    try {
      for (let page = 0; page < 128 && Date.now() < deadline; page++) {
        const snapshot = await this.retainWorkerHistory(run.id, before, worker.id);
        if (!snapshot.source_id || !snapshot.version || !Array.isArray(snapshot.turns)) throw new FactoryError("native_history_incomplete", "The child has no verified native history page", 409);
        turns += snapshot.turns.length;
        if (source && source !== snapshot.source_id) throw new FactoryError("native_identity_changed", "The child's native history changed during retention", 409);
        source = snapshot.source_id;
        if (page === 0) latestVersion = snapshot.version;
        snapshotIds.push(snapshot.id);
        if (!snapshot.cursor) {
          if (!turns) throw new FactoryError("native_history_incomplete", "The child has not recorded its native conversation yet", 409);
          const latest = await this.retainWorkerHistory(run.id, undefined, worker.id);
          if (latest.source_id !== source || latest.version !== latestVersion) throw new FactoryError("native_history_incomplete", "The child conversation changed while retaining its history; capture its current context before closing", 409);
          this.store.event(run.implementation_id, "worker_history_retained", { run_id: run.id, worker_id: worker.id, identity: identity(worker), source_id: source, snapshot_ids: snapshotIds });
          return;
        }
        if (cursors.has(snapshot.cursor)) break;
        cursors.add(snapshot.cursor); before = snapshot.cursor;
      }
      throw new FactoryError("native_history_incomplete", "The child's native history is incomplete; retain its context before closing it", 409);
    } catch (error) {
      const reason = "Native child history could not be completely retained; its context and ownership remain available for recovery";
      const current = this.store.get<FactoryWorker>("workers", worker.id);
      if (current && owns(current.condition)) this.store.put("workers", { ...current, waiting_reason: reason }, run.id);
      this.store.event(run.implementation_id, "worker_history_unavailable", { run_id: run.id, worker_id: worker.id, native_context_retained: true });
      throw new FactoryError(error instanceof FactoryError && error.code === "native_identity_changed" ? error.code : "execution_uncertain", reason, 409);
    }
  }
  async workerAction(id: string, workerId: string, action: string): Promise<unknown> {
    const run = ["stop", "reconcile"].includes(action) ? this.store.get<FactoryRun>("runs", id) : this.run(id, false); const worker = this.store.get<FactoryWorker>("workers", workerId);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (!worker || worker.run_id !== id) throw new FactoryError("invalid_worker", "Select this Run's worker");
    if (action === "check") return this.check(id, workerId);
    if (action === "stop") { await this.runtime.operation(run, "stop-worker", { worker_id: workerId }); this.store.put("workers", { ...worker, condition: "cancelled" }, id); return { ok: true }; }
    if (action === "review-evidence") {
      if (worker.role === "implementer") throw new FactoryError("independent_review_required", "Use a separate Standards or Spec context", 409);
      const current = await this.runtime.operation<{ head: string }>(run, "head");
      let evidence = this.store.list<FactoryReviewEvidence>("review_evidence", id).find(entry => entry.worker_id === workerId);
      if (!evidence) {
        const report = await this.runtime.operation<{ head: string; source_id: string; content: string; outcome: FactoryReviewEvidence["outcome"] }>(run, action, { worker_id: workerId });
        if (report.head !== current.head || worker.base !== current.head || !["passed", "failed"].includes(report.outcome) || typeof report.content !== "string" || report.content.length > 512 * 1024 || typeof report.source_id !== "string") throw new FactoryError("review_stale", "Review evidence must name the current integration head", 409);
        evidence = { ...this.store.record(), run_id: id, worker_id: workerId, axis: worker.role, ...report };
        this.store.put("review_evidence", evidence, id);
        this.store.event(run.implementation_id, "review_axis_retained", { evidence_id: evidence.id, axis: evidence.axis, head: evidence.head });
      }
      if (evidence.head !== current.head || worker.base !== current.head) throw new FactoryError("review_stale", "Review evidence must name the current integration head", 409);
      if (worker.condition !== "completed") {
        await this.retainChild(run, worker);
        this.run(id, false);
        await this.runtime.operation(run, "stop-worker", { worker_id: workerId });
        this.store.put("workers", { ...this.store.get<FactoryWorker>("workers", workerId)!, head: evidence.head, condition: "completed" }, id);
      }
      return evidence;
    }
    if (action !== "refresh" && action !== "reconcile") throw new FactoryError("not_found", "Unknown worker action", 404);
    if (!owns(worker.condition)) return worker;
    const next = await this.runtime.operation<FactoryWorker>(run, action === "reconcile" ? "reconcile-worker" : action, { worker_id: workerId });
    const current = this.store.get<FactoryWorker>("workers", workerId);
    if (current && JSON.stringify(current) !== JSON.stringify(worker)) return current;
    if (next.id !== worker.id || next.run_id !== id || next.ticket_id !== worker.ticket_id || next.role !== worker.role || next.base !== worker.base || worker.worktree !== null && next.worktree !== worker.worktree || worker.branch !== null && next.branch !== worker.branch) throw new FactoryError("worker_identity_changed", "The observed worker identity changed", 409);
    const observed = this.runtime.observeWorker(run, worker, next);
    this.store.put("workers", observed, id); return observed;
  }
  async check(id: string, workerId: string | null = null): Promise<FactoryCheck> {
    const run = this.run(id, false);
    if (run.machine_id === "local") assertFactoryBuildPlatform();
    const check = this.store.db.transaction(() => {
      const capacity = factoryCapacity(this.store, this.settings());
      if (capacity.builds.used >= capacity.builds.limit) throw new FactoryError("build_capacity_exhausted", `Waiting for build capacity: ${capacity.builds.used}/${capacity.builds.limit}. ${capacity.build_reservations.map(build => `${build.assignment_title} [${build.machine_id}, ${build.condition}${build.uncertain ? ", uncertain" : ""}]`).join("; ")}`, 409);
      const record: FactoryCheck = { ...this.store.record(), run_id: id, worker_id: workerId, head: "", workspace_hash: "", commands: [], condition: "working" };
      this.store.put("checks", record, id); return record;
    }).immediate();
    let result: FactoryCheck;
    try { result = await this.runtime.operation(run, "check", { worker_id: workerId, check }); }
    catch { result = { ...check, condition: "interrupted" }; }
    if (this.stopped) return { ...check, condition: "interrupted" };
    if (result.id !== check.id || result.run_id !== id || result.worker_id !== workerId) throw new FactoryError("check_identity_changed", "The Machine returned unrelated check evidence; capacity remains reserved", 409);
    this.store.put("checks", result, id); this.store.event(run.implementation_id, "checks_retained", { check_id: result.id, condition: result.condition, head: result.head }); return result;
  }
  async reconcileCheck(id: string, checkId: string): Promise<FactoryCheck> {
    const run = this.store.get<FactoryRun>("runs", id); const check = this.store.get<FactoryCheck>("checks", checkId);
    if (!run || !check || check.run_id !== id) throw new FactoryError("not_found", "Owned check not found", 404);
    const result = await this.runtime.operation<FactoryCheck>(run, "check-reconcile", { check_id: checkId });
    if (result.id !== checkId || result.run_id !== id || result.worker_id !== check.worker_id) throw new FactoryError("check_identity_changed", "The observed check identity changed; capacity remains reserved", 409);
    this.store.put("checks", result, id); this.store.event(run.implementation_id, "check_reconciled", { check_id: checkId, condition: result.condition }); return result;
  }
  async integrate(id: string, workerId: string): Promise<FactoryWorker> {
    const run = this.run(id); const worker = this.store.get<FactoryWorker>("workers", workerId);
    if (!worker?.head || worker.run_id !== id || worker.role !== "implementer") throw new FactoryError("worker_not_ready", "Reconcile the worker's integration tip first", 409);
    const questions = this.workflow.questions(run.implementation_id);
    if (questions.some((question) => question.answer === null) || questions.length && !this.store.list<{ worker_id: string; revision: string }>("answer_consumption", id).some((receipt) => receipt.worker_id === worker.id && receipt.revision === this.workflow.questionRevision(run.implementation_id))) throw new FactoryError("answers_unconsumed", "The worker must consume the current answered context through its scoped tracker", 409);
    const check = this.store.list<FactoryCheck>("checks", id).filter((entry) => entry.worker_id === workerId).at(-1);
    if (!check || check.condition !== "passed" || check.head !== worker.head) throw new FactoryError("checks_required", "Run fresh checks on the reconciled worker head", 409);
    if (worker.condition !== "completed") await this.retainChild(run, worker);
    this.run(id);
    const batch = worker.rework_batch_id ? this.store.get<ReworkBatch>("automatic_review_batches", worker.rework_batch_id) : null;
    if (batch && worker.condition !== "completed") {
      const expected = this.automaticRepairHead(run, batch);
      const current = await this.runtime.operation<{ head: string }>(run, "head");
      if (worker.integration_tip !== expected || current.head !== expected && !(worker.integration_pending && current.head === worker.head)) throw new FactoryError("review_stale", "The candidate changed outside the automatic review repair lineage", 409);
      this.run(id);
    }
    const next = await this.runtime.operation<FactoryWorker>(run, "integrate", { worker_id: workerId, tip: worker.integration_tip });
    if (next.id !== workerId || next.run_id !== id || next.head !== worker.head || next.condition !== "completed") throw new FactoryError("integration_uncertain", "Integration identity is uncertain; reconcile before further work", 409);
    await this.runtime.operation(run, "stop-worker", { worker_id: workerId });
    this.store.put("workers", next, id);
    const graph = this.store.get<{ id: string; hash: string; tickets: FactoryTicket[] }>("graphs", run.implementation_id);
    if (graph && this.workflow.graphHash(run.implementation_id) === (this.store.get<{ hash: string }>("execution_plans", run.id)?.hash ?? run.graph_hash)) this.store.put("graphs", { ...graph, tickets: graph.tickets.map((ticket) => ticket.id === worker.ticket_id ? { ...ticket, status: "done" } : ticket) }, run.implementation_id);
    const completed = new Set(this.store.list<FactoryWorker>("workers", id).filter((entry) => entry.role === "implementer" && entry.condition === "completed").map((entry) => entry.ticket_id));
    if (this.workflow.executionTickets(run).every((ticket) => completed.has(ticket.id))) {
      const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
      this.store.put("implementations", { ...implementation, stage: "review" });
    }
    this.store.event(run.implementation_id, "ticket_integrated", { worker_id: workerId, ticket_id: worker.ticket_id, head: next.head }); return next;
  }
  private findingRuns(run: FactoryRun): Set<string> {
    const ids = new Set<string>();
    let current: FactoryRun | null = run;
    while (current && current.implementation_id === run.implementation_id && !ids.has(current.id)) {
      ids.add(current.id);
      current = current.retry_of ? this.store.get<FactoryRun>("runs", current.retry_of) : null;
    }
    return ids;
  }
  private completionEvidence(run: FactoryRun, current: { head: string; workspace_hash: string }): FactoryRun["implementation_completion"] | null {
    if (this.store.get<FactoryRun>("runs", run.id)?.issue_pause || this.store.get<FactoryRun>("runs", run.id)?.scope_pause) return null;
    const check = this.store.list<FactoryCheck>("checks", run.id).filter(entry => entry.worker_id === null).at(-1);
    const reviews = this.store.list<FactoryReviewEvidence>("review_evidence", run.id);
    const standards = reviews.filter(entry => entry.axis === "standards").at(-1);
    const spec = reviews.filter(entry => entry.axis === "spec").at(-1);
    const workers = this.store.list<FactoryWorker>("workers", run.id);
    const tickets = this.workflow.executionTickets(run);
    const project = (run.manifest as { project: FactoryProject }).project;
    const commands = [...project.setup ?? [], ...project.checks ?? []];
    if (!check || check.condition !== "passed" || check.head !== current.head || check.workspace_hash !== current.workspace_hash
      || !/^[a-f0-9]{40}$/.test(current.head) || current.workspace_hash !== CLEAN_WORKSPACE_HASH || !project.checks?.length
      || JSON.stringify(check.commands.map(command => command.args)) !== JSON.stringify(commands) || check.commands.some(command => command.exit_code !== 0)
      || !standards || !spec || [standards, spec].some(review => review.outcome !== "passed" || review.head !== current.head)
      || standards.worker_id === spec.worker_id || [standards, spec].some(review => !workers.some(worker => worker.id === review.worker_id && worker.role === review.axis && worker.base === current.head && worker.condition === "completed"))
      || workers.some(worker => owns(worker.condition))
      || this.workflow.questions(run.implementation_id).some(question => question.answer === null)
      || this.store.list<{ run_id: string | null; status: string }>("comments", run.implementation_id).some(comment => comment.run_id !== null && this.findingRuns(run).has(comment.run_id) && comment.status !== "resolved")
      || this.store.list<FactoryCheck>("checks", run.id).some(check => ["working", "interrupted"].includes(check.condition))
      || tickets.some(ticket => !workers.some(worker => worker.role === "implementer" && worker.ticket_id === ticket.id && worker.condition === "completed"))) return null;
    return { head: current.head, workspace_hash: current.workspace_hash, check_id: check.id, standards_id: standards.id, spec_id: spec.id };
  }
  /** A public reconciliation can finish execution without accepting or delivering its changes. */
  async reconcileCompletion(id: string): Promise<FactoryRun> {
    const run = this.store.get<FactoryRun>("runs", id)!;
    if ((run.manifest as { planning_authority?: { automatic_execution?: boolean } }).planning_authority?.automatic_execution) return run;
    let retired = this.store.get("implementation_retirement", id);
    if (!retired && run.implementation_completion_pending && ["completed", "cancelled"].includes(run.condition)) retired = this.store.put("implementation_retirement", { id }, run.implementation_id);
    if (run.action !== "implement-spec" || run.issue_pause || run.scope_pause || !["ready", "completed"].includes(run.condition) && !run.implementation_completion_pending && !retired) return run;
    let current: { head: string; workspace_hash: string } | null = null;
    try { current = await this.runtime.operation(run, "head"); } catch { /* Unobservable evidence retains capacity. */ }
    const cleaned = this.store.get<CompletionCleanup>("implementation_cleanup", id);
    if (!current && run.condition === "completed" && !run.implementation_completion_pending && run.implementation_completion
      && cleaned?.machine_id === run.machine_id && cleaned.worktree === run.worktree && cleaned.branch === run.branch
      && JSON.stringify(cleaned.completion) === JSON.stringify(run.implementation_completion)) current = cleaned.completion;
    const completion = current && this.completionEvidence(run, current);
    if (!completion) {
      if (!run.implementation_completion && !run.implementation_completion_pending && !retired) return run;
      // Native retirement is durable even when its logical completion proof expires.
      // Keep that distinction after removing the stale proof from the public Run.
      if (run.implementation_completion) this.store.put("implementation_retirement", { id, completion: run.implementation_completion }, run.implementation_id);
      const next: FactoryRun = { ...run, implementation_completion: undefined, implementation_completion_pending: retired || run.implementation_completion ? undefined : run.implementation_completion_pending, condition: "needs_you", waiting_reason: "Implementation evidence changed or is unavailable. Reconcile current checks and independent reviews." };
      this.store.put("runs", next, run.implementation_id);
      const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
      this.store.put("implementations", { ...implementation, activity: undefined });
      return next;
    }
    if (run.implementation_completion && JSON.stringify(run.implementation_completion) === JSON.stringify(completion)) return run;
    await this.retainBeforeStop(id);
    const finished = await this.retireImplementation(run, completion);
    const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
    if (!["merged", "released"].includes(implementation.outcome)) this.store.put("implementations", { ...implementation, stage: "review", activity: hasIssueSource(this.store, run.implementation_id) ? "awaiting_merge" : undefined });
    this.store.event(run.implementation_id, "implementation_execution_finished", { run_id: id, ...completion, owner_accepted: false, delivered: false });
    return finished;
  }
  async cleanup(id: string): Promise<unknown> {
    let run = this.store.get<FactoryRun>("runs", id);
    if (!run || run.implementation_completion_pending || !["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_owned", "Stop and observe this Run before cleanup", 409);
    if (this.store.get<{ rework_requested?: boolean }>("implementation_retirement", id)?.rework_requested) {
      const latest = this.store.list<FactoryRun>("runs", run.implementation_id).filter(candidate => candidate.id !== id && this.findingRuns(candidate).has(id)).at(-1);
      const successor = latest ? await this.runtime.reconcile(latest.id) : null;
      if (!successor?.implementation_completion || !this.store.list<FactoryApproval>("approvals", run.implementation_id).some(approval => approval.kind === "review" && approval.revision === successor.implementation_completion!.head && approval.scope.startsWith(`Run ${successor.id};`))) throw new FactoryError("review_acceptance_required", "Accept the repaired implementation before removing its retained predecessor checkout", 409);
    }
    // Verify the proof while the checkout still exists; cleanup cannot bless stale evidence.
    if (run.implementation_completion) run = await this.reconcileCompletion(id);
    if (!["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_owned", "Reconcile this Run's current evidence before cleanup", 409);
    if (run.implementation_completion && !this.store.list<FactoryApproval>("approvals", run.implementation_id).some(approval => approval.kind === "review" && approval.revision === run.implementation_completion!.head && approval.scope.startsWith(`Run ${id};`))) throw new FactoryError("review_acceptance_required", "Choose Accept reviewed head before removing this implementation checkout", 409);
    const result = await this.runtime.operation<{ removed: string[]; branches_retained: boolean; notes_retained: boolean }>(run, "cleanup");
    const live = this.store.get<FactoryRun>("runs", id)!;
    if (run.implementation_completion && run.worktree && result?.branches_retained === true && result.notes_retained === true
      && Array.isArray(result.removed) && result.removed.includes(run.worktree)
      && live.condition === "completed" && !live.implementation_completion_pending && live.machine_id === run.machine_id && live.worktree === run.worktree && live.branch === run.branch
      && JSON.stringify(live.implementation_completion) === JSON.stringify(run.implementation_completion)
      && JSON.stringify(this.completionEvidence(live, run.implementation_completion)) === JSON.stringify(run.implementation_completion)) {
      this.store.put<CompletionCleanup>("implementation_cleanup", { id, machine_id: run.machine_id, worktree: run.worktree, branch: run.branch, completion: run.implementation_completion }, run.implementation_id);
    }
    this.store.event(run.implementation_id, "clean_checkouts_removed", { run_id: id, result });
    return result;
  }
  private async retireImplementation(run: FactoryRun, expected: NonNullable<FactoryRun["implementation_completion"]>): Promise<FactoryRun> {
    const live = this.store.get<FactoryRun>("runs", run.id)!;
    const retired = this.store.get("implementation_retirement", run.id);
    if (!live.implementation_completion_pending && !retired && !["ready", "completed"].includes(live.condition)) throw new FactoryError("execution_changed", "The implementation changed before retirement; reconcile its current ownership", 409);
    if (live.issue_pause || live.scope_pause || this.workflow.questions(run.implementation_id).some(question => question.answer === null)) throw new FactoryError("answers_unready", "Resolve current owner decisions before finishing implementation", 409);
    if (this.store.list<{ run_id: string | null; status: string }>("comments", run.implementation_id).some(comment => comment.run_id !== null && this.findingRuns(run).has(comment.run_id) && comment.status !== "resolved")) throw new FactoryError("findings_open", "Resolve retained findings before finishing implementation", 409);
    if (JSON.stringify(this.completionEvidence(run, expected)) !== JSON.stringify(expected)) throw new FactoryError("fresh_evidence_required", "Implementation ownership or evidence changed before retirement", 409);
    this.store.put("runs", { ...live, implementation_completion_pending: true }, run.implementation_id);
    const alreadyRetired = retired || run.implementation_completion || run.implementation_completion_pending && ["completed", "cancelled"].includes(run.condition);
    const stopped = alreadyRetired ? { ...run, condition: "completed" as const } : await this.runtime.stopRun(run.id, { summary: `Implementation execution finished at ${expected.head}` }, "retirement");
    if (!["completed", "cancelled"].includes(stopped.condition)) throw new FactoryError("execution_owned", "Native execution did not confirm termination; retain its reservation", 409);
    // A crash or a changed head after Stop must not turn confirmed physical
    // termination into either lost logical ownership or an unrecoverable pending flag.
    this.store.put("implementation_retirement", { ...this.store.get<{ id: string; rework_requested?: boolean }>("implementation_retirement", run.id), id: run.id }, run.implementation_id);
    const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    const completion = this.completionEvidence(run, head);
    if (!completion || JSON.stringify(completion) !== JSON.stringify(expected)) throw new FactoryError("fresh_evidence_required", "Implementation changed while retiring execution; retain capacity and reconcile", 409);
    const finished: FactoryRun = { ...stopped, condition: "completed", implementation_completion_pending: undefined, implementation_completion: completion };
    this.store.db.transaction(() => {
      this.store.put("runs", finished, run.implementation_id);
      this.store.remove("implementation_retirement", run.id);
    })();
    return finished;
  }
  async accept(id: string, body: Record<string, unknown>, issueApprovalId?: string): Promise<FactoryRun> {
    let run = this.run(id, false, true);
    if ((run.manifest as { planning_authority?: { automatic_execution?: boolean } }).planning_authority?.automatic_execution) throw new FactoryError("human_review_required", "Approve the checked candidate in Human Review; Done requires verified delivery", 409);
    await this.retainBeforeStop(id);
    this.run(id, false, true); // Capture may overlap an owner action; validate the live scope afterwards.
    const current = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    if (body.head !== current.head) throw new FactoryError("review_stale", "Accept the exact current integration head", 409);
    const check = this.store.list<FactoryCheck>("checks", id).filter((entry) => entry.worker_id === null).at(-1);
    const reviews = this.store.list<FactoryReviewEvidence>("review_evidence", id);
    if (!check || check.condition !== "passed" || check.head !== current.head || check.workspace_hash !== current.workspace_hash || current.workspace_hash !== CLEAN_WORKSPACE_HASH || !["standards", "spec"].every((axis) => reviews.filter((entry) => entry.axis === axis).at(-1)?.outcome === "passed" && reviews.filter((entry) => entry.axis === axis).at(-1)?.head === current.head)) throw new FactoryError("fresh_evidence_required", "Retain fresh checks and separate passing Standards and Spec reports at this head", 409);
    if (run.action === "implement-spec" && !this.completionEvidence(run, current)) throw new FactoryError("fresh_evidence_required", "Retain all frozen Project checks and independent reviews, and reconcile every owned worker and build", 409);
    const tickets = this.workflow.executionTickets(run);
    const done = this.store.list<FactoryWorker>("workers", id).filter((entry) => entry.role === "implementer" && entry.condition === "completed");
    if (run.action === "implement-spec" && tickets.some((ticket) => !done.some((entry) => entry.ticket_id === ticket.id))) throw new FactoryError("tickets_incomplete", "Integrate every accepted Ticket before completion", 409);
    if (this.store.list<{ run_id: string | null; status: string }>("comments", run.implementation_id).some((entry) => entry.run_id !== null && this.findingRuns(run).has(entry.run_id) && entry.status !== "resolved")) throw new FactoryError("findings_open", "Resolve this Run's retained findings with fresh evidence before acceptance", 409);
    if (this.workflow.questions(run.implementation_id).some(question => question.answer === null)) throw new FactoryError("answers_unready", "Answer pending owner questions before accepting the prepared implementation", 409);
    const approval = { ...this.store.record(), implementation_id: run.implementation_id, kind: "review", revision: current.head, scope: `Run ${id}; checks ${check.id}; independent Standards and Spec reports`, ...(issueApprovalId ? { source_approval_id: issueApprovalId } : {}) };
    // Release native ownership explicitly, while retaining Git and all evidence.
    const stopped = run.action === "implement-spec" ? await this.retireImplementation(run, this.completionEvidence(run, current)!) : await this.runtime.stopRun(id, { summary: `Owner accepted implementation at ${current.head}` });
    if (!["completed", "cancelled"].includes(stopped.condition)) throw new FactoryError("execution_owned", "Native execution did not confirm termination; retain its reservation", 409);
    this.store.put("approvals", approval, run.implementation_id);
    const completed: FactoryRun = { ...stopped, condition: "completed", accepted_result: { head: current.head, workspace_hash: current.workspace_hash, check_id: check.id, review_ids: ["standards", "spec"].map(axis => reviews.filter(entry => entry.axis === axis).at(-1)!.id), question_revision: this.workflow.questionRevision(run.implementation_id) }, ...(run.action === "implement-spec" ? { implementation_completion: this.completionEvidence(run, current) ?? undefined } : {}) };
    this.store.put("runs", completed, run.implementation_id);
    const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
    if (["work", "implement-spec"].includes(run.action) && !["merged", "released"].includes(implementation.outcome)) {
      const requiresDelivery = !manualCompletionAllowed(this.store, implementation) || hasIssueSource(this.store, run.implementation_id);
      this.store.put("implementations", { ...implementation, stage: requiresDelivery ? "review" : "done", activity: requiresDelivery ? "awaiting_merge" : undefined, outcome: "implementation_complete" });
      const evidence = await new FactoryDelivery(this.store, this.runtime).inspect(run.implementation_id);
      if (!requiresDelivery && (!evidence.quiescent || evidence.repository_changes === "unknown")) {
        const current = this.store.get<Implementation>("implementations", run.implementation_id)!;
        this.store.put("implementations", { ...current, stage: "review" });
      }
    }
    if (run.action === "apply-retro") {
      const scoped = (run.manifest as { retrospective: import("../shared/protocol.ts").FactoryRetrospective }).retrospective;
      const proposal = this.store.get<import("../shared/protocol.ts").FactoryRetrospective>("retrospectives", scoped.id);
      if (proposal) this.store.put("retrospectives", { ...proposal, applied_run_id: run.id, updated_at: completed.updated_at }, proposal.project_id);
    }
    this.store.event(run.implementation_id, "implementation_accepted", { run_id: id, head: current.head, publication_authorized: false }); return completed;
  }
  /** Trusted issue scope already authorizes implementation. Only resting, verified
   * work can release its slot; merge and delivery retain their separate owner gate. */
  async completeReadyIssue(id: string): Promise<void> {
    const run = this.store.get<FactoryRun>("runs", id);
    // Capacity reconciliation can retire verified execution before this legacy
    // approved-plan handoff. Acceptance still revalidates the complete live proof.
    if (run?.action !== "implement-spec" || run.condition !== "ready" && !(run.condition === "completed" && run.implementation_completion) || run.accepted_result || run.scope_pause || run.issue_pause || !(run.manifest as { issue_scope?: unknown }).issue_scope) return;
    if (this.workflow.questions(run.implementation_id).some(question => question.answer === null)
      || this.store.list<FactoryWorker>("workers", id).some(worker => owns(worker.condition))
      || this.store.list<FactoryCheck>("checks", id).some(check => ["working", "interrupted"].includes(check.condition))) return;
    const check = this.store.list<FactoryCheck>("checks", id).filter(check => check.worker_id === null).at(-1);
    const reviews = this.store.list<FactoryReviewEvidence>("review_evidence", id);
    if (!check || check.condition !== "passed" || !["standards", "spec"].every(axis => reviews.filter(review => review.axis === axis).at(-1)?.head === check.head && reviews.filter(review => review.axis === axis).at(-1)?.outcome === "passed")) return;
    const scope = (run.manifest as { issue_scope: import("../shared/github-project.ts").ProjectIssueExecutionScope }).issue_scope;
    await this.accept(id, { head: check.head }, scope.approval.id);
  }
  async resolveFinding(id: string, commentId: string, body: Record<string, unknown>): Promise<unknown> {
    const comment = this.store.get<import("../shared/protocol.ts").ReviewComment>("comments", commentId);
    if (!comment || comment.implementation_id !== id || !comment.run_id) throw new FactoryError("invalid_finding", "Select a finding attached to this Implementation's Run");
    const candidate = this.store.list<FactoryRun>("runs", id).filter(run => this.findingRuns(run).has(comment.run_id!)).at(-1);
    const run = this.run(candidate?.id ?? comment.run_id, false);
    const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    const check = this.store.list<FactoryCheck>("checks", run.id).filter((entry) => entry.worker_id === null).at(-1);
    const evidence = this.store.list<FactoryReviewEvidence>("review_evidence", run.id);
    if (body.head !== head.head || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 20000 || check?.condition !== "passed" || check.head !== head.head || check.workspace_hash !== head.workspace_hash || head.workspace_hash !== CLEAN_WORKSPACE_HASH || !["standards", "spec"].every((axis) => evidence.filter((entry) => entry.axis === axis).at(-1)?.head === head.head && evidence.filter((entry) => entry.axis === axis).at(-1)?.outcome === "passed")) throw new FactoryError("fresh_evidence_required", "Resolve findings with an explicit summary, fresh checks and separate passing reviews at this head", 409);
    const next = { ...comment, status: "resolved", updated_at: new Date().toISOString(), resolution: { head: head.head, check_id: check.id, summary: body.summary } };
    this.store.put("comments", next, id); this.store.event(id, "finding_resolved", { comment_id: commentId, resolution: next.resolution }); return next;
  }
}
