import { randomUUID } from "node:crypto";
import type { AssignmentDelivery, AssignmentDeliveryConfiguration, DeliveryChange, FactoryProject, FactoryRun, FactoryWorker, Implementation } from "../shared/factory.ts";
import type { DeliveryReadRequest } from "../shared/factory-delivery.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryRuntime } from "./factory-runtime.ts";
import { FactoryDelivery } from "./factory-delivery.ts";

interface Pull { number: number; html_url: string; state: string; merged: boolean; merge_commit_sha: string | null; base: { ref: string; repo: { full_name: string } }; head: { sha: string } }
interface Tree { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] }
const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);

/** Retains owner linkage; observes delivery without ever asking GitHub to merge. */
export class FactoryMergeDelivery {
  private readonly busy = new Set<string>();
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly retainHandoff: (runId: string) => Promise<void>) {}
  private idea(id: string): Implementation {
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea) throw new FactoryError("not_found", "Assignment not found", 404);
    return idea;
  }
  private scope(id: string): string {
    const { completion_evidence: _, updated_at: __, ...idea } = this.idea(id);
    const runs = this.store.list<FactoryRun>("runs", id);
    return hash(JSON.stringify({ idea, project: idea.project_id && this.store.get("projects", idea.project_id), runs: runs.map(({ updated_at, condition, waiting_reason, ...run }) => run), workers: runs.flatMap(run => this.store.list<FactoryWorker>("workers", run.id).map(({ updated_at, ...worker }) => worker)), checks: runs.flatMap(run => this.store.list("checks", run.id)) }));
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new FactoryError("delivery_busy", "Wait for this Assignment's delivery verification", 409);
    this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); }
  }
  async link(id: string, body: AssignmentDeliveryConfiguration): Promise<AssignmentDelivery> {
    return this.locked(id, async () => {
      const idea = this.idea(id), scope = this.scope(id);
      if (body.expected_revision !== (idea.delivery?.revision ?? null)) throw new FactoryError("delivery_changed", "Refresh delivery evidence before correcting its links", 409);
      if (!idea.delivery_scope?.base || !idea.delivery_scope.branch || !idea.project_id || idea.archived_at || idea.stage === "done") throw new FactoryError("delivery_scope_required", "Start repository work before linking its delivery PRs", 409);
      const runs = this.store.list<FactoryRun>("runs", id);
      const run = runs.at(-1);
      if (!run?.worktree || body.machine_id !== run.machine_id || typeof body.account_profile_id !== "string" || !Array.isArray(body.pull_numbers) || !body.pull_numbers.length || body.pull_numbers.length > 20 || body.pull_numbers.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(body.pull_numbers).size !== body.pull_numbers.length) throw new FactoryError("invalid_delivery", "Select this Assignment's Machine, GitHub account and distinct delivery PR numbers");
      const project = this.store.get<FactoryProject>("projects", idea.project_id)!;
      const selected = project.account_bindings?.[body.machine_id]?.github;
      if (selected && selected !== body.account_profile_id) throw new FactoryError("account_scope_mismatch", "Use the Project's selected GitHub account", 409);
      const discovered = await this.runtime.discover(body.machine_id, run.worktree);
      if (discovered.repository !== idea.delivery_scope.repository || !discovered.github.repository || idea.delivery_scope.github_repository && discovered.github.repository.toLowerCase() !== idea.delivery_scope.github_repository.toLowerCase()) throw new FactoryError("delivery_repository_required", "Restore the Assignment's GitHub repository identity before linking delivery", 409);
      const account = await this.runtime.accountSnapshot(body.machine_id, { github: body.account_profile_id });
      const metadata = await this.runtime.deliveryRead(body.machine_id, { account_snapshot: account, repository: discovered.github.repository, kind: "repository" }) as { full_name?: string };
      if (metadata.full_name?.toLowerCase() !== discovered.github.repository.toLowerCase()) throw new FactoryError("delivery_repository_required", "The selected account cannot verify this repository", 409);
      if (this.scope(id) !== scope) throw new FactoryError("delivery_changed", "The Assignment changed while linking delivery", 409);
      const delivery: AssignmentDelivery = { revision: randomUUID(), machine_id: body.machine_id, account_profile_id: body.account_profile_id, repository: discovered.github.repository, branch: idea.delivery_scope.branch, pull_numbers: [...body.pull_numbers].sort((a, b) => a - b), condition: "linked", changes: [], pulls: [], problem: null, checked_at: null };
      this.store.put("implementations", { ...idea, delivery, delivery_scope: { ...idea.delivery_scope, github_repository: discovered.github.repository } });
      this.store.event(id, "delivery_linked", { revision: delivery.revision, repository: delivery.repository, branch: delivery.branch, pull_numbers: delivery.pull_numbers });
      return delivery;
    });
  }
  private async changes(idea: Implementation): Promise<DeliveryChange[]> {
    const files = new Map<string, DeliveryChange>();
    for (const run of this.store.list<FactoryRun>("runs", idea.id)) {
      if (!run.worktree || !idea.delivery_scope?.base) throw new FactoryError("delivery_changes_unknown", "Restore retained worktrees before verifying delivery", 409);
      const workers = this.store.list<FactoryWorker>("workers", run.id);
      for (const path of new Set([run.worktree, ...workers.map(worker => worker.worktree)])) {
        if (!path) throw new FactoryError("delivery_changes_unknown", "Restore retained worker changes before verifying delivery", 409);
        const workspace = await this.runtime.capture(run.machine_id, path, idea.delivery_scope.base, "workspace");
        const branch = await this.runtime.capture(run.machine_id, path, idea.delivery_scope.base, "branch");
        if (workspace.files.length || workspace.repository !== idea.delivery_scope.repository || branch.repository !== idea.delivery_scope.repository) throw new FactoryError("delivery_changes_unknown", "Commit retained changes and restore the repository identity before verifying delivery", 409);
        for (const file of branch.files) {
          if (file.new_oid === undefined || file.new_mode === undefined) throw new FactoryError("delivery_changes_unknown", "Update this Machine's bridge to verify committed delivery changes", 409);
          const change: DeliveryChange = { path: file.path, oid: file.new_oid, mode: file.new_mode, ...(file.old_path ? { old_path: file.old_path } : {}) };
          const prior = files.get(file.path);
          if (prior && JSON.stringify(prior) !== JSON.stringify(change)) throw new FactoryError("delivery_changes_ambiguous", "Reconcile retained branches into one intended change set before verifying delivery", 409);
          files.set(file.path, change);
        }
      }
    }
    if (!files.size) throw new FactoryError("delivery_changes_unknown", "No intended repository changes were found; inspect completion evidence for research acceptance", 409);
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  async sync(id: string, revision: unknown): Promise<AssignmentDelivery> {
    return this.locked(id, async () => {
      let idea = this.idea(id);
      const linked = idea.delivery;
      if (!linked) {
        await new FactoryDelivery(this.store, this.runtime).inspect(id);
        throw new FactoryError("delivery_changed", "Link the Assignment's delivery PRs before verifying, or discard this Assignment", 409);
      }
      if (revision !== linked.revision) throw new FactoryError("delivery_changed", "Refresh the Assignment's delivery PRs before verifying", 409);
      if (idea.stage === "done" && linked.condition === "merged") return linked;
      let evidence = await new FactoryDelivery(this.store, this.runtime).inspect(id);
      idea = this.idea(id);
      const scope = this.scope(id);
      const delivery: AssignmentDelivery = { ...linked, changes: [], pulls: [], condition: "needs_you", problem: null, checked_at: new Date().toISOString() };
      try {
        if (!evidence.quiescent) throw new FactoryError("delivery_active", evidence.repository_changes === "unknown" ? evidence.reason! : "Stop and reconcile owned work before verifying delivery", 409);
        const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
        const selected = project?.account_bindings?.[linked.machine_id]?.github;
        if (selected && selected !== linked.account_profile_id) throw new FactoryError("account_scope_changed", "Correct delivery links to use the Project's selected GitHub account", 409);
        delivery.changes = await this.changes(idea);
        const account = await this.runtime.accountSnapshot(linked.machine_id, { github: linked.account_profile_id });
        const read = async <T>(request: Omit<DeliveryReadRequest, "account_snapshot" | "repository">): Promise<T> => {
          if (this.scope(id) !== scope) throw new FactoryError("delivery_changed", "The Assignment changed during delivery verification", 409);
          return await this.runtime.deliveryRead(linked.machine_id, { ...request, repository: linked.repository, account_snapshot: account }) as T;
        };
        const tree = async (ref: string): Promise<Tree> => {
          const result = await read<Tree>({ kind: "tree", ref });
          if (result.truncated !== false || !Array.isArray(result.tree)) throw new FactoryError("delivery_incomplete", "GitHub tree evidence is incomplete; inspect and correct the delivery links", 409);
          return result;
        };
        const contains = (tree: Tree, file: DeliveryChange): boolean => {
          const entry = tree.tree.find(entry => entry.path === file.path);
          return file.oid === null ? !entry : entry?.sha === file.oid && entry.mode === file.mode && (!file.old_path || !tree.tree.some(entry => entry.path === file.old_path));
        };
        const target = await read<{ name: string; commit: { sha: string } }>({ kind: "branch", ref: linked.branch });
        if (target.name !== linked.branch || !oid(target.commit?.sha)) throw new FactoryError("delivery_wrong_target", "GitHub could not verify the frozen delivery branch", 409);
        delivery.branch_head = target.commit.sha;
        const covered = new Set<string>();
        for (const number of linked.pull_numbers) {
          const pull = await read<Pull>({ kind: "pull", number });
          if (pull.number !== number || pull.base?.repo?.full_name?.toLowerCase() !== linked.repository.toLowerCase() || pull.base.ref !== linked.branch) throw new FactoryError("delivery_wrong_target", `PR #${number} belongs to another repository or branch. Correct its delivery link.`, 409);
          if (!pull.merged || pull.state !== "closed" || !oid(pull.merge_commit_sha) || !oid(pull.head?.sha)) throw new FactoryError("delivery_unmerged", `PR #${number} is not verified merged. Merge it manually, correct its link, or discard this Assignment.`, 409);
          const comparison = await read<{ status?: string; merge_base_commit?: { sha: string } }>({ kind: "compare", base: pull.merge_commit_sha, head: target.commit.sha });
          if (!["ahead", "identical"].includes(comparison.status ?? "") || comparison.merge_base_commit?.sha !== pull.merge_commit_sha) throw new FactoryError("delivery_wrong_target", `PR #${number}'s merge is not contained in ${linked.branch}. Correct its link.`, 409);
          const changed = new Map<string, { status: string; sha: string; previous_filename?: string }>();
          let complete = false;
          for (let page = 1; page <= 30; page++) {
            const files = await read<{ filename: string; status: string; sha: string; previous_filename?: string }[]>({ kind: "files", number, page });
            if (!Array.isArray(files) || files.some(file => typeof file.filename !== "string" || typeof file.status !== "string" || !oid(file.sha))) throw new FactoryError("delivery_incomplete", "GitHub returned incomplete PR files", 409);
            for (const file of files) changed.set(file.filename, file);
            if (files.length < 100) { complete = true; break; }
          }
          if (!complete) throw new FactoryError("delivery_incomplete", "PR file coverage exceeds the verification budget", 409);
          const mergedTree = await tree(pull.merge_commit_sha);
          const paths = delivery.changes.filter(file => {
            const change = changed.get(file.path);
            return change && (file.oid === null ? change.status === "removed" : change.sha === file.oid) && (!file.old_path || change.previous_filename === file.old_path) && contains(mergedTree, file);
          }).map(file => file.path);
          if (!paths.length) throw new FactoryError("delivery_unrelated", `PR #${number} does not cover the intended changes. Correct its link or discard this Assignment.`, 409);
          for (const path of paths) covered.add(path);
          delivery.pulls.push({ number, url: `https://github.com/${linked.repository}/pull/${number}`, head: pull.head.sha, merge_commit: pull.merge_commit_sha, covered_paths: paths });
        }
        if (delivery.changes.some(file => !covered.has(file.path))) throw new FactoryError("delivery_partial", "Linked merges cover only part of the intended changes. Link every required delivery PR or discard this Assignment.", 409);
        const branchTree = await tree(target.commit.sha);
        if (delivery.changes.some(file => !contains(branchTree, file))) throw new FactoryError("delivery_partial", "The delivery branch does not contain all intended changes. Inspect its current content and correct the delivery evidence.", 409);
        const latestTarget = await read<{ name: string; commit: { sha: string } }>({ kind: "branch", ref: linked.branch });
        if (latestTarget.name !== linked.branch || latestTarget.commit?.sha !== target.commit.sha) throw new FactoryError("delivery_branch_changed", "The delivery branch changed during verification. Sync delivery again against its current revision.", 409);
        if (this.scope(id) !== scope) throw new FactoryError("delivery_changed", "The Assignment changed during delivery verification", 409);
        for (const run of this.store.list<FactoryRun>("runs", id)) {
          if (["completed", "cancelled", "failed"].includes(run.condition)) continue;
          if (run.action === "implement-spec" || run.action === "apply-retro") throw new FactoryError("delivery_active", "Complete the implementation's checks and review before finishing delivery", 409);
          await this.retainHandoff(run.id);
          await this.runtime.finishStep(run.id);
        }
        evidence = await new FactoryDelivery(this.store, this.runtime).inspect(id);
        if (!evidence.quiescent || JSON.stringify(await this.changes(this.idea(id))) !== JSON.stringify(delivery.changes)) throw new FactoryError("delivery_changes_changed", "Retained changes or owned work changed during verification. Reconcile them and sync delivery again.", 409);
        delivery.condition = "merged";
        if (idea.delivery_scope?.milestone === "release") delivery.problem = "Verified merges are retained. A containing release is still required to finish this Assignment.";
      } catch (error) {
        delivery.problem = error instanceof FactoryError ? error.message : "Delivery evidence is unavailable. Reconnect the Machine or verify the selected GitHub account, then sync again.";
      }
      if (this.scope(id) !== scope) throw new FactoryError("delivery_changed", "The Assignment changed during delivery verification; refresh before continuing", 409);
      const current = this.idea(id);
      this.store.db.transaction(() => {
        const done = delivery.condition === "merged" && current.delivery_scope?.milestone === "merge";
        this.store.put("implementations", { ...current, delivery, completion_evidence: { ...evidence, reason: delivery.problem }, ...(done ? { stage: "done", outcome: "merged" } : {}) });
        const previous = current.delivery;
        if (previous?.condition !== delivery.condition || previous.problem !== delivery.problem || JSON.stringify(previous.changes) !== JSON.stringify(delivery.changes) || JSON.stringify(previous.pulls) !== JSON.stringify(delivery.pulls)) this.store.event(id, done ? "assignment_delivered" : "delivery_observed", { revision: delivery.revision, condition: delivery.condition, problem: delivery.problem });
      })();
      return delivery;
    });
  }
}
