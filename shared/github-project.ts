import type { FactoryRecord } from "./factory.ts";
export const PROJECT_TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;
export type ProjectTriageRole = typeof PROJECT_TRIAGE_ROLES[number];
export type ProjectTriageLabels = Partial<Record<ProjectTriageRole, string>>;
export interface ProjectGitHubPolicy extends FactoryRecord {
  project_id: string; revision: string; project_scope: string; repository: string; account_profile_id: string;
  sync_enabled: boolean; import_issues: boolean; import_fixes: boolean; auto_update: boolean; auto_merge: boolean;
  trusted_reviewers: string[]; required_checks: string[]; review_context: string; poll_minutes: number;
  /** Omitted fields on older records inherit defaults; these gates never follow PR merge policy. */
  triage_labels?: ProjectTriageLabels; auto_implement?: boolean; trusted_issue_approvers?: string[];
}
export interface GitHubConnection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
export interface ProjectPullRequest {
  number: number; id: string; title: string; body: string; url: string; state: string; isDraft: boolean;
  headRefOid: string; baseRefOid: string; headRefName: string; baseRefName: string;
  author: { login: string } | null; mergeStateStatus: string; reviewDecision: string | null;
  headRepository: { nameWithOwner: string } | null; viewerCanUpdate: boolean;
  reviews: GitHubConnection<{ id: string; state: string; body: string; submittedAt: string | null; author: { login: string } | null; commit: { oid: string } | null }>;
  reviewRequests: GitHubConnection<{ requestedReviewer: { login?: string; name?: string } | null }>;
  reviewThreads: GitHubConnection<{ id: string; isResolved: boolean; isOutdated: boolean; comments: GitHubConnection<{ body: string; path: string; author: { login: string } | null }> }>;
  commits: { nodes: { commit: { statusCheckRollup: { contexts: GitHubConnection<{ name?: string; context?: string; conclusion?: string | null; status?: string; state?: string }> } | null } }[] };
  baseRef: { branchProtectionRule: { isAdminEnforced: boolean; requiresApprovingReviews: boolean; requiredApprovingReviewCount: number; requiresStatusChecks: boolean; requiresStrictStatusChecks: boolean; requiresConversationResolution: boolean; requiredStatusCheckContexts: string[] } | null } | null;
}
export type IssueReadinessReason = "start_planning" | "human_only" | "wontfix" | "conflicting_triage" | "approval_required" | "automatic_implementation_disabled" | "issue_closed" | "batch_incomplete";
/** Trusted GitHub readiness reads one fenced `saurons-eye-readiness` JSON block in a native issue
 * comment: { issue_revision, plan }. Only the selected verified owner account or a configured
 * approver can grant readiness. Edited comments use the native editor identity, failing closed when
 * it is unavailable. The digest covers repository/issue identity, title, body, labels and
 * state. Comment timestamps are not scope approval. Empty dependency/decision arrays are explicit;
 * testing_seams must contain confirmed boundaries. The public API reports the digest to approve.
 */
export interface ProjectIssuePlan {
  acceptance_criteria: string;
  dependencies: { repository: string; issue_number: number; requires: "merge" | "release" }[];
  testing_seams: string[]; planning_decisions: string[];
}
export interface ProjectIssueApproval extends FactoryRecord {
  source_id: string; issue_revision: string; policy_revision: string; actor: string;
  origin: "owner" | "github_comment"; evidence_id: string | null; plan: ProjectIssuePlan;
}
export interface ProjectIssueApprovalRequest { issue_revision: string; policy_revision: string; plan: ProjectIssuePlan }
export interface ProjectIssueReadiness { eligible: boolean; reasons: IssueReadinessReason[]; approval: ProjectIssueApproval | null }
export interface ProjectGitHubSource extends FactoryRecord {
  project_id: string; external_id: string; number: number; kind: "issue" | "fix"; implementation_id: string; revision: string; url: string; state: string;
  repository?: string; issue?: { title: string; body: string; updated_at: string | null; labels: string[] };
  triage_roles?: ProjectTriageRole[]; readiness?: ProjectIssueReadiness;
  publication_batch_id?: string; batch_item_key?: string; originating_plan_id?: string;
}
export interface ProjectGitHubPull extends FactoryRecord { project_id: string; pull: ProjectPullRequest; blockers: string[]; observed_at: string; fix_implementation_id: string | null }
export interface ProjectGitHubMutation extends FactoryRecord { project_id: string; repository: string; pull_id: string; number: number; action: "merge" | "update" | "rerequest"; head: string; base: string; policy_revision: string; condition: "sending" | "confirmed" | "uncertain"; problem: string | null }
export interface ProjectGitHubOverview { policy: ProjectGitHubPolicy | null; pulls: ProjectGitHubPull[]; sources: ProjectGitHubSource[]; mutations: ProjectGitHubMutation[]; last_sync: string | null; problem: string | null }
export interface ProjectGitHubFiles { head: string; base: string; files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[] }
export interface ProjectGitHubSettings { repository: string; default_branch: string; reviewers: string[]; required_checks: string[]; protected: boolean }
export type ProjectGitHubConfiguration = Omit<ProjectGitHubPolicy, keyof FactoryRecord | "project_id" | "revision" | "project_scope"> & { expected_revision: string | null };
