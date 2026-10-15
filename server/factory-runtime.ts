import { factoryCapacity } from "./factory-capacity.ts";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
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
function issueScopeIdentity(scope: unknown): unknown {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return scope ?? null;
  const selected = scope as Record<string, unknown>;
  return [selected.source_id, selected.source_revision, selected.graph_hash];
}
export class FactoryRuntime {
  private readonly dispatches = new Map<string, Promise<FactoryRun>>();
  private readonly starts = new Map<string, { scope: string; pending: Promise<FactoryRun> }>();
  private stopped = false;
  private recovery: Promise<void> | null = null;
  private readonly recoveryIds: string[];
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly settings: () => FactorySettings, private readonly host: FactoryExecutionHost, private readonly endpoint: MachineEndpoint, private readonly readArtifact: (record: FactoryArtifact) => Buffer, private readonly publicUrl: string | null, private readonly references: FactoryReferences, private readonly accounts: MachineAccounts, private readonly issueAdmission: (id: string, scope: unknown, retryRunId?: string) => import("../shared/issue-admission.ts").IssueAdmission, private readonly reconcileImplementation: (id: string) => Promise<FactoryRun>) { this.recoveryIds = this.store.list<FactoryRun>("runs").filter(run => activeConditions.has(run.condition) || run.implementation_completion_pending || run.implementation_completion).map(run => run.id); }
  /** Restart observes durable identities once before accepting another operation. Never relaunch. */
  recover(): Promise<void> {
    return this.recovery ??= (async () => {
      for (const id of this.recoveryIds) {
        if (this.stopped) return;
        try { await this.reconcile(id); }
        catch (error) {
          if (this.stopped) return;
          const run = this.store.get<FactoryRun>("runs", id);
          if (!run?.implementation_completion_pending) throw error;
          if (run?.implementation_completion_pending) {
            this.store.put("runs", { ...run, condition: "disconnected", waiting_reason: "Implementation retirement is uncertain; reconcile its retained identity before release" }, run.implementation_id);
            this.store.event(run.implementation_id, "run_recovery_uncertain", { run_id: id, code: error instanceof FactoryError ? error.code : "recovery_uncertain" });
          }
        }
      }
    })();
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
    if (this.store.get<FactoryRun>("runs", run.id)?.issue_pause && !["head", "transcript", "review-evidence", "reconcile-worker", "stop-worker", "check-reconcile", "cleanup"].includes(action)) throw new FactoryError("issue_pause_required", "Controlled pause requested; reconcile retained work before continuing", 409);
    if (existsSync(join(this.store.root, "recovery-copy.json")) && !["transcript", "head", "review-evidence"].includes(action)) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    return (run.machine_id === "local" ? await this.host.operation(run.id, action, body) : await this.remote(run.machine_id, `/runs/${run.id}/operations/${action}`, body)) as T;
  }
  async inspect(machineId: string, path: string): Promise<Awaited<ReturnType<typeof inspectCheckout>>> {
    return machineId === "local" ? inspectCheckout(path) : this.remote(machineId, "/inspect", { path });
  }
  async paneState(machineId: string, paneId: string): Promise<Awaited<ReturnType<FactoryExecutionHost["paneState"]>>> {
    return machineId === "local" ? this.host.paneState(paneId) : this.remote(machineId, "/pane-state", { pane_id: paneId });
  }
  async capture(machineId: string, path: string, base: string, mode: "branch" | "workspace"): Promise<{ repository: string; head: string; files: import("../shared/protocol.ts").ReviewSnapshot["files"] }> {
    return this.remote(machineId, "/review", { path, base, mode });
  }
  async retry(runId: string, body: Record<string, unknown>, origin: string): Promise<FactoryRun> {
    const previous = this.store.get<FactoryRun>("runs", runId);
    if (!previous) throw new FactoryError("not_found", "Run not found", 404);
    if (!(previous.manifest as { issue_admission?: unknown }).issue_admission || previous.condition !== "failed" || body.issue_scope === undefined) throw new FactoryError("retry_unavailable", "Only a failed issue attempt can be retried after current scope review", 409);
    return this.start(previous.implementation_id, { ...body, action: "implement-spec", retry_of: runId }, origin);
  }
  async start(id: string, body: Record<string, unknown>, origin: string, continuation?: { runId?: string; finish?: () => Promise<void>; validateScope?: () => void }): Promise<FactoryRun> {
    const key = JSON.stringify([id, body.idempotency_key]);
    const scope = hash(JSON.stringify([body.action, issueScopeIdentity(body.issue_scope), body.retry_of ?? null]));
    const existing = this.starts.get(key);
    if (existing) {
      if (existing.scope !== scope) throw new FactoryError("idempotency_conflict", "This Start key belongs to another scope", 409);
      return existing.pending;
    }
    const pending = this.startOwned(id, body, origin, continuation);
    this.starts.set(key, { scope, pending });
    try { return await pending; } finally { this.starts.delete(key); }
  }
  private async startOwned(id: string, body: Record<string, unknown>, origin: string, continuation?: { runId?: string; finish?: () => Promise<void>; validateScope?: () => void }): Promise<FactoryRun> {
    continuation?.validateScope?.();
    if (!actions.includes(body.action as FactoryAction) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_start", "Select an explicit action with an idempotency key");
    let implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) throw new FactoryError("not_found", "Implementation not found", 404);
    const previous = this.store.list<FactoryRun>("runs", id).find((run) => run.idempotency_key === body.idempotency_key);
    if (previous) {
      if (previous.retry_of !== body.retry_of) throw new FactoryError("idempotency_conflict", "This Start key belongs to another attempt", 409);
      if (previous.action !== body.action) throw new FactoryError("idempotency_conflict", "This Start key already belongs to another action", 409);
      const admitted = (previous.manifest as { issue_admission?: import("../shared/issue-admission.ts").IssueAdmission }).issue_admission;
      const scope = admitted ? { source_id: admitted.source.id, source_revision: admitted.source.revision, graph_hash: admitted.planning.graph_hash } : null;
      if (hash(JSON.stringify(issueScopeIdentity(scope))) !== hash(JSON.stringify(issueScopeIdentity(body.issue_scope)))) throw new FactoryError("idempotency_conflict", "This Start key belongs to another issue scope", 409);
      return this.dispatches.get(previous.id) ?? previous;
    }
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Execution is disabled on a restored copy until separately scoped promotion", 409);
    const project = implementation.project_id ? this.store.get<FactoryProject>("projects", implementation.project_id) : null;
    if (implementation.archived_at || project?.removed_at) throw new FactoryError("inactive_assignment", "Restore this Assignment and Project before starting work", 409);
    const action = body.action as FactoryAction;
    if (body.issue_scope !== undefined && action !== "implement-spec") throw new FactoryError("invalid_issue_scope", "Prepared issue scope authorizes implementation only");
    if (action === "implement-spec" && body.retry_of === undefined && this.store.list<FactoryRun>("runs", id).some(run => run.condition === "failed" && (run.manifest as { issue_admission?: unknown }).issue_admission)) throw new FactoryError("retry_required", "Failed issue work requires the owner’s explicit Retry", 409);
    const validateRetry = () => {
      const latest = this.store.list<FactoryRun>("runs", id).at(-1);
      if (body.retry_of !== undefined && (latest?.id !== body.retry_of || latest.condition !== "failed")) throw new FactoryError("retry_superseded", "Refresh the latest attempt before Retry", 409);
    };
    validateRetry();
    const retryRunId = typeof body.retry_of === "string" ? body.retry_of : undefined;
    const issueAdmission = body.issue_scope === undefined ? null : this.issueAdmission(id, body.issue_scope, retryRunId);
    const validateIssue = () => {
      if (issueAdmission && hash(JSON.stringify(this.issueAdmission(id, body.issue_scope, retryRunId))) !== hash(JSON.stringify(issueAdmission))) throw new FactoryError("issue_changed", "The issue admission evidence changed; review it before starting", 409);
    };
    if (["work", "implement-spec", "grill-with-docs", "to-tickets", "retro", "apply-retro"].includes(action) && !project) throw new FactoryError("project_required", "Select a Project before starting this action", 409);
    const retrospective = ["retro", "apply-retro"].includes(action) ? this.store.get<import("../shared/protocol.ts").FactoryRetrospective>("retrospectives", String(body.retrospective_id)) : null;
    if (["retro", "apply-retro"].includes(action) && (!retrospective || retrospective.project_id !== project?.id || action === "apply-retro" && !retrospective.approved)) throw new FactoryError("retrospective_scope_required", "Select retained Project evidence and separately approve improvements before applying them", 409);
    if (action === "to-spec" && this.workflow.questions(id).length && (!this.workflow.approved(id, "shared_understanding", this.workflow.questionRevision(id)) || this.workflow.questions(id).some((question) => question.answer === null))) throw new FactoryError("understanding_unconfirmed", "Answer pending questions and confirm their shared understanding before specification", 409);
    const machineId = implementation.machine_id ?? project?.machine_id;
    if (!machineId) throw new FactoryError("machine_required", "Select an execution Machine explicitly", 409);
    if (this.store.list<FactoryRun>("runs", id).some((run) => run.id !== continuation?.runId && activeConditions.has(run.condition))) throw new FactoryError("implementation_owned", "An existing or uncertain Run retains ownership; reconcile it before starting another", 409);
    const validateChildren = () => {
      const priorRuns = new Set(this.store.list<FactoryRun>("runs", id).map(run => run.id));
      if (this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").some(worker => priorRuns.has(worker.run_id) && activeConditions.has(worker.condition)) || this.store.list<import("../shared/protocol.ts").FactoryCheck>("checks").some(check => priorRuns.has(check.run_id) && ["working", "interrupted"].includes(check.condition))) throw new FactoryError("implementation_owned", "An active or uncertain worker or build still owns this Assignment; reconcile it before another attempt", 409);
    };
    validateChildren();
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
    if (accountSnapshot && capabilities.account_profile_protocol !== 1) throw new FactoryError("account_bridge_required", "The selected Machine needs account-profile bridge support", 409);
    const capability = capabilities.providers.find((entry) => entry.provider === provider);
    if (!capability?.installed || !capability.skills_verified || capabilities.skill_manifest?.hash !== skills.hash || action === "implement-spec" && !capability.factory_ready) throw new FactoryError("provider_unavailable", capability?.reasons.join("; ") || "The selected provider has no verified native contract on this Machine", 409);
    const checkout = project ? this.store.list<ProjectCheckout>("checkouts", project.id).find((entry) => entry.machine_id === machineId) : null;
    let inspected: Awaited<ReturnType<typeof inspectCheckout>> | null = null;
    if (project) {
      if (!checkout) throw new FactoryError("checkout_required", "Configure a verified checkout on the selected Machine", 409);
      inspected = await this.inspect(machineId, checkout.path);
      if (inspected.repository !== checkout.repository) throw new FactoryError("wrong_checkout", "The selected checkout belongs to a different repository", 409);
      if (action === "implement-spec" && machineId === "local" && (await git(inspected.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new FactoryError("dirty_checkout", "Save the Project checkout's existing changes before starting automated implementation. Planning and direct work can start in their own workspaces", 409);
    }
    if (action === "implement-spec" && project?.tracker !== "app") throw new FactoryError("tracker_setup_required", "Select the app-native Other tracker explicitly; external tracker publication remains a separately configured action", 409);
    const selection = parseModelSelection(body.execution_preset === undefined ? project?.provider === provider ? project.execution_preset : undefined : body.execution_preset);
    const executionPreset = selection.model && inspected ? resolveModelSelection(selection, await this.modelCatalog(machineId, provider, inspected.path, inspected.repository, accountSnapshot)) : selection;
    if (selection.model && !inspected) throw new FactoryError("checkout_required", "Select a Project checkout before choosing a model", 409);
    const specification = this.workflow.specification(id); const graphHash = this.workflow.graphHash(id);
    validateIssue();
    if (action === "to-tickets" || action === "implement-spec") {
      if (!specification || !issueAdmission && (!this.workflow.approved(id, "specification", specification.id) || !this.workflow.approved(id, "testing_seams", specification.id))) throw new FactoryError("scope_unaccepted", "Accept the current specification and testing seams", 409);
    }
    if (action === "implement-spec") {
      if (!this.workflow.tickets(id).length || !issueAdmission && !this.workflow.approved(id, "ticket_graph", graphHash)) throw new FactoryError("scope_unaccepted", "Accept the current Ticket graph", 409);
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
      if (!specification || !this.workflow.tickets(id).length || !issueAdmission && (!this.workflow.approved(id, "specification", specification.id) || !this.workflow.approved(id, "testing_seams", specification.id) || !this.workflow.approved(id, "ticket_graph", graphHash))) throw new FactoryError("scope_unaccepted", "Accept the current specification, testing seams and Ticket graph", 409);
      if (!project?.checks?.length || !project.permissions?.trim()) throw new FactoryError("project_setup_required", "Configure known Project checks and execution permissions before factory admission", 409);
    }
    const api = new URL(this.publicUrl ?? origin);
    if (!["http:", "https:"].includes(api.protocol) || api.username || api.password) throw new FactoryError("invalid_factory_url", "Use an authenticated HTTP(S) app address for the tracker");
    const contractHash = hash(JSON.stringify({ implementation, project, checkout, specification, graphHash, settings: this.settings(), skills: skills.hash, artifacts, messages, projectReferences }));
    await this.reconcileCapacity();
    const run = this.store.db.transaction(() => {
      continuation?.validateScope?.();
      const raced = this.store.list<FactoryRun>("runs", id).find((entry) => entry.idempotency_key === body.idempotency_key);
      if (raced) return { run: raced, accepted: false };
      validateRetry();
      validateChildren();
      validateIssue();
      if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping; reconcile before retrying", 409);
      const currentHash = hash(JSON.stringify({ implementation: this.store.get("implementations", id), project: project ? this.store.get("projects", project.id) : null, checkout: checkout ? this.store.get("checkouts", checkout.id) : null, specification: this.workflow.specification(id), graphHash: this.workflow.graphHash(id), settings: this.settings(), skills: skills.hash, artifacts: selectedArtifacts(), messages: this.store.list<FactoryMessage>("messages", id), projectReferences: project ? this.references.current(project.id) : null }));
      if (currentHash !== contractHash) throw new FactoryError("scope_changed", "The selected execution scope changed during admission", 409);
      const owned = this.store.list<FactoryRun>("runs").filter((entry) => activeConditions.has(entry.condition));
      if (owned.some((entry) => entry.implementation_id === id)) throw new FactoryError("implementation_owned", "An existing or uncertain Run still owns this Implementation", 409);
      const capacity = factoryCapacity(this.store);
      if (capacity.implementations.size >= this.settings().max_implementations || capacity.agents >= this.settings().max_agents) throw new FactoryError("capacity_exhausted", "Global execution capacity is in use; start manually after capacity is released", 409);
      const record: FactoryRun = { ...this.store.record(), implementation_id: id, action, provider, machine_id: machineId, condition: "accepted", waiting_reason: null, idempotency_key: body.idempotency_key as string, specification_id: specification?.id ?? null, graph_hash: graphHash, base: inspected?.head ?? null, checkout: inspected?.path ?? null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills, artifacts, context_message_ids: messages.map(message => message.id), retrospective, retrospective_evidence: retrospective ? this.store.get("retro_evidence", retrospective.id) : null, implementation, project, checkout: inspected, specification, tickets: this.workflow.tickets(id), approvals: this.store.list<FactoryApproval>("approvals", id), effective_settings: this.settings(), provider_version: capability.version, permissions: "Retain native controls; publication, merge, deployment and destructive cleanup are separate owner actions", contract_hash: contractHash } };
      if (retryRunId) record.retry_of = retryRunId;
      record.manifest = { ...(record.manifest as object), execution_preset: executionPreset, project_references: projectReferences, account_snapshot: accountSnapshot, ...(issueAdmission ? { issue_admission: issueAdmission } : {}) };
      if (projectReferences) this.references.freeze(projectReferences.project_id);
      this.store.put("runs", record, id);
      this.store.put("run_access", { id: record.id, token: randomBytes(32).toString("base64url"), url: `${api.origin}/api/factory-agent/${record.id}` });
      this.store.put("run_artifacts", { id: record.id, artifacts });
      this.store.event(id, "dispatch_accepted", { run_id: record.id, action }); return { run: record, accepted: true };
    }).immediate();
    const accepted = run;
    const pending = this.dispatches.get(accepted.run.id);
    if (pending) return pending;
    if (!accepted.accepted) return accepted.run;
    const dispatch = this.dispatch(accepted.run);
    this.dispatches.set(accepted.run.id, dispatch);
    try { return await dispatch; } finally { this.dispatches.delete(accepted.run.id); }
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
      if (current?.issue_pause) run = { ...run, issue_pause: current.issue_pause, condition: "needs_you", waiting_reason: current.waiting_reason };
      this.store.put("runs", run, run.implementation_id);
      this.store.event(run.implementation_id, run.condition === "working" ? "native_launch_confirmed" : "dispatch_uncertain", { run_id: run.id, machine_id: run.machine_id, pane_id: run.pane_id, reason: run.waiting_reason });
      if (run.condition === "working") { const idea = this.store.get<Implementation>("implementations", run.implementation_id)!; this.store.put("implementations", { ...idea, stage: ["work", "implement-spec"].includes(run.action) ? "running" : "specifying" }); }
    })();
    return run;
  }
  private observed(expected: FactoryRun, actual: FactoryRun): FactoryRun {
    for (const key of ["id", "implementation_id", "action", "provider", "machine_id", "idempotency_key", "specification_id", "graph_hash", "base", "checkout", "created_at", "retry_of"] as const) if (actual?.[key] !== expected[key]) throw new FactoryError("run_identity_changed", "The Machine returned another accepted Run identity; preserve ownership", 409);
    if (hash(JSON.stringify(actual.manifest)) !== hash(JSON.stringify(expected.manifest)) || !["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted", "failed", "cancelled", "completed"].includes(actual.condition)) throw new FactoryError("run_identity_changed", "The Machine changed the accepted contract; preserve ownership", 409);
    if (expected.worktree && (actual.worktree !== expected.worktree || actual.branch !== expected.branch || expected.workspace_id !== null && actual.workspace_id !== expected.workspace_id || expected.pane_id !== null && actual.pane_id !== expected.pane_id)) throw new FactoryError("run_identity_changed", "The Machine changed the owned working directory or native identity", 409);
    return actual;
  }
  /** Refresh capacity from owned native identities, including remote and resting chats. */
  async reconcileCapacity(): Promise<void> {
    const runs = this.store.list<FactoryRun>("runs").filter(run => run.implementation_completion || run.implementation_completion_pending || run.action === "implement-spec" && run.condition === "completed" || activeConditions.has(run.condition) && run.pane_id && run.worktree && (run.machine_id !== "local" || run.condition === "ready"));
    await Promise.all(runs.map(run => this.reconcile(run.id)));
    const workers = this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").filter(worker => activeConditions.has(worker.condition) && worker.pane_id && worker.worktree && (worker.condition === "ready" || this.store.get<FactoryRun>("runs", worker.run_id)?.machine_id !== "local"));
    await Promise.all(workers.map(async worker => {
      const run = this.store.get<FactoryRun>("runs", worker.run_id);
      if (!run) return;
      let next = worker;
      try {
        next = await this.operation(run, "reconcile-worker", { worker_id: worker.id });
        if (!["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted", "failed", "cancelled", "completed"].includes(next.condition) || next.id !== worker.id || next.run_id !== run.id || next.ticket_id !== worker.ticket_id || next.role !== worker.role || next.base !== worker.base || next.worktree !== worker.worktree || next.branch !== worker.branch || next.pane_id !== worker.pane_id || next.workspace_id !== worker.workspace_id) throw new FactoryError("worker_identity_changed", "The observed worker identity changed", 409);
      } catch { next = { ...worker, condition: "disconnected", waiting_reason: "Worker observation is uncertain; capacity remains reserved" }; }
      if (JSON.stringify(this.store.get("workers", worker.id)) === JSON.stringify(worker)) this.store.put("workers", next, run.id);
    }));
  }
  async reconcile(runId: string): Promise<FactoryRun> {
    let run = this.store.get<FactoryRun>("runs", runId); if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (["completed", "cancelled", "failed"].includes(run.condition)) return run.implementation_completion || run.implementation_completion_pending || run.action === "implement-spec" && run.condition === "completed" ? this.reconcileImplementation(runId) : run;
    const revision = hash(JSON.stringify(run));
    try { run = this.observed(run, run.machine_id === "local" ? await this.host.reconcile(run.id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${run.id}/reconcile`, {})); }
    catch (error) { run = { ...run, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The Machine cannot currently be observed; ownership is retained", updated_at: new Date().toISOString() }; }
    if (this.stopped) return run;
    const current = this.store.get<FactoryRun>("runs", runId);
    if (current && hash(JSON.stringify(current)) !== revision) return current;
    if (current?.implementation_completion_pending) run = { ...run, implementation_completion_pending: true };
    if (current?.issue_pause) run = { ...run, issue_pause: current.issue_pause, condition: "needs_you", waiting_reason: current.waiting_reason };
    const question = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).find((entry) => entry.run_id === run!.id && entry.answer === null);
    if (question && ["working", "ready"].includes(run.condition)) run = { ...run, condition: "needs_you", waiting_reason: question.question };
    this.store.put("runs", run, run.implementation_id); this.store.event(run.implementation_id, "run_reconciled", { run_id: run.id, condition: run.condition }); return run.action === "implement-spec" ? this.reconcileImplementation(runId) : run;
  }
  async stopRun(id: string, body: Record<string, unknown>): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length > 100_000)) throw new FactoryError("invalid_summary", "Enter a bounded Stop summary");
    for (const worker of this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers", id)) if (worker.workspace_id && worker.condition !== "cancelled") { await this.operation(run, "stop-worker", { worker_id: worker.id }); this.store.put("workers", { ...worker, condition: worker.condition === "completed" ? "completed" : "cancelled" }, id); }
    const stopped = { ...this.observed(run, run.machine_id === "local" ? await this.host.stopRun(id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${id}/stop`, {})), ...(run.implementation_completion_pending ? { implementation_completion_pending: true } : {}) };
    const current = this.store.get<FactoryRun>("runs", id);
    if (current?.issue_pause) stopped.issue_pause = current.issue_pause;
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
  async outputs(run: FactoryRun): Promise<FactoryOutput[]> { return run.machine_id === "local" ? this.host.outputs(run.id) : this.remote(run.machine_id, `/runs/${run.id}/artifacts`); }
  async send(run: FactoryRun, text: string, signal: AbortSignal): Promise<void> { if (run.machine_id === "local") await this.host.send(run.id, text, signal); else await this.remote(run.machine_id, `/runs/${run.id}/send`, { text }, signal); }
  async output(run: FactoryRun, output: FactoryOutput): Promise<{ content_base64: string }> { return run.machine_id === "local" ? this.host.output(run.id, output.name, output.hash) : this.remote(run.machine_id, `/runs/${run.id}/artifacts/content?name=${encodeURIComponent(output.name)}&hash=${encodeURIComponent(output.hash)}`); }
  stop(): void { this.stopped = true; this.host.stop(); }
}
