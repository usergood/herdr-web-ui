import type { FactoryRecord } from "./factory.ts";
export interface ProjectGitHubPolicy extends FactoryRecord {
  project_id: string; revision: string; project_scope: string; repository: string; account_profile_id: string;
  sync_enabled: boolean; import_issues: boolean; import_fixes: boolean; auto_update: boolean; auto_merge: boolean;
  trusted_reviewers: string[]; required_checks: string[]; review_context: string; poll_minutes: number;
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
/** A prerequisite returned by GitHub's native blocked_by relationship. */
export interface GitHubIssueDependency {
  external_id: string; repository: string; number: number; url: string;
  state: "open" | "closed"; source_updated_at: string;
}
export interface GitHubDependencyEdge extends GitHubIssueDependency {
  implementation_id: string | null; resolution: "resolved" | "missing" | "cyclic" | "cross_boundary" | "ambiguous";
  blocker: "delivery_unverified" | "missing" | "cyclic" | "cross_boundary" | "ambiguous";
}
/** A complete native relationship snapshot. Sync problems invalidate it for new admission. */
export interface GitHubDependencyEvidence {
  revision: string; source_revision: string; fetched_at: string;
  account_profile_id: string; policy_revision: string; complete: boolean; fresh: boolean;
  edges: GitHubDependencyEdge[];
}
/** One observed issue scope. Fetch evidence never participates in its content revision. */
export interface ProjectGitHubIssueRevision {
  revision: string; title: string; body: string; labels: string[]; state: "open" | "closed";
  source_updated_at: string; fetched_at: string; repository: string; url: string;
  account_profile_id: string; policy_revision: string;
  native_dependencies?: Pick<GitHubIssueDependency, "external_id" | "repository" | "number" | "url">[];
}
export interface ProjectGitHubSource extends FactoryRecord { project_id: string; external_id: string; number: number; kind: "issue" | "fix"; implementation_id: string; revision: string; url: string; state: string; readiness_evidence?: import("./github-readiness.ts").IssueReadinessEvidence; readiness_approvals?: import("./github-readiness.ts").IssueReadinessApproval[]; readiness?: import("./github-readiness.ts").IssueReadiness; current?: ProjectGitHubIssueRevision; history?: ProjectGitHubIssueRevision[]; dependencies?: GitHubDependencyEvidence }
export interface ProjectGitHubPull extends FactoryRecord { project_id: string; pull: ProjectPullRequest; blockers: string[]; observed_at: string; fix_implementation_id: string | null }
export interface ProjectGitHubMutation extends FactoryRecord { project_id: string; repository: string; pull_id: string; number: number; action: "merge" | "update" | "rerequest"; head: string; base: string; policy_revision: string; condition: "sending" | "confirmed" | "uncertain"; problem: string | null }
export interface ProjectGitHubOverview { policy: ProjectGitHubPolicy | null; readiness_policy?: import("./github-readiness.ts").ProjectReadinessPolicy | null; pulls: ProjectGitHubPull[]; sources: ProjectGitHubSource[]; mutations: ProjectGitHubMutation[]; last_sync: string | null; problem: string | null }
export interface ProjectGitHubFiles { head: string; base: string; files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[] }
export interface ProjectGitHubSettings { repository: string; default_branch: string; reviewers: string[]; required_checks: string[]; protected: boolean }
export type ProjectGitHubConfiguration = Omit<ProjectGitHubPolicy, keyof FactoryRecord | "project_id" | "revision" | "project_scope"> & { expected_revision: string | null };
