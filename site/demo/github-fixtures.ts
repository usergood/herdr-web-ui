import type { ProjectPullRequest } from "../../shared/github-project.ts";
const info = { hasNextPage: false, endCursor: null };
/** Fictional data shared by browser fixtures, never a real repository or account. */
export const fictionalGitHubIssue = { number: 12, node_id: "fictional-issue-12", title: "Fictional GitHub ticket", body: "Keep review context with imported work.", html_url: "https://github.com/fictional/project/issues/12", state: "open", labels: [{ name: "needs-plan" }], updated_at: "2026-10-01T12:00:00Z" };
export const fictionalGitHubPull: ProjectPullRequest = {
  number: 27, id: "fictional-pr-27", title: "Fictional pending review", body: "An external contribution awaiting review.", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false,
  headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", baseRefName: "main", author: { login: "fictional-contributor" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: false,
  mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviews: { nodes: [], pageInfo: info }, reviewRequests: { nodes: [{ requestedReviewer: { login: "fictional-work" } }], pageInfo: info }, reviewThreads: { nodes: [], pageInfo: info },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Fast checks", conclusion: "SUCCESS", status: "COMPLETED" }], pageInfo: info } } } }] },
  baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } },
};
