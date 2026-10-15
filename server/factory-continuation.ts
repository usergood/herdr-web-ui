import type { FactoryCapacityWait, FactoryProject, FactoryRun, Implementation, ProjectCheckout } from "../shared/protocol.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryRuntime } from "./factory-runtime.ts";

interface Continuation {
  id: string; implementation_id: string; key: string; signature: string;
  body: Record<string, unknown>; origin: string; scope_hash: string; run_id: string | null;
  condition: "starting" | "queued" | "verifying" | "started" | "failed";
  queued_request?: Record<string, unknown>;
  problem: string | null;
  verification_deadline?: number;
}

/** One explicit owner Continue retains the handoff and advances an approved scope. */
export class FactoryContinuation {
  private readonly pending = new Map<string, Promise<FactoryRun | FactoryCapacityWait>>();
  private readonly verifying = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  stop(): void { this.stopped = true; for (const timer of this.retries.values()) clearTimeout(timer); this.retries.clear(); }
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly runtime: FactoryRuntime, private readonly retain: (id: string, allowPartial: boolean) => Promise<void>) {
    runtime.queue.onRun = run => {
      const record = this.store.list<Continuation>("workflow_continuations", run.implementation_id).find(entry => entry.key === run.idempotency_key);
      if (!record || this.stopped) return;
      const verifying = run.action === "verify-provider" && record.body.action === "implement-spec";
      this.store.put("workflow_continuations", { ...record, run_id: run.id, condition: verifying ? "verifying" : "started", problem: null }, run.implementation_id);
      if (verifying) this.retry(run.id);
    };
    for (const record of this.store.list<Continuation>("workflow_continuations")) if (record.condition === "verifying" && record.run_id) this.retry(record.run_id);
  }

  /** Remote readiness has no local collector event. Observe accepted identity only;
   * never redispatch a probe, and leave ownership intact when the deadline expires. */
  private retry(runId: string): void {
    if (this.stopped || this.retries.has(runId)) return;
    const record = this.store.list<Continuation>("workflow_continuations").find(entry => entry.condition === "verifying" && entry.run_id === runId);
    if (!record) return;
    const deadline = record.verification_deadline ?? Date.now() + 600_000;
    if (deadline <= Date.now()) {
      const problem = "Native verification did not finish within ten minutes; inspect its retained evidence before continuing";
      this.store.put("workflow_continuations", { ...record, condition: "failed", problem }, record.implementation_id);
      this.store.event(record.implementation_id, "continuation_waiting", { run_id: runId, message: problem }); return;
    }
    this.store.put("workflow_continuations", { ...record, verification_deadline: deadline }, record.implementation_id);
    const timer = setTimeout(() => { this.retries.delete(runId); void this.verified(runId); }, Math.min(2_000, deadline - Date.now()));
    timer.unref(); this.retries.set(runId, timer);
  }

  start(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryRun | FactoryCapacityWait> {
    if (this.stopped) return Promise.reject(new FactoryError("stopping", "The bridge is stopping; retain the current workflow", 409));
    if (this.pending.has(id)) return Promise.reject(new FactoryError("continuation_busy", "This Assignment is already continuing; refresh its current step", 409));
    const operation = this.advance(id, body, origin);
    this.pending.set(id, operation);
    return operation.finally(() => this.pending.delete(id));
  }
  private scopeHash(id: string): string {
    const idea = this.store.get<Implementation>("implementations", id)!;
    const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    const { updated_at: updated, created_at: created, ...projectScope } = project ?? { updated_at: "", created_at: "" };
    const checkout = project ? this.store.list<ProjectCheckout>("checkouts", project.id).find(entry => entry.machine_id === (idea.machine_id ?? project.machine_id)) : null;
    const checkoutScope = checkout ? { path: checkout.path, repository: checkout.repository, head: checkout.head, branch: checkout.branch, instructions: checkout.instructions.map(entry => ({ path: entry.path, hash: entry.hash })) } : null;
    const spec = this.workflow.specification(id);
    return hash(JSON.stringify({ assignment: { title: idea.title, description: idea.description, project_id: idea.project_id, provider: idea.provider, machine_id: idea.machine_id, archived_at: idea.archived_at }, project: projectScope, checkout: checkoutScope, specification: spec?.hash ?? null, graph: this.workflow.graphHash(id), question_revision: this.workflow.questionRevision(id) }));
  }
  private validate(id: string, body: Record<string, unknown>): void {
    if (!["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "verify-provider"].includes(String(body.action)) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key) || body.run_id !== null && typeof body.run_id !== "string" || body.allow_partial_handoff !== undefined && typeof body.allow_partial_handoff !== "boolean") throw new FactoryError("invalid_continuation", "Select the displayed next step with its current Run and request key");
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea) throw new FactoryError("not_found", "Assignment not found", 404);
    const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    const spec = this.workflow.specification(id);
    if (body.expected !== undefined) {
      const expected = body.expected as Record<string, unknown>;
      if (!expected || typeof expected !== "object" || expected.provider !== (idea.provider ?? project?.provider) || expected.machine_id !== (idea.machine_id ?? project?.machine_id) || expected.project_id !== idea.project_id || expected.specification_id !== (spec?.id ?? null) || expected.graph_hash !== this.workflow.graphHash(id)) throw new FactoryError("scope_changed", "The approved workflow scope changed; refresh before continuing", 409);
    }
    if (body.action !== "verify-provider" && this.workflow.questions(id).some(q => q.answer === null)) throw new FactoryError("answers_unready", "Answer the pending product questions before continuing", 409);
    if (body.action === "to-tickets" || body.action === "implement-spec") {
      if (!spec || !this.workflow.approved(id, "specification", spec.id) || !this.workflow.approved(id, "testing_seams", spec.id)) throw new FactoryError("scope_unaccepted", "Accept the current specification and testing seams before continuing", 409);
    }
    if (body.action === "implement-spec" && (!this.workflow.tickets(id).length || !this.workflow.approved(id, "ticket_graph", this.workflow.graphHash(id)))) throw new FactoryError("scope_unaccepted", "Approve the current Ticket graph before continuing", 409);
  }
  private validateScope(id: string, expected: string, body: Record<string, unknown>): void {
    if (expected !== this.scopeHash(id)) throw new FactoryError("scope_changed", "Project settings or the approved scope changed; inspect them before continuing", 409);
    this.validate(id, body);
  }
  private async advance(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryRun | FactoryCapacityWait> {
    const signature = hash(JSON.stringify(body));
    const previous = this.store.list<Continuation>("workflow_continuations", id).find(record => record.key === body.idempotency_key);
    if (previous) {
      if (previous.signature !== signature) throw new FactoryError("continuation_conflict", "This Continue key belongs to another scope", 409);
      const run = previous.run_id ? this.store.get<FactoryRun>("runs", previous.run_id) : null;
      if (run) return run;
      if (previous.condition === "queued" && previous.queued_request) return this.runtime.requestStart(id, previous.queued_request, previous.origin);
      throw new FactoryError("continuation_uncertain", previous.problem ?? "The previous Continue needs reconciliation; it was not replayed", 409);
    }
    this.validate(id, body);
    const scopeHash = this.scopeHash(id);
    const source = typeof body.run_id === "string" ? this.store.get<FactoryRun>("runs", body.run_id) : null;
    const active = this.store.list<FactoryRun>("runs", id).filter(run => !["completed", "cancelled", "failed"].includes(run.condition));
    if (body.run_id !== null && (!source || source.implementation_id !== id) || active.some(run => run.id !== source?.id)) throw new FactoryError("step_changed", "Refresh the Assignment's current step before continuing", 409);
    let action = body.action;
    if (action === "implement-spec") {
      if (source?.action === "verify-provider" && !["cancelled", "failed"].includes(source.condition)) await this.runtime.verifyProvider(source);
      const idea = this.store.get<Implementation>("implementations", id)!;
      const project = this.store.get<FactoryProject>("projects", idea.project_id!)!;
      const capabilities = await this.runtime.capabilities(idea.machine_id ?? project.machine_id, project.account_bindings?.[idea.machine_id ?? project.machine_id] ? await this.runtime.accountSnapshot(idea.machine_id ?? project.machine_id, project.account_bindings[idea.machine_id ?? project.machine_id]!) : null);
      if (!capabilities.providers.find(entry => entry.provider === (idea.provider ?? project.provider))?.factory_ready) action = "verify-provider";
    }
    // Capture immutable owner intent before any native side effect. A lost response
    // can return the same accepted Run; an uncertain start never blindly retries.
    this.validateScope(id, scopeHash, body);
    const record: Continuation = { id: this.store.record().id, implementation_id: id, key: String(body.idempotency_key), signature, body, origin, scope_hash: scopeHash, run_id: null, condition: "starting", problem: null };
    this.store.put("workflow_continuations", record, id);
    try {
      const run = await this.runtime.start(id, { ...body, action }, origin, { validateScope: () => this.validateScope(id, record.scope_hash, body), ...(source && !["completed", "cancelled", "failed"].includes(source.condition) ? { runId: source.id, finish: async () => {
        const observed = await this.runtime.reconcile(source.id);
        if (observed.condition !== "ready") throw new FactoryError("step_not_ready", observed.waiting_reason ?? "The current step is still working; continue when its proposal is ready", 409);
        await this.retain(source.id, body.allow_partial_handoff === true);
        await this.runtime.finishStep(source.id);
      } } : {}) });
      if (this.stopped) return run;
      this.store.put("workflow_continuations", { ...record, run_id: run.id, condition: action === "verify-provider" && body.action === "implement-spec" ? "verifying" : "started" }, id);
      return run;
    } catch (error) {
      if (this.stopped) throw error;
      if (error instanceof FactoryError && error.code === "capacity_exhausted") {
        this.store.put("workflow_continuations", { ...record, condition: "queued", queued_request: { ...body, action }, problem: null }, id);
        return this.runtime.requestStart(id, { ...body, action }, origin);
      }
      this.store.put("workflow_continuations", { ...record, condition: "failed", problem: error instanceof FactoryError ? error.message : "Continue could not be confirmed; inspect retained ownership" }, id);
      throw error;
    }
  }

  /** Collector/consumption events may complete a probe only under retained owner intent. */
  async verified(runId: string): Promise<void> {
    if (this.stopped || this.verifying.has(runId)) return;
    const retry = this.retries.get(runId); if (retry) clearTimeout(retry); this.retries.delete(runId);
    const record = this.store.list<Continuation>("workflow_continuations").find(entry => entry.condition === "verifying" && entry.run_id === runId);
    if (!record) return;
    this.verifying.add(runId);
    try {
      const run = await this.runtime.reconcile(runId);
      if (this.stopped) return;
      if (["working", "needs_you", "blocked"].includes(run.condition)) { this.retry(runId); return; }
      if (run.condition !== "ready") return;
      this.validate(record.implementation_id, record.body);
      this.validateScope(record.implementation_id, record.scope_hash, record.body);
      await this.runtime.verifyProvider(run);
      if (this.stopped) return;
      this.validateScope(record.implementation_id, record.scope_hash, record.body);
      // All evidence and approvals are still checked by normal factory admission.
      const next = await this.runtime.start(record.implementation_id, { ...record.body, idempotency_key: `${record.key.slice(0, 110)}-verified` }, record.origin, { runId, validateScope: () => this.validateScope(record.implementation_id, record.scope_hash, record.body), finish: async () => {
        await this.retain(runId, false);
        await this.runtime.finishStep(runId);
      } });
      if (this.stopped) return;
      this.store.put("workflow_continuations", { ...record, run_id: next.id, condition: "started", problem: null }, record.implementation_id);
    } catch (error) {
      // Missing native evidence remains an honest wait. Other failures require an
      // explicit new Continue rather than restarting unattended after an ambiguity.
      if (this.stopped) return;
      const waiting = error instanceof FactoryError && ["verification_round_required", "native_evidence_required", "agent_busy"].includes(error.code);
      this.store.put("workflow_continuations", { ...record, condition: waiting ? "verifying" : "failed", problem: error instanceof FactoryError ? error.message : "Verification continuation needs reconciliation" }, record.implementation_id);
      const message = error instanceof FactoryError ? error.message : "Verification continuation needs reconciliation";
      if (record.problem !== message) this.store.event(record.implementation_id, "continuation_waiting", { run_id: runId, message });
      if (error instanceof FactoryError && ["native_evidence_required", "agent_busy"].includes(error.code)) this.retry(runId);
    } finally { this.verifying.delete(runId); }
  }
}
