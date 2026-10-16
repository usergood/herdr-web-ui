/** Fictional read-only GitHub proofs for the owned public HTTP/browser fixtures. */
export function githubDeliveryResponses({ merged = true, targetBranch = "main", containsRelease = true } = {}): Record<string, unknown> {
  const comparison = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } };
  return {
    "repos/fictional/project/branches/main": { name: "main", commit: { sha: "f".repeat(40) } },
    "repos/fictional/project/pulls/27": { number: 27, html_url: "https://github.com/fictional/project/pull/27", merged, merged_at: "2026-10-03T12:00:00Z", merge_commit_sha: "c".repeat(40), head: { sha: "a".repeat(40) }, base: { ref: targetBranch, repo: { full_name: "fictional/project" } } },
    ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "f".repeat(40)]: comparison,
    "repos/fictional/project/releases/tags/v1": { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: false, published_at: "2026-10-04T12:00:00Z" },
    "repos/fictional/project/git/ref/tags/v1": { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } },
    ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "d".repeat(40)]: { ...comparison, status: containsRelease ? "ahead" : "behind" },
  };
}
