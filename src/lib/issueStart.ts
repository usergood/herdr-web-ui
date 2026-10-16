import type { FactoryDetail } from "../../shared/protocol.ts";
import type { IssueStartScope } from "../../shared/issue-admission.ts";

/** Both implementation controls use the displayed issue scope and eligibility. */
export function issueImplementationStart(detail: Pick<FactoryDetail, "github_sources">): { blocked: boolean; scope: IssueStartScope | undefined } {
  const source = detail.github_sources?.find(source => source.kind === "issue" && source.planning);
  const planning = source?.planning;
  return {
    blocked: !!source && (planning?.condition !== "prepared" || !source.intake?.eligible),
    scope: source && planning?.graph_hash ? { source_id: source.id, source_revision: source.revision, graph_hash: planning.graph_hash } : undefined,
  };
}
