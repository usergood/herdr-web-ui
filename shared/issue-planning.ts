import type { FactoryRecord } from "./factory.ts";
import type { IssueReadinessApproval } from "./github-readiness.ts";

/** Planning authorization is provenance, never a synthetic owner approval receipt. */
export interface IssuePlanning extends FactoryRecord {
  implementation_id: string; source_id: string; source_revision: string;
  trusted_scope: import("./github-project.ts").ProjectGitHubIssueRevision;
  condition: "prepared" | "needs_you" | "stale";
  origin: "issue_body" | "app_plan"; content: string;
  dependencies: string; testing_seams: string;
  specification_id: string | null; graph_hash: string | null;
  question_ids: string[]; consumed_question_revision: string | null;
  app_approval_ids?: string[];
  authorization: { approval: IssueReadinessApproval; checks_required: true; independent_reviews: ["standards", "spec"] };
}
export interface PrepareIssuePlan { source_revision: string; question_revision?: string }
