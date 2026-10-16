import type { AccountBindingSnapshot } from "../shared/accounts.ts";
import type { FactoryCheck, FactoryProject, FactoryPullRequest, FactoryReviewEvidence, FactoryRun, FactoryWorker } from "../shared/factory.ts";
import type { MachineAccounts } from "./accounts.ts";
import { FactoryError, git } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";

interface PublicationIntent {
  id: string; run_id: string; head: string; repository: string; base_branch: string; branch: string;
  condition: "prepared" | "sending" | "published"; number?: number; url?: string;
}
interface GitHubPull {
  number: number; html_url: string; state: string; body: string;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

/** Only the owned Machine pushes. A retained create intent is reconciled by lookup,
 * never replayed after an unknown response. No merge operation exists here. */
export class FactoryPublication {
  private readonly busy = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly accounts: MachineAccounts | undefined, private readonly observe: (id: string) => Promise<FactoryRun>, private readonly head: (id: string) => Promise<{ head: string; workspace_hash: string }>) {}
  async publish(id: string, body: Record<string, unknown>): Promise<FactoryPullRequest> {
    if (this.busy.has(id)) throw new FactoryError("publication_busy", "Publication is being reconciled", 409);
    this.busy.add(id);
    try { return await this.perform(id, body); } finally { this.busy.delete(id); }
  }
  private async perform(id: string, body: Record<string, unknown>): Promise<FactoryPullRequest> {
    const run = await this.observe(id);
    const frozen = run.manifest as { project: FactoryProject; planning_authority?: { automatic_execution?: boolean }; account_snapshot?: AccountBindingSnapshot; implementation?: { title: string } };
    const policy = frozen.project.pull_request;
    if (run.action !== "implement-spec" || !frozen.planning_authority?.automatic_execution || !policy || !this.accounts || !frozen.account_snapshot?.profiles.some(p => p.service === "github")) throw new FactoryError("publication_unconfigured", "Publication requires the accepted Specification, explicit Project destination and a verified frozen GitHub account", 409);
    if (!run.worktree || !run.branch?.startsWith("saurons-eye/") || !run.branch.includes(run.id) || !/^[\w.-]+\/[\w.-]+$/.test(policy.repository) || !policy.base_branch || run.condition !== "ready") throw new FactoryError("publication_unready", "Verify the owned resting Run and publication destination", 409);
    if (this.store.list<FactoryWorker>("host_workers", id).some(w => !["completed", "cancelled", "failed"].includes(w.condition))) throw new FactoryError("writers_active", "Quiesce owned workers before publication", 409);
    const check = typeof body.check_id === "string" ? this.store.get<FactoryCheck>("host_checks", body.check_id) : null;
    const recipes = [...frozen.project.setup ?? [], ...frozen.project.checks ?? []];
    const reports = Array.isArray(body.reports) ? body.reports.map(reference => {
      if (!reference || typeof reference.worker_id !== "string") return null;
      const report = this.store.get<FactoryReviewEvidence>("host_review_evidence", reference.worker_id);
      return report?.source_id === reference.source_id ? report : null;
    }) : [];
    if (!check || check.run_id !== id || check.worker_id !== null || check.condition !== "passed" || check.head !== body.head || check.workspace_hash !== body.workspace_hash || !recipes.length || JSON.stringify(check.commands.map(c => c.args)) !== JSON.stringify(recipes) || check.commands.some(c => c.exit_code !== 0) || reports.length !== 2 || !["standards", "spec"].every(axis => reports.some(r => r?.run_id === id && r.axis === axis && r.head === body.head && r.outcome === "passed"))) throw new FactoryError("fresh_evidence_required", "Publication requires this Machine's passing configured checks and separate native Standards and Spec reports at the current head", 409);
    const assertCurrent = async () => {
      const lease = this.store.get<{ closing?: boolean; run: FactoryRun }>("host_leases", id);
      if (!lease || lease.closing || lease.run.suspension) throw new FactoryError("run_stopping", "Publication stopped with its owned Run", 409);
      const current = await this.head(id);
      if (current.head !== body.head || current.workspace_hash !== body.workspace_hash) throw new FactoryError("review_stale", "Publication must cover the checked integration workspace", 409);
      const tracked = await git(run.worktree!, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      const untracked = (await git(run.worktree!, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(n => n && !n.startsWith(".saurons-eye-") && n !== ".opencode/agents/saurons-eye.md" && !/^(\.agents|\.claude|\.opencode)\/skills\//.test(n));
      if (tracked || untracked.length) throw new FactoryError("dirty_integration", "Commit the checked changes before publication", 409);
    };
    await assertCurrent();
    const origin = (await git(run.worktree, ["config", "--get", "remote.origin.url"])).trim();
    if (![`https://github.com/${policy.repository}.git`, `https://github.com/${policy.repository}`, `git@github.com:${policy.repository}.git`, `ssh://git@github.com/${policy.repository}.git`].includes(origin)) throw new FactoryError("publication_target_changed", "The configured PR repository must match the owned checkout's origin", 409);
    const key = `${id}:${body.head}`;
    let intent = this.store.get<PublicationIntent>("host_publications", key);
    if (intent && (intent.repository !== policy.repository || intent.base_branch !== policy.base_branch || intent.branch !== run.branch)) throw new FactoryError("publication_target_changed", "The retained publication destination changed", 409);
    intent ??= { id: key, run_id: id, head: String(body.head), repository: policy.repository, base_branch: policy.base_branch, branch: run.branch, condition: "prepared" };
    this.store.put("host_publications", intent, id);
    const marker = `<!-- saurons-eye:${id}:${body.head} -->`;
    const api = (args: string[]) => this.accounts!.github(frozen.account_snapshot!, args);
    const pulls = await api(["api", `repos/${policy.repository}/pulls?state=all&head=${encodeURIComponent(policy.repository.split("/")[0] + ":" + run.branch)}&base=${encodeURIComponent(policy.base_branch)}&per_page=100`]);
    if (!Array.isArray(pulls) || pulls.length > 1) throw new FactoryError("publication_uncertain", "The owned PR lookup is ambiguous; retain the publication identity", 409);
    let pull = pulls[0] as GitHubPull | undefined;
    if (!pull) {
      if (intent.condition !== "prepared") throw new FactoryError("publication_uncertain", "GitHub has not confirmed the retained PR creation; do not replay it", 409);
      const destination = `https://github.com/${policy.repository}.git`;
      const remote = (await git(run.worktree, ["ls-remote", "--heads", destination, `refs/heads/${run.branch}`])).trim();
      if (remote && remote.split(/\s+/)[0] !== body.head) throw new FactoryError("publication_branch_changed", "The owned remote branch has another head; preserve it", 409);
      await assertCurrent();
      await git(run.worktree, ["push", "--", destination, `${body.head}:refs/heads/${run.branch}`]);
      await assertCurrent();
      intent = { ...intent, condition: "sending" }; this.store.put("host_publications", intent, id);
      const title = (frozen.implementation?.title ?? frozen.project.name).replace(/[\r\n]/g, " ").slice(0, 180);
      const description = `## Summary\n\n${title}\n\n\`\`\`text\nAccepted Specification → Tickets → checks → Standards + Spec → PR\n\`\`\`\n\n## Evidence\n\n- Checked and independently reviewed commit: ${body.head}\n- Check: ${String(body.check_id)}\n- Independent reports: ${Array.isArray(body.evidence_ids) ? body.evidence_ids.join(", ") : ""}\n\n## Merge Danger\n\n**Door:** two-way\n\n**Blast Radius:** Project\n\nMerge requires separate Human Review authorization.\n\n${marker}`;
      try { pull = await api(["api", `repos/${policy.repository}/pulls`, "--method", "POST", "-f", `title=feat: ${title}`, "-f", `head=${run.branch}`, "-f", `base=${policy.base_branch}`, "-f", `body=${description}`]) as GitHubPull; }
      catch { throw new FactoryError("publication_uncertain", "PR creation was sent; reconcile its exact identity before any further action", 409); }
    }
    if (pull && !pull.body?.includes(marker) && typeof body.previous_head === "string") {
      const previous = this.store.get<PublicationIntent>("host_publications", `${id}:${body.previous_head}`);
      const previousMarker = `<!-- saurons-eye:${id}:${body.previous_head} -->`;
      if (!previous || previous.condition !== "published" || previous.number !== pull.number || previous.branch !== run.branch || previous.repository !== policy.repository || previous.base_branch !== policy.base_branch || pull.state !== "open" || !pull.body?.includes(previousMarker) || ![body.previous_head, body.head].includes(pull.head?.sha) || pull.head.ref !== run.branch || pull.head.repo?.full_name !== policy.repository || pull.base?.ref !== policy.base_branch || pull.base.repo?.full_name !== policy.repository || pull.html_url !== previous.url) throw new FactoryError("publication_target_changed", "The repaired candidate must update the exact previously published PR", 409);
      if (intent.condition !== "prepared") throw new FactoryError("publication_uncertain", "PR update was sent; reconcile its retained identity before any further action", 409);
      const destination = `https://github.com/${policy.repository}.git`;
      const remote = (await git(run.worktree, ["ls-remote", "--heads", destination, `refs/heads/${run.branch}`])).trim().split(/\s+/)[0];
      if (remote !== body.previous_head && remote !== body.head) throw new FactoryError("publication_branch_changed", "The owned remote branch changed outside this repair", 409);
      try { await git(run.worktree, ["merge-base", "--is-ancestor", body.previous_head, String(body.head)]); }
      catch { throw new FactoryError("publication_branch_changed", "The repaired head must preserve the published history", 409); }
      await assertCurrent();
      if (remote !== body.head) await git(run.worktree, ["push", "--", destination, `${body.head}:refs/heads/${run.branch}`]);
      await assertCurrent();
      intent = { ...intent, condition: "sending" }; this.store.put("host_publications", intent, id);
      const description = pull.body.replace(previousMarker, marker) + `\n\nRepaired candidate: ${body.head}\nCheck: ${String(body.check_id)}\nIndependent reports: ${(body.evidence_ids as string[]).join(", ")}\nMerge still requires Human Review authorization.\n`;
      try { await api(["api", `repos/${policy.repository}/pulls/${pull.number}`, "--method", "PATCH", "-f", `body=${description}`]); }
      catch { throw new FactoryError("publication_uncertain", "PR update was sent; reconcile its exact identity before any further action", 409); }
      const updated = await api(["api", `repos/${policy.repository}/pulls?state=all&head=${encodeURIComponent(policy.repository.split("/")[0] + ":" + run.branch)}&base=${encodeURIComponent(policy.base_branch)}&per_page=100`]);
      if (!Array.isArray(updated) || updated.length !== 1) throw new FactoryError("publication_uncertain", "The updated owned PR is not yet unambiguous", 409);
      pull = updated[0] as GitHubPull;
    }
    if (pull.state !== "open" || !pull.body?.includes(marker) || pull.head?.sha !== body.head || pull.head.ref !== run.branch || pull.head.repo?.full_name !== policy.repository || pull.base?.ref !== policy.base_branch || pull.base.repo?.full_name !== policy.repository || !Number.isSafeInteger(pull.number) || pull.number < 1 || pull.html_url !== `https://github.com/${policy.repository}/pull/${pull.number}`) throw new FactoryError("publication_target_changed", "The PR identity, revision or destination differs from the authorized candidate", 409);
    await assertCurrent();
    this.store.put("host_publications", { ...intent, condition: "published", number: pull.number, url: pull.html_url }, id);
    return { ...this.store.record(), id: key, run_id: id, head: String(body.head), repository: policy.repository, base_branch: policy.base_branch, branch: run.branch, number: pull.number, url: pull.html_url, check_id: String(body.check_id), evidence_ids: body.evidence_ids as string[] };
  }
}
