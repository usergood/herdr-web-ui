import type { GitHubDependencyEdge, IssueDeliveryLink, ProjectGitHubSource } from "../shared/github-project.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { isJsonObject } from "./http.ts";
import { dependencyPlan } from "./issue-dependencies.ts";

const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s~^:?*\[\\\x00-\x1f]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));

export function coverageRevision(store: FactoryStore, projectId: string): string {
  return hash(JSON.stringify(store.list<ProjectGitHubSource>("github_sources", projectId).filter(source => source.kind === "issue").map(source => [source.id, source.revision, dependencyPlan(store, source).revision, store.get<IssueDeliveryLink>("github_delivery_links", source.id)?.revision ?? null])));
}

export function linkIssueDelivery(store: FactoryStore, source: ProjectGitHubSource, body: Record<string, unknown>): void {
  const prior = store.get<IssueDeliveryLink>("github_delivery_links", source.id);
  if (body.source_revision !== source.revision || body.expected_revision !== (prior?.revision ?? null)) throw new FactoryError("delivery_changed", "Refresh the issue and its intended coverage before linking delivery", 409);
  if (Object.keys(body).some(key => !["source_revision", "expected_revision", "target_branch", "intended_prs", "release_tag"].includes(key)) || !ref(body.target_branch) || body.release_tag !== null && !ref(body.release_tag) || !Array.isArray(body.intended_prs) || body.intended_prs.length > 50 || body.intended_prs.some(pull => !isJsonObject(pull) || !Number.isSafeInteger(pull.number) || (pull.number as number) < 1 || !sha(pull.head) || Object.keys(pull).some(key => !["number", "head"].includes(key))) || new Set(body.intended_prs.map(pull => pull.number)).size !== body.intended_prs.length) throw new FactoryError("invalid_delivery_link", "Select a target branch and the complete intended PR numbers and exact heads; a release tag is optional");
  const link: IssueDeliveryLink = { ...store.record(), source_id: source.id, source_revision: source.revision, revision: store.record().id, target_branch: body.target_branch, intended_prs: body.intended_prs as IssueDeliveryLink["intended_prs"], release_tag: body.release_tag as string | null };
  store.db.transaction(() => {
    store.put("github_sources", { ...source, delivery_requires: source.delivery_requires === "release" || body.release_tag ? "release" : "merge" }, source.project_id);
    store.put("github_delivery_links", { ...link, id: source.id }, source.project_id);
    store.put("github_delivery_link_versions", link, source.implementation_id);
    store.event(source.implementation_id, "issue_delivery_linked", { source_id: source.id, revision: link.revision });
  })();
}

/** GitHub is read-only here. Owner coverage records never substitute for merge evidence. */
export async function verifyIssueDelivery(store: FactoryStore, edge: GitHubDependencyEdge, target: ProjectGitHubSource, branch: string | null, api: (path: string) => Promise<unknown>): Promise<GitHubDependencyEdge> {
  const link = store.get<IssueDeliveryLink>("github_delivery_links", target.id);
  if (!branch || !link || link.source_revision !== target.revision || !link.intended_prs.length) return edge;
  const branchProof = await api(`repos/${edge.repository}/branches/${encodeURIComponent(branch)}`);
  if (!isJsonObject(branchProof) || branchProof.name !== branch || !isJsonObject(branchProof.commit) || !sha(branchProof.commit.sha)) return edge;
  const merges: NonNullable<GitHubDependencyEdge["delivery"]>["merges"] = [];
  for (const intended of link.intended_prs) {
    const pull = await api(`repos/${edge.repository}/pulls/${intended.number}`);
    if (!isJsonObject(pull) || pull.number !== intended.number || pull.html_url !== `https://github.com/${edge.repository}/pull/${intended.number}` || pull.merged !== true || typeof pull.merged_at !== "string" || !Number.isFinite(Date.parse(pull.merged_at)) || !sha(pull.merge_commit_sha) || !isJsonObject(pull.head) || pull.head.sha !== intended.head || !isJsonObject(pull.base) || !isJsonObject(pull.base.repo) || typeof pull.base.repo.full_name !== "string" || pull.base.repo.full_name.toLowerCase() !== edge.repository.toLowerCase()) return edge;
    if (pull.base.ref !== branch || link.target_branch !== branch) return { ...edge, blocker: "wrong_target" };
    const comparison = await api(`repos/${edge.repository}/compare/${pull.merge_commit_sha}...${branchProof.commit.sha}`);
    if (!isJsonObject(comparison) || !["ahead", "identical"].includes(String(comparison.status)) || !isJsonObject(comparison.base_commit) || comparison.base_commit.sha !== pull.merge_commit_sha || !isJsonObject(comparison.merge_base_commit) || comparison.merge_base_commit.sha !== pull.merge_commit_sha) return edge;
    merges.push({ number: intended.number, url: pull.html_url, head: intended.head, merge_commit: pull.merge_commit_sha, target_branch: branch });
  }
  const delivered = { coverage_revision: link.revision, merges };
  if (edge.requires === "release") {
    const blocked = { ...edge, blocker: "release_unverified" as const, delivery: delivered };
    if (!link.release_tag) return blocked;
    const release = await api(`repos/${edge.repository}/releases/tags/${encodeURIComponent(link.release_tag)}`);
    if (!isJsonObject(release) || release.tag_name !== link.release_tag || release.html_url !== `https://github.com/${edge.repository}/releases/tag/${link.release_tag}` || release.draft !== false || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) return blocked;
    const tagRef = await api(`repos/${edge.repository}/git/ref/tags/${encodeURIComponent(link.release_tag)}`);
    if (!isJsonObject(tagRef) || tagRef.ref !== `refs/tags/${link.release_tag}` || !isJsonObject(tagRef.object)) return blocked;
    let object = tagRef.object;
    for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
      if (!sha(object.sha)) return blocked;
      const annotated = await api(`repos/${edge.repository}/git/tags/${object.sha}`);
      if (!isJsonObject(annotated) || annotated.sha !== object.sha || !isJsonObject(annotated.object)) return blocked;
      object = annotated.object;
    }
    if (object.type !== "commit" || !sha(object.sha)) return blocked;
    const releaseCommit = object.sha;
    for (const merge of merges) {
      const comparison = await api(`repos/${edge.repository}/compare/${merge.merge_commit}...${releaseCommit}`);
      if (!isJsonObject(comparison) || !["ahead", "identical"].includes(String(comparison.status)) || !isJsonObject(comparison.base_commit) || comparison.base_commit.sha !== merge.merge_commit || !isJsonObject(comparison.merge_base_commit) || comparison.merge_base_commit.sha !== merge.merge_commit) return blocked;
    }
    return { ...edge, blocker: null, delivery: { ...delivered, release: { tag: link.release_tag, commit: releaseCommit, url: release.html_url, published_at: release.published_at } } };
  }
  return { ...edge, blocker: null, delivery: delivered };
}
