import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryAutomaticExecution, FactoryCheck, FactoryExecutionPlan, FactoryProject, FactoryRun, FactoryWorker, Implementation } from "../shared/factory.ts";
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
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly runtime: FactoryRuntime, private readonly pipeline: FactoryPipeline) { this.schedule(); }
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
  private save(plan: FactoryExecutionPlan, condition: FactoryAutomaticExecution["condition"], reason: string | null, attempts = 0, nextAttempt = 0): void {
    if (!this.live(plan)) return;
    const previous = this.store.get<FactoryAutomaticExecution>("automatic_execution", plan.run_id);
    if (previous?.condition === condition && previous.reason === reason && previous.attempts === attempts) return;
    const record: FactoryAutomaticExecution = { ...(previous ?? this.store.record()), id: plan.run_id, run_id: plan.run_id, plan_hash: plan.hash, condition, reason, attempts, next_attempt_at: nextAttempt, updated_at: new Date().toISOString() };
    this.store.put("automatic_execution", record, this.store.get<FactoryRun>("runs", plan.run_id)!.implementation_id);
  }
  private async advance(plan: FactoryExecutionPlan): Promise<void> {
    let run = this.live(plan);
    if (!run) return;
    const progress = this.store.get<FactoryAutomaticExecution>("automatic_execution", run.id);
    if (["blocked", "checked"].includes(progress?.condition ?? "") || (progress?.next_attempt_at ?? 0) > Date.now()) return;
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
      if (["capacity_exhausted", "build_capacity_exhausted", "shared_writer_owned", "worker_busy", "integration_busy", "answers_unready", "answers_unconsumed"].includes(code)) { this.save(plan, "waiting", reason); return; }
      const retry = ["execution_uncertain", "machine_offline", "machine_disconnected", "remote_factory_unavailable", "integration_uncertain"].includes(code);
      const attempts = (progress?.attempts ?? 0) + 1;
      this.save(plan, retry && attempts < 6 ? "waiting" : "blocked", `${reason}${retry && attempts >= 6 ? "; automatic recovery exhausted after six observations" : ""}`, attempts, retry ? Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) : 0);
    }
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
    if (!check || check.head !== current.head || current.workspace_hash !== undefined && check.workspace_hash !== current.workspace_hash) check = await this.pipeline.check(run.id, worker?.id ?? null);
    if (!this.live(plan)) return null;
    if (["working", "interrupted"].includes(check.condition)) return null;
    if (check.condition !== "passed") throw new FactoryError("checks_failed", `Check ${check.id} failed: ${check.commands.filter(c => c.exit_code !== 0).map(c => c.args.join(" ")).join(", ") || "the checked workspace changed"}`, 409);
    return check;
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
