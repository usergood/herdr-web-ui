import type { AccountBindingSnapshot } from "../shared/accounts.ts";
import type { FactoryCheck, FactoryHumanApproval, FactoryMergeResult, FactoryProject, FactoryPullRequest, FactoryReviewEvidence, FactoryRun, FactoryWorker } from "../shared/factory.ts";
import type { ProjectGitHubPolicy } from "../shared/github-project.ts";
import type { MachineAccounts } from "./accounts.ts";
import { FactoryError, git } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
interface Pull {
  author?: { login: string } | null;
  number: number; url: string; state: string; isDraft: boolean; headRefOid: string; headRefName: string; baseRefName: string;
  headRepository: { nameWithOwner: string }; baseRepository: { nameWithOwner: string };
  merged: boolean; mergeCommit: { oid: string } | null; mergeStateStatus: string; reviewDecision: string | null;
  reviews: Connection<{ state: string; author: { login: string } | null; commit: { oid: string } | null; submittedAt: string }>;
  reviewThreads: Connection<{ isResolved: boolean }>; reviewRequests: Connection<unknown>;
  commits: Connection<{ commit: { statusCheckRollup: { contexts: Connection<{ name?: string; context?: string; state?: string; status?: string; conclusion?: string }> } | null } }>;
  baseRef?: { branchProtectionRule?: { isAdminEnforced: boolean; requiredApprovingReviewCount: number; requiredStatusCheckContexts?: string[] } | null };
}
interface Intent { id: string; approval: FactoryHumanApproval; pr: FactoryPullRequest; condition: "prepared" | "sending" | "verified"; merge_sha?: string }
const fields = `author { login } number url state isDraft headRefOid headRefName baseRefName headRepository { nameWithOwner } baseRepository { nameWithOwner } merged mergeCommit { oid } mergeStateStatus reviewDecision baseRef { branchProtectionRule { isAdminEnforced requiredApprovingReviewCount requiredStatusCheckContexts } }
reviews(first:100) { nodes { state author { login } commit { oid } submittedAt } pageInfo { hasNextPage } }
reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage } }
reviewRequests(first:100) { nodes { __typename } pageInfo { hasNextPage } }
commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } pageInfo { hasNextPage } } } } } pageInfo { hasNextPage } }`;

