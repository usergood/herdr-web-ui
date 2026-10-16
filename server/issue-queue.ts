import { latestImplementationAttempt, readyIssuePlanningStep } from "../shared/issue-queue.ts";
import type { FactoryEvent, FactoryRun, Implementation } from "../shared/factory.ts";
import type { ProjectGitHubSource } from "../shared/github-project.ts";
import type { IssueQueueEntry, ProjectQueuePolicy } from "../shared/issue-queue.ts";
import type { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";

/** Completed planning is reusable history; implementation attempts still require explicit Retry. */
export function issueExecutionAttempts(store: FactoryStore, id: string): FactoryRun[] {
  return store.list<FactoryRun>("runs", id).filter(run => run.action === "implement-spec" || !["completed", "failed", "cancelled"].includes(run.condition));
}

/** A paused contract never resumes: only an owner's confirmed Stop permits a new attempt. */
export function issueRetryAvailable(store: FactoryStore, run: FactoryRun | undefined): boolean {
  if (!run || run.implementation_completion_pending || run.implementation_completion) return false;
  return run.condition === "failed" || run.condition === "cancelled" && (!!run.issue_pause || store.get<{ rework_requested?: boolean }>("implementation_retirement", run.id)?.rework_requested === true) && store.list<FactoryEvent>("events", run.implementation_id).some(event => event.kind === "run_stopped" && (event.data as { run_id?: string } | null)?.run_id === run.id);
}

/** One eligibility result is shared by previews, source detail and the board. */
export function issueQueueEntry(store: FactoryStore, source: ProjectGitHubSource, policy: ProjectQueuePolicy, accountReady: boolean, retryRunId?: string, planningRunId?: string): IssueQueueEntry {
  const idea = store.get<Implementation>("implementations", source.implementation_id);
  const workflow = new FactoryWorkflow(store);
  const reasons: IssueQueueEntry["reasons"] = [];
  const reason = (code: string, detail = "") => reasons.push({ code, detail });
  if (source.publication_batch_id && store.get<{ dispatch_ready: boolean }>("github_issue_batches", source.publication_batch_id)?.dispatch_ready !== true) reason("planning_needs_you", "The whole issue batch awaits confirmed publication and dependency links.");
  if (!idea || idea.project_id !== source.project_id) reason("assignment_moved");
  if (idea?.archived_at) reason("assignment_archived");
  if (idea?.discard_requested_at || idea?.outcome === "discarded") reason("assignment_discarded");
  if (idea?.outcome !== "none" || idea?.stage === "done") reason("assignment_finished");
  const attempts = issueExecutionAttempts(store, source.implementation_id).filter(run => !(run.id === planningRunId && readyIssuePlanningStep(run)));
  const latest = latestImplementationAttempt(attempts);
  if (attempts.some(run => run.action !== "implement-spec") || latest && !(latest.id === retryRunId && issueRetryAvailable(store, latest))) reason("attempt_exists");
  if (!accountReady) reason("account_unavailable");
  for (const blocker of (source.readiness && "blockers" in source.readiness ? source.readiness.blockers : ["sync_required"])) reason("readiness_" + blocker);
  if (!source.planning) reason("planning_required");
  else if (source.planning.condition !== "prepared") reason(source.planning.condition === "needs_you" ? "planning_needs_you" : "planning_changed");
  const pending = workflow.questions(source.implementation_id).some(question => question.answer === null);
  if (pending && !reasons.some(reason => reason.code === "planning_needs_you")) reason("planning_needs_you");
  if (!source.dependencies?.complete || !source.dependencies.fresh) reason("dependencies_stale");
  for (const conflict of source.dependencies?.conflicts ?? []) reason("dependencies_conflict", conflict);
  for (const edge of source.dependencies?.edges ?? []) if (edge.blocker) reason("dependency_" + edge.blocker, `${edge.repository} #${edge.number}`);
  const eligible = reasons.length === 0;
  const lane = pending || source.planning?.condition === "needs_you" ? "needs_you" : idea?.stage === "running" || idea?.stage === "review" || idea?.stage === "done" ? idea.stage : eligible && policy.automatic_implementation ? "queued" : "inbox";
  return { source_id: source.id, implementation_id: source.implementation_id, number: source.number, title: source.current?.title ?? idea?.title ?? "", position: idea?.position ?? 0, eligible, lane, activity: idea?.activity, reasons };
}
