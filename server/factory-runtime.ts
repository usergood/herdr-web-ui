import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FactoryAction, FactoryApproval, FactoryArtifact, FactoryOutput, FactoryProject, FactoryRun, FactorySettings, Implementation, ProjectCheckout } from "../shared/protocol.ts";
import { FactoryError, git, hash, inspectCheckout } from "./factory-host.ts";
import { FactoryExecutionHost } from "./factory-execution-host.ts";
import { bundlePayload, verifySkills } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";

export type MachineEndpoint = (machineId: string) => { url: string; token: string } | undefined;
type HostCapabilities = Awaited<ReturnType<FactoryExecutionHost["capabilities"]>>;
const activeConditions = new Set(["accepted", "working", "needs_you", "blocked", "disconnected", "interrupted"]);
const actions: FactoryAction[] = ["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets", "implement-spec", "retro", "apply-retro", "verify-provider"];
export class FactoryRuntime {
  private readonly dispatches = new Map<string, Promise<FactoryRun>>();
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly settings: () => FactorySettings, private readonly host: FactoryExecutionHost, private readonly endpoint: MachineEndpoint, private readonly readArtifact: (record: FactoryArtifact) => Buffer, private readonly publicUrl: string | null) {}
  private async remote<T>(machineId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const endpoint = this.endpoint(machineId);
    if (!endpoint) throw new FactoryError("machine_offline", "The selected Machine is disconnected; its ownership is retained", 409);
    try {
      const deadline = AbortSignal.timeout(path.endsWith("/operations/check") ? 325_000 : path === "/launch" ? 75_000 : 15_000);
      const response = await fetch(`${endpoint.url}/api/factory-host${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${endpoint.token}`, "x-herdr-factory": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) throw new FactoryError("remote_factory_unavailable", "The selected Machine rejected this factory operation; verify its bridge, native tools and checkout", response.status === 404 ? 409 : response.status);
      return await response.json() as T;
    } catch (error) { if (error instanceof FactoryError) throw error; throw new FactoryError("machine_disconnected", "The selected Machine could not be observed; reconcile its accepted identity before retrying", 409); }
  }
  async capabilities(machineId = "local"): Promise<HostCapabilities> {
    const capabilities = machineId === "local" ? await this.host.capabilities() : await this.remote<HostCapabilities>(machineId, "/capabilities");
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
    const questions = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).filter((question) => question.run_id === run.id);
    const revision = this.workflow.questionRevision(run.implementation_id);
    if (!questions.length || questions.some((question) => question.answer === null) || !this.store.list<{ revision: string }>("answer_consumption", run.id).some((receipt) => receipt.revision === revision)) throw new FactoryError("verification_round_required", "Complete a real recorded owner-question round and native consumption before certification", 409);
    return run.machine_id === "local" ? this.host.verifyProvider(run.id) : this.remote(run.machine_id, `/runs/${run.id}/verify-provider`, {});
  }
  async operation<T>(run: FactoryRun, action: string, body: Record<string, unknown> = {}): Promise<T> {
    if (existsSync(join(this.store.root, "recovery-copy.json")) && !["transcript", "head", "review-evidence"].includes(action)) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    return (run.machine_id === "local" ? await this.host.operation(run.id, action, body) : await this.remote(run.machine_id, `/runs/${run.id}/operations/${action}`, body)) as T;
  }
  async inspect(machineId: string, path: string): Promise<Awaited<ReturnType<typeof inspectCheckout>>> {
    return machineId === "local" ? inspectCheckout(path) : this.remote(machineId, "/inspect", { path });
  }
  async capture(machineId: string, path: string, base: string, mode: "branch" | "workspace"): Promise<{ repository: string; head: string; files: import("../shared/protocol.ts").ReviewSnapshot["files"] }> {
    return this.remote(machineId, "/review", { path, base, mode });
  }
  async start(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryRun> {
    if (!actions.includes(body.action as FactoryAction) || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_start", "Select an explicit action with an idempotency key");
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) throw new FactoryError("not_found", "Implementation not found", 404);
    const previous = this.store.list<FactoryRun>("runs", id).find((run) => run.idempotency_key === body.idempotency_key);
    if (previous) {
      if (previous.action !== body.action) throw new FactoryError("idempotency_conflict", "This Start key already belongs to another action", 409);
      return this.dispatches.get(previous.id) ?? previous;
    }
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Execution is disabled on a restored copy until separately scoped promotion", 409);
    const project = implementation.project_id ? this.store.get<FactoryProject>("projects", implementation.project_id) : null;
    const action = body.action as FactoryAction;
    if (["implement-spec", "grill-with-docs", "to-tickets", "retro", "apply-retro"].includes(action) && !project) throw new FactoryError("project_required", "Select a Project before starting this action", 409);
    const retrospective = ["retro", "apply-retro"].includes(action) ? this.store.get<import("../shared/protocol.ts").FactoryRetrospective>("retrospectives", String(body.retrospective_id)) : null;
    if (["retro", "apply-retro"].includes(action) && (!retrospective || retrospective.project_id !== project?.id || action === "apply-retro" && !retrospective.approved)) throw new FactoryError("retrospective_scope_required", "Select retained Project evidence and separately approve improvements before applying them", 409);
    if (action === "to-spec" && this.store.list<{ answer: string | null }>("questions", id).length && (!this.workflow.approved(id, "shared_understanding", this.workflow.questionRevision(id)) || this.store.list<{ answer: string | null }>("questions", id).some((question) => question.answer === null))) throw new FactoryError("understanding_unconfirmed", "Answer pending questions and confirm their shared understanding before specification", 409);
    const machineId = implementation.machine_id ?? project?.machine_id;
    if (!machineId) throw new FactoryError("machine_required", "Select an execution Machine explicitly", 409);
    if (this.store.list<FactoryRun>("runs", id).some((run) => activeConditions.has(run.condition))) throw new FactoryError("implementation_owned", "An existing or uncertain Run retains ownership; reconcile it before starting another", 409);
    const provider = implementation.provider ?? project?.provider ?? this.settings().provider;
    if (body.expected !== undefined) {
      if (!body.expected || typeof body.expected !== "object" || Array.isArray(body.expected)) throw new FactoryError("invalid_scope", "Confirm the displayed execution context");
      const expected = body.expected as Record<string, unknown>;
      if (expected.provider !== provider || expected.machine_id !== machineId || expected.project_id !== implementation.project_id || expected.specification_id !== (this.workflow.specification(id)?.id ?? null) || expected.graph_hash !== this.workflow.graphHash(id)) throw new FactoryError("scope_changed", "The displayed execution context changed; inspect it before starting", 409);
    }
    const skills = verifySkills(this.settings().skills_path ?? this.host.skillPath());
    const capabilities = await this.capabilities(machineId);
    const capability = capabilities.providers.find((entry) => entry.provider === provider);
    if (!capability?.installed || !capability.skills_verified || capabilities.skill_manifest?.hash !== skills.hash || action === "implement-spec" && !capability.factory_ready) throw new FactoryError("provider_unavailable", capability?.reasons.join("; ") || "The selected provider has no verified native contract on this Machine", 409);
    const checkout = project ? this.store.list<ProjectCheckout>("checkouts", project.id).find((entry) => entry.machine_id === machineId) : null;
    let inspected: Awaited<ReturnType<typeof inspectCheckout>> | null = null;
    if (project) {
      if (!checkout) throw new FactoryError("checkout_required", "Configure a verified checkout on the selected Machine", 409);
      inspected = await this.inspect(machineId, checkout.path);
      if (inspected.repository !== checkout.repository) throw new FactoryError("wrong_checkout", "The selected checkout belongs to a different repository", 409);
      if (machineId === "local" && (await git(inspected.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new FactoryError("dirty_checkout", "Preserve the checkout's existing changes before starting repository work", 409);
    }
    if (action === "implement-spec" && project?.tracker !== "app") throw new FactoryError("tracker_setup_required", "Select the app-native Other tracker explicitly; external tracker publication remains a separately configured action", 409);
    const specification = this.workflow.specification(id); const graphHash = this.workflow.graphHash(id);
    const selectedEvidence = new Set(retrospective?.evidence_ids ?? []);
    const selectedArtifacts = (): FactoryArtifact[] => [...this.store.list<FactoryArtifact>("artifacts"), ...this.store.list<FactoryArtifact>("deleted_artifacts")].filter((artifact) => artifact.implementation_id === id && this.store.get("artifacts", artifact.id) !== null || selectedEvidence.has(artifact.id));
    const artifacts = selectedArtifacts();
    if (artifacts.reduce((size, artifact) => size + artifact.size, 0) > 64 * 1024 * 1024) throw new FactoryError("context_too_large", "Retained attachments exceed this Run's 64 MiB materialization budget", 413);
    if (action === "implement-spec") {
      if (!specification || !this.workflow.approved(id, "specification", specification.id) || !this.workflow.approved(id, "testing_seams", specification.id) || !this.workflow.tickets(id).length || !this.workflow.approved(id, "ticket_graph", graphHash)) throw new FactoryError("scope_unaccepted", "Accept the current specification, testing seams and Ticket graph", 409);
      if (!project?.checks?.length || !project.permissions?.trim()) throw new FactoryError("project_setup_required", "Configure known Project checks and execution permissions before factory admission", 409);
    }
    const api = new URL(this.publicUrl ?? origin);
    if (!["http:", "https:"].includes(api.protocol) || api.username || api.password) throw new FactoryError("invalid_factory_url", "Use an authenticated HTTP(S) app address for the tracker");
    const contractHash = hash(JSON.stringify({ implementation, project, checkout, specification, graphHash, settings: this.settings(), skills: skills.hash, artifacts }));
    const run = this.store.db.transaction(() => {
      const raced = this.store.list<FactoryRun>("runs", id).find((entry) => entry.idempotency_key === body.idempotency_key);
      if (raced) return { run: raced, accepted: false };
      if (this.stopped) throw new FactoryError("stopping", "The bridge is stopping; reconcile before retrying", 409);
      const currentHash = hash(JSON.stringify({ implementation: this.store.get("implementations", id), project: project ? this.store.get("projects", project.id) : null, checkout, specification: this.workflow.specification(id), graphHash: this.workflow.graphHash(id), settings: this.settings(), skills: skills.hash, artifacts: selectedArtifacts() }));
      if (currentHash !== contractHash) throw new FactoryError("scope_changed", "The selected execution scope changed during admission", 409);
      const active = this.store.list<FactoryRun>("runs").filter((entry) => activeConditions.has(entry.condition));
      if (active.some((entry) => entry.implementation_id === id)) throw new FactoryError("implementation_owned", "An existing or uncertain Run still owns this Implementation", 409);
      const children = this.store.list<{ condition: string }>("workers").filter((entry) => activeConditions.has(entry.condition as FactoryRun["condition"])).length;
      if (new Set(active.map((entry) => entry.implementation_id)).size >= this.settings().max_implementations || active.length + children >= this.settings().max_agents) throw new FactoryError("capacity_exhausted", "Global execution capacity is in use; start manually after capacity is released", 409);
      const record: FactoryRun = { ...this.store.record(), implementation_id: id, action, provider, machine_id: machineId, condition: "accepted", waiting_reason: null, idempotency_key: body.idempotency_key as string, specification_id: specification?.id ?? null, graph_hash: graphHash, base: inspected?.head ?? null, checkout: inspected?.path ?? null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills, artifacts, context_message_ids: this.store.list<{ id: string }>("messages", id).map((message) => message.id), retrospective, retrospective_evidence: retrospective ? this.store.get("retro_evidence", retrospective.id) : null, implementation, project, checkout: inspected, specification, tickets: this.workflow.tickets(id), approvals: this.store.list<FactoryApproval>("approvals", id), effective_settings: this.settings(), provider_version: capability.version, permissions: "Retain native controls; publication, merge, deployment and destructive cleanup are separate owner actions", contract_hash: contractHash } };
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
  private async dispatch(record: FactoryRun): Promise<FactoryRun> {
    let run = record;
    let dispatched = false;
    const access = this.store.get<{ token: string; url: string }>("run_access", record.id);
    try {
      const attachments = (this.store.get<{ artifacts: FactoryArtifact[] }>("run_artifacts", record.id)?.artifacts ?? []).map((artifact) => ({ ...artifact, content_base64: this.readArtifact(artifact).toString("base64") }));
      dispatched = true;
      run = this.observed(record, record.machine_id === "local" ? await this.host.launch(record, access ?? undefined, attachments) : await this.remote<FactoryRun>(record.machine_id, "/launch", { run: record, access, attachments }));
    }
    catch (error) { run = { ...record, condition: dispatched ? "disconnected" : "failed", waiting_reason: error instanceof FactoryError ? error.message : "Launch outcome is uncertain; reconcile native identity", updated_at: new Date().toISOString() }; }
    if (!this.stopped) this.store.db.transaction(() => {
      this.store.put("runs", run, run.implementation_id);
      this.store.event(run.implementation_id, run.condition === "working" ? "native_launch_confirmed" : "dispatch_uncertain", { run_id: run.id, machine_id: run.machine_id, pane_id: run.pane_id, reason: run.waiting_reason });
      if (run.condition === "working") { const idea = this.store.get<Implementation>("implementations", run.implementation_id)!; this.store.put("implementations", { ...idea, stage: run.action === "implement-spec" ? "running" : "specifying" }); }
    })();
    return run;
  }
  private observed(expected: FactoryRun, actual: FactoryRun): FactoryRun {
    for (const key of ["id", "implementation_id", "action", "provider", "machine_id", "idempotency_key", "specification_id", "graph_hash", "base", "checkout", "created_at"] as const) if (actual?.[key] !== expected[key]) throw new FactoryError("run_identity_changed", "The Machine returned another accepted Run identity; preserve ownership", 409);
    if (hash(JSON.stringify(actual.manifest)) !== hash(JSON.stringify(expected.manifest)) || !["accepted", "working", "needs_you", "blocked", "disconnected", "interrupted", "failed", "cancelled", "completed"].includes(actual.condition)) throw new FactoryError("run_identity_changed", "The Machine changed the accepted contract; preserve ownership", 409);
    if (expected.worktree && (actual.worktree !== expected.worktree || actual.branch !== expected.branch || expected.workspace_id !== null && actual.workspace_id !== expected.workspace_id || expected.pane_id !== null && actual.pane_id !== expected.pane_id)) throw new FactoryError("run_identity_changed", "The Machine changed the owned working directory or native identity", 409);
    return actual;
  }
  async reconcile(runId: string): Promise<FactoryRun> {
    let run = this.store.get<FactoryRun>("runs", runId); if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (["completed", "cancelled", "failed"].includes(run.condition)) return run;
    try { run = this.observed(run, run.machine_id === "local" ? await this.host.reconcile(run.id) : await this.remote<FactoryRun>(run.machine_id, `/runs/${run.id}/reconcile`, {})); }
    catch (error) { run = { ...run, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The Machine cannot currently be observed; ownership is retained", updated_at: new Date().toISOString() }; }
    const question = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).find((entry) => entry.run_id === run!.id && entry.answer === null);
    if (question && run.condition === "working") run = { ...run, condition: "needs_you", waiting_reason: question.question };
    this.store.put("runs", run, run.implementation_id); this.store.event(run.implementation_id, "run_reconciled", { run_id: run.id, condition: run.condition }); return run;
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
  async outputs(run: FactoryRun): Promise<FactoryOutput[]> { return run.machine_id === "local" ? this.host.outputs(run.id) : this.remote(run.machine_id, `/runs/${run.id}/artifacts`); }
  async send(run: FactoryRun, text: string, signal: AbortSignal): Promise<void> { if (run.machine_id === "local") await this.host.send(run.id, text, signal); else await this.remote(run.machine_id, `/runs/${run.id}/send`, { text }, signal); }
  async output(run: FactoryRun, output: FactoryOutput): Promise<{ content_base64: string }> { return run.machine_id === "local" ? this.host.output(run.id, output.name, output.hash) : this.remote(run.machine_id, `/runs/${run.id}/artifacts/content?name=${encodeURIComponent(output.name)}&hash=${encodeURIComponent(output.hash)}`); }
  stop(): void { this.stopped = true; this.host.stop(); }
}
