import type { GitHubDependencyEdge, IssueDeliveryLink, ProjectGitHubSource } from "../shared/github-project.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { isJsonObject } from "./http.ts";
import { dependencyPlan } from "./issue-dependencies.ts";
import type { Implementation } from "../shared/factory.ts";

const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s~^:?*\[\\\x00-\x1f]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));

/** Issue delivery applies regardless of whether execution used guarded admission or ordinary Work. */
export function hasIssueSource(store: FactoryStore, implementationId: string): boolean {
  return store.list<ProjectGitHubSource>("github_sources").some(source => source.kind === "issue" && source.implementation_id === implementationId);
}

/** Both branch and release evidence must prove ancestry of the exact merge commit. */
function containsMerge(comparison: unknown, mergeCommit: string): boolean | null {
  if (!isJsonObject(comparison) || !isJsonObject(comparison.base_commit) || comparison.base_commit.sha !== mergeCommit
    || !isJsonObject(comparison.merge_base_commit) || !sha(comparison.merge_base_commit.sha)) return null;
  if (["ahead", "identical"].includes(String(comparison.status)) && comparison.merge_base_commit.sha === mergeCommit) return true;
  if (["behind", "diverged"].includes(String(comparison.status)) && comparison.merge_base_commit.sha !== mergeCommit) return false;
  return null;
}

export function coverageRevision(store: FactoryStore, projectId: string): string {
  // A failed fence outside sync (for example, owner readiness approval) also
  // invalidates dependency proofs previously certified from the old inventory.
  return hash(JSON.stringify(store.list<ProjectGitHubSource>("github_sources", projectId).filter(source => source.kind === "issue").map(source => [source.id, source.revision, dependencyPlan(store, source).revision, store.get<IssueDeliveryLink>("github_delivery_links", source.id)?.revision ?? null, source.readiness_evidence?.complete ?? null, source.readiness_evidence?.source_revision ?? null])));
}

/** Coverage survives metadata edits only along a proven, uninterrupted semantic history. */
export function deliveryScopeCurrent(store: FactoryStore, source: ProjectGitHubSource, link: IssueDeliveryLink): boolean {
  const current = source.current;
  const history = source.history ?? [];
  if (link.source_id !== source.id || !current?.native_dependencies || current.revision !== source.revision || store.get("github_delivery_scope_invalidations", link.revision)) return false;
  let anchor = -1;
  for (const [index, observed] of history.entries()) {
    if (observed.revision === link.source_revision && Date.parse(observed.fetched_at) <= Date.parse(link.created_at)) anchor = index;
  }
  // No inferred equivalence for legacy records without the linked observation.
  if (anchor < 0) return false;
  return [...history.slice(anchor), current].every(observed => !!observed.native_dependencies
    && (["title", "body", "state", "repository", "url", "native_dependencies"] as const).every(key => JSON.stringify(observed[key]) === JSON.stringify(current[key])));
}

