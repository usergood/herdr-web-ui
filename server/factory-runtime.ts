import { agentCapacityPool } from "./factory-capacity.ts";
import { FactoryParking } from "./factory-parking.ts";
import { FactoryDispatch } from "./factory-dispatch.ts";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FactoryAutomaticExecution, FactoryExecutionPlan } from "../shared/factory.ts";
import type { FactoryHostRequests, FactoryAction, FactoryApproval, FactoryArtifact, FactoryMessage, FactoryOutput, FactoryProject, FactoryProvider, FactoryRun, FactorySettings, Implementation, ProjectCheckout } from "../shared/protocol.ts";
import { FactoryError, git, hash, inspectCheckout } from "./factory-host.ts";
import { FactoryExecutionHost } from "./factory-execution-host.ts";
import { bundlePayload, verifySkills } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryReferences } from "./factory-references.ts";
import type { CodexReferenceContext } from "../shared/protocol.ts";
import type { AccountBindingSnapshot, ProjectAccountBindings } from "../shared/accounts.ts";
import type { AccountOverview, AccountProfile, AccountSetup } from "../shared/accounts.ts";
import type { MachineAccounts } from "./accounts.ts";
import { validPermissionMode } from "../shared/agent-permissions.ts";
import { parseModelSelection, resolveModelSelection } from "./agent-model-selection.ts";

