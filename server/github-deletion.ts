import type { ProjectGitHubPolicy, ProjectGitHubPull, ProjectGitHubSource } from "../shared/github-project.ts";
import type { FactoryPullRequest, FactoryRun } from "../shared/factory.ts";
import type { AccountBindingSnapshot, AccountIdentity } from "../shared/accounts.ts";
import { MachineAccounts } from "./accounts.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

interface SourceIdentity { repository: string; external_id: string; number: number; kind: "issue" | "fix" }
type Suppression = (SourceIdentity | { repository: string; kind: "fix"; branch: string }) & { id: string };
interface Deletion extends SourceIdentity { id: string; implementation_id: string; project_id: string; account_profile_id: string; identity: AccountIdentity; confirmed: boolean }

export function githubSuppressed(store: FactoryStore, repository: string, externalId: string, number: number, kind: "issue" | "fix", branch?: string): boolean {
  return store.list<Suppression>("github_suppressions").some(source => source.repository.toLowerCase() === repository.toLowerCase() && source.kind === kind && ("branch" in source ? source.branch === branch : source.external_id === externalId || source.number === number));
}

/** Capture source fences before awaiting cleanup; retain no Assignment content. */
export class GitHubDeletion {
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly accounts: MachineAccounts) {}
  stop(): void { this.stopped = true; }
  prepare(id: string): void {
    const sources = this.store.list<ProjectGitHubSource>("github_sources").filter(source => source.implementation_id === id).map(source => {
      const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/(issues|pull)\/(\d+)$/.exec(source.url);
      if (!match || Number(match[3]) !== source.number || (match[2] === "issues") !== (source.kind === "issue")) throw new FactoryError("github_source_uncertain", "The linked GitHub source identity needs reconciliation", 409);
      const identity: SourceIdentity = { repository: match[1]!, external_id: source.external_id, number: source.number, kind: source.kind };
      return { source, identity, key: hash(JSON.stringify(identity)) };
    });
    const published = this.store.list<FactoryPullRequest>("pull_requests", id).map(pr => {
      const run = this.store.get<FactoryRun>("runs", pr.run_id);
      const policy = (run?.manifest as { project?: { pull_request?: { repository: string } } } | undefined)?.project?.pull_request;
      if (!run || run.implementation_id !== id || pr.repository !== policy?.repository || pr.branch !== run.branch || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.url !== `https://github.com/${pr.repository}/pull/${pr.number}`) throw new FactoryError("github_source_uncertain", "The published PR identity needs reconciliation before Delete", 409);
      return { repository: pr.repository, external_id: pr.url, number: pr.number, kind: "fix" as const };
    });
    // Publication can have taken effect before its reply reaches this owner.
    const publishing = this.store.list<FactoryRun>("runs", id).flatMap(run => {
      const review = this.store.get<{ head: string | null; check_id: string | null }>("automatic_review", run.id);
      const repository = (run.manifest as { project?: { pull_request?: { repository: string } } }).project?.pull_request?.repository;
      if (!review?.head || !review.check_id || !repository || !run.branch) return [];
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new FactoryError("github_source_uncertain", "The publication repository needs reconciliation before Delete", 409);
      return [{ repository, kind: "fix" as const, branch: run.branch }];
    });
    // This fence must survive a missing/disabled account or changed configuration.
    this.store.db.transaction(() => {
      for (const identity of [...published, ...publishing]) this.store.put<Suppression>("github_suppressions", { id: hash(JSON.stringify(identity)), ...identity });
      for (const { source, identity, key } of sources) {
        this.store.put<Suppression>("github_suppressions", { id: key, ...identity });
        for (const pull of this.store.list<ProjectGitHubPull>("github_pulls", source.project_id)) if (pull.fix_implementation_id === id) this.store.put("github_pulls", { ...pull, fix_implementation_id: null }, source.project_id);
      }
    }).immediate();
    this.store.db.transaction(() => {
      for (const { source, identity, key } of sources) {
        if (source.kind === "issue" && !this.store.get("github_deletions", key)) {
          const policy = this.store.get<ProjectGitHubPolicy>("github_policies", source.project_id);
          if (!policy || policy.repository.toLowerCase() !== identity.repository.toLowerCase()) throw new FactoryError("github_scope_changed", "Restore the linked repository's GitHub configuration to finish Delete", 409);
          const account = this.accounts.overview().profiles.find(profile => profile.id === policy.account_profile_id);
          if (!account?.verified_identity) throw new FactoryError("github_account_unavailable", "Restore the authorized GitHub identity to finish permanent issue deletion", 409);
          this.store.put<Deletion>("github_deletions", { id: key, ...identity, implementation_id: id, project_id: source.project_id, account_profile_id: policy.account_profile_id, identity: account.verified_identity, confirmed: false }, id);
        }
      }
    }).immediate();
  }
  async reconcile(id: string): Promise<void> {
    for (const entry of this.store.list<Deletion>("github_deletions", id)) {
      if (entry.confirmed) continue;
      const account = this.accounts.overview().profiles.find(profile => profile.id === entry.account_profile_id);
      // A transient native read failure marks the profile needs_login. Re-observe
      // the same expected identity; never sign in, refresh credentials or fall back.
      if (account?.state === "needs_login" && account.expected_login.toLowerCase() === entry.identity.login.toLowerCase() && (!account.expected_account_id || account.expected_account_id === entry.identity.account_id)) await this.accounts.verify(account.id, { expected_revision: account.revision });
      const scope = await this.accounts.freeze({ github: entry.account_profile_id });
      if (JSON.stringify(scope.profiles[0]?.identity) !== JSON.stringify(entry.identity)) throw new FactoryError("github_identity_changed", "Restore the authorized GitHub identity to finish permanent issue deletion", 409);
      const [owner, name] = entry.repository.split("/");
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { id nameWithOwner viewerPermission issues(first:100${cursor ? ",after:" + JSON.stringify(cursor) : ""}) { nodes { id number } pageInfo { hasNextPage endCursor } } } }`;
        const observed = await this.github(scope, ["api", "graphql", "-f", "query=" + query]) as { errors?: unknown; data?: { repository?: { id: string; nameWithOwner: string; viewerPermission: string; issues: { nodes: { id: string; number: number }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } };
        const repository = observed.data?.repository;
        if (observed.errors || !repository || typeof repository.id !== "string" || typeof repository.nameWithOwner !== "string" || repository.nameWithOwner.toLowerCase() !== entry.repository.toLowerCase() || !Array.isArray(repository.issues?.nodes) || repository.issues.nodes.some(issue => !issue || typeof issue.id !== "string" || !Number.isSafeInteger(issue.number) || issue.number < 1) || typeof repository.issues.pageInfo?.hasNextPage !== "boolean") throw new FactoryError("github_delete_unconfirmed", "GitHub issue inventory is incomplete; permanent deletion remains pending", 409);
        if (repository.issues.nodes.some(issue => issue.id === entry.external_id)) {
          if (repository.viewerPermission !== "ADMIN") throw new FactoryError("github_delete_permission", `GitHub ${entry.repository} requires repository-admin permission for permanent issue deletion`, 409);
          const result = await this.github(scope, ["api", "graphql", "-f", `query=mutation { deleteIssue(input:{issueId:${JSON.stringify(entry.external_id)},clientMutationId:${JSON.stringify(entry.id)}}) { clientMutationId repository { id nameWithOwner } } }`]) as { errors?: { type?: string }[]; data?: { deleteIssue?: { clientMutationId?: string; repository?: { id: string } } } };
          const permissionErrors = Array.isArray(result.errors) ? [...new Set(result.errors.map(error => error?.type).filter(type => ["FORBIDDEN", "INSUFFICIENT_SCOPES"].includes(type ?? "")))] : [];
          if (permissionErrors.length) throw new FactoryError("github_delete_permission", `GitHub refused permanent issue deletion (${permissionErrors.join(" / ")}); check repository-admin permissions and organization deletion policy`, 409);
          if (result.errors || result.data?.deleteIssue?.clientMutationId !== entry.id || result.data?.deleteIssue?.repository?.id !== repository.id) throw new FactoryError("github_delete_unconfirmed", "GitHub did not confirm permanent issue deletion; check repository permissions and organization policy", 409);
        } else if (repository.issues.pageInfo.hasNextPage) {
          const next = repository.issues.pageInfo.endCursor;
          if (!next || next === cursor || page === 99) throw new FactoryError("github_delete_unconfirmed", "GitHub issue inventory exceeds the bounded deletion budget", 409);
          cursor = next; continue;
        }
        if (this.stopped) throw new FactoryError("github_delete_interrupted", "GitHub deletion will reconcile after restart", 409);
        this.store.put("github_deletions", { ...entry, confirmed: true }, id);
        break;
      }
    }
  }
  private async github(scope: AccountBindingSnapshot, args: string[]): Promise<unknown> {
    const authorize = () => { if (this.stopped) throw new FactoryError("github_delete_interrupted", "GitHub deletion will reconcile after restart", 409); };
    authorize();
    const result = await this.accounts.github(scope, args, authorize);
    authorize(); this.accounts.assertPublic(JSON.stringify(result)); return result;
  }
  finish(id: string): void {
    for (const entry of this.store.list<Deletion>("github_deletions", id)) this.store.remove("github_deletions", entry.id);
  }
}
