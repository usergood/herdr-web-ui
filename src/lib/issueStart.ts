import { readyIssuePlanningStep } from "../../shared/issue-queue.ts";
import type { FactoryDetail } from "../../shared/protocol.ts";
import type { IssueStartScope } from "../../shared/issue-admission.ts";

/** Both implementation controls use the displayed issue scope and eligibility. */
export function issueImplementationStart(detail: Pick<FactoryDetail, "github_sources" | "runs">): { blocked: boolean; scope: IssueStartScope | undefined } {
  const source = detail.github_sources?.find(source => source.kind === "issue" && source.planning);
  const planning = source?.planning;
  const owned = detail.runs.filter(run => !["completed", "failed", "cancelled"].includes(run.condition));
  const continuing = owned.length === 1 && readyIssuePlanningStep(owned[0]) && !detail.runs.some(run => run.action === "implement-spec")
    && source?.intake?.reasons.length === 1 && source.intake.reasons[0]?.code === "attempt_exists";
  return {
    blocked: !!source && (planning?.condition !== "prepared" || !source.intake?.eligible && !continuing),
    scope: source && planning?.graph_hash ? { source_id: source.id, source_revision: source.revision, graph_hash: planning.graph_hash } : undefined,
  };
}