export type MachineEndpoint = (machineId: string) => { url: string; token: string } | undefined;
type HostCapabilities = Awaited<ReturnType<FactoryExecutionHost["capabilities"]>>;
const activeConditions = new Set(["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted"]);
const actions: FactoryAction[] = ["work", "setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets", "implement-spec", "retro", "apply-retro", "verify-provider"];
export class FactoryRuntime {
  reconcileDeletion: ((id: string) => Promise<unknown>) | null = null;
  retainBeforePause: ((id: string, workerId?: string) => Promise<void>) | null = null;
  private readonly pausing = new Map<string, Promise<void>>();
  readonly queue: FactoryDispatch;
  private readonly parking: FactoryParking;
  private readonly dispatches = new Map<string, Promise<FactoryRun>>();
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly settings: () => FactorySettings, private readonly host: FactoryExecutionHost, private readonly endpoint: MachineEndpoint, private readonly readArtifact: (record: FactoryArtifact) => Buffer, private readonly publicUrl: string | null, private readonly references: FactoryReferences, private readonly accounts: MachineAccounts) {
    this.queue = new FactoryDispatch(store, () => this.reconcileCapacity(), (id, body, origin) => this.start(id, body, origin, undefined, true));
    this.queue.maintenance = async () => {
      for (const idea of store.list<Implementation>("implementations")) if (idea.deletion) await this.reconcileDeletion?.(idea.id);
      for (const idea of store.list<Implementation>("implementations")) if (idea.pause?.condition === "pending") await this.reconcilePause(idea.id);
      for (const run of store.list<FactoryRun>("runs")) {
        const idea = store.get<Implementation>("implementations", run.implementation_id);
        if (idea?.pause || idea?.deletion) continue;
        const targets = [run, ...store.list<import("../shared/factory.ts").FactoryWorker>("workers", run.id)];
        for (const target of targets) if (target.suspension && target.suspension.condition !== "stopped") {
          try {
            const result = await this.operation<FactoryRun | import("../shared/factory.ts").FactoryWorker>(run, "resume-status", { pause_id: target.suspension.pause_id, ...(target.id !== run.id ? { worker_id: target.id } : {}) });
            this.completeResumption(run, target, result);
          } catch { /* Unknown execution keeps its reservation; observation never launches. */ }
        }
      }
    };
    this.queue.resumeSuspension = (id, body) => this.resumeSuspension(id, body);
    this.parking = new FactoryParking(store, workflow, this.queue, planning => agentCapacityPool(store, settings(), planning), (run, text, signal, worker) => worker ? this.operation(run, "send-worker", { worker_id: worker.id, text }).then(() => {}) : this.deliver(run, text, signal));
  }
  async requestStart(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryRun | import("../shared/factory.ts").FactoryCapacityWait> {
    this.assertExecuting(id);
    if (!actions.includes(body.action as FactoryAction) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_start", "Select an explicit action with an idempotency key");
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea) throw new FactoryError("not_found", "Assignment not found", 404);
    const existing = this.store.list<FactoryRun>("runs", id).find(run => run.idempotency_key === body.idempotency_key);
    if (existing) return this.start(id, body, origin);
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Execution is disabled on a restored copy", 409);
    const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    const action = body.action as FactoryAction;
    const planning = ["grill-me", "grill-with-docs"].includes(action) || action === "to-spec" && !this.workflow.approved(id, "specification", this.workflow.specification(id)?.id ?? "");
    return this.queue.start({ ...this.store.record(), id: `${id}:${body.idempotency_key}`, implementation_id: id, assignment_title: idea.title, action, machine_id: idea.machine_id ?? project?.machine_id ?? "local", provider: idea.provider ?? project?.provider ?? this.settings().provider, idempotency_key: body.idempotency_key, reason: "Waiting for agent capacity", purpose: planning ? "planning" : "execution", condition: "queued", run_id: null }, body, origin);
  }
  assertExecuting(id: string): void {
    const idea = this.store.get<Implementation>("implementations", id);
    if (idea?.deletion || this.store.get("deleted_assignments", id)) throw new FactoryError("assignment_deleting", "This Assignment has a permanent Delete; execution cannot resume", 409);
    if (idea?.pause) throw new FactoryError("assignment_paused", "Resume this Assignment before starting execution", 409);
  }
  async pauseAssignment(id: string, resume = false): Promise<Implementation> {
    const idea = this.store.get<Implementation>("implementations", id);
    if (!idea) throw new FactoryError("not_found", "Assignment not found", 404);
    if (idea.deletion) throw new FactoryError("assignment_deleting", "This Assignment has a pending permanent Delete; execution cannot resume", 409);
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Execution control is disabled on a restored copy", 409);
    if (resume) {
      if (idea.pause?.condition === "pending") throw new FactoryError("pause_pending", "Wait for confirmed shutdown before resuming", 409);
      return this.store.db.transaction(() => {
        for (const run of this.store.list<FactoryRun>("runs", id)) {
          const progress = this.store.get<FactoryAutomaticExecution>("automatic_execution", run.id);
          const plan = this.store.get<FactoryExecutionPlan>("execution_plans", run.id);
          // Only exhausted recoverable observations carry a future retry time.
          // Genuine validation failures retain their zero deadline and evidence.
          // A repeated Resume without a confirmed Pause grants no new budget.
          if (idea.pause?.condition === "paused" && progress?.condition === "blocked" && progress.attempts >= 6 && progress.next_attempt_at > 0 && plan
            && progress.plan_hash === plan.hash && run.specification_id === plan.specification_id
            && this.workflow.specification(id)?.id === run.specification_id && this.workflow.approved(id, "specification", run.specification_id)
            && this.workflow.graphHash(id) === plan.hash && !this.workflow.questions(id, run.id).some(question => question.answer === null)) {
            this.store.put("automatic_execution", { ...progress, condition: "waiting", reason: "Owner Resume renewed bounded recovery of retained unfinished work", attempts: 0, next_attempt_at: 0, updated_at: new Date().toISOString() }, id);
            this.store.event(id, "automatic_execution_recovery_resumed", { run_id: run.id, pause_id: idea.pause.id, reason: progress.reason, attempts: progress.attempts });
          }
          const workers = this.store.list<import("../shared/factory.ts").FactoryWorker>("workers", run.id);
          for (const target of [...workers, run]) {
            if (target.suspension?.condition !== "stopped" || !activeConditions.has(target.condition) || !activeConditions.has(target.suspension.previous_condition)) continue;
            this.enqueueSuspension(idea, run, target);
          }
        }
        const { pause: _pause, ...next } = idea;
        this.store.put("implementations", next);
        return next;
      }).immediate();
    }
    const next: Implementation = { ...idea, pause: idea.pause ?? { id: this.store.record().id, condition: "pending", reasons: [] } };
    this.store.put("implementations", next);
    await this.reconcilePause(id);
    return this.store.get<Implementation>("implementations", id)!;
  }
  private planning(run: Pick<FactoryRun, "action" | "implementation_id">): boolean {
    const specification = this.workflow.specification(run.implementation_id);
    return ["grill-me", "grill-with-docs"].includes(run.action) || run.action === "to-spec" && (!specification || !this.workflow.approved(run.implementation_id, "specification", specification.id));
  }
  private enqueueSuspension(idea: Implementation, run: FactoryRun, target: FactoryRun | import("../shared/factory.ts").FactoryWorker): void {
    const suspension = target.suspension!;
    const queuedAt = suspension.queued_at ?? new Date().toISOString();
    this.store.put(target.id === run.id ? "runs" : "workers", { ...target, suspension: { ...suspension, queued_at: queuedAt } }, target.id === run.id ? idea.id : run.id);
    this.queue.enqueueContinuation({ ...this.store.record(), created_at: queuedAt, id: `suspension:${suspension.pause_id}:${target.id}`, implementation_id: idea.id, assignment_title: idea.title, action: run.action, machine_id: run.machine_id, provider: run.provider, idempotency_key: suspension.pause_id, reason: "Waiting for capacity to continue unfinished work", purpose: target.id === run.id && this.planning(run) ? "planning" : "execution", condition: "queued", run_id: run.id, continuation: true }, { suspension: true, pause_id: suspension.pause_id, ...(target.id !== run.id ? { worker_id: target.id } : {}) });
  }
  async resumeSuspension(id: string, body: Record<string, unknown>): Promise<void> {
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) return;
    this.assertExecuting(run.implementation_id);
    const workerId = typeof body.worker_id === "string" ? body.worker_id : null;
    const kind = workerId ? "workers" : "runs";
    const target = this.store.get<FactoryRun | import("../shared/factory.ts").FactoryWorker>(kind, workerId ?? id);
    if (!target?.suspension || target.suspension.pause_id !== body.pause_id) return;
    if (target.suspension.condition !== "stopped") return;
    const graphHash = this.store.get<{ hash: string }>("execution_plans", run.id)?.hash ?? run.graph_hash;
    if (run.specification_id && (this.workflow.specification(run.implementation_id)?.id !== run.specification_id || !this.workflow.approved(run.implementation_id, "specification", run.specification_id)) || graphHash && this.workflow.graphHash(run.implementation_id) !== graphHash) throw new FactoryError("scope_changed", "The accepted scope changed while paused; reconcile its authority before continuing", 409);
    if (this.workflow.questions(run.implementation_id, run.id).some(q => q.answer === null)) throw new FactoryError("answers_unready", "Answer pending owner questions before continuing", 409);
    const reserved = this.store.db.transaction(() => {
      this.assertExecuting(run.implementation_id);
      const pool = agentCapacityPool(this.store, this.settings(), !workerId && this.planning(run));
      const reservation = { ...target, condition: "accepted" as const, ...(!workerId ? { capacity_pool: pool } : {}), suspension: { ...target.suspension!, condition: "resuming" as const } };
      this.store.put(kind, reservation, workerId ? id : run.implementation_id);
      return reservation;
    }).immediate();
    try {
      const snapshot = this.store.list<import("../shared/factory.ts").NativeConversationSnapshot>("native_snapshots", id).filter(entry => (entry.worker_id ?? null) === workerId).at(-1);
      const history = snapshot ? `Retained native snapshot ${snapshot.id} (${snapshot.source_id}).${snapshot.cursor ? " Earlier pages remain in retained Assignment history." : ""}\n` + snapshot.turns.map(turn => `${turn.role}: ${turn.parts.flatMap(part => part.kind === "text" || part.kind === "compact" ? [part.text] : []).join("\n")}`).join("\n\n").slice(-48_000) : "No native transcript page could be captured; the original provider store and all previously retained Assignment history remain preserved. Inspect the retained files and current tracker evidence before continuing.";
      const result = await this.operation<FactoryRun | import("../shared/factory.ts").FactoryWorker>(run, "resume-context", { ...body, history });
      this.completeResumption(run, reserved, result);
    } catch {
      if (!this.stopped && JSON.stringify(this.store.get(kind, target.id)) === JSON.stringify(reserved)) this.store.put(kind, { ...reserved, condition: "disconnected", suspension: { ...reserved.suspension, condition: "uncertain" }, waiting_reason: "Continuation outcome is uncertain; reservation retained without replay" }, workerId ? id : run.implementation_id);
    }
  }
  private completeResumption(run: FactoryRun, expected: FactoryRun | import("../shared/factory.ts").FactoryWorker, result: FactoryRun | import("../shared/factory.ts").FactoryWorker): void {
    const worker = "run_id" in expected;
    const neverStarted = result.suspension?.condition === "stopped" && result.suspension.pause_id === expected.suspension?.pause_id;
    if (result.id !== expected.id || result.worktree !== expected.worktree || result.branch !== expected.branch || result.suspension && !neverStarted || !["working", "ready", "needs_you"].includes(result.condition)) throw new FactoryError("resume_uncertain", "The Machine did not confirm the retained continuation", 409);
    if (worker) {
      if (!("run_id" in result) || result.run_id !== run.id || result.ticket_id !== expected.ticket_id || result.role !== expected.role || result.base !== expected.base) throw new FactoryError("resume_uncertain", "The Machine returned another child identity", 409);
    } else this.observed({ ...expected, pane_id: null, workspace_id: null, suspension: undefined }, result as FactoryRun);
    const kind = worker ? "workers" : "runs";
    if (this.stopped || this.store.get<Implementation>("implementations", run.implementation_id)?.pause || JSON.stringify(this.store.get(kind, expected.id)) !== JSON.stringify(expected)) return;
    if (neverStarted) {
      this.enqueueSuspension(this.store.get<Implementation>("implementations", run.implementation_id)!, run, { ...expected, condition: "ready", suspension: { ...expected.suspension!, condition: "stopped" } });
      return;
    }
    const { suspension: _suspension, ...next } = { ...expected, ...result };
    if (next.continuation) {
      this.store.remove("capacity_waits", `resume:${next.continuation.id}`);
      next.continuation = { ...next.continuation, condition: "resumed", reason: "Owner Resume continued the retained work", question_revision: this.workflow.questionRevision(run.implementation_id, run.id) };
    }
    this.store.put(kind, { ...next, ...(!worker ? { capacity_pool: (expected as FactoryRun).capacity_pool } : {}) }, worker ? run.id : run.implementation_id);
  }
  private reconcilePause(id: string): Promise<void> {
    const pending = this.pausing.get(id);
    if (pending) return pending;
    const operation = this.performPause(id).finally(() => this.pausing.delete(id));
    this.pausing.set(id, operation);
    return operation;
  }
  private async performPause(id: string): Promise<void> {
    const idea = this.store.get<Implementation>("implementations", id);
    if (idea?.pause?.condition !== "pending") return;
    const pauseId = idea.pause.id; const reasons: string[] = [];
    for (const run of this.store.list<FactoryRun>("runs", id)) {
      const workers = this.store.list<import("../shared/factory.ts").FactoryWorker>("workers", run.id);
      const checks = this.store.list<import("../shared/factory.ts").FactoryCheck>("checks", run.id).filter(c => ["working", "interrupted"].includes(c.condition));
      if (run.suspension?.pause_id === pauseId && run.suspension.condition === "stopped") continue;
      if (!activeConditions.has(run.condition) && !workers.some(w => activeConditions.has(w.condition)) && !checks.length) continue;
      const uncertain = (target: FactoryRun | import("../shared/factory.ts").FactoryWorker) => ({ ...target, suspension: { pause_id: pauseId, condition: "uncertain" as const, previous_condition: target.suspension?.previous_condition ?? target.condition } });
      this.store.db.transaction(() => {
        if (activeConditions.has(run.condition)) this.store.put("runs", uncertain(run), id);
        for (const worker of workers) if (activeConditions.has(worker.condition)) this.store.put("workers", uncertain(worker), run.id);
      }).immediate();
      try {
        if (this.dispatches.has(run.id)) throw new FactoryError("allocation_pending", "Waiting for accepted allocation to settle", 409);
        // Capture before closing native workspaces. A missing transcript must never prevent shutdown.
        await this.retainBeforePause?.(run.id).catch(() => {});
        for (const worker of workers.filter(w => activeConditions.has(w.condition))) await this.retainBeforePause?.(run.id, worker.id).catch(() => {});
        const result = await this.operation<import("../shared/factory.ts").FactoryPauseResult>(run, "pause", { pause_id: pauseId });
        this.observed(run, result.run);
        if (result.run.id !== run.id || result.run.implementation_id !== id || result.run.suspension?.pause_id !== pauseId || result.run.suspension.condition !== "stopped" || result.run.worktree !== run.worktree || result.workers.some(w => w.run_id !== run.id || activeConditions.has(w.condition) && (w.suspension?.condition !== "stopped" || w.suspension.pause_id !== pauseId)) || workers.some(w => activeConditions.has(w.condition) && !result.workers.some(stopped => stopped.id === w.id)) || result.checks.some(c => c.run_id !== run.id || ["working", "interrupted"].includes(c.condition)) || checks.some(c => !result.checks.some(stopped => stopped.id === c.id && stopped.worker_id === c.worker_id))) throw new FactoryError("pause_uncertain", "Machine shutdown acknowledgment did not match the owned resources", 409);
        if (this.stopped) return;
        this.store.db.transaction(() => {
          this.store.put("runs", { ...result.run, continuation: run.continuation }, id);
          for (const worker of result.workers) {
            const current = this.store.get<import("../shared/factory.ts").FactoryWorker>("workers", worker.id);
            if (!current || current.run_id !== run.id) throw new FactoryError("pause_uncertain", "Unknown child in shutdown acknowledgment", 409);
            this.store.put("workers", { ...current, ...worker, continuation: current.continuation }, run.id);
          }
          for (const check of checks) this.store.put("checks", result.checks.find(stopped => stopped.id === check.id)!, run.id);
        }).immediate();
      } catch (error) { reasons.push(`${run.machine_id} / ${run.id}: ${error instanceof FactoryError ? error.message : "Shutdown could not be confirmed; reservations retained"}`); }
    }
    if (this.stopped) return;
    const current = this.store.get<Implementation>("implementations", id);
    if (current?.pause?.id === pauseId) this.store.put("implementations", { ...current, pause: { ...current.pause, condition: reasons.length ? "pending" : "paused", reasons } });
  }
  async discover(machineId: string, path: string): Promise<import("../shared/project-setup.ts").ProjectDiscovery> { return machineId === "local" ? this.host.discover(path) : this.remote(machineId, "/project-discovery", { path }); }
  async modelCatalog(machineId: string, provider: FactoryProvider, path: string, repository: string, snapshot?: AccountBindingSnapshot | null): Promise<import("../shared/agent-models.ts").AgentModelCatalog> {
    const result = machineId === "local" ? await this.host.modelCatalog(provider, path, repository, snapshot) : await this.remote<import("../shared/agent-models.ts").AgentModelCatalog>(machineId, "/model-catalog", { provider, path, repository, account_snapshot: snapshot } satisfies FactoryHostRequests["model_catalog"]);
    if (result.protocol !== 1 || result.provider !== provider || !Array.isArray(result.models)) throw new FactoryError("model_catalog_unavailable", "Update this Machine's bridge to read its model catalog", 409);
    return result;
  }
  async accountSnapshot(machineId: string, bindings: ProjectAccountBindings): Promise<AccountBindingSnapshot> {
    return machineId === "local" ? this.accounts.freeze(bindings) : this.remote(machineId, "/accounts/snapshot", { bindings });
  }
  async discoverAccounts(machineId: string, path?: string): Promise<import("../shared/accounts.ts").NativeAccountDiscovery> { return machineId === "local" ? this.accounts.discoverNative(path) : this.remote(machineId, "/accounts/discovery" + (path ? `?path=${encodeURIComponent(path)}` : "")); }
  async importAccount(machineId: string, body: Record<string, unknown>): Promise<AccountProfile> { return machineId === "local" ? this.accounts.importNative(body) : this.remote(machineId, "/accounts/import", body); }
  async accountOverview(machineId: string): Promise<AccountOverview> {
    const result = machineId === "local" ? this.accounts.overview() : await this.remote<AccountOverview>(machineId, "/accounts");
    if (result.protocol !== 1 || typeof result.host_id !== "string" || !Array.isArray(result.profiles)) throw new FactoryError("account_bridge_required", "Update this Machine's bridge before selecting accounts", 409);
    return result;
  }
  async createAccount(machineId: string, body: Record<string, unknown>): Promise<AccountProfile> { return machineId === "local" ? this.accounts.create(body) : this.remote(machineId, "/accounts", body); }
  async accountOperation(machineId: string, id: string, operation: string, body: Record<string, unknown>): Promise<AccountProfile | AccountSetup> { return machineId === "local" ? this.accounts.operation(id, operation, body) : this.remote(machineId, `/accounts/${id}/${operation}`, body); }
  async prepareReferences(projectId: string, machineId: string, expectedRevision: unknown): Promise<CodexReferenceContext> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Reference preparation is disabled on a restored copy", 409);
    if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping", 409);
    const library = this.references.current(projectId);
    if (expectedRevision !== library.revision) throw new FactoryError("references_changed", "Refresh the Project references before preparing Codex", 409);
    const project = this.store.get<FactoryProject>("projects", projectId)!;
    const checkout = this.store.list<ProjectCheckout>("checkouts", projectId).find((entry) => entry.machine_id === machineId);
    if (!checkout) throw new FactoryError("checkout_required", "Configure a verified checkout on the selected Machine", 409);
    const inspected = await this.inspect(machineId, checkout.path);
    if (this.stopped) throw new FactoryError("stopping", "The bridge stopped during preparation", 409);
    if (inspected.repository !== project.repository || inspected.repository !== checkout.repository) throw new FactoryError("wrong_checkout", "The Machine checkout changed", 409);
    if (this.references.current(projectId).revision !== library.revision) throw new FactoryError("references_changed", "The reference scope changed during preparation", 409);
    this.references.freeze(projectId);
    const payload = { ...this.references.payload(library), machine_id: machineId, checkout: { path: inspected.path, repository: inspected.repository } };
    const result = machineId === "local" ? await this.host.prepareReferences(payload) : await this.remote<CodexReferenceContext>(machineId, "/references/prepare", payload);
    if (result.project_id !== projectId || result.machine_id !== machineId || result.revision !== library.revision || typeof result.index_path !== "string" || typeof result.prompt !== "string") throw new FactoryError("references_identity_changed", "The Machine returned another reference context", 409);
    this.store.put("project_reference_contexts", { ...this.store.record(), ...result }, projectId);
    return result;
  }
  private async remote<T>(machineId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const endpoint = this.endpoint(machineId);
    if (!endpoint) throw new FactoryError("machine_offline", "The selected Machine is disconnected; its ownership is retained", 409);
    try {
      const deadline = AbortSignal.timeout(path.endsWith("/operations/check") ? 325_000 : path === "/launch" ? 75_000 : path === "/model-catalog" ? 30_000 : 15_000);
      const response = await fetch(`${endpoint.url}/api/factory-host${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${endpoint.token}`, "x-herdr-factory": "1", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) {
        if (response.status === 409 && /\/operations\/(publish|review-evidence|merge)$/.test(path)) {
          const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          const reasons: Record<string, string> = {
            merge_waiting: "Waiting for required GitHub checks or reviews; retained approval will be observed automatically",
            merge_blocked: "GitHub protection, pending reviews, required checks or conflicts block this target",
            merge_denied: "GitHub refused this merge under its repository permissions, protection or conflict rules; inspect the PR before further action",
            merge_unconfigured: "Merge requires a resting owned Run, frozen destination and verified GitHub account",
            merge_authority_changed: "The merge authority differs from the exact published candidate",
            merge_target_changed: "The PR candidate or target differs from the frozen merge destination",
            merge_coverage_unverified: "The authorized target or containing release could not be verified",
            merge_busy: "This candidate's merge is already being reconciled",
            run_stopping: "Pause or Delete stopped this merge operation",
            publication_unconfigured: "Publication requires the frozen Project destination and a verified GitHub account on the execution Machine",
            publication_unready: "Verify the owned resting Run and its publication destination",
            publication_target_changed: "The PR identity or destination differs from the authorized candidate",
            publication_branch_changed: "The owned remote branch has another head; preserve it for reconciliation",
            publication_uncertain: "PR creation is awaiting confirmation of its exact identity; do not replay it",
            publication_busy: "Publication is already being reconciled on the execution Machine",
            fresh_evidence_required: "Publication requires the Machine's passing configured checks and separate native reports at this head",
            writers_active: "Owned workers remain active; quiesce them before publication",
            dirty_integration: "Commit the checked integration changes before publication",
            review_stale: "The checked candidate or independent review workspace changed; retain its evidence for inspection",
            worker_busy: "The independent reviewer is still executing; wait for verified native rest",
            native_evidence_required: "The independent native report is not yet readable on the execution Machine",
            review_evidence_required: "Retain native code-review loading and a completed independent axis report",
            account_host_changed: "The frozen GitHub account belongs to another Machine",
            account_changed: "The frozen GitHub account changed; reconcile its accepted scope",
          };
          const code = failure?.error?.code;
          if (code && reasons[code]) throw new FactoryError(code, reasons[code], 409);
          throw new FactoryError("remote_factory_unavailable", "The execution Machine could not verify its review or publication operation", 409);
        }
        if (response.status === 409 && /\/operations\/(refresh|integrate)$/.test(path)) {
          const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          const reasons: Record<string, string> = {
            integration_conflict: "The candidate has an integration conflict; preserve its worktree for reconciliation",
            worker_stale: "The candidate integration tip changed; refresh and check the retained worker",
            dirty_worker: "The candidate has uncommitted changes; inspect the retained worktree",
            shared_writer_required: "The candidate changes shared documents without the required ownership claim",
            scaffolding_committed: "The candidate includes application scaffolding; inspect its commits",
            worker_busy: "The native worker is executing; wait for verified rest before integration",
            integration_busy: "The backend merger is busy with another candidate",
          };
          const code = failure?.error?.code;
          if (code && reasons[code]) throw new FactoryError(code, reasons[code], 409);
        }
        if (response.status === 409 && (path.endsWith("/send") || path.endsWith("/operations/send-worker"))) {
          const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          const code = failure?.error?.code;
          if (code && ["agent_busy", "worker_busy", "delivery_busy", "input_draft", "agent_blocked", "agent_not_ready", "run_unavailable"].includes(code)) throw new FactoryError(code, code === "input_draft" ? "The native input contains a draft; inspect it before resuming" : "Native delivery is waiting for the owned conversation to become ready", 409);
        }
        // Verification may be resting before its native transcript is fully recorded.
        // Preserve only known retry semantics, never a remote diagnostic or credential.
        if (response.status === 409 && path.endsWith("/verify-provider")) {
          const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          const code = failure?.error?.code;
          if (code === "native_evidence_required" || code === "agent_busy") throw new FactoryError(code, "The Machine has not finished recording native verification evidence", 409);
        }
        throw new FactoryError("remote_factory_unavailable", "The selected Machine rejected this factory operation; verify its bridge, native tools and checkout", response.status === 404 ? 409 : response.status);
      }
      return await response.json() as T;
    } catch (error) { if (error instanceof FactoryError) throw error; throw new FactoryError("machine_disconnected", "The selected Machine could not be observed; reconcile its accepted identity before retrying", 409); }
  }
  async capabilities(machineId = "local", snapshot?: AccountBindingSnapshot | null): Promise<HostCapabilities> {
    const capabilities = machineId === "local" ? await this.host.capabilities(snapshot) : await this.remote<HostCapabilities>(machineId, "/capabilities", snapshot ? { account_snapshot: snapshot } : undefined);
    if (capabilities.factory_host_protocol !== 1 || !Array.isArray(capabilities.providers) || capabilities.providers.length !== 3) throw new FactoryError("factory_bridge_incompatible", "This Machine's factory bridge needs an explicitly approved update", 409);
    return capabilities;
  }
  async prepare(machineId: string): Promise<HostCapabilities> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Machine preparation is disabled on a restored copy", 409);
    const payload = bundlePayload(verifySkills(this.settings().skills_path));
    if (machineId === "local") this.host.prepare(payload);
    else await this.remote(machineId, "/prepare", payload);
    return this.capabilities(machineId);
  }
  async verifyProvider(run: FactoryRun): Promise<HostCapabilities> {
    const questions = this.workflow.questions(run.implementation_id, run.id);
    const revision = this.workflow.questionRevision(run.implementation_id, run.id);
    if (!questions.length || questions.some((question) => question.answer === null) || !this.store.list<{ revision: string }>("answer_consumption", run.id).some((receipt) => receipt.revision === revision)) throw new FactoryError("verification_round_required", "Complete a real recorded owner-question round and native consumption before certification", 409);
    return run.machine_id === "local" ? this.host.verifyProvider(run.id) : this.remote(run.machine_id, `/runs/${run.id}/verify-provider`, {});
  }
  async operation<T>(run: FactoryRun, action: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!["delete", "pause", "resume-context", "resume-status", "transcript", "head", "check-reconcile", "reconcile-worker", "stop-worker"].includes(action)) this.assertExecuting(run.implementation_id);
    if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping", 409);
    if (existsSync(join(this.store.root, "recovery-copy.json")) && !["transcript", "head", "review-evidence"].includes(action)) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const result = (run.machine_id === "local" ? await this.host.operation(run.id, action, body) : await this.remote(run.machine_id, `/runs/${run.id}/operations/${action}`, body)) as T;
    if (this.stopped) throw new FactoryError("stopping", "The bridge stopped during the operation; ownership is retained", 409);
    return result;
  }
  async inspect(machineId: string, path: string): Promise<Awaited<ReturnType<typeof inspectCheckout>>> {
    return machineId === "local" ? inspectCheckout(path) : this.remote(machineId, "/inspect", { path });
  }
  async deleteAttempt(run: FactoryRun, deletionId: string): Promise<void> {
    if (this.dispatches.has(run.id)) throw new FactoryError("allocation_pending", "Waiting for accepted allocation to settle", 409);
    const result = await this.operation<import("../shared/factory.ts").FactoryDeleteAttemptResult>(run, "delete", { deletion_id: deletionId, implementation_id: run.implementation_id });
    if (result.run_id !== run.id || result.deletion_id !== deletionId || result.condition !== "deleted") throw new FactoryError("delete_uncertain", "Machine deletion acknowledgment does not match the owned attempt", 409);
  }
  async paneState(machineId: string, paneId: string): Promise<Awaited<ReturnType<FactoryExecutionHost["paneState"]>>> {
    return machineId === "local" ? this.host.paneState(paneId) : this.remote(machineId, "/pane-state", { pane_id: paneId });
  }
  async capture(machineId: string, path: string, base: string, mode: "branch" | "workspace"): Promise<{ repository: string; head: string; files: import("../shared/protocol.ts").ReviewSnapshot["files"] }> {
    return this.remote(machineId, "/review", { path, base, mode });
  }
  async start(id: string, body: Record<string, unknown>, origin: string, continuation?: { runId?: string; finish?: () => Promise<void>; validateScope?: () => void }, admitting = false): Promise<FactoryRun> {
    this.assertExecuting(id);
    continuation?.validateScope?.();
    if (!actions.includes(body.action as FactoryAction) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_start", "Select an explicit action with an idempotency key");
    let implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) throw new FactoryError("not_found", "Implementation not found", 404);
    const previous = this.store.list<FactoryRun>("runs", id).find((run) => run.idempotency_key === body.idempotency_key);
    if (previous) {
      if (previous.action !== body.action) throw new FactoryError("idempotency_conflict", "This Start key already belongs to another action", 409);
      return this.dispatches.get(previous.id) ?? previous;
    }
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Execution is disabled on a restored copy until separately scoped promotion", 409);
    if (!admitting) await this.queue.flush();
    if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping", 409);
    const project = implementation.project_id ? this.store.get<FactoryProject>("projects", implementation.project_id) : null;
    if (implementation.archived_at || project?.removed_at) throw new FactoryError("inactive_assignment", "Restore this Assignment and Project before starting work", 409);
    const action = body.action as FactoryAction;
    if (["work", "implement-spec", "grill-with-docs", "to-tickets", "retro", "apply-retro"].includes(action) && !project) throw new FactoryError("project_required", "Select a Project before starting this action", 409);
    const retrospective = ["retro", "apply-retro"].includes(action) ? this.store.get<import("../shared/protocol.ts").FactoryRetrospective>("retrospectives", String(body.retrospective_id)) : null;
    if (["retro", "apply-retro"].includes(action) && (!retrospective || retrospective.project_id !== project?.id || action === "apply-retro" && !retrospective.approved)) throw new FactoryError("retrospective_scope_required", "Select retained Project evidence and separately approve improvements before applying them", 409);
    if (action === "to-spec" && this.workflow.questions(id).length && (!this.workflow.approved(id, "shared_understanding", this.workflow.questionRevision(id)) || this.workflow.questions(id).some((question) => question.answer === null))) throw new FactoryError("understanding_unconfirmed", "Answer pending questions and confirm their shared understanding before specification", 409);
    const machineId = implementation.machine_id ?? project?.machine_id;
    if (!machineId) throw new FactoryError("machine_required", "Select an execution Machine explicitly", 409);
    if (this.store.list<FactoryRun>("runs", id).some((run) => run.id !== continuation?.runId && activeConditions.has(run.condition))) throw new FactoryError("implementation_owned", "An existing or uncertain Run retains ownership; reconcile it before starting another", 409);
    const priorRuns = new Set(this.store.list<FactoryRun>("runs", id).map((run) => run.id));
    if (this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").some((worker) => priorRuns.has(worker.run_id) && activeConditions.has(worker.condition))) throw new FactoryError("implementation_owned", "An accepted or uncertain child still owns this Implementation; reconcile or stop it before starting another", 409);
    const provider = implementation.provider ?? project?.provider ?? this.settings().provider;
    if (project?.permission_mode && !validPermissionMode(provider, project.permission_mode)) throw new FactoryError("permission_provider_mismatch", "The selected CLI does not support this Project's permission mode. Choose a compatible CLI or update Project execution settings before starting", 409);
    if (action === "implement-spec" && project?.permission_mode === "read_only") throw new FactoryError("project_read_only", "Choose an editing permission mode in Project settings before implementation", 409);
    if (body.expected !== undefined) {
      if (!body.expected || typeof body.expected !== "object" || Array.isArray(body.expected)) throw new FactoryError("invalid_scope", "Confirm the displayed execution context");
      const expected = body.expected as Record<string, unknown>;
      if (expected.provider !== provider || expected.machine_id !== machineId || expected.project_id !== implementation.project_id || expected.specification_id !== (this.workflow.specification(id)?.id ?? null) || expected.graph_hash !== this.workflow.graphHash(id)) throw new FactoryError("scope_changed", "The displayed execution context changed; inspect it before starting", 409);
    }
    const skills = verifySkills(this.settings().skills_path ?? this.host.skillPath());
    const accountSnapshot = project?.account_bindings?.[machineId] && Object.keys(project.account_bindings[machineId]!).length ? await this.accountSnapshot(machineId, project.account_bindings[machineId]!) : null;
    const capabilities = await this.capabilities(machineId, accountSnapshot);
    if (this.stopped) throw new FactoryError("stopping", "The bridge stopped during admission", 409);
    if (accountSnapshot && capabilities.account_profile_protocol !== 1) throw new FactoryError("account_bridge_required", "The selected Machine needs account-profile bridge support", 409);
    const capability = capabilities.providers.find((entry) => entry.provider === provider);
    if (!capability?.installed || !capability.skills_verified || capabilities.skill_manifest?.hash !== skills.hash || action === "implement-spec" && !capability.factory_ready) throw new FactoryError("provider_unavailable", capability?.reasons.join("; ") || "The selected provider has no verified native contract on this Machine", 409);
    const checkout = project ? this.store.list<ProjectCheckout>("checkouts", project.id).find((entry) => entry.machine_id === machineId) : null;
    let inspected: Awaited<ReturnType<typeof inspectCheckout>> | null = null;
    if (project) {
      if (!checkout) throw new FactoryError("checkout_required", "Configure a verified checkout on the selected Machine", 409);
      inspected = await this.inspect(machineId, checkout.path);
      if (this.stopped) throw new FactoryError("stopping", "The bridge stopped during admission", 409);
      if (inspected.repository !== checkout.repository) throw new FactoryError("wrong_checkout", "The selected checkout belongs to a different repository", 409);
      if (action === "implement-spec" && machineId === "local" && (await git(inspected.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new FactoryError("dirty_checkout", "Save the Project checkout's existing changes before starting automated implementation. Planning and direct work can start in their own workspaces", 409);
    }
    if (action === "implement-spec" && project?.tracker !== "app") throw new FactoryError("tracker_setup_required", "Select the app-native Other tracker explicitly; external tracker publication remains a separately configured action", 409);
    const selection = parseModelSelection(body.execution_preset === undefined ? project?.provider === provider ? project.execution_preset : undefined : body.execution_preset);
    const executionPreset = selection.model && inspected ? resolveModelSelection(selection, await this.modelCatalog(machineId, provider, inspected.path, inspected.repository, accountSnapshot)) : selection;
    if (selection.model && !inspected) throw new FactoryError("checkout_required", "Select a Project checkout before choosing a model", 409);
    const specification = this.workflow.specification(id); const graphHash = this.workflow.graphHash(id);
    const automatic = this.workflow.planningRequest(id, body.idempotency_key);
    const planningAuthority = automatic ? this.store.get<FactoryApproval>("approvals", automatic.approval_id) : null;
    if (automatic && this.workflow.questions(id).some(question => question.answer === null)) throw new FactoryError("answers_unready", "Answer the pending owner questions before automatic planning", 409);
    if (automatic && (automatic.scope_hash !== this.workflow.planningScope(id) || planningAuthority?.automatic_execution !== true || planningAuthority.revision !== specification?.id)) throw new FactoryError("scope_changed", "The accepted Specification execution scope changed", 409);
    if (action === "to-tickets" || action === "implement-spec") {
      if (!specification || !this.workflow.approved(id, "specification", specification.id) || (!planningAuthority && !this.workflow.approved(id, "testing_seams", specification.id))) throw new FactoryError("scope_unaccepted", "Accept the current specification and testing seams", 409);
    }
    if (action === "implement-spec") {
      if (!planningAuthority && (!this.workflow.tickets(id).length || !this.workflow.approved(id, "ticket_graph", graphHash))) throw new FactoryError("scope_unaccepted", "Accept the current Ticket graph", 409);
      if (!project?.checks?.length || !project.permissions?.trim()) throw new FactoryError("project_setup_required", "Configure known Project checks and execution permissions before factory admission", 409);
    }
    // Validate the next action before releasing the resting predecessor. Retained context
    // is then included in the new immutable contract, just as with a manual handoff.
    continuation?.validateScope?.();
    if (continuation?.finish) {
      await continuation.finish();
      continuation.validateScope?.();
      const current = this.store.get<Implementation>("implementations", id)!;
      const { updated_at: beforeUpdated, ...beforeScope } = implementation;
      const { updated_at: afterUpdated, ...afterScope } = current;
      if (hash(JSON.stringify(beforeScope)) !== hash(JSON.stringify(afterScope))) throw new FactoryError("scope_changed", "The Assignment changed during its handoff; inspect it before continuing", 409);
      if (checkout && hash(JSON.stringify(this.store.get("checkouts", checkout.id))) !== hash(JSON.stringify(checkout))) throw new FactoryError("scope_changed", "The checkout changed during its handoff; inspect it before continuing", 409);
      implementation = current;
    }
    const selectedEvidence = new Set(retrospective?.evidence_ids ?? []);
    const selectedArtifacts = (): FactoryArtifact[] => {
      const captures = this.store.list<{ id: string; artifact_ids: string[] }>("planning_captures");
      return [...this.store.list<FactoryArtifact>("artifacts"), ...this.store.list<FactoryArtifact>("deleted_artifacts")].filter(artifact => {
        const capture = /^planning-(?:[a-f0-9]{16}-|index-)/.test(artifact.name) ? captures.find(entry => artifact.origin.includes(`:run-${entry.id}:artifact-`)) : undefined;
        return selectedEvidence.has(artifact.id) || artifact.implementation_id === id && this.store.get("artifacts", artifact.id) !== null && (!capture || capture.artifact_ids.includes(artifact.id));
      });
    };
    const artifacts = selectedArtifacts();
    const messages = this.store.list<FactoryMessage>("messages", id);
    const projectReferences = project ? this.references.current(project.id) : null;
    if (projectReferences?.entries.length && capabilities.project_reference_protocol !== 1) throw new FactoryError("factory_bridge_incompatible", "The selected Machine needs a bridge with Project reference support", 409);
    if (projectReferences?.entries.length && provider !== "codex") throw new FactoryError("reference_provider_unavailable", "Project references currently require Codex; keep the selected provider or explicitly choose Codex", 409);
    if (artifacts.reduce((size, artifact) => size + artifact.size, 0) + (projectReferences?.entries.reduce((size, entry) => size + entry.size, 0) ?? 0) > 64 * 1024 * 1024) throw new FactoryError("context_too_large", "Retained inputs exceed this Run's 64 MiB materialization budget", 413);
    if (action === "implement-spec") {
      if (!specification || !this.workflow.approved(id, "specification", specification.id) || (!planningAuthority && !this.workflow.approved(id, "testing_seams", specification.id)) || !planningAuthority && (!this.workflow.tickets(id).length || !this.workflow.approved(id, "ticket_graph", graphHash))) throw new FactoryError("scope_unaccepted", "Accept the current specification, testing seams and Ticket graph", 409);
      if (!project?.checks?.length || !project.permissions?.trim()) throw new FactoryError("project_setup_required", "Configure known Project checks and execution permissions before factory admission", 409);
    }
    const api = new URL(this.publicUrl ?? automatic?.origin ?? origin);
    if (!["http:", "https:"].includes(api.protocol) || api.username || api.password) throw new FactoryError("invalid_factory_url", "Use an authenticated HTTP(S) app address for the tracker");
    const contractHash = hash(JSON.stringify({ implementation, project, checkout, specification, graphHash, settings: this.settings(), skills: skills.hash, artifacts, messages, projectReferences }));
    await this.reconcileCapacity();
    const run = this.store.db.transaction(() => {
      this.assertExecuting(id);
      continuation?.validateScope?.();
      const raced = this.store.list<FactoryRun>("runs", id).find((entry) => entry.idempotency_key === body.idempotency_key);
      if (raced) return { run: raced, accepted: false };
      if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping; reconcile before retrying", 409);
      if (automatic && this.workflow.questions(id).some(question => question.answer === null)) throw new FactoryError("answers_unready", "Answer the pending owner questions before automatic planning", 409);
      if (automatic && automatic.scope_hash !== this.workflow.planningScope(id)) throw new FactoryError("scope_changed", "The accepted execution scope changed during admission", 409);
      const currentHash = hash(JSON.stringify({ implementation: this.store.get("implementations", id), project: project ? this.store.get("projects", project.id) : null, checkout: checkout ? this.store.get("checkouts", checkout.id) : null, specification: this.workflow.specification(id), graphHash: this.workflow.graphHash(id), settings: this.settings(), skills: skills.hash, artifacts: selectedArtifacts(), messages: this.store.list<FactoryMessage>("messages", id), projectReferences: project ? this.references.current(project.id) : null }));
      if (currentHash !== contractHash) throw new FactoryError("scope_changed", "The selected execution scope changed during admission", 409);
      const owned = this.store.list<FactoryRun>("runs").filter((entry) => activeConditions.has(entry.condition));
      if (owned.some((entry) => entry.implementation_id === id)) throw new FactoryError("implementation_owned", "An existing or uncertain Run still owns this Implementation", 409);
      const planning = ["grill-me", "grill-with-docs"].includes(action) || action === "to-spec" && (!specification || !this.workflow.approved(id, "specification", specification.id));
      const capacityPool = agentCapacityPool(this.store, this.settings(), planning);
      const record: FactoryRun = { ...this.store.record(), implementation_id: id, action, provider, machine_id: machineId, capacity_pool: capacityPool, condition: "accepted", waiting_reason: null, idempotency_key: body.idempotency_key as string, specification_id: specification?.id ?? null, graph_hash: graphHash, base: inspected?.head ?? null, checkout: inspected?.path ?? null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills, artifacts, context_message_ids: messages.map(message => message.id), retrospective, retrospective_evidence: retrospective ? this.store.get("retro_evidence", retrospective.id) : null, implementation, project, checkout: inspected, specification, tickets: this.workflow.tickets(id), approvals: this.store.list<FactoryApproval>("approvals", id), effective_settings: this.settings(), provider_version: capability.version, permissions: "Retain native controls; publication, merge, deployment and destructive cleanup are separate owner actions", contract_hash: contractHash } };
      record.manifest = { ...(record.manifest as object), ...(planningAuthority ? { planning_authority: planningAuthority } : {}), github_policy: project ? this.store.get("github_policies", project.id) : null, execution_preset: executionPreset, project_references: projectReferences, account_snapshot: accountSnapshot };
      if (projectReferences) this.references.freeze(projectReferences.project_id);
      this.store.remove("capacity_waits", `${id}:${body.idempotency_key}`);
      this.store.put("runs", record, id); this.store.event(id, "dispatch_accepted", { run_id: record.id, action }); return { run: record, accepted: true };
    }).immediate();
    const accepted = run;
    const pending = this.dispatches.get(accepted.run.id);
    if (pending) return pending;
    if (!accepted.accepted) return accepted.run;
    this.store.put("run_access", { id: accepted.run.id, token: randomBytes(32).toString("base64url"), url: `${api.origin}/api/factory-agent/${accepted.run.id}` });
    this.store.put("run_artifacts", { id: accepted.run.id, artifacts });
    const dispatch = this.dispatch(accepted.run);
    this.dispatches.set(accepted.run.id, dispatch);
    try { return await dispatch; } finally { this.dispatches.delete(accepted.run.id); }
  }
  async discussReview(parent: FactoryRun, review: import("../shared/factory.ts").FactoryHumanReview, message: FactoryMessage, origin: string, claim: () => void): Promise<FactoryRun> {
    this.assertExecuting(parent.implementation_id);
    const capabilities = await this.capabilities(parent.machine_id, (parent.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot);
    if (capabilities.human_review_protocol !== 1) throw new FactoryError("human_review_bridge_required", "The selected Machine needs Human Review bridge support before its assistant can execute", 409);
    const currentReview = () => {
      const current = this.store.get<import("../shared/factory.ts").FactoryHumanReview>("human_reviews", review.id);
      if (!current || current.condition !== "ready" || current.head !== review.head || current.snapshot_id !== review.snapshot_id) throw new FactoryError("continuation_waiting", "Human Review discussion yields while submitted fixes run or its captured candidate changes", 409);
      return current;
    };
    const reviewRuns = this.store.list<FactoryRun>("runs", parent.implementation_id).filter(r => r.conversation_kind === "human_review");
    const key = `human-review-${review.id}-${message.id}`;
    const existing = reviewRuns.find(r => r.id === review.assistant_run_id && r.base === review.head && !["completed", "cancelled", "failed"].includes(r.condition)) ?? reviewRuns.find(r => r.idempotency_key === key);
    if (existing) {
      // Admission and the durable sending claim precede every native effect.
      this.store.db.transaction(() => { currentReview(); agentCapacityPool(this.store, this.settings()); claim(); }).immediate();
      await this.send(existing, `Human Review discussion of snapshot ${review.snapshot_id}, head ${review.head}. Discuss only; do not edit, create workers, publish or merge.\n\n${message.content}`, new AbortController().signal);
      return this.store.get<FactoryRun>("runs", existing.id)!;
    }
    const captured = await this.inspect(parent.machine_id, parent.worktree!);
    if (captured.head !== review.head) throw new FactoryError("review_stale", "The assistant checkout differs from the captured review", 409);
    const inspected = await this.inspect(parent.machine_id, parent.checkout!);
    if (inspected.repository !== captured.repository) throw new FactoryError("wrong_checkout", "The Human Review candidate and Project checkout belong to different repositories", 409);
    const histories = this.store.list<import("../shared/factory.ts").NativeConversationSnapshot>("native_snapshots").filter(s => reviewRuns.some(r => r.id === s.run_id));
    const history = histories.flatMap(s => s.turns.map(turn => `${turn.role}: ${turn.parts.flatMap(part => part.kind === "text" || part.kind === "compact" ? [part.text] : []).join("\n")}`)).join("\n\n").slice(-48000);
    const { planning_authority: _authority, ...manifest } = parent.manifest as Record<string, unknown>;
    const run = this.store.db.transaction(() => {
      this.assertExecuting(parent.implementation_id);
      const current = currentReview();
      const pool = agentCapacityPool(this.store, this.settings());
      const record: FactoryRun = { ...parent, ...this.store.record(), action: "work", conversation_kind: "human_review", capacity_pool: pool, condition: "accepted", waiting_reason: null, idempotency_key: key, base: review.head, checkout: parent.checkout, worktree: null, branch: null, workspace_id: null, pane_id: null, continuation: undefined, suspension: undefined, manifest: { ...manifest, checkout: inspected, human_review: { review, message, history, history_snapshot_ids: histories.map(s => s.id), snapshot: this.store.get("snapshots", review.snapshot_id!) }, context_message_ids: this.store.list<FactoryMessage>("messages", parent.implementation_id).filter(m => m.chat_id === message.chat_id).map(m => m.id) } };
      claim(); this.store.put("runs", record, parent.implementation_id);
      this.store.put("human_reviews", { ...current, assistant_run_id: record.id }, parent.implementation_id);
      const api = new URL(this.publicUrl ?? origin);
      this.store.put("run_access", { id: record.id, token: randomBytes(32).toString("base64url"), url: `${api.origin}/api/factory-agent/${record.id}` });
      return record;
    }).immediate();
    const pending = this.dispatch(run); this.dispatches.set(run.id, pending);
    try { return await pending; } finally { this.dispatches.delete(run.id); }
  }
  private async dispatch(record: FactoryRun): Promise<FactoryRun> {
    let run = record;
    let dispatched = false;
    const access = this.store.get<{ token: string; url: string }>("run_access", record.id);
    try {
      const attachments = (this.store.get<{ artifacts: FactoryArtifact[] }>("run_artifacts", record.id)?.artifacts ?? []).map((artifact) => ({ ...artifact, content_base64: this.readArtifact(artifact).toString("base64") }));
      const library = (record.manifest as { project_references?: import("../shared/protocol.ts").ProjectReferenceLibrary }).project_references;
      const references = library?.entries.length ? this.references.payload(library) : undefined;
      dispatched = true;
      run = this.observed(record, record.machine_id === "local" ? await this.host.launch(record, access ?? undefined, attachments, references) : await this.remote<FactoryRun>(record.machine_id, "/launch", { run: record, access, attachments, references }));
    }
    catch (error) { run = { ...record, condition: dispatched ? "disconnected" : "failed", waiting_reason: error instanceof FactoryError ? error.message : "Launch outcome is uncertain; reconcile native identity", updated_at: new Date().toISOString() }; }
    if (!this.stopped) this.store.db.transaction(() => {
      const current = this.store.get<FactoryRun>("runs", run.id);
      if (current && ["cancelled", "completed", "failed"].includes(current.condition)) { run = current; return; }
      run = { ...run, capacity_pool: current?.capacity_pool ?? run.capacity_pool, continuation: current?.continuation ?? run.continuation, ...(current?.continuation && ["working", "ready"].includes(run.condition) ? { condition: current.condition, waiting_reason: current.waiting_reason } : {}) };
      this.store.put("runs", run, run.implementation_id);
      this.store.event(run.implementation_id, run.condition === "working" ? "native_launch_confirmed" : "dispatch_uncertain", { run_id: run.id, machine_id: run.machine_id, pane_id: run.pane_id, reason: run.waiting_reason });
      if (run.condition === "working") { const idea = this.store.get<Implementation>("implementations", run.implementation_id)!; this.store.put("implementations", { ...idea, stage: run.conversation_kind === "human_review" ? "review" : ["work", "implement-spec"].includes(run.action) ? "running" : "specifying" }); }
    })();
    return run;
  }
  private observed(expected: FactoryRun, actual: FactoryRun): FactoryRun {
    for (const key of ["id", "implementation_id", "action", "provider", "machine_id", "idempotency_key", "specification_id", "graph_hash", "base", "checkout", "created_at"] as const) if (actual?.[key] !== expected[key]) throw new FactoryError("run_identity_changed", "The Machine returned another accepted Run identity; preserve ownership", 409);
    if (hash(JSON.stringify(actual.manifest)) !== hash(JSON.stringify(expected.manifest)) || !["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted", "failed", "cancelled", "completed"].includes(actual.condition)) throw new FactoryError("run_identity_changed", "The Machine changed the accepted contract; preserve ownership", 409);
    if (expected.worktree && (actual.worktree !== expected.worktree || actual.branch !== expected.branch || expected.workspace_id !== null && actual.workspace_id !== expected.workspace_id || expected.pane_id !== null && actual.pane_id !== expected.pane_id)) throw new FactoryError("run_identity_changed", "The Machine changed the owned working directory or native identity", 409);
    // Admission and reactivation own the pool centrally; the Machine observes execution.
    return { ...actual, capacity_pool: expected.capacity_pool, continuation: expected.continuation };
  }
  /** Refresh capacity from owned native identities, including remote and resting chats. */
  async reconcileCapacity(): Promise<void> {
    const runs = this.store.list<FactoryRun>("runs").filter(run => !run.suspension && activeConditions.has(run.condition) && !this.dispatches.has(run.id) && !this.store.get<Implementation>("implementations", run.implementation_id)?.pause);
    await Promise.all(runs.map(run => this.reconcile(run.id)));
    if (this.stopped) return;
    const workers = this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").filter(worker => activeConditions.has(worker.condition));
    await Promise.all(workers.map(async worker => {
      const run = this.store.get<FactoryRun>("runs", worker.run_id);
      if (!run) return;
      if (worker.suspension) return;
      if (this.store.get<Implementation>("implementations", run.implementation_id)?.pause) return;
      let next = worker;
      try {
        next = await this.operation(run, "reconcile-worker", { worker_id: worker.id });
        if (!["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted", "failed", "cancelled", "completed"].includes(next.condition) || next.id !== worker.id || next.run_id !== run.id || next.ticket_id !== worker.ticket_id || next.role !== worker.role || next.base !== worker.base || (["worktree", "branch", "pane_id", "workspace_id"] as const).some(key => worker[key] !== null && next[key] !== worker[key])) throw new FactoryError("worker_identity_changed", "The observed worker identity changed", 409);
      } catch { next = { ...worker, condition: "disconnected", waiting_reason: "Worker observation is uncertain; capacity remains reserved" }; }
      if (!this.stopped && JSON.stringify(this.store.get("workers", worker.id)) === JSON.stringify(worker)) this.store.put("workers", this.observeWorker(run, worker, next), run.id);
    }));
  }
  observeWorker(run: FactoryRun, expected: import("../shared/factory.ts").FactoryWorker, actual: import("../shared/factory.ts").FactoryWorker): import("../shared/factory.ts").FactoryWorker {
    // A lost merger reply is recovered through integrate, which retains graph
    // progress and closes native ownership. Observation alone cannot complete it.
    if (actual.role === "implementer" && actual.condition === "completed" && expected.condition !== "completed") actual = { ...actual, integration_pending: true, condition: "ready", waiting_reason: "The Machine merged this candidate; retain its integration receipt" };
    return this.parking.observeWorker(run, { ...actual, continuation: expected.continuation }, actual.condition === "ready");
  }
  async reconcile(runId: string): Promise<FactoryRun> {
    let run = this.store.get<FactoryRun>("runs", runId); if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (run.suspension) return run;
    if (this.store.get<Implementation>("implementations", run.implementation_id)?.pause) return run;
    if (["completed", "cancelled", "failed"].includes(run.condition)) return run;
    const revision = hash(JSON.stringify(run));
    try { run = this.observed(run, run.machine_id === "local" ? await this.host.reconcile(run.id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${run.id}/reconcile`, {})); }
    catch (error) { run = { ...run, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The Machine cannot currently be observed; ownership is retained", updated_at: new Date().toISOString() }; }
    if (this.stopped) return run;
    const current = this.store.get<FactoryRun>("runs", runId);
    if (current && hash(JSON.stringify(current)) !== revision) return current;
    run = this.parking.observe(run, run.condition === "ready");
    const question = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).find((entry) => entry.run_id === run!.id && entry.answer === null);
    if (question && ["working", "ready"].includes(run.condition)) run = { ...run, condition: "needs_you", waiting_reason: question.question };
    this.store.put("runs", run, run.implementation_id);
    if (current?.condition !== run.condition || current.waiting_reason !== run.waiting_reason || JSON.stringify(current.continuation) !== JSON.stringify(run.continuation)) this.store.event(run.implementation_id, "run_reconciled", { run_id: run.id, condition: run.condition });
    return run;
  }
  async stopRun(id: string, body: Record<string, unknown>): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length > 100_000)) throw new FactoryError("invalid_summary", "Enter a bounded Stop summary");
    for (const worker of this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers", id)) if (worker.workspace_id && worker.condition !== "cancelled") { await this.operation(run, "stop-worker", { worker_id: worker.id }); this.store.put("workers", { ...worker, condition: worker.condition === "completed" ? "completed" : "cancelled" }, id); }
    const stopped = this.observed(run, run.machine_id === "local" ? await this.host.stopRun(id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${id}/stop`, {}));
    this.store.db.transaction(() => { this.store.put("runs", stopped, run.implementation_id); this.store.event(run.implementation_id, "run_stopped", { run_id: id, summary: body.summary ?? "Owner stopped this attempt", worktree_retained: true }); })();
    return stopped;
  }
  async finishStep(id: string): Promise<FactoryRun> {
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (this.workflow.questions(run.implementation_id, run.id).some(question => question.answer === null)) throw new FactoryError("answers_unready", "Answer this step's pending questions before continuing", 409);
    if (this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers", id).some(worker => !["completed", "cancelled", "failed"].includes(worker.condition)) || this.store.list<import("../shared/protocol.ts").FactoryCheck>("checks", id).some(check => ["working", "interrupted"].includes(check.condition))) throw new FactoryError("step_owned", "Reconcile owned workers and checks before continuing", 409);
    const finished = this.observed(run, run.machine_id === "local" ? await this.host.finishStep(id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${id}/finish`, {}));
    this.store.put("runs", finished, run.implementation_id);
    this.store.event(run.implementation_id, "workflow_step_finished", { run_id: id, chat_retained: true, review_accepted: false, changes_retained: true });
    return finished;
  }
  async answerDelivery(run: FactoryRun, revision: string, key: string): Promise<import("../shared/protocol.ts").FactoryAnswerDelivery | null> {
    const workers = this.store.list<import("../shared/factory.ts").FactoryWorker>("workers", run.id).filter(worker => worker.continuation?.kind === "owner" && (worker.continuation.question_revision === null || worker.continuation.question_revision === revision));
    if (run.continuation?.kind !== "owner" && !workers.length) return null;
    await this.reconcile(run.id);
    await this.queue.flush();
    const current = this.store.get<FactoryRun>("runs", run.id)!;
    const receipts = workers.map(worker => this.parking.answerDelivery(current, revision, key, this.store.get<import("../shared/factory.ts").FactoryWorker>("workers", worker.id)!)).filter(receipt => receipt !== null);
    const parent = this.parking.answerDelivery(current, revision, key);
    if (parent) receipts.push(parent);
    return receipts.find(receipt => receipt.condition === "uncertain" || receipt.condition === "blocked") ?? receipts.find(receipt => receipt.condition !== "sent") ?? receipts[0] ?? null;
  }
  async outputs(run: FactoryRun): Promise<FactoryOutput[]> { return run.machine_id === "local" ? this.host.outputs(run.id) : this.remote(run.machine_id, `/runs/${run.id}/artifacts`); }
  async send(run: FactoryRun, text: string, signal: AbortSignal): Promise<void> {
    this.assertExecuting(run.implementation_id);
    const reservation = this.store.db.transaction(() => {
      const current = this.store.get<FactoryRun>("runs", run.id);
      if (!current || !["working", "ready", "needs_you", "blocked"].includes(current.condition)) throw new FactoryError("run_unavailable", "Reconcile the Run before submitting changes", 409);
      if (["sending", "uncertain"].includes(current.continuation?.condition ?? "")) throw new FactoryError("delivery_busy", "Inspect the pending continuation before sending another batch", 409);
      if (current.condition !== "ready" && !["parked", "queued"].includes(current.continuation?.condition ?? "")) return null;
      const specification = this.workflow.specification(current.implementation_id);
      const planning = ["grill-me", "grill-with-docs"].includes(current.action) || current.action === "to-spec" && (!specification || !this.workflow.approved(current.implementation_id, "specification", specification.id));
      const pool = agentCapacityPool(this.store, this.settings(), planning);
      const reserved: FactoryRun = { ...current, ...(current.continuation ? { continuation: { ...current.continuation, condition: "sending", reason: "The owner is resuming this conversation" } } : {}), capacity_pool: pool, condition: "accepted", waiting_reason: null, updated_at: new Date().toISOString() };
      this.store.put("runs", reserved, run.implementation_id); return reserved;
    }).immediate();
    const settle = (condition: FactoryRun["condition"], reason: string | null): void => {
      if (reservation && JSON.stringify(this.store.get("runs", run.id)) === JSON.stringify(reservation)) this.store.put("runs", { ...reservation, condition, waiting_reason: reason, updated_at: new Date().toISOString() }, run.implementation_id);
    };
    try {
      await this.deliver(run, text, signal);
      settle("working", null);
      const current = this.store.get<FactoryRun>("runs", run.id);
      if (current?.continuation && current.continuation.id === reservation?.continuation?.id && current.continuation.condition === "sending" && !["completed", "cancelled", "failed"].includes(current.condition)) {
        this.store.remove("capacity_waits", `resume:${current.continuation.id}`);
        this.store.put("runs", { ...current, continuation: { ...current.continuation, condition: "resumed", reason: "The owner explicitly resumed this conversation" } }, run.implementation_id);
      }
    } catch (error) {
      const busy = error instanceof FactoryError && ["agent_busy", "delivery_busy"].includes(error.code);
      const unsent = error instanceof FactoryError && ["input_draft", "disconnected", "recovery_copy"].includes(error.code);
      settle(busy ? "working" : unsent ? "ready" : "disconnected", busy || unsent ? null : "Answer delivery outcome is uncertain; execution capacity remains reserved");
      const current = this.store.get<FactoryRun>("runs", run.id);
      if (current?.continuation && current.continuation.id === reservation?.continuation?.id && current.continuation.condition === "sending") this.store.put("runs", { ...current, continuation: { ...current.continuation, condition: busy || unsent ? "parking" : "uncertain", reason: error instanceof Error ? error.message : "Answer delivery is uncertain; inspect the conversation" } }, run.implementation_id);
      throw error;
    }
  }
  private async deliver(run: FactoryRun, text: string, signal: AbortSignal): Promise<void> {
    if (run.machine_id === "local") await this.host.send(run.id, text, signal);
    else await this.remote(run.machine_id, `/runs/${run.id}/send`, { text }, signal);
  }
  async output(run: FactoryRun, output: FactoryOutput): Promise<{ content_base64: string }> { return run.machine_id === "local" ? this.host.output(run.id, output.name, output.hash) : this.remote(run.machine_id, `/runs/${run.id}/artifacts/content?name=${encodeURIComponent(output.name)}&hash=${encodeURIComponent(output.hash)}`); }
  stop(): void { this.stopped = true; this.queue.stop(); this.parking.stop(); this.host.stop(); }
}
