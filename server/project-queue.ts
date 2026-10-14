import { randomUUID } from "node:crypto";
import type { FactoryProject, FactoryRun, FactorySettings, Implementation } from "../shared/factory.ts";
import type { ProjectGitHubOverview } from "../shared/github-project.ts";
import type { ProjectQueueOverview } from "../shared/project-queue.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";
import { factoryCapacity } from "./factory-capacity.ts";

type QueuePolicy = { id: string; revision: string; max_implementations: number; paused: boolean };
type RetryReceipt = { id: string; implementation_id: string; consumed_run_id: string | null };

/** Queue selection shares the factory's record store and reservation owner. */
export class ProjectQueue {
  constructor(private readonly store: FactoryStore, private readonly settings: () => FactorySettings, private readonly issues: (id: string) => ProjectGitHubOverview) {}
  private project(id: string): FactoryProject {
    const project = this.store.get<FactoryProject>("projects", id);
    if (!project) throw new FactoryError("not_found", "Project not found", 404);
    if (project.removed_at) throw new FactoryError("project_removed", "Restore this Project before controlling its queue", 409);
    return project;
  }
  private maximum(): number { const settings = this.settings(); return Math.min(settings.max_implementations, settings.max_agents, settings.max_builds); }
  overview(id: string): ProjectQueueOverview {
    this.project(id);
    const policy = this.store.get<QueuePolicy>("project_queues", id);
    const sources = this.issues(id).sources.filter(source => source.kind === "issue");
    const paused = policy?.paused ?? false;
    const settings = this.settings();
    const capacity = factoryCapacity(this.store);
    const projectRuns = this.store.list<FactoryRun>("runs").filter(run => (run.manifest as { project?: FactoryProject }).project?.id === id && ["work", "implement-spec"].includes(run.action));
    const implementing = new Set(projectRuns.filter(run => capacity.implementing.has(run.implementation_id)).map(run => run.implementation_id));
    const effectiveLimit = Math.min(policy?.max_implementations ?? 1, this.maximum());
    const items = this.store.list<Implementation>("implementations").filter(idea => idea.project_id === id && !idea.archived_at && idea.stage !== "done").sort((a, b) => a.position - b.position).map(idea => {
      const source = sources.find(entry => entry.implementation_id === idea.id);
      const reasons: string[] = [...(source?.readiness?.reasons ?? ["planning_required"])];
      if (["implementation_complete", "pr_open", "merged", "released"].includes(idea.outcome) || this.store.list<import("../shared/factory.ts").FactoryEvent>("events", idea.id).some(event => event.kind === "historical_completion_reconciled")) reasons.push("awaiting_delivery");
      // Unavailable delivery evidence cannot satisfy an approved prerequisite.
      if (source?.readiness?.approval?.plan.dependencies.length) reasons.push("dependency_unverified");
      if (paused) reasons.push("queue_paused");
      if (implementing.size >= effectiveLimit) reasons.push("project_capacity");
      if (capacity.implementations.size >= settings.max_implementations) reasons.push("assignment_capacity");
      if (capacity.agents >= settings.max_agents) reasons.push("agent_capacity");
      if (capacity.builds >= settings.max_builds) reasons.push("build_capacity");
      if (this.store.list<FactoryRun>("runs", idea.id).some(run => !["completed", "cancelled", "failed"].includes(run.condition))) reasons.push("implementation_owned");
      if (this.retryRequired(idea.id)) reasons.push("retry_required");
      return { implementation_id: idea.id, title: idea.title, priority: idea.position, eligible: reasons.length === 0, reasons, failed_run_id: this.failedAttempt(idea.id)?.id ?? null };
    });
    return { project_id: id, revision: policy?.revision ?? null, max_implementations: policy?.max_implementations ?? 1, effective_limit: effectiveLimit, paused, capacity: { project_implementations: implementing.size, implementations: capacity.implementations.size, agents: capacity.agents, builds: capacity.builds, max_implementations: settings.max_implementations, max_agents: settings.max_agents, max_builds: settings.max_builds }, next_implementation_id: items.find(item => item.eligible)?.implementation_id ?? null, items };
  }
  assertAdmission(implementationId: string, continuing = false): void {
    const idea = this.store.get<Implementation>("implementations", implementationId);
    if (!idea?.project_id) return;
    const view = this.overview(idea.project_id);
    if (!continuing && view.paused) throw new FactoryError("queue_paused", "The Project queue is paused; accepted work continues", 409);
    if (!continuing && this.retryRequired(implementationId)) throw new FactoryError("retry_required", "The failed implementation attempt requires the owner's explicit Retry", 409);
    const own = factoryCapacity(this.store).implementing.has(implementationId) ? 1 : 0;
    if (continuing && own) return;
    if (view.capacity.project_implementations - own >= view.effective_limit) throw new FactoryError("project_capacity_exhausted", "The Project's implementing Assignment limit is reserved; reconcile accepted work before starting more", 409);
  }
  private failedAttempt(id: string): FactoryRun | undefined {
    const run = this.store.list<FactoryRun>("runs", id).filter(entry => ["work", "implement-spec"].includes(entry.action)).at(-1);
    return run?.condition === "failed" ? run : undefined;
  }
  private retryRequired(id: string): boolean {
    const failed = this.failedAttempt(id);
    return !!failed && (!this.store.get<RetryReceipt>("queue_retries", failed.id) || this.store.get<RetryReceipt>("queue_retries", failed.id)?.consumed_run_id !== null);
  }
  retry(id: string, body: Record<string, unknown>): ProjectQueueOverview {
    return this.store.db.transaction(() => {
      const idea = this.store.get<Implementation>("implementations", id);
      const failed = this.failedAttempt(id);
      if (!idea?.project_id || idea.archived_at || !failed || body.run_id !== failed.id) throw new FactoryError("retry_changed", "Select the current failed implementation attempt before Retry", 409);
      const runs = this.store.list<FactoryRun>("runs", id);
      const runIds = new Set(runs.map(run => run.id));
      if (runs.some(run => !["completed", "cancelled", "failed"].includes(run.condition)) || this.store.list<import("../shared/factory.ts").FactoryWorker>("workers").some(worker => runIds.has(worker.run_id) && !["completed", "cancelled", "failed"].includes(worker.condition)) || this.store.list<import("../shared/factory.ts").FactoryCheck>("checks").some(check => runIds.has(check.run_id) && ["working", "interrupted"].includes(check.condition))) throw new FactoryError("implementation_owned", "Reconcile retained work before authorizing another attempt", 409);
      this.project(idea.project_id);
      if (!this.store.get("queue_retries", failed.id)) {
        this.store.put<RetryReceipt>("queue_retries", { id: failed.id, implementation_id: id, consumed_run_id: null }, id);
        this.store.event(id, "implementation_retry_requested", { run_id: failed.id });
      }
      return this.overview(idea.project_id);
    }).immediate();
  }
  consumeRetry(id: string, nextRunId: string): void {
    const failed = this.failedAttempt(id);
    const receipt = failed ? this.store.get<RetryReceipt>("queue_retries", failed.id) : null;
    if (receipt) this.store.put("queue_retries", { ...receipt, consumed_run_id: nextRunId }, id);
  }
  configure(id: string, body: Record<string, unknown>): ProjectQueueOverview {
    return this.store.db.transaction(() => {
      const current = this.overview(id);
      if (body.expected_revision !== current.revision) throw new FactoryError("queue_changed", "Refresh the Project queue before saving", 409);
      if (!Number.isSafeInteger(body.max_implementations) || Number(body.max_implementations) < 1 || Number(body.max_implementations) > this.maximum() && body.max_implementations !== current.max_implementations || typeof body.paused !== "boolean") throw new FactoryError("invalid_queue", "Select a positive Project limit within global Assignment, agent and build limits and an explicit pause setting");
      this.store.put("project_queues", { id, revision: randomUUID(), max_implementations: Number(body.max_implementations), paused: body.paused }, id);
      this.store.event(null, "project_queue_configured", { project_id: id, max_implementations: body.max_implementations, paused: body.paused });
      return this.overview(id);
    }).immediate();
  }
}