/** A sent merge is observed after restart; its mutation is never replayed. */
export class FactoryMerge {
  private stopped = false;
  stop(): void { this.stopped = true; }
  private readonly busy = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly accounts: MachineAccounts | undefined, private readonly head: (id: string) => Promise<{ head: string; workspace_hash: string }>, private readonly observe: (id: string) => Promise<FactoryRun>) {}
  async merge(id: string, body: Record<string, unknown>): Promise<FactoryMergeResult> {
    if (this.busy.has(id)) throw new FactoryError("merge_busy", "This candidate's merge is already being reconciled", 409);
    this.busy.add(id);
    try { return await this.perform(id, body); } finally { this.busy.delete(id); }
  }
  private async perform(id: string, body: Record<string, unknown>): Promise<FactoryMergeResult> {
    const run = await this.observe(id);
    const frozen = run.manifest as { project?: FactoryProject; account_snapshot?: AccountBindingSnapshot; github_policy?: ProjectGitHubPolicy | null };
    const policy = frozen.project?.pull_request;
    const approval = body.approval as FactoryHumanApproval | undefined;
    const pr = body.pull_request as FactoryPullRequest | undefined;
    const publication = pr ? this.store.get<FactoryPullRequest & { condition: string }>("host_publications", `${id}:${pr.head}`) : null;
    if (!this.accounts || !policy || !frozen.account_snapshot || run.action !== "implement-spec" || !run.worktree || !run.branch || run.condition !== "ready") throw new FactoryError("merge_unconfigured", "Merge requires a resting owned Run, frozen destination and verified GitHub account", 409);
    if (!approval || approval.provenance?.kind !== "owner_button" || !approval.provenance.origin || approval.run_id !== id || approval.implementation_id !== run.implementation_id || approval.head !== body.head || !approval.snapshot_id || !approval.review_id || !pr || pr.run_id !== id || pr.head !== body.head || pr.repository !== policy.repository || pr.base_branch !== policy.base_branch || pr.branch !== run.branch || !publication || publication.condition !== "published" || publication.number !== pr.number || publication.head !== pr.head || publication.repository !== pr.repository || publication.base_branch !== pr.base_branch || publication.branch !== pr.branch || pr.url !== `https://github.com/${policy.repository}/pull/${pr.number}`) throw new FactoryError("merge_authority_changed", "Owner authority must match the exact published candidate and frozen target", 409);
    const check = this.store.list<FactoryCheck>("host_checks", id).filter(c => c.worker_id === null).at(-1);
    const reports = Array.isArray(body.reports) ? body.reports.map(r => r && typeof r.worker_id === "string" ? this.store.get<FactoryReviewEvidence>("host_review_evidence", r.worker_id) : null) : [];
    const latestReports = this.store.list<FactoryReviewEvidence>("host_review_evidence", id);
    const recipes = [...frozen.project?.setup ?? [], ...frozen.project?.checks ?? []];
    if (!check || check.id !== body.check_id || check.id !== pr.check_id || check.run_id !== id || check.worker_id !== null || check.condition !== "passed" || check.head !== pr.head || check.workspace_hash !== body.workspace_hash || !recipes.length || JSON.stringify(check.commands.map(c => c.args)) !== JSON.stringify(recipes) || check.commands.some(c => c.exit_code !== 0) || reports.length !== 2 || reports[0]?.worker_id === reports[1]?.worker_id || !["standards", "spec"].every(axis => reports.some((r, i) => r?.worker_id === latestReports.filter(latest => latest.axis === axis).at(-1)?.worker_id && r?.axis === axis && r.run_id === id && r.head === pr.head && r.outcome === "passed" && r.source_id === (body.reports as { source_id: string }[])[i]?.source_id))) throw new FactoryError("fresh_evidence_required", "Merge requires the Machine's matching passing checks and independent Standards and Spec reports", 409);
    const assertLive = () => {
      if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping; retain the merge intent for reconciliation", 409);
      const lease = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", id);
      if (!lease || lease.closing || lease.run.suspension || this.store.get("host_delete_requests", id)) throw new FactoryError("run_stopping", "Pause or Delete stopped this merge operation", 409);
      const latestCheck = this.store.list<FactoryCheck>("host_checks", id).filter(c => c.worker_id === null).at(-1);
      const currentReports = this.store.list<FactoryReviewEvidence>("host_review_evidence", id);
      if (!latestCheck || latestCheck.id !== check.id || latestCheck.condition !== "passed" || latestCheck.head !== pr.head || latestCheck.workspace_hash !== check.workspace_hash || !["standards", "spec"].every(axis => {
        const expected = reports.find(r => r?.axis === axis);
        const current = currentReports.filter(r => r.axis === axis).at(-1);
        return current?.worker_id === expected?.worker_id && current?.source_id === expected?.source_id && current?.head === pr.head && current?.outcome === "passed";
      })) throw new FactoryError("fresh_evidence_required", "The checked evidence changed during merge reconciliation", 409);
      if (this.store.list<FactoryWorker>("host_workers", id).some(w => !["completed", "cancelled", "failed"].includes(w.condition))) throw new FactoryError("writers_active", "Quiesce all owned workers before merging", 409);
    };
    const assertCurrent = async () => {
      assertLive();
      const current = await this.head(id);
      if (current.head !== pr.head || current.workspace_hash !== check.workspace_hash) throw new FactoryError("review_stale", "The checked workspace changed; capture and review the current candidate", 409);
      const origin = (await git(run.worktree!, ["config", "--get", "remote.origin.url"])).trim();
      if (![ `https://github.com/${policy.repository}`, `https://github.com/${policy.repository}.git`, `git@github.com:${policy.repository}.git`, `ssh://git@github.com/${policy.repository}.git` ].includes(origin)) throw new FactoryError("merge_target_changed", "The owned checkout no longer matches the frozen repository", 409);
      const tracked = await git(run.worktree!, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      const untracked = (await git(run.worktree!, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(n => n && !n.startsWith(".saurons-eye-") && n !== ".opencode/agents/saurons-eye.md" && !/^(\.agents|\.claude|\.opencode)\/skills\//.test(n));
      if (tracked || untracked.length) throw new FactoryError("dirty_integration", "Commit and review workspace changes before merging", 409);
      assertLive();
    };
    await assertCurrent();
    const key = `${id}:${pr.head}`;
    let intent = this.store.get<Intent>("host_merges", key);
    if (intent && (intent.approval.id !== approval.id || JSON.stringify(intent.pr) !== JSON.stringify(pr))) {
      if (intent.condition !== "prepared") throw new FactoryError("merge_authority_changed", "A different retained approval owns this merge", 409);
      // A checked no-op repair may retain the head while explicit owner authority
      // changes. Only a positively unsent intent can adopt the validated request.
      intent = { id: key, approval, pr, condition: "prepared" };
    }
    intent ??= { id: key, approval, pr, condition: "prepared" };
    this.store.put("host_merges", intent, id);
    const api = async (path: string, args: string[] = [], guard = assertLive) => { const value = await this.accounts!.github(frozen.account_snapshot!, ["api", path, ...args], guard); assertLive(); return value; };
    const readPull = async () => {
      const [owner, name] = policy.repository.split("/");
      const response = await api("graphql", ["-f", `query=query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { pullRequest(number:${pr.number}) { ${fields} } } }`]) as { errors?: unknown; data?: { repository?: { pullRequest?: Pull } } };
      const pull = response.data?.repository?.pullRequest;
      if (response.errors || !pull || pull.number !== pr.number || pull.url !== pr.url || pull.headRefOid !== pr.head || pull.headRefName !== pr.branch || pull.baseRefName !== pr.base_branch || pull.headRepository?.nameWithOwner !== pr.repository || pull.baseRepository?.nameWithOwner !== pr.repository) throw new FactoryError("merge_target_changed", "GitHub's PR identity, candidate or target differs from this approval", 409);
      return pull;
    };
    let pull = await readPull();
    if (!pull.merged && intent.condition === "prepared") {
      const complete = <T>(c: Connection<T> | undefined) => Array.isArray(c?.nodes) && c.pageInfo?.hasNextPage === false;
      const contexts = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
      if (!complete(pull.reviews) || !complete(pull.reviewThreads) || !complete(pull.reviewRequests) || !complete(pull.commits) || contexts && !complete(contexts)) throw new FactoryError("merge_blocked", "GitHub review and check inventory is incomplete", 409);
      if (pull.state !== "OPEN" || pull.isDraft || !["CLEAN", "BLOCKED", "UNSTABLE", "UNKNOWN"].includes(pull.mergeStateStatus) || pull.reviewDecision && !["APPROVED", "REVIEW_REQUIRED"].includes(pull.reviewDecision) || pull.reviewThreads.nodes.some(t => !t.isResolved) || pull.baseRef?.branchProtectionRule?.isAdminEnforced === false) throw new FactoryError("merge_blocked", "GitHub protection, pending reviews, unresolved conversations or conflicts block this target", 409);
      const opinions = new Map<string, Pull["reviews"]["nodes"][number]>();
      for (const r of [...pull.reviews.nodes].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) if (r.author && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) opinions.set(r.author.login.toLowerCase(), r);
      if ([...opinions.values()].some(r => r.state === "CHANGES_REQUESTED")) throw new FactoryError("merge_blocked", "GitHub still has requested changes", 409);
      const githubPolicy = frozen.github_policy;
      const trustedApprovals = [...opinions.values()].filter(r => r.state === "APPROVED" && r.commit?.oid === pr.head && r.author?.login.toLowerCase() !== pull.author?.login.toLowerCase() && githubPolicy?.trusted_reviewers.some(login => login.toLowerCase() === r.author?.login.toLowerCase()));
      if (githubPolicy && githubPolicy.repository !== pr.repository) throw new FactoryError("merge_blocked", "The frozen Project repository differs from this candidate", 409);
      let waiting = pull.mergeStateStatus === "UNKNOWN" || pull.reviewDecision === "REVIEW_REQUIRED" || pull.reviewRequests.nodes.length > 0 || !!(githubPolicy?.trusted_reviewers.length && trustedApprovals.length < Math.max(1, pull.baseRef?.branchProtectionRule?.requiredApprovingReviewCount ?? 1));
      for (const name of new Set([...githubPolicy?.required_checks ?? [], ...pull.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []])) {
        const matching = contexts?.nodes.filter(c => (c.name ?? c.context) === name) ?? [];
        if (matching.some(c => c.context ? !["SUCCESS", "PENDING", "EXPECTED"].includes(c.state ?? "") : c.status === "COMPLETED" && c.conclusion !== "SUCCESS")) throw new FactoryError("merge_blocked", `Required check failed: ${name}`, 409);
        if (!matching.length || matching.some(c => c.context ? c.state !== "SUCCESS" : c.status !== "COMPLETED")) waiting = true;
      }
      if (waiting) throw new FactoryError("merge_waiting", "Waiting for required GitHub checks or reviews; retained approval will be observed automatically", 409);
      if (pull.mergeStateStatus !== "CLEAN") throw new FactoryError("merge_blocked", "GitHub protection or conflicts block this target", 409);
      await assertCurrent();
      intent = { ...intent, condition: "sending" };
      // The final account/native permission check precedes retaining the irreversible send intent.
      let mutation: unknown;
      try {
        mutation = await api(`repos/${pr.repository}/pulls/${pr.number}/merge`, ["--method", "PUT", "-f", `sha=${pr.head}`, "-f", "merge_method=squash"], () => { assertLive(); this.store.put("host_merges", intent!, id); });
      } catch { return { run_id: id, head: pr.head, repository: pr.repository, base_branch: pr.base_branch, number: pr.number, condition: "uncertain", merge_sha: null, release_tag: null, reason: "Merge acknowledgment was lost or permission was denied; observe this PR before further action" }; }
      if ((mutation as { merged?: boolean } | null)?.merged === false) throw new FactoryError("merge_denied", "GitHub refused this merge under its repository permissions, protection or conflict rules; inspect the PR before further action", 409);
      pull = await readPull();
    }
    const result: FactoryMergeResult = { run_id: id, head: pr.head, repository: pr.repository, base_branch: pr.base_branch, number: pr.number, condition: "uncertain", merge_sha: null, release_tag: null, reason: "GitHub has not confirmed this merge; the sent operation will not be replayed" };
    if (!pull.merged || pull.state !== "MERGED" || !/^[a-f0-9]{40}$/.test(pull.mergeCommit?.oid ?? "")) return result;
    const sha = pull.mergeCommit!.oid;
    const contains = async (target: string) => {
      const compare = await api(`repos/${pr.repository}/compare/${sha}...${encodeURIComponent(target)}`) as { status: string; merge_base_commit?: { sha: string } };
      return ["identical", "ahead"].includes(compare.status) && compare.merge_base_commit?.sha === sha;
    };
    const target = await api(`repos/${pr.repository}/commits/${encodeURIComponent(`heads/${pr.base_branch}`)}`) as { sha: string };
    if (!/^[a-f0-9]{40}$/.test(target.sha) || !await contains(target.sha)) throw new FactoryError("merge_coverage_unverified", "The authorized target does not contain the PR's confirmed merge commit", 409);
    this.store.put("host_merges", { ...intent, condition: "verified", merge_sha: sha }, id);
    result.merge_sha = sha; result.condition = "merged"; result.reason = null;
    if (frozen.project?.delivery_policy === "release") {
      result.condition = "awaiting_release"; result.reason = "Merge verified; waiting for a published release containing it";
      const releases = await api(`repos/${pr.repository}/releases`) as { draft: boolean; prerelease: boolean; tag_name: string }[];
      if (!Array.isArray(releases)) throw new FactoryError("merge_coverage_unverified", "The published release inventory could not be verified", 409);
      for (const release of releases.slice(0, 100)) if (!release.draft && !release.prerelease && typeof release.tag_name === "string" && release.tag_name) {
        const commit = await api(`repos/${pr.repository}/commits/${encodeURIComponent(`tags/${release.tag_name}`)}`) as { sha: string };
        if (/^[a-f0-9]{40}$/.test(commit.sha) && await contains(commit.sha)) { result.condition = "released"; result.release_tag = release.tag_name; result.reason = null; break; }
      }
    }
    return result;
  }
}
