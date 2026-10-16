import { claudeInputDraft, noteSubmitted, viewportShowsLive } from "./prompt.ts";
import { paneRead, paneScrollInfo } from "./herdr/client.ts";
import { projectWorkflowPrompt } from "./factory-project-policy.ts";
import { writePrivateFile } from "./factory-files.ts";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactoryCheck, FactoryProject, FactoryRun, FactoryWorker } from "../shared/protocol.ts";
import { factoryPaneResting, factoryAgentArguments, type FactoryNative } from "./factory-native.ts";
import { prepareFactoryPrompt } from "./factory-prompt.ts";
import { FactoryError, git, hash, inspectCheckout, withinRoot } from "./factory-host.ts";
import { provisionFactoryAgent, provisionSkills, verifySkills } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";
import { factoryTrackerClient, factoryTrackerGuide } from "./factory-tracker-client.ts";
import { runFactoryCommand } from "./factory-command.ts";
import { recordScaffolding } from "./factory-cleanup.ts";
import { factoryEnvironment } from "./factory-environment.ts";
import type { AccountBindingSnapshot } from "../shared/accounts.ts";
import type { MachineAccounts } from "./accounts.ts";
import { preparedProjectReferences } from "./factory-reference-context.ts";

type Lease = { id: string; signature: string; run: FactoryRun; closing?: boolean };

