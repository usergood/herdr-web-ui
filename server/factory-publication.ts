import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryCheck, FactoryProject, FactoryReviewEvidence, FactoryRun, Implementation } from "../shared/factory.ts";
import type { ImplementationPublication, PublicationOverview } from "../shared/factory-publication.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryRuntime } from "./factory-runtime.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryDelivery } from "./factory-delivery.ts";
import { FactoryMergeDelivery } from "./factory-merge-delivery.ts";
import { FactoryError, hash } from "./factory-host.ts";

interface Pull {
  number: number; html_url: string; body: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

/** Durable publication ownership survives uncertain transport and bridge restarts. */
export class FactoryPublication {
  private readonly busy = new Set<string>();
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly workflow: FactoryWorkflow, private readonly delivery: FactoryMergeDelivery) {
    this.retainInterrupted();
  }
  private retainInterrupted(): void {
    for (const p of this.store.list<ImplementationPublication>("pr_publications")) if (p.condition === "sending") this.store.put("pr_publications", { ...p, condition: "uncertain", problem: "Publication was interrupted. Reconcile its retained intent before continuing.", updated_at: new Date().toISOString() }, p.run_id);
  }
  stop(): void { this.retainInterrupted(); this.stopped = true; }
  private run(id: string): FactoryRun {
    if (this.stopped) throw new FactoryError("publication_disabled", "Publication stopped; reconcile the retained intent after reconnecting", 409);
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    return run;
  }
  private retained(id: string): ImplementationPublication | null { return this.store.list<ImplementationPublication>("pr_publications", id).at(-1) ?? null; }
  async automatic(id: string): Promise<void> {
    const run = this.run(id), idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    if (!idea.project_id || this.store.get<FactoryProject>("projects", idea.project_id)?.auto_publish_pr !== true || !run.accepted_result || this.retained(id)) return;
    try { await this.publish(id, run.accepted_result.head, "project"); }
    catch { /* Missing or stale evidence remains visible through the publication overview. */ }
  }
  private async candidate(id: string): Promise<Omit<ImplementationPublication, keyof import("../shared/factory.ts").FactoryRecord | "authority" | "condition" | "pull" | "problem" | "creation_attempted" | "upload_head">> {
    const run = this.run(id), accepted = run.accepted_result;
    const idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    if (existsSync(join(this.store.root, "recovery-copy.json")) || !project || project.removed_at || idea.archived_at || idea.discard_requested_at || idea.stage === "done" || !["implementation_complete", "pr_open"].includes(idea.outcome) || run.scope_pause || run.condition !== "completed" || !["work", "implement-spec"].includes(run.action) || !accepted || !run.worktree || !run.branch || !run.base || this.store.list<FactoryRun>("runs", idea.id).at(-1)?.id !== id) throw new FactoryError("publication_unaccepted", "Accept this Assignment's reviewed implementation before publishing its PR", 409);
    const check = this.store.list<FactoryCheck>("checks", id).filter(c => c.worker_id === null).at(-1);
    const reviews = this.store.list<FactoryReviewEvidence>("review_evidence", id);
    const reports = ["standards", "spec"].map(axis => reviews.filter(r => r.axis === axis).at(-1));
    const commands = [...project.setup ?? [], ...project.checks ?? []];
    if (!check || check.id !== accepted.check_id || check.condition !== "passed" || check.head !== accepted.head || check.workspace_hash !== accepted.workspace_hash || !commands.length || JSON.stringify(check.commands.map(c => c.args)) !== JSON.stringify(commands) || check.commands.some(c => c.exit_code !== 0) || reports.some(r => !r || r.outcome !== "passed" || r.head !== accepted.head || !accepted.review_ids.includes(r.id)) || this.workflow.questionRevision(idea.id) !== accepted.question_revision || this.workflow.questions(idea.id).some(q => q.answer === null) || this.store.list<{ status: string }>("comments", idea.id).some(c => c.status !== "resolved")) throw new FactoryError("fresh_evidence_required", "Publication requires current passing checks and independent Standards and Spec reviews of the accepted head", 409);
    const evidence = await new FactoryDelivery(this.store, this.runtime).inspect(idea.id);
    if (!evidence.quiescent || evidence.repository_changes !== "changes") throw new FactoryError("publication_active", "Reconcile owned work and repository changes before publishing", 409);
    const checkout = await this.runtime.inspect(run.machine_id, run.worktree);
    const discovered = await this.runtime.discover(run.machine_id, run.worktree);
    const workspace = await this.runtime.capture(run.machine_id, run.worktree, run.base, "workspace");
    const branch = await this.runtime.capture(run.machine_id, run.worktree, run.base, "branch");
    if (branch.files.some(file => [file.path, file.old_path].some(path => path && (path.startsWith(".saurons-eye-") || path === ".opencode/agents/saurons-eye.md" || /^(\.agents|\.claude|\.opencode)\/skills\//.test(path))))) throw new FactoryError("scaffolding_committed", "Remove application runtime scaffolding from the reviewed commits before publication", 409);
    const repository = idea.delivery_scope?.github_repository;
    if (!repository || discovered.github.repository?.toLowerCase() !== repository.toLowerCase() || checkout.repository !== idea.delivery_scope?.repository || checkout.repository !== project.repository || checkout.branch !== run.branch || checkout.head !== accepted.head || branch.head !== accepted.head || workspace.head !== accepted.head || workspace.files.length || !branch.files.length || accepted.workspace_hash !== hash(JSON.stringify({ diff: "", files: [] }))) throw new FactoryError("publication_scope_changed", "The accepted repository, branch or reviewed diff changed; retain fresh evidence before publishing", 409);
    const snapshot = (run.manifest as { account_snapshot?: import("../shared/accounts.ts").AccountBindingSnapshot }).account_snapshot;
    const github = snapshot?.profiles.find(p => p.service === "github");
    if (!snapshot || !github || project.account_bindings?.[run.machine_id]?.github !== github.id) throw new FactoryError("account_scope_required", "Bind and verify the Project's GitHub account before accepting its implementation", 409);
    const current = await this.runtime.accountSnapshot(run.machine_id, { github: github.id });
    if (!current || current.host_id !== snapshot.host_id || JSON.stringify(current.profiles[0]) !== JSON.stringify(github)) throw new FactoryError("account_scope_changed", "The accepted GitHub account changed; verify its publication scope", 409);
    return { run_id: id, implementation_id: idea.id, machine_id: run.machine_id, repository, branch: run.branch, target_branch: idea.delivery_scope!.branch!, base: run.base, head: accepted.head, diff_hash: hash(JSON.stringify(branch.files)), account_snapshot: current, check_id: check.id, review_ids: reports.map(r => r!.id) };
  }
  async overview(id: string): Promise<PublicationOverview> {
    const run = this.run(id), idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    const view: PublicationOverview = { run_id: id, head: run.accepted_result?.head ?? null, repository: idea.delivery_scope?.github_repository ?? null, branch: run.branch, target_branch: idea.delivery_scope?.branch ?? null, eligible: false, problem: null, publication: this.retained(id) };
    try { await this.candidate(id); view.eligible = true; }
    catch (error) { view.problem = error instanceof FactoryError ? error.message : "Publication evidence is unavailable. Reconnect the Machine and inspect the accepted result."; }
    return view;
  }
  private async validate(p: ImplementationPublication, mutating = false): Promise<void> {
    const candidate = await this.candidate(p.run_id);
    for (const [key, value] of Object.entries(candidate)) if (JSON.stringify(p[key as keyof ImplementationPublication]) !== JSON.stringify(value)) throw new FactoryError("publication_scope_changed", "The retained publication scope changed; inspect its evidence before continuing", 409);
    if (mutating && p.authority === "project" && this.store.get<FactoryProject>("projects", this.store.get<Implementation>("implementations", p.implementation_id)!.project_id!)?.auto_publish_pr !== true) throw new FactoryError("publication_unauthorized", "Automatic PR publication is disabled for this Project", 409);
  }
  private matching(p: ImplementationPublication, pull: Pull): boolean {
    return Number.isSafeInteger(pull?.number) && pull.number > 0 && typeof pull.html_url === "string" && pull.html_url.toLowerCase() === `https://github.com/${p.repository}/pull/${pull.number}`.toLowerCase() && pull.head?.sha === p.head && pull.head?.ref === p.branch && pull.head.repo?.full_name?.toLowerCase() === p.repository.toLowerCase() && pull.base?.ref === p.target_branch && pull.base.repo?.full_name?.toLowerCase() === p.repository.toLowerCase() && typeof pull.body === "string" && pull.body.includes(`<!-- saurons-eye-pr:${p.id} -->`);
  }
  private async lookup(p: ImplementationPublication): Promise<Pull | null> {
    const result = await this.runtime.publication(p.machine_id, { action: "lookup", publication: p, title: "" });
    if (!Array.isArray(result) || result.length >= 100) throw new FactoryError("publication_incomplete", "PR publication evidence is incomplete; reconcile before proceeding", 409);
    if (!result.length) return null;
    if (result.length !== 1 || !this.matching(p, result[0])) throw new FactoryError("publication_ambiguous", "This branch has unrelated or changed PR evidence; inspect it before publishing", 409);
    return result[0];
  }
  private async confirm(p: ImplementationPublication, pull: Pull): Promise<ImplementationPublication> {
    if (!this.matching(p, pull)) throw new FactoryError("publication_scope_changed", "GitHub returned another PR head, repository or target; reconcile its publication", 409);
    await this.validate(p);
    const idea = this.store.get<Implementation>("implementations", p.implementation_id)!;
    await this.delivery.link(idea.id, { expected_revision: idea.delivery?.revision ?? null, machine_id: p.machine_id, account_profile_id: p.account_snapshot.profiles[0]!.id, pull_numbers: [...new Set([...(idea.delivery?.pull_numbers ?? []), pull.number])] });
    const confirmed: ImplementationPublication = { ...p, condition: "confirmed", pull: { number: pull.number, url: pull.html_url }, problem: null, updated_at: new Date().toISOString() };
    this.store.db.transaction(() => {
      this.store.put("pr_publications", confirmed, p.run_id);
      this.store.put("implementations", { ...this.store.get<Implementation>("implementations", idea.id)!, outcome: "pr_open" });
      this.store.event(idea.id, "implementation_pr_published", { publication_id: p.id, run_id: p.run_id, head: p.head, repository: p.repository, target_branch: p.target_branch, pull: confirmed.pull });
    })();
    return confirmed;
  }
  async publish(id: string, head: unknown, authority: "owner" | "project" = "owner", metadata: { title?: unknown; body?: unknown } = {}): Promise<ImplementationPublication> {
    if (this.busy.has(id)) throw new FactoryError("publication_busy", "This Run's PR publication is already owned", 409);
    this.busy.add(id);
    let p: ImplementationPublication | null = null;
    try {
      const candidate = await this.candidate(id);
      if (authority === "project" && this.store.get<FactoryProject>("projects", this.store.get<Implementation>("implementations", candidate.implementation_id)!.project_id!)?.auto_publish_pr !== true) throw new FactoryError("publication_unauthorized", "Automatic PR publication is disabled for this Project", 409);
      if (head !== candidate.head) throw new FactoryError("publication_scope_changed", "Publish only the displayed accepted head", 409);
      const idea = this.store.get<Implementation>("implementations", candidate.implementation_id)!;
      const title = metadata.title ?? idea.title;
      const description = metadata.body ?? idea.description;
      if (typeof title !== "string" || !title.trim() || title.length > 200 || /[\r\n]/.test(title) || typeof description !== "string" || description.length > 50_000) throw new FactoryError("invalid_publication_metadata", "Enter a bounded PR title and problem/result description");
      const check = this.store.get<FactoryCheck>("checks", candidate.check_id)!;
      const body = `${description.trim() || idea.title}\n\nValidation at ${candidate.head}:\n${check.commands.map(command => `- ${command.args.join(" ")}: exit ${command.exit_code}`).join("\n")}\nIndependent Standards and Spec reviews passed.\n\nAssignment: ${idea.id}\nChecks: ${check.id}\nReviews: ${candidate.review_ids.join(", ")}`;
      p = this.retained(id);
      const resuming = !!p;
      if (p) { await this.validate(p); if (p.condition !== "prepared" || p.creation_attempted !== false) return p; }
      p = p ? { ...p, authority, condition: "sending", problem: null } : { ...this.store.record(), ...candidate, authority, condition: "sending", creation_attempted: false, pull: null, problem: null, metadata: { title: title.trim(), body } };
      this.store.put("pr_publications", p, id);
      this.store.event(p.implementation_id, resuming ? "implementation_pr_publication_resumed" : "implementation_pr_publication_intent", { publication_id: p.id, authority, head: p.head, repository: p.repository, target_branch: p.target_branch });
      const existing = await this.lookup(p);
      if (existing) return await this.confirm(p, existing);
      await this.validate(p, true);
      const uploaded = await this.runtime.publication(p.machine_id, { action: p.upload_head ? "branch" : "push", publication: p, title: "" }) as { commit?: { sha?: string } };
      if (uploaded?.commit?.sha !== p.head) throw new FactoryError("publication_upload_uncertain", "GitHub has not confirmed the approved branch head; reconcile publication", 409);
      p = { ...p, upload_head: p.head }; this.store.put("pr_publications", p, id);
      await this.validate(p, true);
      p = { ...p, creation_attempted: true }; this.store.put("pr_publications", p, id);
      const pull = await this.runtime.publication(p.machine_id, { action: "create", publication: p, title: p.metadata?.title ?? idea.title }) as Pull;
      return await this.confirm(p, pull);
    } catch (error) {
      if (!p) throw error;
      const uncertain: ImplementationPublication = { ...p, condition: "uncertain", problem: error instanceof FactoryError ? error.message : "Publication is unconfirmed; reconcile the retained intent before trying again", updated_at: new Date().toISOString() };
      if (!this.stopped) this.store.put("pr_publications", uncertain, id); return uncertain;
    } finally { this.busy.delete(id); }
  }
  async reconcile(id: string): Promise<ImplementationPublication> {
    if (this.busy.has(id)) throw new FactoryError("publication_busy", "Wait for the owned PR publication", 409);
    this.busy.add(id);
    try {
      const p = this.retained(id);
      if (!p) throw new FactoryError("publication_required", "No PR publication intent is retained", 409);
      if (p.condition === "confirmed") return p;
      await this.validate(p);
      const pull = await this.lookup(p);
      if (!pull) {
        if (p.creation_attempted === false) {
          const uploaded = await this.runtime.publication(p.machine_id, { action: "branch", publication: p, title: "" }) as { commit?: { sha?: string } };
          if (uploaded?.commit?.sha === p.head) {
            await this.validate(p);
            const prepared: ImplementationPublication = { ...p, condition: "prepared", upload_head: p.head, problem: null, updated_at: new Date().toISOString() };
            this.store.put("pr_publications", prepared, id); return prepared;
          }
        }
        const pending: ImplementationPublication = { ...p, condition: "uncertain", problem: "No matching PR receipt is confirmed. Preserve the intent and inspect GitHub before retrying.", updated_at: new Date().toISOString() };
        this.store.put("pr_publications", pending, id); return pending;
      }
      return await this.confirm(p, pull);
    } finally { this.busy.delete(id); }
  }
}
