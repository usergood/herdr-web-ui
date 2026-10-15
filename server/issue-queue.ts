import type { FactoryRun, Implementation } from "../shared/factory.ts";
import type { ProjectGitHubSource } from "../shared/github-project.ts";
import type { IssueQueueEntry, ProjectQueuePolicy } from "../shared/issue-queue.ts";
import type { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";

/** One eligibility result is shared by previews, source detail and the board. */
export function issueQueueEntry(store: FactoryStore, source: ProjectGitHubSource, policy: ProjectQueuePolicy, accountReady: boolean, retryRunId?: string): IssueQueueEntry {
  const idea = store.get<Implementation>("implementations", source.implementation_id);
  const workflow = new FactoryWorkflow(store);
  const reasons: IssueQueueEntry["reasons"] = [];
  const reason = (code: string, detail = "") => reasons.push({ code, detail });
  if (!idea || idea.project_id !== source.project_id) reason("assignment_moved");
  if (idea?.archived_at) reason("assignment_archived");
  if (idea?.outcome !== "none" || idea?.stage === "done") reason("assignment_finished");
  const attempts = store.list<FactoryRun>("runs", source.implementation_id);
  const latest = attempts.at(-1);
  if (attempts.length && !(latest?.id === retryRunId && latest?.condition === "failed")) reason("attempt_exists");
  if (!accountReady) reason("account_unavailable");
  for (const blocker of source.readiness?.blockers ?? ["sync_required"]) reason("readiness_" + blocker);
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
