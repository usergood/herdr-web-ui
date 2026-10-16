import type { ProjectGitHubSource, ProjectGitHubPolicy } from "./github-project.ts";
import type { ProjectReadinessPolicy } from "./github-readiness.ts";
import type { IssuePlanning } from "./issue-planning.ts";
import type { ProjectQueuePolicy } from "./issue-queue.ts";

/** Explicit owner Start of this displayed prepared scope; automation is separate. */
export interface IssueStartScope { source_id: string; source_revision: string; graph_hash: string }
export interface IssuePause {
  source_id: string; source_revision: string; requested_at: string;
  reason: "scope_changed" | "readiness_revoked" | "issue_closed";
}
export interface IssueAdmission {
  source: ProjectGitHubSource;
  planning: IssuePlanning;
  github_policy: ProjectGitHubPolicy;
  readiness_policy: ProjectReadinessPolicy;
  queue_policy: ProjectQueuePolicy;
  queue_revision: string;
}

/** Bounded current-view identity; the full frozen contract stays in lazy detail. */
export interface IssueAdmissionSummary {
  source: { id: string; revision: string; current?: { title: string } };
  planning: { authorization: { approval: { actor: { login: string } } } };
}
export function summarizeIssueAdmission(admitted: IssueAdmission | null | undefined): IssueAdmissionSummary | undefined {
  if (!admitted) return undefined;
  return { source: { id: admitted.source.id, revision: admitted.source.revision, ...(admitted.source.current ? { current: { title: admitted.source.current.title } } : {}) }, planning: { authorization: { approval: { actor: { login: admitted.planning.authorization.approval.actor.login } } } } };
}
