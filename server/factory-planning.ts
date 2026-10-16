import type { FactoryPlanningRequest, FactoryRun, Implementation } from "../shared/factory.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./factory-host.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";
import type { FactoryStore } from "./factory-store.ts";
import type { FactoryWorkflow } from "./factory-workflow.ts";

/** Durable Specification acceptance outbox. Admission and uncertain launches remain
 * owned by the shared queue; restart never creates a second coordinator. */
export class FactoryPlanning {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly runtime: FactoryRuntime, private readonly retain: (id: string) => Promise<void>) { this.schedule(); }
  private schedule(): void {
    this.timer = setTimeout(() => { void this.drain().catch(() => {}).finally(() => { if (!this.stopped) this.schedule(); }); }, 250);
    this.timer.unref();
  }
  private async drain(): Promise<void> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) return;
    for (const request of this.store.list<FactoryPlanningRequest>("automatic_planning")) {
      if (this.stopped) return;
      if (request.condition === "blocked" || (request.next_attempt_at ?? 0) > Date.now()) continue;
      const id = request.implementation_id;
      const idea = this.store.get<Implementation>("implementations", id);
      if (idea?.pause || idea?.deletion) continue;
      const key = `specification-${request.specification_id}`;
      try {
        const existing = this.store.list<FactoryRun>("runs", id).find(run => run.idempotency_key === key);
        if (existing) {
          if (["accepted", "disconnected", "interrupted"].includes(existing.condition)) {
            const observed = await this.runtime.reconcile(existing.id);
            if (this.stopped) return;
            const uncertain = ["accepted", "disconnected", "interrupted"].includes(observed.condition);
            const attempts = uncertain ? (request.attempts ?? 0) + 1 : 0;
            this.store.put("automatic_planning", { ...request, condition: attempts >= 6 ? "blocked" : "started", run_id: existing.id, attempts, next_attempt_at: uncertain ? Date.now() + Math.min(30_000, 1000 * 2 ** attempts) : 0, reason: attempts >= 6 ? "Orchestrator execution remains uncertain after six observations; inspect its retained native identity" : observed.waiting_reason }, id);
          } else if (request.condition !== "started") this.store.put("automatic_planning", { ...request, condition: "started", run_id: existing.id, reason: null }, id);
          continue;
        }
        if (request.scope_hash !== this.workflow.planningScope(id)) throw new FactoryError("scope_changed", "The accepted execution scope changed; inspect it with the owner before planning", 409);
        if (this.workflow.questions(id).some(q => q.answer === null)) continue;
        const active = this.store.list<FactoryRun>("runs", id).filter(run => !["completed", "cancelled", "failed"].includes(run.condition));
        if (active.length) {
          const source = active.length === 1 && active[0]?.action === "to-spec" ? active[0] : null;
          if (!source) continue;
          const observed = await this.runtime.reconcile(source.id);
          if (this.stopped) return;
          if (observed.condition !== "ready") continue;
          await this.retain(source.id);
          if (this.stopped) return;
          await this.runtime.finishStep(source.id);
          if (this.stopped) return;
        }
        const result = await this.runtime.requestStart(id, { action: "implement-spec", idempotency_key: key }, "http://localhost");
        if (this.stopped) return;
        this.store.put("automatic_planning", { ...request, condition: "pane_id" in result ? "started" : result.condition === "blocked" ? "blocked" : "queued", run_id: "pane_id" in result ? result.id : null, attempts: 0, next_attempt_at: 0, reason: "reason" in result ? result.reason : result.waiting_reason }, id);
      } catch (error) {
        if (this.stopped) return;
        const current = this.store.get<Implementation>("implementations", id);
        if (!current || current.deletion) continue;
        if (current.pause || error instanceof FactoryError && error.code === "assignment_paused") {
          this.store.put("automatic_planning", { ...request, condition: "pending", reason: error instanceof FactoryError ? error.message : request.reason }, id);
          continue;
        }
        this.store.db.transaction(() => {
          const reason = error instanceof FactoryError ? error.message : "Automatic planning could not be verified; inspect the retained request";
          if (error instanceof FactoryError && error.code === "scope_changed") this.workflow.mutate(id, "questions", { question: `${reason} (Specification ${request.specification_id}). Which Specification and execution settings should govern the next attempt?` });
          const retry = error instanceof FactoryError && ["handoff_incomplete", "native_history_incomplete", "native_evidence_required", "machine_offline", "machine_disconnected"].includes(error.code);
          const attempts = retry ? (request.attempts ?? 0) + 1 : request.attempts ?? 0;
          this.store.put("automatic_planning", { ...request, condition: retry && attempts < 6 ? "pending" : "blocked", attempts, next_attempt_at: retry && attempts < 6 ? Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) : 0, reason: `${reason}${retry && attempts >= 6 ? "; automatic handoff recovery exhausted after six observations; inspect the preserved planning history" : ""}` }, id);
        }).immediate();
      }
    }
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