/** The execution Machine owns Git/process operations; the connection server owns the task graph. */
export class FactoryWorktrees {
  private stopped = false;
  private readonly locks = new Set<string>();
  private readonly builds = new Map<string, { run_id: string; controller: AbortController; promise: Promise<FactoryCheck> }>();
  constructor(private readonly store: FactoryStore, private readonly native: FactoryNative, private readonly skillsPath: () => string | null, private readonly accounts?: MachineAccounts) {}
  private run(id: string, factoryRequired = true): FactoryRun {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Worktree control is disabled on a restored copy", 409);
    const lease = this.store.get<Lease>("host_leases", id);
    if (lease?.closing) throw new FactoryError("run_stopping", "This Run is stopping; no new native work or builds may start", 409);
    const run = lease?.run;
    if (!run?.worktree || !run.branch || !run.checkout || factoryRequired && run.action !== "implement-spec" || !["working", "ready", "needs_you", "blocked"].includes(run.condition)) throw new FactoryError("factory_run_required", "Use an observed, admitted repository Run", 409);
    if (realpathSync(run.worktree) !== run.worktree) throw new FactoryError("worktree_changed", "The Run's owned worktree changed", 409);
    return run;
  }
  private async identity(run: FactoryRun, worker?: FactoryWorker): Promise<string> {
    const path = worker?.worktree ?? run.worktree!;
    const expected = worker?.branch ?? run.branch;
    if (!path || realpathSync(path) !== path || (await git(path, ["branch", "--show-current"])).trim() !== expected || (await inspectCheckout(path)).repository !== (run.manifest as { checkout: { repository: string } }).checkout.repository) throw new FactoryError("worktree_changed", "The owned repository, branch or cwd changed", 409);
    return path;
  }
  async head(id: string): Promise<{ head: string; workspace_hash: string }> {
    const run = this.run(id, false); const path = await this.identity(run);
    return { head: (await git(path, ["rev-parse", "HEAD"])).trim(), workspace_hash: await this.workspaceHash(path) };
  }
  async reviewHead(id: string, workerId: string): Promise<string> {
    const run = this.run(id, false); const worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!worker || worker.run_id !== id || worker.role === "implementer") throw new FactoryError("independent_review_required", "Select an independent review context", 409);
    const path = await this.identity(run, worker); await this.quiescent(worker);
    const head = (await git(path, ["rev-parse", "HEAD"])).trim();
    if (head !== worker.base || (await git(path, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"])).trim()) throw new FactoryError("review_stale", "The independent reviewer changed its checked candidate", 409);
    return head;
  }
  private async workspaceHash(path: string): Promise<string> {
    const diff = await git(path, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    const untracked = (await git(path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((name) => name && !name.startsWith(".saurons-eye-") && !/^(\.agents|\.claude|\.opencode)\/skills\//.test(name));
    let budget = 0; const files = [];
    for (const name of untracked) {
      const file = join(path, name); const info = lstatSync(file);
      if (info.isSymbolicLink()) { files.push({ path: name, link: readlinkSync(file) }); continue; }
      budget += info.size;
      if (!info.isFile() || info.nlink > 1 || budget > 16 * 1024 * 1024) throw new FactoryError("workspace_too_large", "Untracked check inputs exceed the safe evidence budget", 413);
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { files.push({ path: name, hash: hash(readFileSync(descriptor)) }); } finally { closeSync(descriptor); }
    }
    return hash(JSON.stringify({ diff, files }));
  }
  async create(id: string, worker: FactoryWorker, context: unknown, access: unknown): Promise<FactoryWorker> {
    const run = this.run(id, worker.role === "implementer"); const parent = await this.identity(run);
    const previous = this.store.get<FactoryWorker>("host_workers", worker.id);
    if (previous) return previous;
    const tip = (await git(parent, ["rev-parse", "HEAD"])).trim();
    if (tip !== worker.base || worker.run_id !== id || !/^[a-f0-9-]{36}$/.test(worker.id)) throw new FactoryError("worker_base_changed", "The integration tip changed before this worker was accepted", 409);
    const root = join(dirname(parent), "workers", worker.id); const path = join(root, "checkout");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (existsSync(path)) throw new FactoryError("worktree_owned", "Unexpected worker files exist; preserve them", 409);
    let record = { ...worker, branch: `${run.branch}-${worker.role}-${worker.id}`, worktree: path };
    let nativeAttempted = false;
    this.store.put("host_workers", record, id); // Save intent before any Git or native allocation.
    try {
      await git(parent, ["worktree", "add", "-b", record.branch, path, tip]);
      provisionSkills(path, run.provider, verifySkills(this.skillsPath()));
      if (access) { writePrivateFile(join(path, ".saurons-eye-access.json"), JSON.stringify({ ...access as object, worker_id: worker.id }), { mode: 0o600, flag: "wx" }); writePrivateFile(join(path, ".saurons-eye-tracker.mjs"), factoryTrackerClient, { mode: 0o600, flag: "wx" }); }
      const project = (run.manifest as { project: FactoryProject }).project;
      const environment = factoryEnvironment(root, id, project.environment, worker.id);
      Object.assign(environment, await this.accounts?.environment((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot, true, path));
      const library = (run.manifest as { project_references?: import("../shared/protocol.ts").ProjectReferenceLibrary }).project_references;
      const referenceContext = library?.entries.length ? preparedProjectReferences(this.store.root, library) : undefined;
      writePrivateFile(join(path, ".saurons-eye-context.json"), JSON.stringify({ run, worker: record, context, project_reference_context: referenceContext, tracker_guide: factoryTrackerGuide, research_directory: join(dirname(run.worktree!), "notes"), environment: { notes: join(root, "notes"), cache: join(root, "cache"), state: join(root, "state"), temporary: join(root, "tmp") }, policy: "Only this worker owns writes here. Use approved testing seams. Consume versioned answers before work. Never create unmanaged children. Keep app scaffolding out of commits. Shared documents may only be written when listed in worker.shared_paths. Merge the integration tip before reporting a result; preserve conflicts for reconciliation." }, null, 2), { flag: "wx", mode: 0o600 });
      nativeAttempted = true;
      const workspace = await this.native.createWorkspace({ cwd: path, label: `saurons-eye-worker-${worker.id}`, env: environment });
      record = { ...record, workspace_id: workspace.workspace.workspace_id, pane_id: workspace.root_pane.pane_id }; this.store.put("host_workers", record, id);
      const current = this.store.get<Lease>("host_leases", id);
      if (!current || current.closing || !["working", "ready", "needs_you", "blocked"].includes(current.run.condition)) {
        await this.stop(id, worker.id);
        return { ...record, condition: "cancelled", waiting_reason: "The owner stopped the parent Run before this native launch" };
      }
      const selected = worker.role === "implementer" ? "tdd" : "code-review";
      provisionFactoryAgent(path, run.provider, selected, verifySkills(this.skillsPath()), worker.role !== "implementer", (run.manifest as { project?: FactoryProject }).project?.permission_mode, (run.manifest as { execution_preset?: import("../shared/agent-models.ts").AgentExecutionPreset }).execution_preset);
      const skillPrefix = `${run.provider === "codex" ? "$" : run.provider === "opencode" ? "@" : "/"}${selected}`;
      const prompt = `${skillPrefix} Read .saurons-eye-context.json. ${worker.role === "implementer" ? (worker.rework_batch_id ? "Read context.review_batch, context.findings and any immutable original reports. Repair only findings relevant to the accepted Ticket within its frozen scope; retain original anchors and do not resolve or rewrite reports. " : "") + "Implement only the accepted Ticket using its confirmed seams; the app's merger owns integration." : `Review only the ${worker.role === "standards" ? "Standards" : "Spec"} axis against the frozen scope. The fixed point is ${run.base}; review git diff ${run.base}...HEAD at the checked candidate ${worker.base}. The accepted Specification and execution plan in context are the Spec source. When context.human_feedback is present, independently verify every submitted comment against the repaired candidate and report unaddressed feedback or scope conflicts as findings. This app already supplies the separate Standards and Spec contexts: override the skill’s ordinary subagent-dispatch and aggregation steps, review only this assigned axis, and never spawn children or ask for a new fixed point. Keep this context independent of the other axis. Make no repository changes. End with FACTORY_REVIEW: PASS or FACTORY_REVIEW: FAIL and explain findings.`}${referenceContext ? ` ${referenceContext.prompt}` : ""}`;
      const launchPrompt = prepareFactoryPrompt(path, prompt + projectWorkflowPrompt((run.manifest as { project?: FactoryProject }).project), skillPrefix);
      recordScaffolding(this.store, worker.id, path, run.provider, verifySkills(this.skillsPath()));
      const args = factoryAgentArguments(run.provider, path, launchPrompt, worker.role !== "implementer", Boolean((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot?.profiles.some((entry) => entry.service === run.provider)), (run.manifest as { project?: import("../shared/factory.ts").FactoryProject }).project?.permission_mode, false, (run.manifest as { execution_preset?: import("../shared/agent-models.ts").AgentExecutionPreset }).execution_preset);
      await this.native.startAgent({ kind: run.provider, paneId: record.pane_id!, name: `eye-worker-${worker.id.replaceAll("-", "").slice(0, 21)}`, args, timeoutMs: 60_000 });
      const afterLaunch = this.store.get<FactoryWorker>("host_workers", worker.id);
      if (afterLaunch?.condition === "cancelled") return afterLaunch;
      const parentLease = this.store.get<Lease>("host_leases", id);
      if (!parentLease || parentLease.closing || !["working", "ready", "needs_you", "blocked"].includes(parentLease.run.condition)) { await this.stop(id, worker.id); return { ...record, condition: "cancelled", waiting_reason: "The owner stopped the parent Run during native launch" }; }
      record = { ...record, condition: "working", updated_at: new Date().toISOString() };
    } catch { record = this.store.get<FactoryWorker>("host_workers", worker.id)?.condition === "cancelled" ? { ...record, condition: "cancelled", waiting_reason: "The owner stopped this native context" } : { ...record, condition: nativeAttempted ? "interrupted" : "failed", waiting_reason: nativeAttempted ? "Worker dispatch is uncertain; reconcile its owned identity before retrying" : "Worker provisioning failed before native allocation; files are retained for inspection" }; }
    this.store.put("host_workers", record, id); return record;
  }
  private async quiescent(worker: FactoryWorker): Promise<void> {
    const snapshot = await this.native.snapshot();
    const pane = snapshot.panes.find((entry) => entry.pane_id === worker.pane_id);
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === worker.workspace_id);
    const provider = this.store.get<Lease>("host_leases", worker.run_id)?.run.provider;
    if (!pane?.cwd || !provider || realpathSync(pane.cwd) !== worker.worktree || workspace?.label !== `saurons-eye-worker-${worker.id}` || !await factoryPaneResting(this.native, pane, provider)) throw new FactoryError("worker_busy", "Verify the worker is ready at its owned cwd before Git control", 409);
  }
  async send(id: string, workerId: string, text: string): Promise<void> {
    const run = this.run(id, false);
    const worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!worker || worker.run_id !== id || !["working", "ready", "needs_you", "blocked"].includes(worker.condition)) throw new FactoryError("run_unavailable", "Reconcile the owned child before resuming", 409);
    await this.identity(run, worker);
    await this.quiescent(worker);
    if (run.provider === "claude") {
      const before = (await paneRead({ paneId: worker.pane_id!, source: "detection", format: "text" })).text;
      const scrollBefore = await paneScrollInfo(worker.pane_id!);
      const shown = (await paneRead({ paneId: worker.pane_id!, source: "visible", format: "ansi" })).text;
      const scrollAfter = await paneScrollInfo(worker.pane_id!);
      const after = (await paneRead({ paneId: worker.pane_id!, source: "detection", format: "text" })).text;
      if (before !== after || claudeInputDraft(after, viewportShowsLive(scrollBefore, scrollAfter, shown, before, after) ? shown : null)) throw new FactoryError("input_draft", "The native child input contains a draft; inspect it before resuming", 409);
    }
    await this.native.prompt(worker.pane_id!, text, undefined, () => {
      const lease = this.store.get<Lease>("host_leases", id);
      const current = this.store.get<FactoryWorker>("host_workers", workerId);
      return !this.stopped && !!lease && !lease.closing && !!current && ["working", "ready", "needs_you", "blocked"].includes(current.condition);
    });
    noteSubmitted(worker.pane_id!, text);
  }
  async reconcile(id: string, workerId: string): Promise<FactoryWorker> {
    const run = this.store.get<Lease>("host_leases", id)?.run; const worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!run?.worktree || !run.branch || !run.checkout) throw new FactoryError("not_found", "Owned Run not found", 404);
    if (!worker || worker.run_id !== id) throw new FactoryError("not_found", "Worker not found", 404);
    if (["cancelled", "completed", "failed"].includes(worker.condition)) return worker;
    let next = worker;
    try {
      await this.identity(run, worker);
      const snapshot = await this.native.snapshot();
      const matches = snapshot.workspaces.filter((entry) => entry.label === `saurons-eye-worker-${worker.id}`);
      const workspace = worker.workspace_id ? snapshot.workspaces.find((entry) => entry.workspace_id === worker.workspace_id) : matches.length === 1 ? matches[0] : undefined;
      const candidates = snapshot.panes.filter((entry) => entry.workspace_id === workspace?.workspace_id && entry.cwd === worker.worktree);
      const pane = worker.pane_id ? snapshot.panes.find((entry) => entry.pane_id === worker.pane_id) : candidates.length === 1 ? candidates[0] : undefined;
      if (!pane?.cwd || realpathSync(pane.cwd) !== worker.worktree || workspace?.label !== `saurons-eye-worker-${worker.id}`) throw new FactoryError("native_identity_uncertain", "The worker's native identity changed; preserve ownership", 409);
      next = { ...worker, workspace_id: workspace.workspace_id, pane_id: pane.pane_id };
      if (pane.agent !== run.provider) next = { ...next, condition: "interrupted", waiting_reason: "Native provider launch is unconfirmed; no retry was sent" };
      else if (pane.agent_status === "blocked") next = { ...next, condition: "needs_you", waiting_reason: "The native worker is waiting for an owner answer" };
      else if (await factoryPaneResting(this.native, pane, run.provider)) next = { ...next, condition: "ready", waiting_reason: "Worker is ready; explicitly check and integrate its result" };
      else if (["working", "idle", "done"].includes(pane.agent_status)) next = { ...next, condition: "working", waiting_reason: null };
      else throw new FactoryError("native_identity_uncertain", "Native worker status is unknown; preserve ownership", 409);
    }
    catch (error) { next = { ...next, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The worker cannot currently be observed" }; }
    const current = this.store.get<FactoryWorker>("host_workers", workerId);
    if (current && JSON.stringify(current) !== JSON.stringify(worker)) return current;
    this.store.put("host_workers", next, id); return next;
  }
  async refresh(id: string, workerId: string): Promise<FactoryWorker> {
    const run = this.run(id); const worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!worker || worker.run_id !== id || worker.role !== "implementer") throw new FactoryError("invalid_worker", "Select this Run's implementer");
    const path = await this.identity(run, worker); await this.quiescent(worker);
    if ((await git(path, ["diff", "--name-only", "HEAD", "--"])).trim()) throw new FactoryError("dirty_worker", "Commit or preserve the worker's changes before reconciliation", 409);
    const tip = (await git(run.worktree!, ["rev-parse", "HEAD"])).trim();
    try { await git(path, ["merge", "--no-edit", tip]); }
    catch { throw new FactoryError("integration_conflict", "The candidate could not merge the current integration tip; preserve the worktree and resolve its conflicts", 409); }
    const next: FactoryWorker = { ...worker, integration_tip: tip, head: (await git(path, ["rev-parse", "HEAD"])).trim(), condition: "ready", waiting_reason: "Run checks before integration", updated_at: new Date().toISOString() };
    this.store.put("host_workers", next, id); return next;
  }
  async check(id: string, workerId: string | null, check: FactoryCheck): Promise<FactoryCheck> {
    const previous = this.store.get<FactoryCheck>("host_checks", check.id);
    if (previous) return this.builds.get(check.id)?.promise ?? previous;
    this.store.put("host_checks", check, id);
    const controller = new AbortController();
    const promise = this.performCheck(id, workerId, check, controller.signal);
    this.builds.set(check.id, { run_id: id, controller, promise });
    try { const result = await promise; this.store.put("host_checks", result, id); return result; }
    finally { this.builds.delete(check.id); }
  }
  private async performCheck(id: string, workerId: string | null, check: FactoryCheck, signal: AbortSignal): Promise<FactoryCheck> {
    const run = this.run(id, false); const worker = workerId ? this.store.get<FactoryWorker>("host_workers", workerId) : null;
    if (workerId && (!worker || worker.run_id !== id)) throw new FactoryError("invalid_worker", "Select this Run's worker");
    const path = await this.identity(run, worker ?? undefined);
    if (worker) await this.quiescent(worker);
    const project = (run.manifest as { project: FactoryProject }).project;
    const head = (await git(path, ["rev-parse", "HEAD"])).trim(); const before = await this.workspaceHash(path);
    const results: FactoryCheck["commands"] = [];
    const root = worker ? dirname(path) : dirname(run.worktree!);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), ...factoryEnvironment(root, id, project.environment, workerId ?? undefined) };
    Object.assign(env, await this.accounts?.environment((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot, true, path));
    const deadline = Date.now() + 300_000;
    for (const args of [...project.setup ?? [], ...project.checks ?? []]) {
      const result = await runFactoryCommand(args, path, env, signal, deadline - Date.now());
      results.push(this.accounts?.sanitize({ args, ...result }) ?? { args, ...result }); if (result.exit_code || signal.aborted) break;
    }
    const unchanged = head === (await git(path, ["rev-parse", "HEAD"])).trim() && before === await this.workspaceHash(path);
    return { ...check, head, workspace_hash: before, commands: results, condition: unchanged && results.length > 0 && results.every((entry) => entry.exit_code === 0) ? "passed" : "failed", updated_at: new Date().toISOString() };
  }
  reconcileCheck(id: string, checkId: string): FactoryCheck {
    const check = this.store.get<FactoryCheck>("host_checks", checkId);
    if (!check || check.run_id !== id) throw new FactoryError("not_found", "Owned check not found", 404);
    return check.condition === "working" && !this.builds.has(checkId) ? { ...check, condition: "interrupted" } : check;
  }
  async stopChecks(id: string): Promise<void> {
    const builds = [...this.builds.values()].filter((build) => build.run_id === id);
    for (const build of builds) build.controller.abort();
    await Promise.allSettled(builds.map((build) => build.promise));
    const unknown = this.store.list<FactoryCheck>("host_checks", id).find(check => ["working", "interrupted"].includes(check.condition) && !this.builds.has(check.id));
    if (unknown) throw new FactoryError("build_identity_uncertain", `Retained build ${unknown.id} has no live cancellation handle; its shutdown remains unconfirmed`, 409);
  }
  shutdown(): void { this.stopped = true; for (const build of this.builds.values()) build.controller.abort(); }
  async stopWorkers(id: string): Promise<void> {
    const workers = this.store.list<FactoryWorker>("host_workers", id).filter(worker => worker.condition !== "cancelled" && (worker.workspace_id || !["completed", "failed"].includes(worker.condition)));
    const results = await Promise.allSettled(workers.map(worker => this.stop(id, worker.id)));
    const failed = results.findIndex(result => result.status === "rejected");
    if (failed !== -1) throw new FactoryError("native_identity_uncertain", `Child ${workers[failed]!.id} shutdown is unconfirmed; its ownership is retained`, 409);
  }
  async integrate(id: string, workerId: string, expectedTip: string): Promise<FactoryWorker> {
    const run = this.run(id); const worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!worker || worker.run_id !== id || worker.role !== "implementer") throw new FactoryError("invalid_worker", "Select an implementer result");
    if (this.locks.has(id)) throw new FactoryError("integration_busy", "The merger currently owns the integration writer", 409);
    this.locks.add(id);
    try {
      const parent = await this.identity(run); const path = await this.identity(run, worker);
      const tip = (await git(parent, ["rev-parse", "HEAD"])).trim(); const head = (await git(path, ["rev-parse", "HEAD"])).trim();
      if (worker.condition !== "completed") await this.quiescent(worker);
      if (worker.head === head && (await git(parent, ["merge-base", tip, head])).trim() === head) {
        const integrated: FactoryWorker = { ...worker, condition: "completed", updated_at: new Date().toISOString() };
        this.store.put("host_workers", integrated, id); return integrated;
      }
      if (worker.condition === "completed") throw new FactoryError("worker_stale", "The previously merged candidate changed; preserve its worktree for inspection", 409);
      if (tip !== expectedTip || tip !== worker.integration_tip || !worker.head || head !== worker.head || (await git(path, ["diff", "--name-only", "HEAD", "--"])).trim() || (await git(parent, ["diff", "--name-only", "HEAD", "--"])).trim()) throw new FactoryError("worker_stale", "Reconcile the worker against the current integration tip and rerun checks", 409);
      await git(path, ["merge-base", "--is-ancestor", tip, head]);
      const files = (await git(path, ["diff", "--name-only", tip, head, "--"])).trim().split("\n");
      const project = (run.manifest as { project: FactoryProject }).project;
      if (files.some((file) => file.startsWith(".saurons-eye-") || file === ".opencode/agents/saurons-eye.md" || /^(\.agents|\.claude|\.opencode)\/skills\//.test(file))) throw new FactoryError("scaffolding_committed", "Remove application scaffolding from the candidate commits before integration", 409);
      if (files.some((file) => (project.shared_paths ?? []).some((shared) => file === shared || file.startsWith(shared.endsWith("/") ? shared : shared + "/")) && !worker.shared_paths.some((shared) => file === shared || file.startsWith(shared.endsWith("/") ? shared : shared + "/")))) throw new FactoryError("shared_writer_required", "Assign ownership for changed shared documents before integration", 409);
      // This serialized backend merger is the only integration writer. Never reset or force.
      await git(parent, ["merge", "--ff-only", head]);
      const next: FactoryWorker = { ...worker, condition: "completed", head, updated_at: new Date().toISOString() };
      this.store.put("host_workers", next, id); return next;
    } finally { this.locks.delete(id); }
  }
  async stop(id: string, workerId: string): Promise<void> {
    let worker = this.store.get<FactoryWorker>("host_workers", workerId);
    if (!worker || worker.run_id !== id) throw new FactoryError("invalid_worker", "Select this Run's worker");
    if (worker.condition === "cancelled") return;
    if (!worker.workspace_id || !worker.pane_id) worker = await this.reconcile(id, workerId);
    const snapshot = await this.native.snapshot();
    const pane = snapshot.panes.find((entry) => entry.pane_id === worker.pane_id);
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === worker.workspace_id);
    let unchanged = false;
    try { unchanged = !!worker.worktree && realpathSync(worker.worktree) === worker.worktree; } catch { /* Unavailable work retains ownership. */ }
    const couldOwn = (cwd: string | null | undefined): boolean => {
      if (!cwd || !worker.worktree) return false;
      try { const path = realpathSync(cwd); return path === worker.worktree || withinRoot(worker.worktree, path); } catch { return true; }
    };
    if (unchanged && worker.workspace_id && worker.pane_id && !workspace && !pane && !snapshot.workspaces.some(w => w.label === `saurons-eye-worker-${worker.id}`) && !snapshot.panes.some(p => !p.cwd && !p.foreground_cwd || couldOwn(p.cwd) || couldOwn(p.foreground_cwd))) {
      this.store.put("host_workers", { ...worker, condition: worker.condition === "completed" ? "completed" : "cancelled" }, id); return;
    }
    if (!pane?.cwd || realpathSync(pane.cwd) !== worker.worktree || workspace?.label !== `saurons-eye-worker-${worker.id}`) throw new FactoryError("native_identity_uncertain", "The worker's native identity is uncertain; preserve ownership", 409);
    await this.native.closeWorkspace(workspace.workspace_id);
    this.store.put("host_workers", { ...worker, condition: worker.condition === "completed" ? "completed" : "cancelled" }, id);
  }
}
