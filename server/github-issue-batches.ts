import { randomUUID } from "node:crypto";
import type { FactoryRun, Implementation } from "../shared/factory.ts";
import type { IssueBatch, IssueBatchProposal, IssueBatchesOverview, PlannedIssue } from "../shared/issue-batches.ts";
import type { IssueBatchAction } from "../shared/issue-batches.ts";
import type { ProjectGitHubPolicy, ProjectGitHubSource, ProjectIssueApproval } from "../shared/github-project.ts";
import type { Issue } from "./github-project.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryError } from "./factory-host.ts";

/** Retained plan proposals. Remote publication is a separate owner action. */
export class GitHubIssueBatches {
  constructor(private readonly store: FactoryStore, private readonly withPolicy: <T>(id: string, revision: string, operation: (context: { policy: ProjectGitHubPolicy; api: (path: string, extra?: string[]) => Promise<unknown>; importIssue: (issue: Issue) => ProjectGitHubSource }) => Promise<T>) => Promise<T>) {}
  private assignment(id: string): Implementation {
    const assignment = this.store.get<Implementation>("implementations", id);
    if (!assignment?.project_id) throw new FactoryError("project_required", "Select a Project for the originating plan", 409);
    return assignment;
  }
  overview(id: string): IssueBatchesOverview {
    this.assignment(id);
    return { batches: this.store.list<IssueBatch>("github_issue_batches", id) };
  }
  private batch(id: string, batchId: string, proof: IssueBatchAction): IssueBatch {
    this.assignment(id);
    const batch = this.store.get<IssueBatch>("github_issue_batches", batchId);
    if (!batch || batch.implementation_id !== id) throw new FactoryError("not_found", "Issue batch not found", 404);
    if (batch.revision !== proof.revision) throw new FactoryError("issue_batch_changed", "Inspect the current batch revision", 409);
    return batch;
  }
  async review(id: string, batchId: string, proof: IssueBatchAction, origin: string): Promise<IssueBatch> {
    const batch = this.batch(id, batchId, proof);
    if (batch.intents.length) throw new FactoryError("issue_batch_started", "Retain the reviewed scope of a started publication", 409);
    return this.withPolicy(batch.project_id, proof.policy_revision, async ({ policy }) => {
      this.batch(id, batchId, proof);
      const next: IssueBatch = { ...batch, condition: "reviewed", review: { revision: batch.revision, policy_revision: policy.revision, repository: policy.repository, account_profile_id: policy.account_profile_id, project_scope: policy.project_scope, reviewed_at: new Date().toISOString(), plan_url: `${origin}/#factory/${id}` } };
      this.store.put("github_issue_batches", next, id);
      this.store.event(id, "issue_batch_reviewed", { batch_id: batch.id, revision: batch.revision, policy_revision: policy.revision });
      return next;
    });
  }
  async publish(id: string, batchId: string, proof: IssueBatchAction): Promise<IssueBatch> {
    return this.deliver(id, batchId, proof, false);
  }
  async resume(id: string, batchId: string, proof: IssueBatchAction): Promise<IssueBatch> {
    return this.deliver(id, batchId, proof, true);
  }
  private async deliver(id: string, batchId: string, proof: IssueBatchAction, resume: boolean): Promise<IssueBatch> {
    const batch = this.batch(id, batchId, proof);
    if (batch.review?.revision !== batch.revision || batch.review.policy_revision !== proof.policy_revision) throw new FactoryError("issue_batch_review_required", "Review this exact batch and Project policy before publishing", 409);
    if (batch.condition === "confirmed") return batch;
    if (batch.intents.length && !resume) throw new FactoryError("issue_batch_uncertain", "Reconcile the retained publication intents before retrying", 409);
    return this.withPolicy(batch.project_id, proof.policy_revision, async ({ policy, api, importIssue }) => {
      const latest = this.batch(id, batchId, proof);
      if (latest.updated_at !== batch.updated_at || latest.review?.reviewed_at !== batch.review?.reviewed_at) throw new FactoryError("issue_batch_changed", "The publication scope changed", 409);
      if (batch.review!.repository !== policy.repository || batch.review!.account_profile_id !== policy.account_profile_id || batch.review!.project_scope !== policy.project_scope || this.assignment(id).project_id !== policy.id) throw new FactoryError("issue_batch_scope_changed", "Review this batch for the current Project repository and account", 409);
      const path = `repos/${policy.repository}/issues`;
      const save = () => { batch.updated_at = new Date().toISOString(); return this.store.put("github_issue_batches", batch, id); };
      const retain = (item: PlannedIssue, issue: Issue) => {
        if (issue.title !== item.title || issue.state !== "open" || issue.pull_request || issue.html_url !== `https://github.com/${policy.repository}/issues/${issue.number}`) throw new FactoryError("github_issue_unconfirmed", "The publication identity or scope was not confirmed", 409);
        const source = { ...importIssue(issue), publication_batch_id: batch.id, batch_item_key: item.key, originating_plan_id: id };
        this.store.put("github_sources", source, policy.id);
        return source;
      };
      const mutate = async (item: PlannedIssue, action: IssueBatch["intents"][number]["action"], number: number | null, body: string[]): Promise<Issue> => {
        const intent: IssueBatch["intents"][number] = { ...this.store.record(), item_key: item.key, action, condition: "sending", issue_number: number, problem: null };
        batch.intents.push(intent); save();
        try {
          const result = await api(path + (number === null ? "" : "/" + number), ["--method", number === null ? "POST" : "PATCH", ...body]) as Issue;
          if (number !== null && result.number !== number) throw new FactoryError("github_issue_unconfirmed", "GitHub returned another issue identity", 409);
          // Receipts include the observed issue, not just an HTTP success.
          retain(item, result);
          intent.condition = "confirmed"; intent.issue_number = result.number;
          save(); return result;
        } catch (error) {
          intent.condition = "uncertain"; intent.problem = error instanceof FactoryError ? error.message : "Inspect GitHub before retrying this publication"; save(); throw error;
        }
      };
      const confirm = (item: PlannedIssue, action: IssueBatch["intents"][number]["action"], number: number) => {
        for (const intent of batch.intents.filter(intent => intent.item_key === item.key && intent.action === action)) {
          intent.condition = "confirmed"; intent.issue_number = number; intent.problem = null;
        }
        save();
      };
      batch.condition = "publishing"; save();
      try {
        if (resume && batch.intents.length) {
          const inventory: Issue[] = [];
          for (let page = 1; page <= 100; page++) {
            const issues = await api(`${path}?state=all&per_page=30&page=${page}&sort=updated&direction=desc`);
            if (!Array.isArray(issues)) throw new FactoryError("github_invalid_response", "GitHub did not confirm a complete publication inventory", 409);
            inventory.push(...issues);
            if (issues.length < 30) break;
            if (page === 100) throw new FactoryError("github_inventory_limit", "Reconcile the publication within the bounded issue inventory", 409);
          }
          for (const item of batch.items) {
            const marker = `<!-- saurons-eye-batch:${batch.id}:${batch.revision}:${item.key} -->`;
            const matches = inventory.filter(issue => typeof issue.body === "string" && issue.body.includes(marker));
            const identity = batch.issues.find(issue => issue.key === item.key);
            const intents = batch.intents.filter(intent => intent.item_key === item.key && intent.action === "create");
            if (matches.length > 1 || (identity || intents.length) && matches.length !== 1) throw new FactoryError("github_creation_uncertain", "Confirm one GitHub issue for each retained batch item; do not recreate uncertain issues", 409);
            if (!matches.length) continue;
            const issue = matches[0]!;
            if (identity && (identity.number !== issue.number || identity.external_id !== issue.node_id) || intents.some(intent => intent.issue_number !== null && intent.issue_number !== issue.number)) throw new FactoryError("github_issue_unconfirmed", "The retained publication identity changed", 409);
            const source = retain(item, issue);
            if (!identity) batch.issues.push({ key: item.key, number: issue.number, external_id: issue.node_id, url: issue.html_url, implementation_id: source.implementation_id, links_confirmed: false });
            confirm(item, "create", issue.number);
          }
          for (const item of batch.items) {
            const identity = batch.issues.find(issue => issue.key === item.key);
            if (!identity) continue;
            const issue = inventory.find(issue => issue.number === identity.number)!;
            const linked = item.dependencies.every(dep => batch.issues.some(issue => issue.key === dep.key));
            if (issue.body !== this.issueBody(batch, item, false) && (!linked || issue.body !== this.issueBody(batch, item, true))) throw new FactoryError("github_issue_changed", "Restore the reviewed issue scope and dependency links before resuming publication", 409);
            const label = policy.triage_labels?.[item.ready_for_agent ? "ready-for-agent" : "needs-triage"] || (item.ready_for_agent ? "ready-for-agent" : "needs-triage");
            const labeled = batch.intents.some(intent => intent.item_key === item.key && intent.action === "label" && intent.condition === "confirmed");
            if ((issue.labels?.length || labeled) && (issue.labels?.length !== 1 || issue.labels[0]?.name !== label)) throw new FactoryError("github_issue_changed", "Restore the reviewed triage label before resuming publication", 409);
          }
        }
        for (const item of batch.items) {
          const identity = batch.issues.find(issue => issue.key === item.key);
          if (identity) {
            const issue = await api(`${path}/${identity.number}`) as Issue;
            retain(item, issue);
            if (issue.node_id !== identity.external_id) throw new FactoryError("github_issue_unconfirmed", "The retained issue identity changed", 409);
            continue;
          }
          const issue = await mutate(item, "create", null, ["-f", "title=" + item.title, "-f", "body=" + this.issueBody(batch, item, false)]);
          const source = retain(item, issue);
          batch.issues.push({ key: item.key, number: issue.number, external_id: issue.node_id, url: issue.html_url, implementation_id: source.implementation_id, links_confirmed: false }); save();
        }
        for (const item of batch.items) {
          const identity = batch.issues.find(issue => issue.key === item.key)!;
          const body = this.issueBody(batch, item, true);
          const current = await api(`${path}/${identity.number}`) as Issue;
          if (current.node_id !== identity.external_id || ![body, this.issueBody(batch, item, false)].includes(current.body ?? "")) throw new FactoryError("github_issue_changed", "Restore the reviewed issue scope before resuming publication", 409);
          if (current.body !== body) await mutate(item, "link", identity.number, ["-f", "body=" + body]);
          const observed = await api(`${path}/${identity.number}`) as Issue;
          if (observed.node_id !== identity.external_id || observed.body !== body) throw new FactoryError("github_links_unconfirmed", "Confirm the complete published dependency links before dispatch", 409);
          retain(item, observed); identity.links_confirmed = true; confirm(item, "link", identity.number);
        }
        for (const item of batch.items) {
          const identity = batch.issues.find(issue => issue.key === item.key)!;
          const label = policy.triage_labels?.[item.ready_for_agent ? "ready-for-agent" : "needs-triage"] || (item.ready_for_agent ? "ready-for-agent" : "needs-triage");
          const current = await api(`${path}/${identity.number}`) as Issue;
          retain(item, current);
          if (current.node_id !== identity.external_id || current.body !== this.issueBody(batch, item, true) || current.labels?.length && (current.labels.length !== 1 || current.labels[0]?.name !== label)) throw new FactoryError("github_issue_changed", "Restore the reviewed scope and triage label before resuming publication", 409);
          const issue = current.labels?.length === 1 && current.labels[0]?.name === label ? current : await mutate(item, "label", identity.number, ["-f", "labels[]=" + label]);
          if (issue.node_id !== identity.external_id || issue.body !== this.issueBody(batch, item, true) || issue.labels?.length !== 1 || issue.labels[0]?.name !== label) throw new FactoryError("github_issue_unconfirmed", "Confirm the reviewed scope and readiness label before dispatch", 409);
          const source = retain(item, issue);
          confirm(item, "label", identity.number);
          if (item.ready_for_agent) {
            const plan = { ...item.plan, dependencies: [...item.plan.dependencies, ...item.dependencies.map(dep => ({ repository: policy.repository, issue_number: batch.issues.find(issue => issue.key === dep.key)!.number, requires: dep.requires }))] };
            const approval: ProjectIssueApproval = { ...this.store.record(), source_id: source.id, issue_revision: source.revision, policy_revision: policy.revision, actor: "owner", origin: "owner", evidence_id: batch.id, plan };
            this.store.put("github_readiness", approval, policy.id);
          }
        }
        // A later mutation can race an external edit to an earlier issue. Confirm the whole
        // graph again before the single local release of the dispatch barrier.
        for (const item of batch.items) {
          const identity = batch.issues.find(issue => issue.key === item.key)!;
          const issue = await api(`${path}/${identity.number}`) as Issue;
          const label = policy.triage_labels?.[item.ready_for_agent ? "ready-for-agent" : "needs-triage"] || (item.ready_for_agent ? "ready-for-agent" : "needs-triage");
          retain(item, issue);
          if (issue.node_id !== identity.external_id || issue.body !== this.issueBody(batch, item, true) || issue.labels?.length !== 1 || issue.labels[0]?.name !== label) throw new FactoryError("github_issue_changed", "The published scope changed; reconcile the whole batch before dispatch", 409);
        }
        batch.condition = "confirmed"; batch.dispatch_ready = true; batch.problem = null; save();
        this.store.event(id, "issue_batch_published", { batch_id: batch.id, revision: batch.revision, issue_numbers: batch.issues.map(issue => issue.number) });
      } catch (error) {
        batch.condition = "held"; batch.dispatch_ready = false;
        batch.problem = error instanceof FactoryError ? error.message : "Publication needs reconciliation; retain all successful issues and intents"; save();
        this.store.event(id, "issue_batch_publication_held", { batch_id: batch.id, revision: batch.revision });
      }
      return batch;
    });
  }
  private issueBody(batch: IssueBatch, item: PlannedIssue, linked: boolean): string {
    const dependencies = linked ? [...item.plan.dependencies.map(dep => `- https://github.com/${dep.repository}/issues/${dep.issue_number} (${dep.requires})`), ...item.dependencies.map(dep => `- ${batch.issues.find(issue => issue.key === dep.key)!.url} (${dep.requires})`)].join("\n") || "None" : "Pending whole-batch publication";
    return `${item.body}\n\n## Acceptance criteria\n${item.plan.acceptance_criteria}\n\n## Deliverable\n${item.deliverable}\n\n## Dependencies\n${dependencies}\n\n## Confirmed testing seams\n${item.plan.testing_seams.map(seam => "- " + seam).join("\n")}\n\n## Planning decisions\n${item.plan.planning_decisions.map(decision => "- " + decision).join("\n") || "None"}\n\n[Originating plan](${batch.review!.plan_url}) · Assignment ${batch.implementation_id}${batch.run_id ? " · Run " + batch.run_id : ""}\n<!-- saurons-eye-batch:${batch.id}:${batch.revision}:${item.key} -->`;
  }
  propose(id: string, value: IssueBatchProposal): IssueBatch {
    const assignment = this.assignment(id);
    const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
    if (!text(value.title, 200) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.idempotency_key) || !Array.isArray(value.items) || !value.items.length || value.items.length > 50 || value.items.some(item => !item || typeof item !== "object")) throw new FactoryError("invalid_issue_batch", "Propose a bounded batch of independent deliverables");
    const keys = new Set(value.items.map(item => item.key));
    if (keys.size !== value.items.length) throw new FactoryError("invalid_issue_batch", "Use a unique key for each deliverable");
    for (const item of value.items) {
      const plan = item.plan;
      if (typeof item.key !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.key) || !text(item.title, 200) || !text(item.body, 30_000) || !text(item.deliverable, 10_000) || typeof item.ready_for_agent !== "boolean" || !Array.isArray(item.dependencies) || item.dependencies.length > 50 || item.dependencies.some(dep => !dep || !keys.has(dep.key) || dep.key === item.key || !["merge", "release"].includes(dep.requires)) || !plan || !text(plan.acceptance_criteria, 50_000) || !Array.isArray(plan.testing_seams) || !plan.testing_seams.length || plan.testing_seams.some(seam => !text(seam, 10_000)) || !Array.isArray(plan.planning_decisions) || plan.planning_decisions.some(decision => !text(decision, 10_000)) || !Array.isArray(plan.dependencies) || plan.dependencies.some(dep => !dep || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(dep.repository) || !Number.isSafeInteger(dep.issue_number) || dep.issue_number < 1 || !["merge", "release"].includes(dep.requires))) throw new FactoryError("invalid_issue_batch", "Retain acceptance, deliverable boundaries, dependencies and confirmed testing decisions");
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (item: PlannedIssue) => {
      if (visiting.has(item.key)) throw new FactoryError("invalid_issue_batch", "Deliverable dependencies must have no cycles");
      if (visited.has(item.key)) return;
      visiting.add(item.key); for (const dep of item.dependencies) visit(value.items.find(item => item.key === dep.key)!);
      visiting.delete(item.key); visited.add(item.key);
    };
    value.items.forEach(visit);
    if (value.run_id) {
      const run = this.store.get<FactoryRun>("runs", value.run_id);
      if (!run || run.implementation_id !== id || !["grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action)) throw new FactoryError("invalid_plan_run", "Link this Assignment's planning Run");
    }
    const existing = this.overview(id).batches.find(batch => batch.key === value.idempotency_key);
    if (existing && !value.batch_id) {
      if (existing.title !== value.title || JSON.stringify(existing.items) !== JSON.stringify(value.items) || existing.run_id !== (value.run_id ?? null)) throw new FactoryError("issue_batch_conflict", "This proposal key already belongs to another plan", 409);
      return existing;
    }
    const prior = value.batch_id ? this.overview(id).batches.find(batch => batch.id === value.batch_id) : null;
    if (value.batch_id && !prior || value.expected_revision !== (prior?.revision ?? null)) throw new FactoryError("issue_batch_changed", "Refresh the proposed batch before editing", 409);
    if (prior?.intents.length) throw new FactoryError("issue_batch_started", "Retain the reviewed scope and receipts of a started publication", 409);
    const batch: IssueBatch = { ...(prior ?? this.store.record()), implementation_id: id, project_id: assignment.project_id!, run_id: value.run_id ?? null, title: value.title, items: value.items, key: value.idempotency_key, revision: randomUUID(), condition: "proposed", review: null, dispatch_ready: false, issues: [], intents: [], problem: null, updated_at: new Date().toISOString() };
    this.store.put("github_issue_batches", batch, id);
    this.store.event(id, "issue_batch_proposed", { batch_id: batch.id, revision: batch.revision });
    return batch;
  }
}
