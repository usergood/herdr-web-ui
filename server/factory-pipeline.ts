import type { FactoryCheck, FactoryProject, FactoryQuestion, FactoryReviewEvidence, FactoryRun, FactorySettings, FactoryTicket, FactoryWorker, Implementation } from "../shared/protocol.ts";
import { FactoryError } from "./factory-host.ts";
import { FactoryRuntime } from "./factory-runtime.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";

const owns = (condition: string): boolean => !["completed", "cancelled", "failed"].includes(condition);
/** Admission reservations cover all native contexts and builds, including uncertain remote work. */
export class FactoryPipeline {
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly workflow: FactoryWorkflow, private readonly settings: () => FactorySettings) {}
  private run(id: string, factoryRequired = true): FactoryRun {
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run || factoryRequired && run.action !== "implement-spec" || !run.checkout || !["working", "needs_you", "blocked"].includes(run.condition)) throw new FactoryError("factory_run_required", "Reconcile an admitted repository Run first", 409);
    return run;
  }
  frontier(run: FactoryRun): FactoryTicket[] {
    const tickets = (run.manifest as { tickets: FactoryTicket[] }).tickets;
    const workers = this.store.list<FactoryWorker>("workers", run.id);
    const done = new Set(workers.filter((worker) => worker.role === "implementer" && worker.condition === "completed").map((worker) => worker.ticket_id));
    return tickets.filter((ticket) => !done.has(ticket.id) && !workers.some((worker) => worker.ticket_id === ticket.id && owns(worker.condition)) && ticket.dependencies.every((dependency) => done.has(dependency)));
  }
  async startWorker(id: string, body: Record<string, unknown>): Promise<FactoryWorker> {
    const run = this.run(id, body.role === "implementer");
    if (!["implementer", "standards", "spec"].includes(String(body.role)) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_worker", "Select a worker role and explicit request key");
    const role = body.role as FactoryWorker["role"];
    if (this.store.list<FactoryQuestion>("questions", run.implementation_id).some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Answer pending owner questions before allocating more work", 409);
    const previous = this.store.list<FactoryWorker & { key: string }>("workers", id).find((worker) => worker.key === body.idempotency_key);
    if (previous) { if (previous.role !== role || role === "implementer" && previous.ticket_id !== body.ticket_id) throw new FactoryError("worker_conflict", "This key already belongs to another worker", 409); return previous; }
    const tip = await this.runtime.operation<{ head: string }>(run, "head");
    const claimed = this.store.db.transaction(() => {
      const raced = this.store.list<FactoryWorker & { key: string }>("workers", id).find((worker) => worker.key === body.idempotency_key);
      if (raced) return { worker: raced, fresh: false };
      this.run(id, role === "implementer");
      const ticket = role === "implementer" ? this.frontier(run).find((entry) => entry.id === body.ticket_id) : null;
      const batch = typeof body.review_batch_id === "string" ? this.store.get<{ id: string; run_id: string; status: string }>("review_batches", body.review_batch_id) : null;
      const rework = role === "implementer" && batch?.run_id === id && batch.status === "sent" ? (run.manifest as { tickets: FactoryTicket[] }).tickets.find((entry) => entry.id === body.ticket_id) : null;
      if (role === "implementer" && !ticket && !rework) throw new FactoryError("ticket_not_ready", "Select a ready Ticket or an explicitly delivered rework batch", 409);
      if (rework && this.store.list<FactoryWorker>("workers", id).some((worker) => worker.ticket_id === rework.id && owns(worker.condition))) throw new FactoryError("ticket_owned", "This Ticket already has an active or uncertain writer", 409);
      if (role !== "implementer" && this.store.list<FactoryWorker>("workers", id).some((worker) => worker.role === "implementer" && owns(worker.condition))) throw new FactoryError("writers_active", "Quiesce repository writers before independent final reviews", 409);
      const count = this.store.list<FactoryRun>("runs").filter((entry) => owns(entry.condition)).length + this.store.list<FactoryWorker>("workers").filter((entry) => owns(entry.condition)).length;
      if (count >= this.settings().max_agents) throw new FactoryError("capacity_exhausted", "Global native context capacity is in use", 409);
      const shared = body.shared_paths ?? [];
      const configured = (run.manifest as { project: FactoryProject }).project.shared_paths ?? [];
      if (!Array.isArray(shared) || shared.some((path) => typeof path !== "string" || !configured.includes(path))) throw new FactoryError("invalid_shared_paths", "Claim only configured shared document paths");
      if (this.store.list<FactoryWorker>("workers", id).some((worker) => owns(worker.condition) && worker.shared_paths.some((path) => shared.includes(path)))) throw new FactoryError("shared_writer_owned", "Another worker owns a selected shared document", 409);
      const worker: FactoryWorker & { key: string } = { ...this.store.record(), run_id: id, ticket_id: (ticket ?? rework)?.id ?? id, role, condition: "accepted", base: tip.head, head: null, integration_tip: tip.head, worktree: null, branch: null, workspace_id: null, pane_id: null, shared_paths: shared as string[], waiting_reason: null, rework_batch_id: rework ? batch!.id : null, key: body.idempotency_key as string };
      this.store.put("workers", worker, id); this.store.event(run.implementation_id, "worker_accepted", { worker_id: worker.id, role, ticket_id: worker.ticket_id }); return { worker, fresh: true };
    }).immediate();
    if (!claimed.fresh) return claimed.worker;
    let worker: FactoryWorker;
    try { worker = await this.runtime.operation(run, "worker", { worker: claimed.worker, context: { manifest: run.manifest, ticket: (run.manifest as { tickets: FactoryTicket[] }).tickets.find((ticket) => ticket.id === claimed.worker.ticket_id), questions: this.store.list<FactoryQuestion>("questions", run.implementation_id), findings: this.store.list<import("../shared/protocol.ts").ReviewComment>("comments", run.implementation_id).filter((comment) => comment.batch_id === claimed.worker.rework_batch_id && claimed.worker.rework_batch_id !== null) } }); }
    catch { worker = { ...claimed.worker, condition: "disconnected", waiting_reason: "Worker dispatch is uncertain; preserve its reservation and reconcile" }; }
    if (worker.id !== claimed.worker.id || worker.run_id !== run.id || worker.ticket_id !== claimed.worker.ticket_id || worker.role !== role || worker.base !== tip.head) throw new FactoryError("worker_identity_changed", "The Machine returned a different worker identity; preserve the accepted reservation", 409);
    this.store.put("workers", { ...worker, key: claimed.worker.key }, id); this.store.event(run.implementation_id, "worker_observed", { worker_id: worker.id, condition: worker.condition }); return worker;
  }
  async workerAction(id: string, workerId: string, action: string): Promise<unknown> {
    const run = this.run(id, false); const worker = this.store.get<FactoryWorker>("workers", workerId);
    if (!worker || worker.run_id !== id) throw new FactoryError("invalid_worker", "Select this Run's worker");
    if (action === "check") return this.check(id, workerId);
    if (action === "stop") { await this.runtime.operation(run, "stop-worker", { worker_id: workerId }); this.store.put("workers", { ...worker, condition: "cancelled" }, id); return { ok: true }; }
    if (action === "review-evidence") {
      if (worker.role === "implementer") throw new FactoryError("independent_review_required", "Use a separate Standards or Spec context", 409);
      const current = await this.runtime.operation<{ head: string }>(run, "head");
      const report = await this.runtime.operation<{ head: string; source_id: string; content: string; outcome: FactoryReviewEvidence["outcome"] }>(run, action, { worker_id: workerId });
      if (report.head !== current.head || worker.base !== current.head || !["passed", "failed"].includes(report.outcome) || typeof report.content !== "string" || report.content.length > 512 * 1024 || typeof report.source_id !== "string") throw new FactoryError("review_stale", "Review evidence must name the current integration head", 409);
      const evidence: FactoryReviewEvidence = { ...this.store.record(), run_id: id, worker_id: workerId, axis: worker.role, ...report };
      await this.runtime.operation(run, "stop-worker", { worker_id: workerId });
      this.store.put("review_evidence", evidence, id); this.store.put("workers", { ...worker, head: report.head, condition: "completed" }, id); this.store.event(run.implementation_id, "review_axis_retained", { evidence_id: evidence.id, axis: evidence.axis, head: evidence.head }); return evidence;
    }
    if (action !== "refresh" && action !== "reconcile") throw new FactoryError("not_found", "Unknown worker action", 404);
    const next = await this.runtime.operation<FactoryWorker>(run, action === "reconcile" ? "reconcile-worker" : action, { worker_id: workerId });
    if (next.id !== worker.id || next.run_id !== id || next.worktree !== worker.worktree || next.branch !== worker.branch) throw new FactoryError("worker_identity_changed", "The observed worker identity changed", 409);
    this.store.put("workers", next, id); return next;
  }
  async check(id: string, workerId: string | null = null): Promise<FactoryCheck> {
    const run = this.run(id, false);
    if (process.platform === "win32" && run.machine_id === "local") throw new FactoryError("build_contract_unverified", "This platform's owned build process contract is not verified", 409);
    const check = this.store.db.transaction(() => {
      if (this.store.list<FactoryCheck>("checks").filter((entry) => ["working", "interrupted"].includes(entry.condition)).length >= this.settings().max_builds) throw new FactoryError("build_capacity_exhausted", "Global build capacity is reserved, including uncertain builds", 409);
      const record: FactoryCheck = { ...this.store.record(), run_id: id, worker_id: workerId, head: "", workspace_hash: "", commands: [], condition: "working" };
      this.store.put("checks", record, id); return record;
    }).immediate();
    let result: FactoryCheck;
    try { result = await this.runtime.operation(run, "check", { worker_id: workerId, check }); }
    catch { result = { ...check, condition: "interrupted" }; }
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
    const questions = this.store.list<FactoryQuestion>("questions", run.implementation_id);
    if (questions.some((question) => question.answer === null) || questions.length && !this.store.list<{ worker_id: string; revision: string }>("answer_consumption", id).some((receipt) => receipt.worker_id === worker.id && receipt.revision === this.workflow.questionRevision(run.implementation_id))) throw new FactoryError("answers_unconsumed", "The worker must consume the current answered context through its scoped tracker", 409);
    const check = this.store.list<FactoryCheck>("checks", id).filter((entry) => entry.worker_id === workerId).at(-1);
    if (!check || check.condition !== "passed" || check.head !== worker.head) throw new FactoryError("checks_required", "Run fresh checks on the reconciled worker head", 409);
    const next = await this.runtime.operation<FactoryWorker>(run, "integrate", { worker_id: workerId, tip: worker.integration_tip });
    if (next.id !== workerId || next.run_id !== id || next.head !== worker.head || next.condition !== "completed") throw new FactoryError("integration_uncertain", "Integration identity is uncertain; reconcile before further work", 409);
    await this.runtime.operation(run, "stop-worker", { worker_id: workerId });
    this.store.put("workers", next, id);
    const graph = this.store.get<{ id: string; hash: string; tickets: FactoryTicket[] }>("graphs", run.implementation_id);
    if (graph && this.workflow.graphHash(run.implementation_id) === run.graph_hash) this.store.put("graphs", { ...graph, tickets: graph.tickets.map((ticket) => ticket.id === worker.ticket_id ? { ...ticket, status: "done" } : ticket) }, run.implementation_id);
    this.store.event(run.implementation_id, "ticket_integrated", { worker_id: workerId, ticket_id: worker.ticket_id, head: next.head }); return next;
  }
  async accept(id: string, body: Record<string, unknown>): Promise<FactoryRun> {
    const run = this.run(id, false); const current = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    if (body.head !== current.head) throw new FactoryError("review_stale", "Accept the exact current integration head", 409);
    const check = this.store.list<FactoryCheck>("checks", id).filter((entry) => entry.worker_id === null).at(-1);
    const reviews = this.store.list<FactoryReviewEvidence>("review_evidence", id);
    if (!check || check.condition !== "passed" || check.head !== current.head || check.workspace_hash !== current.workspace_hash || !["standards", "spec"].every((axis) => reviews.filter((entry) => entry.axis === axis).at(-1)?.outcome === "passed" && reviews.filter((entry) => entry.axis === axis).at(-1)?.head === current.head)) throw new FactoryError("fresh_evidence_required", "Retain fresh checks and separate passing Standards and Spec reports at this head", 409);
    const tickets = (run.manifest as { tickets: FactoryTicket[] }).tickets;
    const done = this.store.list<FactoryWorker>("workers", id).filter((entry) => entry.role === "implementer" && entry.condition === "completed");
    if (run.action === "implement-spec" && tickets.some((ticket) => !done.some((entry) => entry.ticket_id === ticket.id))) throw new FactoryError("tickets_incomplete", "Integrate every accepted Ticket before completion", 409);
    if (this.store.list<{ status: string }>("comments", run.implementation_id).some((entry) => entry.status !== "resolved")) throw new FactoryError("findings_open", "Resolve retained findings with fresh evidence before acceptance", 409);
    const approval = { ...this.store.record(), implementation_id: run.implementation_id, kind: "review", revision: current.head, scope: `Run ${id}; checks ${check.id}; independent Standards and Spec reports` };
    this.store.put("approvals", approval, run.implementation_id);
    // Release native ownership explicitly, while retaining Git and all evidence.
    const stopped = await this.runtime.stopRun(id, { summary: `Owner accepted implementation at ${current.head}` });
    const completed: FactoryRun = { ...stopped, condition: "completed" };
    this.store.put("runs", completed, run.implementation_id);
    const implementation = this.store.get<Implementation>("implementations", run.implementation_id)!;
    if (run.action === "implement-spec") this.store.put("implementations", { ...implementation, stage: "done", outcome: "implementation_complete" });
    this.store.event(run.implementation_id, "implementation_accepted", { run_id: id, head: current.head, publication_authorized: false }); return completed;
  }
  async resolveFinding(id: string, commentId: string, body: Record<string, unknown>): Promise<unknown> {
    const comment = this.store.get<import("../shared/protocol.ts").ReviewComment>("comments", commentId);
    if (!comment || comment.implementation_id !== id || !comment.run_id) throw new FactoryError("invalid_finding", "Select a finding attached to this Implementation's Run");
    const run = this.run(comment.run_id, false);
    const head = await this.runtime.operation<{ head: string; workspace_hash: string }>(run, "head");
    const check = this.store.list<FactoryCheck>("checks", run.id).filter((entry) => entry.worker_id === null).at(-1);
    const evidence = this.store.list<FactoryReviewEvidence>("review_evidence", run.id);
    if (body.head !== head.head || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 20000 || check?.condition !== "passed" || check.head !== head.head || check.workspace_hash !== head.workspace_hash || !["standards", "spec"].every((axis) => evidence.filter((entry) => entry.axis === axis).at(-1)?.head === head.head && evidence.filter((entry) => entry.axis === axis).at(-1)?.outcome === "passed")) throw new FactoryError("fresh_evidence_required", "Resolve findings with an explicit summary, fresh checks and separate passing reviews at this head", 409);
    const next = { ...comment, status: "resolved", updated_at: new Date().toISOString(), resolution: { head: head.head, check_id: check.id, summary: body.summary } };
    this.store.put("comments", next, id); this.store.event(id, "finding_resolved", { comment_id: commentId, resolution: next.resolution }); return next;
  }
}
