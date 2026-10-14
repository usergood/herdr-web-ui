import { randomUUID } from "node:crypto";
import type { FactoryProject, FactoryRun, FactorySettings, Implementation } from "../shared/factory.ts";
import type { ProjectGitHubOverview } from "../shared/github-project.ts";
import type { ProjectQueueOverview } from "../shared/project-queue.ts";
import type { ProjectGitHubSource } from "../shared/github-project.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";
import { factoryCapacity } from "./factory-capacity.ts";

type QueuePolicy = { id: string; revision: string; max_implementations: number; paused: boolean };
type RetryReceipt = { id: string; implementation_id: string; consumed_run_id: string | null };
type AdmissionHold = { id: string; approval_id: string; problem: string };

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
      const hold = this.store.get<AdmissionHold>("issue_admission_holds", idea.id);
      const stopped = this.store.list<FactoryRun>("runs", idea.id).filter(run => run.action === "implement-spec").at(-1);
      const ownerStopped = !!source?.readiness?.approval && stopped?.condition === "cancelled" && (stopped.manifest as { issue_scope?: { approval: { id: string } } }).issue_scope?.approval.id === source.readiness.approval.id;
      const problem = ownerStopped ? "Automatic implementation was stopped. Start another attempt explicitly." : hold?.approval_id === source?.readiness?.approval?.id ? hold?.problem ?? null : null;
      if (problem) reasons.push("admission_held");
      if (ownerStopped) reasons.push("implementation_stopped");
      if (["implementation_complete", "pr_open", "merged", "released"].includes(idea.outcome) || idea.delivery && ["merged", "released"].includes(idea.delivery.condition) || this.store.list<import("../shared/factory.ts").FactoryEvent>("events", idea.id).some(event => event.kind === "historical_completion_reconciled")) reasons.push("awaiting_delivery");
      if (source?.readiness?.approval?.plan.dependencies.length) {
        try { this.prerequisites(idea.id); } catch { reasons.push("dependency_unverified"); }
      }
      if (idea.discard_requested_at) reasons.push("assignment_discarded");
      if (paused) reasons.push("queue_paused");
      if (implementing.size >= effectiveLimit) reasons.push("project_capacity");
      if (capacity.implementations.size >= settings.max_implementations) reasons.push("assignment_capacity");
      if (capacity.agents >= settings.max_agents) reasons.push("agent_capacity");
      if (capacity.builds >= settings.max_builds) reasons.push("build_capacity");
      if (this.store.list<FactoryRun>("runs", idea.id).some(run => !["completed", "cancelled", "failed"].includes(run.condition))) reasons.push("implementation_owned");
      if (this.retryRequired(idea.id)) reasons.push("retry_required");
      return { implementation_id: idea.id, title: idea.title, priority: idea.position, eligible: reasons.length === 0, reasons, problem, failed_run_id: this.failedAttempt(idea.id)?.id ?? null };
    });
    return { project_id: id, revision: policy?.revision ?? null, max_implementations: policy?.max_implementations ?? 1, effective_limit: effectiveLimit, paused, capacity: { project_implementations: implementing.size, implementations: capacity.implementations.size, agents: capacity.agents, builds: capacity.builds, max_implementations: settings.max_implementations, max_agents: settings.max_agents, max_builds: settings.max_builds }, next_implementation_id: items.find(item => item.eligible)?.implementation_id ?? null, items };
  }
  holdAdmission(id: string, problem: string | null): void {
    if (!problem) { this.store.remove("issue_admission_holds", id); return; }
    const idea = this.store.get<Implementation>("implementations", id)!;
    const approval = idea.project_id ? this.issues(idea.project_id).sources.find(source => source.implementation_id === id)?.readiness?.approval : null;
    if (!approval) return;
    const prior = this.store.get<AdmissionHold>("issue_admission_holds", id);
    if (prior?.approval_id === approval.id && prior.problem === problem) return;
    this.store.put<AdmissionHold>("issue_admission_holds", { id, approval_id: approval.id, problem });
    this.store.event(id, "issue_admission_held", { reason: problem, approval_id: approval.id });
  }
  admissionProblem(id: string): string | null {
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea?.project_id) return null;
    try {
      const approval = this.issues(idea.project_id).sources.find(source => source.implementation_id === id)?.readiness?.approval;
      const hold = this.store.get<AdmissionHold>("issue_admission_holds", id);
      return approval && !approval.revoked_at && hold?.approval_id === approval.id ? hold.problem : null;
    } catch { return null; }
  }
  /** Delivery receipts cover the whole prerequisite, including Assignments still
   * awaiting a release. Closing an issue or accepting implementation is insufficient. */
  prerequisites(id: string): Implementation[] {
    const idea = this.store.get<Implementation>("implementations", id)!;
    const sources = this.store.list<ProjectGitHubSource>("github_sources");
    const source = sources.find(source => source.kind === "issue" && source.implementation_id === id);
    const plan = source ? this.issues(source.project_id).sources.find(item => item.id === source.id)?.readiness?.approval?.plan : null;
    const project = idea.project_id ? this.project(idea.project_id) : null;
    const branch = idea.delivery_scope?.branch ?? project?.delivery_branch ?? this.store.list<import("../shared/factory.ts").ProjectCheckout>("checkouts", idea.project_id ?? "").find(checkout => checkout.machine_id === (idea.machine_id ?? project?.machine_id))?.branch;
    return (plan?.dependencies ?? []).map(dependency => {
      const matches = sources.filter(item => item.kind === "issue" && item.repository?.toLowerCase() === dependency.repository.toLowerCase() && item.number === dependency.issue_number);
      const local = matches.filter(item => item.project_id === source?.project_id);
      const candidates = local.length ? local : matches;
      const prerequisite = candidates.length === 1 ? this.store.get<Implementation>("implementations", candidates[0]!.implementation_id) : null;
      const delivery = prerequisite?.delivery;
      const merged = delivery && delivery.repository.toLowerCase() === dependency.repository.toLowerCase() && ["merged", "released"].includes(delivery.condition) && delivery.checked_at && delivery.changes.length && delivery.pulls.length && delivery.changes.every(change => delivery.pulls.some(pull => pull.covered_paths.includes(change.path)));
      const satisfied = merged && (dependency.requires === "release"
        ? delivery.condition === "released" && delivery.release && delivery.pulls.every(pull => delivery.release!.merge_commits.includes(pull.merge_commit))
        : delivery.repository.toLowerCase() === source?.repository?.toLowerCase() && delivery.branch === branch);
      if (!satisfied || prerequisite?.outcome === "discarded" || prerequisite?.discard_requested_at) throw new FactoryError("dependency_unverified", "Wait for verified prerequisite changes in the target branch or the explicitly required released artifact", 409);
      return prerequisite!;
    });
  }
  assertAdmission(implementationId: string, continuing = false): void {
    const idea = this.store.get<Implementation>("implementations", implementationId);
    if (!idea?.project_id) return;
    const view = this.overview(idea.project_id);
    if (!continuing && view.paused) throw new FactoryError("queue_paused", "The Project queue is paused; accepted work continues", 409);
    if (!continuing && this.retryRequired(implementationId)) throw new FactoryError("retry_required", "The failed implementation attempt requires the owner's explicit Retry", 409);
    if (!continuing) this.prerequisites(implementationId);
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