/** Retain superseded proof as history, never as current Assignment completion. */
export function invalidateIssueDelivery(store: FactoryStore, source: ProjectGitHubSource, reason: "scope_changed" | "coverage_changed" = "scope_changed"): void {
  store.db.transaction(() => {
    const link = store.get<IssueDeliveryLink>("github_delivery_links", source.id);
    // Positive drift at a fallible collection fence may never be imported into
    // source history. Retire this link even if the next observation reverts it.
    if (reason === "scope_changed" && link) store.put("github_delivery_scope_invalidations", { id: link.revision, source_id: source.id }, source.implementation_id);
    const idea = store.get<Implementation>("implementations", source.implementation_id);
    if (idea?.delivery_evidence?.source_id !== source.id) return;
    const { delivery_evidence: evidence, ...retained } = idea;
    store.event(idea.id, "issue_delivery_invalidated", { source_id: source.id, evidence });
    store.put("implementations", { ...retained, ...(reason === "coverage_changed"
      ? { stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" }
      : { stage: "inbox", activity: undefined, outcome: "none" }) });
  })();
}

export function linkIssueDelivery(store: FactoryStore, source: ProjectGitHubSource, body: Record<string, unknown>): void {
  const prior = store.get<IssueDeliveryLink>("github_delivery_links", source.id);
  if (body.source_revision !== source.revision || body.expected_revision !== (prior?.revision ?? null)) throw new FactoryError("delivery_changed", "Refresh the issue and its intended coverage before linking delivery", 409);
  if (Object.keys(body).some(key => !["source_revision", "expected_revision", "target_branch", "intended_prs", "release_tag"].includes(key)) || !ref(body.target_branch) || body.release_tag !== null && !ref(body.release_tag) || !Array.isArray(body.intended_prs) || body.intended_prs.length > 50 || body.intended_prs.some(pull => !isJsonObject(pull) || !Number.isSafeInteger(pull.number) || (pull.number as number) < 1 || !sha(pull.head) || Object.keys(pull).some(key => !["number", "head"].includes(key))) || new Set(body.intended_prs.map(pull => pull.number)).size !== body.intended_prs.length) throw new FactoryError("invalid_delivery_link", "Select a target branch and the complete intended PR numbers and exact heads; a release tag is optional");
  const link: IssueDeliveryLink = { ...store.record(), source_id: source.id, source_revision: source.revision, revision: store.record().id, target_branch: body.target_branch, intended_prs: body.intended_prs as IssueDeliveryLink["intended_prs"], release_tag: body.release_tag as string | null };
  store.db.transaction(() => {
    invalidateIssueDelivery(store, source, "coverage_changed");
    store.put("github_sources", { ...source, delivery_requires: source.delivery_requires === "release" || body.release_tag ? "release" : "merge" }, source.project_id);
    store.put("github_delivery_links", { ...link, id: source.id }, source.project_id);
    store.put("github_delivery_link_versions", link, source.implementation_id);
    store.event(source.implementation_id, "issue_delivery_linked", { source_id: source.id, revision: link.revision });
  })();
}

/** GitHub is read-only here. Owner coverage records never substitute for merge evidence. */
export async function verifyIssueDelivery(store: FactoryStore, edge: GitHubDependencyEdge, target: ProjectGitHubSource, branch: string | null, api: (path: string) => Promise<unknown>): Promise<GitHubDependencyEdge & { contradicted?: "merge" | "release" }> {
  // The collection fence can invalidate the retained inventory revision. Its
  // incomplete scope observation blocks both own delivery and dependents, even
  // when an old coverage link still matches. Label eligibility is not required.
  const observation = target.readiness_evidence;
  if (observation && (!observation.complete || observation.source_revision !== target.revision)) return edge;
  const link = store.get<IssueDeliveryLink>("github_delivery_links", target.id);
  if (!branch || !link || !deliveryScopeCurrent(store, target, link) || !link.intended_prs.length) return edge;
  const branchProof = await api(`repos/${edge.repository}/branches/${encodeURIComponent(branch)}`);
  if (!isJsonObject(branchProof) || branchProof.name !== branch || !isJsonObject(branchProof.commit) || !sha(branchProof.commit.sha)) return edge;
  const merges: NonNullable<GitHubDependencyEdge["delivery"]>["merges"] = [];
  for (const intended of link.intended_prs) {
    const pull = await api(`repos/${edge.repository}/pulls/${intended.number}`);
    if (!isJsonObject(pull) || pull.number !== intended.number || pull.html_url !== `https://github.com/${edge.repository}/pull/${intended.number}` || pull.merged !== true || typeof pull.merged_at !== "string" || !Number.isFinite(Date.parse(pull.merged_at)) || !sha(pull.merge_commit_sha) || !isJsonObject(pull.head) || pull.head.sha !== intended.head || !isJsonObject(pull.base) || !isJsonObject(pull.base.repo) || typeof pull.base.repo.full_name !== "string" || pull.base.repo.full_name.toLowerCase() !== edge.repository.toLowerCase()) return edge;
    if (pull.base.ref !== branch || link.target_branch !== branch) return { ...edge, blocker: "wrong_target" };
    const comparison = await api(`repos/${edge.repository}/compare/${pull.merge_commit_sha}...${branchProof.commit.sha}`);
    const contained = containsMerge(comparison, pull.merge_commit_sha);
    if (contained !== true) return { ...edge, ...(contained === false ? { contradicted: "merge" as const } : {}) };
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
      const contained = containsMerge(comparison, merge.merge_commit);
      if (contained !== true) return { ...blocked, ...(contained === false ? { contradicted: "release" as const } : {}) };
    }
    return { ...edge, blocker: null, delivery: { ...delivered, release: { tag: link.release_tag, commit: releaseCommit, url: release.html_url, published_at: release.published_at } } };
  }
  return { ...edge, blocker: null, delivery: delivered };
}
