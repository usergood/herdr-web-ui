import { mkdirSync } from "node:fs";
import { permissionDescription, validPermissionMode } from "../shared/agent-permissions.ts";
import { MATT_PROJECT_WORKFLOW } from "../shared/project-setup.ts";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { FactoryHostRequests, FactoryArtifact, FactoryChat, FactoryDetail, FactoryMessage, FactoryProject, FactoryProvider, FactoryRun, FactorySettings, Implementation, ProjectCheckout } from "../shared/protocol.ts";
import { badRequest, errorResponse, httpError, isJsonObject, jsonResponse } from "./http.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryError, hash, inspectCheckout } from "./factory-host.ts";
import { FactoryArtifacts } from "./factory-artifacts.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryBackup } from "./factory-backup.ts";
import { FactoryRuntime, type MachineEndpoint } from "./factory-runtime.ts";
import type { FactoryNative } from "./factory-native.ts";
import { FactoryExecutionHost } from "./factory-execution-host.ts";
import { captureReview, FactoryReview } from "./factory-review.ts";
import { FactoryPipeline } from "./factory-pipeline.ts";
import { FactoryContinuation } from "./factory-continuation.ts";
import { FactoryRetrospectives } from "./factory-retrospective.ts";
import { HerdrError } from "./herdr/client.ts";
import { factoryTrackerGuide } from "./factory-tracker-client.ts";
import { FactoryReferences } from "./factory-references.ts";
import { projectReferenceTemplate } from "../shared/project-references.ts";
import { MachineAccounts } from "./accounts.ts";
import type { AccountTools } from "./account-tools.ts";
import { ProjectGitHub } from "./github-project.ts";
import { hasIssueSource } from "./issue-delivery.ts";
import { sameOrigin } from "./machine-security.ts";
import { parseModelSelection, resolveModelSelection } from "./agent-model-selection.ts";

const providers: FactoryProvider[] = ["codex", "claude", "opencode"];
const initialSettings: FactorySettings = { provider: "codex", max_implementations: 6, max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };

export class FactoryService {
  readonly store: FactoryStore;
  private readonly artifacts: FactoryArtifacts;
  private readonly workflow: FactoryWorkflow;
  private readonly backup: FactoryBackup;
  private readonly runtime: FactoryRuntime;
  private readonly review: FactoryReview;
  private readonly executionHost: FactoryExecutionHost;
  private readonly pipeline: FactoryPipeline;
  private readonly continuation: FactoryContinuation;
  private readonly retrospectives: FactoryRetrospectives;
  private readonly references: FactoryReferences;
  private readonly accounts: MachineAccounts;
  private readonly github: ProjectGitHub;
  private address: string | null = null;
  private stopped = false;
  constructor(stateDir: string, private readonly skillsPath: string | null = null, native: Partial<FactoryNative> = {}, endpoint: MachineEndpoint = () => undefined, publicUrl: string | null = null, accountTools: AccountTools = {}, private readonly registeredMachine: (id: string) => boolean = (id) => id === "local" || !!endpoint(id), accountDiscoveryHome?: string) {
    this.accounts = new MachineAccounts(stateDir, accountTools, false, accountDiscoveryHome);
    this.store = new FactoryStore(stateDir); this.artifacts = new FactoryArtifacts(this.store, (text) => this.accounts.assertPublic(text)); this.workflow = new FactoryWorkflow(this.store); this.backup = new FactoryBackup(this.store, this.artifacts);
    this.accounts.usage((id) => [...this.store.list<FactoryRun>("runs"), ...this.store.list<{ run: FactoryRun; closing?: boolean }>("host_leases").map((lease) => lease.run)].some((run) => ["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted"].includes(run.condition) && (run.manifest as { account_snapshot?: import("../shared/accounts.ts").AccountBindingSnapshot })?.account_snapshot?.profiles.some((profile) => profile.id === id)));
    this.references = new FactoryReferences(this.store, this.artifacts);
    this.executionHost = new FactoryExecutionHost(this.store, () => this.settings().skills_path, native, this.accounts);
    this.runtime = new FactoryRuntime(this.store, this.workflow, () => this.settings(), this.executionHost, endpoint, (record) => this.artifacts.read(record), publicUrl, this.references, this.accounts, (id, scope, retryRunId) => this.github.admission(id, scope, retryRunId), id => this.pipeline.reconcileCompletion(id)); this.review = new FactoryReview(this.store, (machine, path, base, mode) => this.runtime.capture(machine, path, base, mode), (machine, path) => this.runtime.inspect(machine, path));
    this.pipeline = new FactoryPipeline(this.store, this.runtime, this.workflow, () => this.settings(), id => this.retainHandoff(id));
    this.continuation = new FactoryContinuation(this.store, this.workflow, this.runtime, async (id, allowPartial) => {
      await this.retainHandoff(id);
      const events = this.store.list<import("../shared/protocol.ts").FactoryEvent>("events", this.store.get<FactoryRun>("runs", id)!.implementation_id).filter(event => (event.data as { run_id?: string })?.run_id === id);
      const latest = (kinds: string[]) => events.filter(event => kinds.includes(event.kind)).at(-1)?.kind;
      if (!allowPartial && (latest(["native_snapshot_unavailable", "planning_handoff_retained"]) === "native_snapshot_unavailable" || latest(["planning_documents_unavailable", "planning_documents_retained"]) === "planning_documents_unavailable")) throw new FactoryError("handoff_incomplete", "Some planning context could not be retained. Review the warning and choose Continue with available context", 409);
    });
    this.retrospectives = new FactoryRetrospectives(this.store);
    this.github = new ProjectGitHub(this.store, this.accounts, (machineId, path) => this.runtime.discover(machineId, path), {
      reconcile: async () => { await this.runtime.recover(); await this.runtime.reconcileCapacity(); },
      start: (id, scope, key, validate) => {
        if (!this.address) throw new FactoryError("factory_address_required", "Wait for the connection server address", 409);
        return this.runtime.start(id, { action: "implement-spec", issue_scope: scope, idempotency_key: key }, this.address, { validateScope: validate });
      },
    });
  }
  bindAddress(address: string): void { this.address = address; }
  settings(): FactorySettings { return this.store.get<{ id: string; value: FactorySettings }>("settings", "default")?.value ?? { ...initialSettings, skills_path: this.skillsPath }; }
  private activeWork(id: string): boolean {
    const runs = this.store.list<FactoryRun>("runs", id); const ids = new Set(runs.map((run) => run.id));
    return runs.some((run) => !["completed", "failed", "cancelled"].includes(run.condition)) || this.store.list<import("../shared/factory.ts").FactoryWorker>("workers").some((worker) => ids.has(worker.run_id) && !["completed", "failed", "cancelled"].includes(worker.condition));
  }
  private projectActive(id: string): boolean {
    const runs = this.store.list<FactoryRun>("runs").filter((run) => (run.manifest as { project?: FactoryProject })?.project?.id === id);
    const ids = new Set(runs.map((run) => run.id));
    return runs.some((run) => !["completed", "failed", "cancelled"].includes(run.condition)) || this.store.list<import("../shared/factory.ts").FactoryWorker>("workers").some((worker) => ids.has(worker.run_id) && !["completed", "failed", "cancelled"].includes(worker.condition));
  }
  private paneLinks(): import("../shared/factory.ts").FactoryPaneLink[] {
    return this.store.list<FactoryRun>("runs").flatMap((run) => {
      const base = { project_id: (run.manifest as { project?: FactoryProject })?.project?.id ?? null, implementation_id: run.implementation_id, run_id: run.id, machine_id: run.machine_id, provider: run.provider };
      return [...(run.pane_id ? [{ ...base, pane_id: run.pane_id, worker_id: null, worktree: run.worktree, workspace_id: run.workspace_id, title: run.action, condition: run.condition }] : []), ...this.store.list<import("../shared/factory.ts").FactoryWorker>("workers", run.id).filter((worker) => worker.pane_id).map((worker) => ({ ...base, pane_id: worker.pane_id!, worker_id: worker.id, worktree: worker.worktree, workspace_id: worker.workspace_id, title: (run.manifest as { tickets?: { id: string; title: string }[] })?.tickets?.find((ticket) => ticket.id === worker.ticket_id)?.title ?? worker.role, condition: worker.condition }))];
    });
  }
  bindPrompt(prompt: FactoryNative["prompt"]): void { this.executionHost.bindPrompt(prompt); }
  private async body(request: Request, limit = 512 * 1024): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) throw new FactoryError("invalid_body", "Enter a JSON request body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new FactoryError("body_too_large", "This request exceeds the configured size limit", 413); } chunks.push(chunk.value); }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isJsonObject(value)) throw new FactoryError("invalid_body", "Enter a JSON object");
    this.accounts.assertPublic(JSON.stringify(value));
    return value;
  }
  private intakeImplementations(): Implementation[] {
    const entries = new Map(this.store.list<FactoryProject>("projects").filter(project => !project.removed_at).flatMap(project => this.github.queue(project.id).entries).map(entry => [entry.implementation_id, entry]));
    return this.store.list<Implementation>("implementations").sort((a, b) => a.position - b.position).map(idea => ({ ...idea, intake: entries.get(idea.id) }));
  }
  detail(id: string): FactoryDetail | null {
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) return null;
    const runs = this.store.list<FactoryRun>("runs", id); const runIds = new Set(runs.map((run) => run.id));
    const active = [...runs].reverse().find(run => !["completed", "cancelled", "failed"].includes(run.condition));
    const questionRunId = active?.action === "verify-provider" ? active.id : undefined;
    const sourceProjects = new Set(this.store.list<import("../shared/github-project.ts").ProjectGitHubSource>("github_sources").filter(source => source.implementation_id === id).map(source => source.project_id));
    const sources = [...sourceProjects].flatMap(projectId => this.github.sources(projectId).filter(source => source.implementation_id === id).map(source => ({ ...this.github.describeSource(source), intake: this.github.intake(source) })));
    const sync = sources[0] ? this.store.get<{ last_sync: string | null; problem: string | null }>("github_sync", sources[0].project_id) : null;
    return { implementation, github_sources: sources, github_sync: sync ? { last_sync: sync.last_sync, problem: sync.problem } : null, question_context: { run_id: questionRunId ?? null, revision: this.workflow.questionRevision(id, questionRunId), questions: this.workflow.questions(id, questionRunId) }, graph_hash: this.workflow.graphHash(id), question_revision: this.workflow.questionRevision(id), chats: this.store.list("chats", id), messages: this.store.list("messages", id), specifications: this.store.list("specifications", id), tickets: this.workflow.tickets(id), approvals: this.store.list("approvals", id), questions: this.store.list("questions", id), artifacts: this.store.list("artifacts", id), runs, snapshots: this.store.list("snapshots", id), comments: this.store.list("comments", id), events: this.store.list("events", id), native_snapshots: this.store.list<import("../shared/protocol.ts").NativeConversationSnapshot>("native_snapshots").filter((record) => runIds.has(record.run_id)), workers: this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").filter((worker) => runIds.has(worker.run_id)), checks: this.store.list<import("../shared/protocol.ts").FactoryCheck>("checks").filter((check) => runIds.has(check.run_id)), review_evidence: this.store.list<import("../shared/protocol.ts").FactoryReviewEvidence>("review_evidence").filter((report) => runIds.has(report.run_id)), retrospectives: implementation.project_id ? this.store.list("retrospectives", implementation.project_id) : [], frontier: runs.at(-1)?.action === "implement-spec" ? this.pipeline.frontier(runs.at(-1)!) : [] };
  }
  agentAuthenticated(request: Request, url: URL): boolean {
    const route = /^\/api\/factory-agent\/([a-zA-Z0-9-]+)\//.exec(url.pathname);
    if (!route) return false;
    const access = this.store.get<{ token: string }>("run_access", route[1]!);
    const presented = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    return !!access && timingSafeEqual(Buffer.from(hash(presented)), Buffer.from(hash(access.token)));
  }
  async handleAgent(request: Request, url: URL): Promise<Response> {
    try {
      const route = /^\/api\/factory-agent\/([a-zA-Z0-9-]+)\/(contract|question|sync-answers|consume|worker|checks|artifact|specification|tickets|proposal|ticket\/[a-zA-Z0-9-]+|worker\/[a-zA-Z0-9-]+\/[a-z-]+)$/.exec(url.pathname);
      if (!route) throw new FactoryError("not_found", "Unknown scoped tracker operation", 404);
      if (!this.agentAuthenticated(request, url)) throw new FactoryError("unauthorized", "Use this Run's scoped tracker credential", 401);
      await this.runtime.recover();
      const run = this.store.get<FactoryRun>("runs", route[1]!);
      if (!run || ["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_closed", "This Run's control scope has ended", 409);
      if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) throw new FactoryError("invalid_origin", "Use the scoped tracker on its authenticated app origin", 403);
      const action = route[2]!;
      if (action === "contract" && request.method === "GET") return jsonResponse({ tracker_guide: factoryTrackerGuide, run, workers: this.store.list("workers", run.id), checks: this.store.list("checks", run.id), review_batches: this.store.list("review_batches", run.implementation_id), messages: this.store.list<FactoryMessage>("messages", run.implementation_id).filter((message) => (run.manifest as { context_message_ids?: string[] }).context_message_ids?.includes(message.id)), question_revision: this.workflow.questionRevision(run.implementation_id, run.id), questions: this.workflow.questions(run.implementation_id, run.id), frontier: run.action === "implement-spec" ? this.pipeline.frontier(run) : [], artifacts: (run.manifest as { artifacts?: FactoryArtifact[] }).artifacts ?? [] });
      if (action.startsWith("ticket/") && request.method === "GET") {
        const ticket = (run.manifest as { tickets: import("../shared/protocol.ts").FactoryTicket[] }).tickets.find((ticket) => ticket.id === action.slice(7));
        if (!ticket) throw new FactoryError("not_found", "Ticket is outside this Run's frozen graph", 404);
        return jsonResponse(ticket);
      }
      if (request.method !== "POST" || request.headers.get("x-herdr-factory") !== "1") throw new FactoryError("invalid_operation", "Use an explicit scoped tracker operation", 400);
      const body = await this.body(request, action === "artifact" ? Math.ceil(this.settings().max_artifact_bytes / 3) * 4 + 64 * 1024 : 512 * 1024);
      if (action === "specification" && run.action === "to-spec") return jsonResponse(this.workflow.mutate(run.implementation_id, "specifications", body), 201);
      if (action === "tickets" && run.action === "to-tickets") return jsonResponse(this.workflow.mutate(run.implementation_id, "tickets", body), 201);
      if (action === "proposal" && run.action === "retro") {
        const scope = (run.manifest as { retrospective: import("../shared/protocol.ts").FactoryRetrospective }).retrospective;
        return jsonResponse(this.retrospectives.propose(scope.id, body), 201);
      }
      if (action === "question") return jsonResponse(this.workflow.mutate(run.implementation_id, "questions", { ...body, run_id: run.id }), 201);
      if (action === "sync-answers") {
        if (body.before !== undefined && typeof body.before !== "string") throw new FactoryError("invalid_cursor", "Use a cursor from this Run's retained native history");
        const snapshot = await this.retainNative(run.id, body.before as string | undefined);
        return jsonResponse({ snapshot_id: snapshot.id, cursor: snapshot.cursor, question_revision: this.workflow.questionRevision(run.implementation_id, run.id), questions: this.workflow.questions(run.implementation_id, run.id) } satisfies import("../shared/protocol.ts").FactoryNativeAnswers);
      }
      if (action === "consume") {
        const revision = this.workflow.questionRevision(run.implementation_id, run.id);
        const questions = this.workflow.questions(run.implementation_id, run.id);
        if (body.revision !== revision || questions.some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Consume the exact answered question revision", 409);
        if (body.worker_id !== undefined && (!this.store.get<{ run_id: string }>("workers", String(body.worker_id)) || this.store.get<{ run_id: string }>("workers", String(body.worker_id))!.run_id !== run.id)) throw new FactoryError("invalid_worker", "Consume answers for a worker in this Run");
        const receipt = { ...this.store.record(), run_id: run.id, worker_id: body.worker_id ?? null, revision };
        this.store.put("answer_consumption", receipt, run.id); this.store.event(run.implementation_id, "answers_consumed", receipt);
        void this.continuation.verified(run.id);
        return jsonResponse({ receipt, questions });
      }
      if (action === "worker") return jsonResponse(await this.pipeline.startWorker(run.id, body));
      if (action === "checks") return jsonResponse(await this.pipeline.check(run.id));
      if (action === "artifact") return jsonResponse(this.artifacts.create(run.implementation_id, { ...body, chat_id: this.store.list<FactoryChat>("chats", run.implementation_id)[0]!.id, origin: `run-${run.id}` }, this.settings()), 201);
      const worker = /^worker\/([a-zA-Z0-9-]+)\/(refresh|reconcile|check|integrate|stop|review-evidence)$/.exec(action);
      if (worker) return jsonResponse(worker[2] === "integrate" ? await this.pipeline.integrate(run.id, worker[1]!) : await this.pipeline.workerAction(run.id, worker[1]!, worker[2]!));
      throw new FactoryError("not_found", "This operation is outside the Run's granted scope", 404);
    } catch (error) { return error instanceof FactoryError ? httpError(error.status, error.code, error.message) : errorResponse(error); }
  }
  private async retainNative(id: string, before?: string): Promise<import("../shared/protocol.ts").NativeConversationSnapshot> {
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (before && !this.store.list<import("../shared/protocol.ts").NativeConversationSnapshot>("native_snapshots", id).some((record) => record.cursor === before)) throw new FactoryError("invalid_cursor", "Use a cursor from this Run's retained native history");
    const captured = await this.runtime.operation<Omit<import("../shared/protocol.ts").NativeConversationSnapshot, "id" | "created_at" | "updated_at" | "sequence" | "run_id">>(run, "transcript", { before });
    return this.store.db.transaction(() => {
      const snapshots = this.store.list<import("../shared/protocol.ts").NativeConversationSnapshot>("native_snapshots", id);
      const previous = snapshots.find((entry) => entry.source_id === captured.source_id && entry.version === captured.version && entry.cursor === captured.cursor);
      if (previous) { this.workflow.retainNativeAnswers(run, previous, before === undefined); return previous; }
      const record = { ...this.store.record(), ...captured, run_id: id, sequence: snapshots.filter((entry) => entry.source_id === captured.source_id).length };
      this.store.put("native_snapshots", record, id); this.store.event(run.implementation_id, "native_snapshot_retained", { snapshot_id: record.id, source_id: record.source_id, sequence: record.sequence, version: record.version }); this.workflow.retainNativeAnswers(run, record, before === undefined); return record;
    }).immediate();
  }
  private async retainHandoff(id: string): Promise<void> {
    const run = this.store.get<FactoryRun>("runs", id);
    if (!run) throw new FactoryError("not_found", "Run not found", 404);
    if (["cancelled", "completed", "failed"].includes(run.condition)) return;
    try {
      const snapshot = await this.retainNative(id);
      const source = `native-handoff:${snapshot.id}`;
      const text = snapshot.turns.map(turn => `${turn.role}: ${turn.parts.flatMap(part => part.kind === "text" || part.kind === "compact" ? [part.text] : []).join("\n")}`).join("\n\n");
      const token = this.store.get<{ token: string }>("run_access", id)?.token;
      const safe = this.accounts.sanitize(token ? text.split(token).join("[scoped credential redacted]") : text);
      const content = `Planning handoff from Run ${id}, native snapshot ${snapshot.id}, source ${snapshot.source_id}.\n${snapshot.cursor ? "This native history page has earlier pages; consult the retained native history for omitted context.\n" : ""}${safe.length > 48_000 ? "Earlier text omitted to keep this handoff within 50,000 characters.\n" : ""}\n${safe.slice(-48_000)}`;
      this.store.db.transaction(() => {
        if (this.store.list<FactoryMessage>("messages", run.implementation_id).some(message => message.source_id === source)) return;
        const chat = this.store.list<FactoryChat>("chats", run.implementation_id)[0]!;
        const message: FactoryMessage = { ...this.store.record(), implementation_id: run.implementation_id, chat_id: chat.id, role: "system", content, source_id: source, sequence: 0 };
        this.store.put("messages", message, run.implementation_id); this.store.event(run.implementation_id, "planning_handoff_retained", { run_id: id, snapshot_id: snapshot.id, message_id: message.id, partial: !!snapshot.cursor || safe.length > 48_000 });
      }).immediate();
    } catch { this.store.event(run.implementation_id, "native_snapshot_unavailable", { run_id: id, native_store_retained: true }); }
    if (["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action)) {
      try { const outputs = await this.importOutputs(run); this.store.event(run.implementation_id, "planning_documents_retained", { run_id: id, artifact_ids: outputs.map(output => output.id) }); }
      catch (error) { this.store.event(run.implementation_id, "planning_documents_unavailable", { run_id: id, code: error instanceof FactoryError ? error.code : "capture_failed", worktree_retained: true }); }
    }
  }
  private async importOutputs(run: FactoryRun): Promise<FactoryArtifact[]> {
    const chat = this.store.list<FactoryChat>("chats", run.implementation_id)[0]!;
    const imported: FactoryArtifact[] = [];
    for (const output of await this.runtime.outputs(run)) {
      const origin = `${run.machine_id}:run-${run.id}:artifact-${hash(output.name).slice(0, 48)}`;
      const bytes = await this.runtime.output(run, output);
      const existing = this.store.list<FactoryArtifact>("artifacts", run.implementation_id).find(artifact => artifact.origin === origin && artifact.hash === output.hash);
      imported.push(existing ?? this.artifacts.create(run.implementation_id, { ...output, ...bytes, chat_id: chat.id, origin }, this.settings()));
    }
    if (["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action)) this.store.put("planning_captures", { id: run.id, artifact_ids: imported.filter(artifact => /^planning-(?:[a-f0-9]{16}-|index-)/.test(artifact.name)).map(artifact => artifact.id) });
    return imported;
  }
  observe(paneId: string, status: string, agent: string | null, ended = false, backgroundWorking = false): void {
    if (this.stopped) return;
    const nextCondition = ended ? "interrupted" : status === "blocked" ? "needs_you" : ["idle", "done"].includes(status) && !backgroundWorking ? "ready" : "working";
    const reason = ended ? "The native pane ended without an accepted outcome; retained work needs reconciliation" : status === "blocked" ? "The native agent is waiting for an owner answer" : null;
    for (const run of this.store.list<FactoryRun>("runs")) if (run.machine_id === "local" && run.pane_id === paneId && ["working", "ready", "needs_you", "blocked"].includes(run.condition)) {
      if (run.issue_pause) continue;
      if (!ended && agent !== run.provider) continue;
      const pending = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).find((question) => question.run_id === run.id && question.answer === null);
      const condition = pending && !ended ? "needs_you" : nextCondition;
      const waiting = pending && !ended ? pending.question : reason;
      if (run.condition !== condition || run.waiting_reason !== waiting) { this.store.put("runs", { ...run, condition, waiting_reason: waiting, updated_at: new Date().toISOString() }, run.implementation_id); this.store.event(run.implementation_id, "native_condition_changed", { run_id: run.id, condition }); }
      if (condition === "ready" && run.action === "verify-provider") void this.continuation.verified(run.id);
    }
    for (const worker of this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers")) if (worker.pane_id === paneId && ["working", "ready", "needs_you", "blocked"].includes(worker.condition)) {
      const run = this.store.get<FactoryRun>("runs", worker.run_id);
      if (run?.machine_id !== "local" || !ended && agent !== run.provider) continue;
      const condition = ended ? "interrupted" : status === "blocked" ? "needs_you" : ["idle", "done"].includes(status) && !backgroundWorking ? "ready" : "working";
      const waiting = !ended && ["idle", "done"].includes(status) ? "Native worker is ready; reconcile its candidate and explicitly refresh, check and integrate it" : reason;
      if (worker.condition !== condition || worker.waiting_reason !== waiting) { this.store.put("workers", { ...worker, condition, waiting_reason: waiting, updated_at: new Date().toISOString() }, worker.run_id); this.store.event(run.implementation_id, "worker_condition_changed", { worker_id: worker.id, condition }); }
    }
  }
  async handle(request: Request, url: URL): Promise<Response> {
    try {
      if (request.method !== "GET" && request.headers.get("x-herdr-factory") !== "1") return httpError(403, "invalid_origin", "Use factory controls from this app");
      if (url.pathname === "/api/factory" || url.pathname.startsWith("/api/factory/")) await this.runtime.recover();
      if (url.pathname === "/api/factory-host/pane-state" && request.method === "POST") {
        const body = await this.body(request); if (typeof body.pane_id !== "string" || (!body.pane_id || body.pane_id.length > 200 || /[\0\r\n]/.test(body.pane_id))) throw new FactoryError("invalid_pane", "Select a native pane");
        return jsonResponse(await this.executionHost.paneState(body.pane_id));
      }
      if (url.pathname === "/api/factory/pane-archives" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id) || typeof body.pane_id !== "string" || (!body.pane_id || body.pane_id.length > 200 || /[\0\r\n]/.test(body.pane_id)) || typeof body.archived !== "boolean") throw new FactoryError("invalid_archive", "Select a Machine and native pane");
        let identity: { terminal_id: string; session_ref: string | null; title: string } | undefined;
        if (body.archived) {
          if (typeof body.terminal_id !== "string" || !body.terminal_id) throw new FactoryError("invalid_archive", "Capture the native terminal identity before archiving");
          const pane = await this.runtime.paneState(body.machine_id, body.pane_id);
          if (typeof pane.terminal_id !== "string" || !pane.terminal_id) throw new FactoryError("archive_bridge_required", "Update this host’s bridge before archiving native chats", 409);
          if (body.terminal_id !== pane.terminal_id || body.session_ref !== pane.session_ref) throw new FactoryError("pane_identity_changed", "The native chat changed; refresh before archiving", 409);
          identity = { terminal_id: pane.terminal_id, session_ref: pane.session_ref, title: (typeof pane.title === "string" ? pane.title : pane.pane_id).slice(0, 500) };
          const link = this.paneLinks().find((entry) => entry.machine_id === body.machine_id && entry.pane_id === body.pane_id);
          if (pane.pane_id !== body.pane_id || !["idle", "done"].includes(pane.agent_status) || (pane.background_tasks ?? 0) > 0 || pane.background_wait || link && this.activeWork(link.implementation_id)) throw new FactoryError("pane_busy", "Finish or stop native work before archiving this chat", 409);
        }
        const id = hash(JSON.stringify([body.machine_id, body.pane_id])); const previous = this.store.get<import("../shared/factory.ts").FactoryPaneArchive>("pane_archives", id);
        const record = { ...(previous ?? this.store.record()), id, machine_id: body.machine_id, pane_id: body.pane_id, ...identity, archived_at: body.archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
        this.store.put("pane_archives", record); return jsonResponse(record);
      }
      const github = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/github(?:\/(configure|sync|settings|readiness|queue|preview)|\/pulls\/(\d+)\/(merge|update|rerequest|import|files)|\/issues\/(\d+)\/(approve|prepare|delivery))?$/.exec(url.pathname);
      if (github) {
        if (request.method === "GET" && github[2] === "queue") return jsonResponse(this.github.queue(github[1]!));
        if (request.method === "GET" && github[4] === "files") return jsonResponse(await this.github.files(github[1]!, Number(github[3]), url.searchParams.get("head")));
        if (request.method === "GET" && !github[2] && !github[3] && !github[5]) return jsonResponse(this.github.overview(github[1]!));
        if (request.method !== "POST" || !sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1" || request.headers.get("x-herdr-factory") !== "1") return httpError(403, "invalid_origin", "Use GitHub controls from this app");
        if (github[2] === "preview") return jsonResponse(await this.github.previewQueue(github[1]!));
        if (github[2] === "queue") return jsonResponse(await this.github.configureQueue(github[1]!, await this.body(request)));
        if (github[5]) return jsonResponse(await (github[6] === "delivery" ? this.github.linkDelivery(github[1]!, Number(github[5]), await this.body(request)) : github[6] === "prepare" ? this.github.prepareIssue(github[1]!, Number(github[5]), await this.body(request)) : this.github.approveIssue(github[1]!, Number(github[5]), await this.body(request))));
        if (github[2] === "readiness") return jsonResponse(await this.github.configureReadiness(github[1]!, await this.body(request) as unknown as import("../shared/github-readiness.ts").ReadinessConfiguration));
        if (github[2] === "configure") return jsonResponse(await this.github.configure(github[1]!, await this.body(request) as unknown as import("../shared/github-project.ts").ProjectGitHubConfiguration));
        if (github[2] === "settings") { const body = await this.body(request); return jsonResponse(await this.github.settings(github[1]!, body.account_profile_id)); }
        if (github[2] === "sync") return jsonResponse(await this.github.sync(github[1]!));
        if (github[3]) return jsonResponse(await this.github.action(github[1]!, Number(github[3]), github[4]!, await this.body(request)));
        return httpError(404, "not_found", "Unknown Project GitHub operation");
      }
      const accountCollection = /^\/api\/factory\/machines\/([a-zA-Z0-9_-]+)\/accounts$/.exec(url.pathname);
      const nativeAccounts = /^\/api\/factory\/machines\/([a-zA-Z0-9_-]+)\/accounts\/(discovery|import)$/.exec(url.pathname);
      const hostNativeAccounts = /^\/api\/factory-host\/accounts\/(discovery|import)$/.exec(url.pathname);
      if (nativeAccounts || hostNativeAccounts) {
        const machine = nativeAccounts?.[1] ?? "local"; const action = nativeAccounts?.[2] ?? hostNativeAccounts?.[1];
        if (!this.registeredMachine(machine)) throw new FactoryError("invalid_machine", "Select a registered Machine");
        if (action === "discovery" && request.method === "GET") return jsonResponse(await this.runtime.discoverAccounts(machine, url.searchParams.get("path") ?? undefined));
        if (action === "import" && request.method === "POST") { if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app"); return jsonResponse(await this.runtime.importAccount(machine, await this.body(request)), 201); }
        return httpError(404, "not_found", "Unknown account import operation");
      }
      const hostAccountCollection = url.pathname === "/api/factory-host/accounts";
      if (accountCollection || hostAccountCollection) {
        const machine = accountCollection?.[1] ?? "local";
        if (request.method === "GET") return jsonResponse(await this.runtime.accountOverview(machine));
        if (request.method === "POST") {
          if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app");
          return jsonResponse(await this.runtime.createAccount(machine, await this.body(request)), 201);
        }
        return badRequest("method_not_allowed", "Use GET or POST");
      }
      const accountOperation = /^\/api\/factory\/machines\/([a-zA-Z0-9_-]+)\/accounts\/([a-zA-Z0-9-]+)\/(key|verify|setup|register-key|configure|disable|recover)(?:\/(status|input|cancel))?$/.exec(url.pathname);
      const hostAccountOperation = /^\/api\/factory-host\/accounts\/([a-zA-Z0-9-]+)\/(key|verify|setup|register-key|configure|disable|recover)(?:\/(status|input|cancel))?$/.exec(url.pathname);
      if ((accountOperation || hostAccountOperation) && request.method === "POST") {
        if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app");
        const body = await this.body(request);
        const machine = accountOperation?.[1] ?? "local";
        const id = accountOperation?.[2] ?? hostAccountOperation![1]!;
        const action = accountOperation?.[3] ?? hostAccountOperation![2]!;
        const suffix = accountOperation?.[4] ?? hostAccountOperation?.[3];
        return jsonResponse(await this.runtime.accountOperation(machine, id, action + (suffix ? "/" + suffix : ""), body), action === "setup" && suffix !== "status" ? 202 : 200, { "cache-control": "no-store" });
      }
      if (url.pathname === "/api/factory-host/accounts/snapshot" && request.method === "POST") { if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app"); return jsonResponse(await this.accounts.freeze((await this.body(request)).bindings as import("../shared/accounts.ts").ProjectAccountBindings)); }
      if (url.pathname === "/api/factory/reference-template" && request.method === "GET") return jsonResponse(projectReferenceTemplate);
      const referencePrepare = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/references\/prepare$/.exec(url.pathname);
      if (referencePrepare && request.method === "POST") { const body = await this.body(request); if (typeof body.machine_id !== "string") throw new FactoryError("invalid_machine", "Select an execution Machine"); return jsonResponse(await this.runtime.prepareReferences(referencePrepare[1]!, body.machine_id, body.expected_revision)); }
      if (url.pathname === "/api/factory-host/references/prepare" && request.method === "POST") return jsonResponse(await this.executionHost.prepareReferences(await this.body(request, 90 * 1024 * 1024) as unknown as import("../shared/protocol.ts").FactoryHostRequests["references"]));
      const referenceRoute = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/references(?:\/([a-zA-Z0-9-]+)\/(source|preview|download|remove))?$/.exec(url.pathname);
      if (referenceRoute) {
        const projectId = referenceRoute[1]!;
        if (referenceRoute[2] && referenceRoute[3] !== "remove" && request.method === "GET") return this.artifacts.response(this.references.get(projectId, referenceRoute[2]), referenceRoute[3]!);
        if (referenceRoute[2] && referenceRoute[3] === "remove" && request.method === "POST") return jsonResponse(this.references.remove(projectId, referenceRoute[2], (await this.body(request)).expected_revision));
        if (!referenceRoute[2] && request.method === "GET") return jsonResponse(this.references.current(projectId));
        if (!referenceRoute[2] && request.method === "POST") return jsonResponse(this.references.create(projectId, await this.body(request, Math.ceil(this.settings().max_artifact_bytes / 3) * 4 + 64 * 1024), this.settings()), 201);
      }
      if (url.pathname === "/api/factory-host/capabilities" && request.method === "GET") return jsonResponse(await this.executionHost.capabilities());
      if (url.pathname === "/api/factory-host/capabilities" && request.method === "POST") { if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app"); return jsonResponse(await this.executionHost.capabilities((await this.body(request)).account_snapshot as import("../shared/accounts.ts").AccountBindingSnapshot)); }
      if (url.pathname === "/api/factory-host/prepare" && request.method === "POST") { this.executionHost.prepare(await this.body(request, 4 * 1024 * 1024)); return jsonResponse(await this.executionHost.capabilities()); }
      if (url.pathname === "/api/factory-host/inspect" && request.method === "POST") { const body = await this.body(request); if (typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Enter an absolute checkout path"); return jsonResponse(await inspectCheckout(body.path)); }
      if (url.pathname === "/api/factory-host/review" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.path !== "string" || typeof body.base !== "string" || !/^[a-f0-9]{40,64}$/.test(body.base) || !["branch", "workspace"].includes(String(body.mode))) throw new FactoryError("invalid_snapshot", "Select a verified checkout, base and review mode");
        const checkout = await inspectCheckout(body.path);
        return jsonResponse({ repository: checkout.repository, ...await captureReview(checkout.path, body.base, body.mode as "branch" | "workspace") });
      }
      if (url.pathname === "/api/factory-host/launch" && request.method === "POST") { const body = await this.body(request, 90 * 1024 * 1024); if (!isJsonObject(body.run)) throw new FactoryError("invalid_launch", "Enter an accepted Run identity"); return jsonResponse(await this.executionHost.launch(body.run as unknown as import("../shared/protocol.ts").FactoryRun, isJsonObject(body.access) && typeof body.access.token === "string" && typeof body.access.url === "string" ? { token: body.access.token, url: body.access.url } : undefined, Array.isArray(body.attachments) ? body.attachments : [], isJsonObject(body.references) ? body.references as unknown as import("../shared/protocol.ts").ProjectReferencePayload : undefined), 202); }
      const operation = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/operations\/([a-z-]+)$/.exec(url.pathname);
      if (operation && request.method === "POST") return jsonResponse(await this.executionHost.operation(operation[1]!, operation[2]!, await this.body(request)));
      const hostReconcile = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/reconcile$/.exec(url.pathname);
      if (hostReconcile && request.method === "POST") return jsonResponse(await this.executionHost.reconcile(hostReconcile[1]!));
      const verificationRoute = /^\/api\/(factory-host|factory)\/runs\/([a-zA-Z0-9-]+)\/verify-provider$/.exec(url.pathname);
      if (verificationRoute && request.method === "POST") {
        if (verificationRoute[1] === "factory-host") return jsonResponse(await this.executionHost.verifyProvider(verificationRoute[2]!));
        const run = this.store.get<FactoryRun>("runs", verificationRoute[2]!);
        if (!run) throw new FactoryError("not_found", "Run not found", 404);
        return jsonResponse(await this.runtime.verifyProvider(run));
      }
      const hostStop = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/stop$/.exec(url.pathname);
      if (hostStop && request.method === "POST") return jsonResponse(await this.executionHost.stopRun(hostStop[1]!));
      const hostFinish = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/finish$/.exec(url.pathname);
      if (hostFinish && request.method === "POST") return jsonResponse(await this.executionHost.finishStep(hostFinish[1]!));
      const hostSend = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/send$/.exec(url.pathname);
      if (hostSend && request.method === "POST") { const body = await this.body(request); if (typeof body.text !== "string" || body.text.length > 250_000) throw new FactoryError("invalid_input", "Enter a bounded change request"); await this.executionHost.send(hostSend[1]!, body.text, request.signal); return jsonResponse({ ok: true }); }
      const hostOutputs = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/artifacts(\/content)?$/.exec(url.pathname);
      if (hostOutputs && request.method === "GET") return jsonResponse(hostOutputs[2] ? this.executionHost.output(hostOutputs[1]!, url.searchParams.get("name") ?? "", url.searchParams.get("hash") ?? "") : await this.executionHost.outputs(hostOutputs[1]!));
      const prepareRoute = /^\/api\/factory\/machines\/([a-zA-Z0-9_-]+)\/prepare$/.exec(url.pathname);
      if (prepareRoute && request.method === "POST") return jsonResponse(await this.runtime.prepare(prepareRoute[1]!));
      if (url.pathname === "/api/factory" && request.method === "GET") return jsonResponse({ implementations: this.intakeImplementations(), pane_links: this.paneLinks(), pane_archives: this.store.list("pane_archives"), projects: this.store.list("projects"), checkouts: this.store.list<ProjectCheckout>("checkouts").map((entry) => { if (url.searchParams.get("navigation") !== "1") return entry; const { instructions: _instructions, ...metadata } = entry; return metadata; }), settings: this.settings(), activity: this.store.list<Implementation>("implementations").flatMap((idea) => { const run = this.store.list<FactoryRun>("runs", idea.id).at(-1); return run ? [{ implementation_id: idea.id, run_id: run.id, condition: run.condition, action: run.action, waiting_reason: run.waiting_reason, completed_tickets: this.workflow.tickets(idea.id).filter((ticket) => ticket.status === "done").length, total_tickets: this.workflow.tickets(idea.id).length }] : []; }) });
      if (url.pathname === "/api/factory/settings" && request.method === "POST") {
        const body = await this.body(request); const settings = { ...this.settings() };
        const known = new Set(Object.keys(settings));
        if (Object.keys(body).some((key) => !known.has(key))) throw new FactoryError("invalid_settings", "Unknown factory setting");
        if (body.provider !== undefined) { if (!providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a supported provider"); settings.provider = body.provider as FactoryProvider; }
        for (const [key, maximum] of [["max_implementations", 32], ["max_agents", 32], ["max_builds", 16], ["max_artifact_bytes", 64 * 1024 * 1024], ["max_storage_bytes", Number.MAX_SAFE_INTEGER]] as const) {
          const value = body[key]; if (value === undefined) continue;
          if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new FactoryError("invalid_limit", "Enter a positive limit within supported capacity");
          settings[key] = value as number;
        }
        if (body.skills_path !== undefined) { if (body.skills_path !== null && typeof body.skills_path !== "string") throw new FactoryError("invalid_skills_path", "Select an absolute pinned skill source"); settings.skills_path = body.skills_path as string | null; }
        this.store.db.transaction(() => { this.store.put("settings", { id: "default", value: settings }); this.store.event(null, "factory_settings_changed", settings); })(); return jsonResponse(settings);
      }
      if (url.pathname === "/api/factory/providers" && request.method === "GET") {
        const machine = url.searchParams.get("machine_id") ?? "local";
        const implementationId = url.searchParams.get("implementation_id"); const implementation = implementationId ? this.store.get<Implementation>("implementations", implementationId) : null;
        const project = implementation?.project_id ? this.store.get<FactoryProject>("projects", implementation.project_id) : null;
        const bindings = project?.account_bindings?.[machine];
        const snapshot = bindings && Object.keys(bindings).length ? await this.runtime.accountSnapshot(machine, bindings) : null;
        return jsonResponse(await this.runtime.capabilities(machine, snapshot));
      }
      if (url.pathname === "/api/factory/model-catalog" && request.method === "POST") {
        const body = await this.body(request);
        const project = typeof body.project_id === "string" ? this.store.get<FactoryProject>("projects", body.project_id) : null;
        if (!project || project.removed_at) throw new FactoryError("not_found", "Project not found", 404);
        const machine = typeof body.machine_id === "string" ? body.machine_id : project.machine_id;
        const provider = (body.provider ?? project.provider) as FactoryProvider;
        if (!providers.includes(provider) || !this.registeredMachine(machine)) throw new FactoryError("invalid_provider", "Select a connected Machine and CLI");
        const checkout = this.store.list<ProjectCheckout>("checkouts", project.id).find(entry => entry.machine_id === machine);
        if (!checkout) throw new FactoryError("checkout_required", "Configure this Machine's Project checkout", 409);
        const bindings = project.account_bindings?.[machine];
        const snapshot = bindings && Object.keys(bindings).length ? await this.runtime.accountSnapshot(machine, bindings) : null;
        return jsonResponse(await this.runtime.modelCatalog(machine, provider, checkout.path, checkout.repository, snapshot));
      }
      if (url.pathname === "/api/factory-host/model-catalog" && request.method === "POST") {
        if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use model controls from this app");
        const body = await this.body(request) as Partial<FactoryHostRequests["model_catalog"]>;
        if (!providers.includes(body.provider as FactoryProvider) || typeof body.path !== "string" || typeof body.repository !== "string") throw new FactoryError("invalid_provider", "Select a CLI and verified checkout");
        return jsonResponse(await this.executionHost.modelCatalog(body.provider as FactoryProvider, body.path, body.repository, body.account_snapshot));
      }
      const artifactMutation = /^\/api\/factory\/artifacts\/([a-zA-Z0-9-]+)\/(note|delete)$/.exec(url.pathname);
      if (artifactMutation && request.method === "POST") return jsonResponse(this.artifacts.mutate(artifactMutation[1]!, artifactMutation[2]!, await this.body(request)));
      const retroRoute = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/retrospectives$/.exec(url.pathname);
      if (retroRoute && request.method === "POST") return jsonResponse(this.retrospectives.create(retroRoute[1]!, await this.body(request)), 201);
      const retroApproval = /^\/api\/factory\/retrospectives\/([a-zA-Z0-9-]+)\/approve$/.exec(url.pathname);
      if (retroApproval && request.method === "POST") return jsonResponse(this.retrospectives.approve(retroApproval[1]!, await this.body(request)));
      const pipelineRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/(workers|checks|accept)$/.exec(url.pathname);
      if (pipelineRoute && request.method === "POST") {
        const body = await this.body(request);
        return jsonResponse(pipelineRoute[2] === "workers" ? await this.pipeline.startWorker(pipelineRoute[1]!, body) : pipelineRoute[2] === "checks" ? await this.pipeline.check(pipelineRoute[1]!) : await this.pipeline.accept(pipelineRoute[1]!, body));
      }
      const workerRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/workers\/([a-zA-Z0-9-]+)\/(refresh|reconcile|check|integrate|stop|review-evidence)$/.exec(url.pathname);
      const checkReconcile = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/checks\/([a-zA-Z0-9-]+)\/reconcile$/.exec(url.pathname);
      if (checkReconcile && request.method === "POST") return jsonResponse(await this.pipeline.reconcileCheck(checkReconcile[1]!, checkReconcile[2]!));
      if (workerRoute && request.method === "POST") return jsonResponse(workerRoute[3] === "integrate" ? await this.pipeline.integrate(workerRoute[1]!, workerRoute[2]!) : await this.pipeline.workerAction(workerRoute[1]!, workerRoute[2]!, workerRoute[3]!));
      const tracker = /^\/api\/factory\/tickets\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (tracker && request.method === "GET") {
        const graph = this.store.list<{ tickets: import("../shared/protocol.ts").FactoryTicket[] }>("graphs").find((graph) => graph.tickets.some((ticket) => ticket.id === tracker[1]));
        const ticket = graph?.tickets.find((ticket) => ticket.id === tracker[1]);
        if (!ticket) throw new FactoryError("not_found", "Ticket not found", 404);
        return jsonResponse(ticket);
      }
      const projectRoute = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/(configure|checkouts|remove|restore)$/.exec(url.pathname);
      const guidanceRoute = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/guidance$/.exec(url.pathname);
      if (guidanceRoute && request.method === "POST") {
        await this.body(request);
        const project = this.store.get<FactoryProject>("projects", guidanceRoute[1]!);
        if (!project || project.removed_at) throw new FactoryError("project_removed", "Select an active Project", 409);
        const existing = project.guidance_assignment_id ? this.store.get<Implementation>("implementations", project.guidance_assignment_id) : null;
        if (existing) return jsonResponse(existing);
        const assignment: Implementation = { ...this.store.record(), title: `Set up ${project.name} guidance`, description: MATT_PROJECT_WORKFLOW + "\n\nInspect existing documents and discuss unresolved domain language and coding standards with the owner. Preserve existing guidance and propose additions in the owned worktree for review.", project_id: project.id, provider: project.provider, machine_id: project.machine_id, stage: "inbox", position: this.store.list<Implementation>("implementations").length, outcome: "none" };
        this.store.db.transaction(() => { this.store.put("implementations", assignment); const chat: FactoryChat = { ...this.store.record(), implementation_id: assignment.id, title: "Setup" }; this.store.put("chats", chat, assignment.id); this.store.put("projects", { ...project, guidance_assignment_id: assignment.id }); })();
        return jsonResponse(assignment, 201);
      }
      if (projectRoute && request.method === "POST") {
        const body = await this.body(request);
        const project = this.store.get<FactoryProject>("projects", projectRoute[1]!);
        if (!project) throw new FactoryError("not_found", "Project not found", 404);
        if (projectRoute[2] === "remove" || projectRoute[2] === "restore") {
          const active = this.projectActive(project.id);
          if (projectRoute[2] === "remove" && active) throw new FactoryError("project_busy", "Finish or stop active Project work before removing its registration", 409);
          const next = { ...project, removed_at: projectRoute[2] === "remove" ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
          this.store.put("projects", next); this.store.event(null, "project_registration_changed", { project_id: project.id, removed_at: next.removed_at }); return jsonResponse(next);
        }
        if (project.removed_at) throw new FactoryError("project_removed", "Restore this Project before editing it", 409);
        if (projectRoute[2] === "checkouts") {
          if (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id) || !this.registeredMachine(body.machine_id) || typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Select a Machine and absolute checkout path");
          const inspected = await this.runtime.inspect(body.machine_id, body.path);
          if (inspected.repository !== project.repository) throw new FactoryError("wrong_checkout", "This checkout belongs to a different repository", 409);
          if (this.store.get<FactoryProject>("projects", project.id)?.removed_at) throw new FactoryError("project_removed", "Restore this Project before editing it", 409);
          const previous = this.store.list<ProjectCheckout>("checkouts", project.id).find((entry) => entry.machine_id === body.machine_id);
          const checkout: ProjectCheckout = { ...(previous ?? this.store.record()), ...inspected, updated_at: new Date().toISOString(), project_id: project.id, machine_id: body.machine_id };
          this.store.put("checkouts", checkout, project.id); this.store.event(null, "checkout_configured", { project_id: project.id, checkout_id: checkout.id });
          return jsonResponse(checkout, 201);
        }
        const next = { ...project, updated_at: new Date().toISOString() };
        if (body.name !== undefined) { if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) throw new FactoryError("invalid_project", "Enter a Project name"); next.name = body.name.trim(); }
        if (body.workflow_instructions !== undefined) { if (typeof body.workflow_instructions !== "string" || body.workflow_instructions.length > 20000) throw new FactoryError("invalid_workflow", "Keep Project workflow instructions within 20,000 characters"); next.workflow_instructions = body.workflow_instructions; }
        if (body.context_target_tokens !== undefined) { if (!Number.isInteger(body.context_target_tokens) || Number(body.context_target_tokens) < 150000 || Number(body.context_target_tokens) > 200000) throw new FactoryError("invalid_context_target", "Use a context planning target between 150,000 and 200,000 tokens"); next.context_target_tokens = Number(body.context_target_tokens); }
        if (body.account_bindings !== undefined) {
          if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app");
          if (!isJsonObject(body.account_bindings)) throw new FactoryError("invalid_account_bindings", "Select account profiles for each configured Machine");
          const bindings: NonNullable<FactoryProject["account_bindings"]> = Object.create(null);
          for (const [machine, selection] of Object.entries(body.account_bindings)) {
            if (!this.store.list<ProjectCheckout>("checkouts", project.id).some((checkout) => checkout.machine_id === machine) || !isJsonObject(selection)) throw new FactoryError("checkout_required", "Configure this Machine's Project checkout before selecting accounts", 409);
            const selected = selection as import("../shared/accounts.ts").ProjectAccountBindings;
            if (JSON.stringify(project.account_bindings?.[machine] ?? {}) !== JSON.stringify(selected)) await this.runtime.accountSnapshot(machine, selected);
            bindings[machine] = selected;
          }
          next.account_bindings = bindings;
        }
        for (const key of ["checks", "setup"] as const) if (body[key] !== undefined) {
          if (!Array.isArray(body[key]) || body[key].length > 20 || body[key].some((args: unknown) => !Array.isArray(args) || !args.length || args.length > 100 || args.some((arg: unknown) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")))) throw new FactoryError("invalid_commands", "Configure bounded command argument arrays");
          next[key] = body[key] as string[][];
        }
        if (body.environment !== undefined) {
          if (!isJsonObject(body.environment) || Object.entries(body.environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,99}$/.test(key) || /^(HOME|PATH|GIT_|HERDR_|LD_|DYLD_|GH_|GITHUB_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|CLOUDFLARE_|WRANGLER_|DOTENV_KEY$)/.test(key) || typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new FactoryError("invalid_environment", "Use task-specific environment names; select credentials through Machine account profiles");
          next.environment = body.environment as Record<string, string>;
        }
        const selectedProvider = (body.provider ?? next.provider) as FactoryProvider;
        if (body.permission_mode !== undefined) {
          if (!providers.includes(selectedProvider) || !validPermissionMode(selectedProvider, body.permission_mode)) throw new FactoryError("invalid_permissions", "Select a native permission mode for this agent");
          next.permission_mode = body.permission_mode;
          if (!next.permissions?.trim()) next.permissions = permissionDescription(body.permission_mode);
        }
        if (body.permissions !== undefined && !(body.permission_mode !== undefined && body.permissions === "")) { if (typeof body.permissions !== "string" || !body.permissions.trim() || body.permissions.length > 20000) throw new FactoryError("invalid_permissions", "Record the Project's explicit execution permissions"); next.permissions = body.permissions; }
        if (body.provider !== undefined && next.permission_mode && !validPermissionMode(selectedProvider, next.permission_mode)) throw new FactoryError("invalid_permissions", "Choose a permission mode for the new agent");
        if (body.shared_paths !== undefined) { if (!Array.isArray(body.shared_paths) || body.shared_paths.some((path: unknown) => typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))) throw new FactoryError("invalid_shared_paths", "Select repository-relative shared documents"); next.shared_paths = body.shared_paths as string[]; }
        if (body.provider !== undefined) { if (!providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a provider"); next.provider = body.provider as FactoryProvider; }
        if (body.machine_id !== undefined) { if (typeof body.machine_id !== "string" || !this.registeredMachine(body.machine_id)) throw new FactoryError("invalid_machine", "Select a registered execution Machine"); if (!this.store.list<ProjectCheckout>("checkouts", project.id).some((entry) => entry.machine_id === body.machine_id)) throw new FactoryError("checkout_required", "Configure this Machine's checkout first"); next.machine_id = body.machine_id; }
        if (body.execution_preset !== undefined) {
          const selection = parseModelSelection(body.execution_preset);
          if (selection.model) {
            const checkout = this.store.list<ProjectCheckout>("checkouts", project.id).find(entry => entry.machine_id === next.machine_id);
            if (!checkout) throw new FactoryError("checkout_required", "Configure this Machine's Project checkout", 409);
            const bindings = next.account_bindings?.[next.machine_id];
            const snapshot = bindings && Object.keys(bindings).length ? await this.runtime.accountSnapshot(next.machine_id, bindings) : null;
            resolveModelSelection(selection, await this.runtime.modelCatalog(next.machine_id, next.provider, checkout.path, checkout.repository, snapshot));
          }
          next.execution_preset = selection;
        } else if (next.provider !== project.provider) delete next.execution_preset;
        if (hash(JSON.stringify(this.store.get("projects", project.id))) !== hash(JSON.stringify(project))) throw new FactoryError("project_changed", "Refresh this Project before saving changes", 409);
        this.store.put("projects", next); this.store.event(null, "project_configured", { project_id: project.id }); return jsonResponse(next);
      }
      const projectAccountCheck = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/accounts\/verify$/.exec(url.pathname);
      if (projectAccountCheck && request.method === "POST") {
        if (request.headers.get("x-herdr-machine") !== "1") return httpError(403, "invalid_origin", "Use account controls from this app");
        const project = this.store.get<FactoryProject>("projects", projectAccountCheck[1]!);
        if (!project) throw new FactoryError("not_found", "Project not found", 404);
        const body = await this.body(request);
        if (typeof body.machine_id !== "string") throw new FactoryError("invalid_machine", "Select the account execution Machine");
        return jsonResponse(await this.runtime.accountSnapshot(body.machine_id, project.account_bindings?.[body.machine_id] ?? {}));
      }
      const reviewRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/(snapshots|comments)$/.exec(url.pathname);
      if (reviewRoute && request.method === "POST") {
        const body = await this.body(request);
        return jsonResponse(reviewRoute[2] === "snapshots" ? await this.review.capture(reviewRoute[1]!, body) : this.review.comment(reviewRoute[1]!, body), 201);
      }
      const batchRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/request-changes$/.exec(url.pathname);
      const resolution = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/comments\/([a-zA-Z0-9-]+)\/resolve$/.exec(url.pathname);
      if (resolution && request.method === "POST") return jsonResponse(await this.pipeline.resolveFinding(resolution[1]!, resolution[2]!, await this.body(request)));
      if (batchRoute && request.method === "POST") return jsonResponse(await this.review.requestChanges(batchRoute[1]!, await this.body(request), (run, text) => this.runtime.send(run, text, request.signal)));
      const startRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/runs$/.exec(url.pathname);
      const continueRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/continue$/.exec(url.pathname);
      if (continueRoute && request.method === "POST") return jsonResponse(await this.continuation.start(continueRoute[1]!, await this.body(request), url.origin), 202);
      if (startRoute && request.method === "POST") {
        const body = await this.body(request);
        if (body.retry_of !== undefined) throw new FactoryError("invalid_start", "Use the explicit Retry operation");
        return jsonResponse(await this.runtime.start(startRoute[1]!, body, url.origin), 202);
      }
      const retryRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/retry$/.exec(url.pathname);
      if (retryRoute && request.method === "POST") return jsonResponse(await this.runtime.retry(retryRoute[1]!, await this.body(request), url.origin), 202);
      const reconcileRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/reconcile$/.exec(url.pathname);
      if (reconcileRoute && request.method === "POST") return jsonResponse(await this.runtime.reconcile(reconcileRoute[1]!));
      const stopRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/stop$/.exec(url.pathname);
      if (stopRoute && request.method === "POST") {
        const body = await this.body(request);
        await this.retainHandoff(stopRoute[1]!);
        return jsonResponse(await this.runtime.stopRun(stopRoute[1]!, body));
      }
      const nativeImport = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/import-conversation$/.exec(url.pathname);
      if (nativeImport && request.method === "POST") { const body = await this.body(request); return jsonResponse(await this.retainNative(nativeImport[1]!, typeof body.before === "string" ? body.before : undefined)); }
      const answerDelivery = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/send-answers$/.exec(url.pathname);
      if (answerDelivery && request.method === "POST") {
        const run = this.store.get<FactoryRun>("runs", answerDelivery[1]!); if (!run) throw new FactoryError("not_found", "Run not found", 404);
        if (run.issue_pause) throw new FactoryError("issue_pause_required", "Controlled pause requested; answering does not resume this Run", 409);
        const body = await this.body(request); const revision = this.workflow.questionRevision(run.implementation_id, run.id);
        if (typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_delivery", "Send answered context with an explicit receipt key");
        if (body.revision !== revision || this.workflow.questions(run.implementation_id, run.id).some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Send the current answered question revision explicitly", 409);
        const prior = this.store.list<{ id: string; key: string; revision: string; condition: string }>("answer_deliveries", run.id).find((entry) => entry.key === body.idempotency_key || entry.revision === revision && ["sending", "sent", "uncertain"].includes(entry.condition));
        if (prior) { if (prior.key === body.idempotency_key && prior.revision !== revision) throw new FactoryError("delivery_conflict", "This key belongs to another answered revision", 409); return jsonResponse(prior); }
        const delivery = { ...this.store.record(), run_id: run.id, revision, key: body.idempotency_key, condition: "sending" };
        this.store.put("answer_deliveries", delivery, run.id);
        try { await this.runtime.send(run, `The owner explicitly sent answered context ${revision}. Read contract through .saurons-eye-tracker.mjs, then consume this exact revision; preserve unanswered or changed questions and await the owner.`, request.signal); delivery.condition = "sent"; }
        catch (error) { delivery.condition = error instanceof FactoryError && ["agent_busy", "delivery_busy", "input_draft", "disconnected", "run_unavailable"].includes(error.code) || error instanceof HerdrError && ["agent_not_ready", "agent_not_found", "agent_blocked", "cancelled"].includes(error.code) ? "blocked" : "uncertain"; this.store.put("answer_deliveries", delivery, run.id); return jsonResponse(delivery); }
        this.store.put("answer_deliveries", delivery, run.id); this.store.event(run.implementation_id, "answered_context_sent", { delivery_id: delivery.id, revision }); return jsonResponse(delivery);
      }
      const cleanup = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/cleanup$/.exec(url.pathname);
      if (cleanup && request.method === "POST") {
        return jsonResponse(await this.pipeline.cleanup(cleanup[1]!));
      }
      const importRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/import-artifacts$/.exec(url.pathname);
      if (importRoute && request.method === "POST") {
        const run = this.store.get<FactoryRun>("runs", importRoute[1]!);
        if (!run) throw new FactoryError("not_found", "Run not found", 404);
        return jsonResponse(await this.importOutputs(run), 201);
      }
      if (url.pathname === "/api/factory/backups" && request.method === "POST") return jsonResponse(this.backup.create(), 201);
      if (url.pathname === "/api/factory/backups" && request.method === "GET") return jsonResponse(this.store.list("backups"));
      const restoreRoute = /^\/api\/factory\/backups\/([a-zA-Z0-9-]+)\/restore$/.exec(url.pathname);
      if (restoreRoute && request.method === "POST") return jsonResponse(this.backup.restore(restoreRoute[1]!), 201);
      const workflowRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/(specifications|tickets|approvals|order|questions)$/.exec(url.pathname);
      if (workflowRoute && request.method === "POST") {
        const body = await this.body(request);
        return jsonResponse(this.workflow.mutate(workflowRoute[1]!, workflowRoute[2]!, body), workflowRoute[2] === "order" ? 200 : 201);
      }
      const answerRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/questions\/([a-zA-Z0-9-]+)\/answer$/.exec(url.pathname);
      if (answerRoute && request.method === "POST") {
        const body = await this.body(request);
        return jsonResponse(this.workflow.mutate(answerRoute[1]!, "answer", { ...body, question_id: answerRoute[2]! }));
      }
      const artifactRoute = /^\/api\/factory\/artifacts\/([a-zA-Z0-9-]+)\/(source|preview|download)$/.exec(url.pathname);
      if (artifactRoute && request.method === "GET") {
        const record = this.store.get<FactoryArtifact>("artifacts", artifactRoute[1]!);
        if (!record) throw new FactoryError("not_found", "Attachment not found", 404);
        return this.artifacts.response(record, artifactRoute[2]!);
      }
      const conversationRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/(chats|messages|artifacts)$/.exec(url.pathname);
      if (conversationRoute && request.method === "POST") {
        const id = conversationRoute[1]!;
        if (!this.store.get("implementations", id)) throw new FactoryError("not_found", "Implementation not found", 404);
        const body = await this.body(request, conversationRoute[2] === "artifacts" ? Math.ceil(this.settings().max_artifact_bytes / 3) * 4 + 64 * 1024 : 512 * 1024);
        if (conversationRoute[2] === "artifacts") return jsonResponse(this.artifacts.create(id, body, this.settings()), 201);
        if (conversationRoute[2] === "chats") {
          if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200) return badRequest("invalid_chat", "Enter a Chat title");
          const chat: FactoryChat = { ...this.store.record(), implementation_id: id, title: body.title.trim() };
          this.store.db.transaction(() => { this.store.put("chats", chat, id); this.store.event(id, "chat_created", { chat_id: chat.id }); })();
          return jsonResponse(chat, 201);
        }
        const chat = typeof body.chat_id === "string" ? this.store.get<FactoryChat>("chats", body.chat_id) : null;
        if (!chat || chat.implementation_id !== id || typeof body.content !== "string" || !body.content.trim() || body.content.length > 100_000 || !["owner", "agent", "system"].includes(String(body.role))) return badRequest("invalid_message", "Enter a message in this Implementation's Chat");
        const imported = body.source_id !== undefined && body.source_id !== null;
        if (imported && (typeof body.source_id !== "string" || body.source_id.length > 256 || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0)) return badRequest("invalid_source", "Native imports require a source identity and sequence");
        const record = this.store.db.transaction(() => {
          const prior = imported ? this.store.list<FactoryMessage>("messages", id).find((message) => message.chat_id === chat.id && message.source_id === body.source_id && message.sequence === body.sequence) : null;
          if (prior) { if (prior.content !== body.content || prior.role !== body.role) throw new FactoryError("source_conflict", "This native event already has different retained content", 409); return prior; }
          const message: FactoryMessage = { ...this.store.record(), implementation_id: id, chat_id: chat.id, role: body.role as FactoryMessage["role"], content: body.content as string, source_id: imported ? body.source_id as string : null, sequence: imported ? body.sequence as number : null };
          this.store.put("messages", message, id); this.store.event(id, "message_retained", { message_id: message.id, chat_id: chat.id }); return message;
        })();
        return jsonResponse(record, 201);
      }
      if (url.pathname === "/api/factory/project-discovery" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.machine_id !== "string" || !this.registeredMachine(body.machine_id) || typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Choose a registered Machine and repository folder");
        return jsonResponse(await this.runtime.discover(body.machine_id, body.path));
      }
      if (url.pathname === "/api/factory-host/project-discovery" && request.method === "POST") { const body = await this.body(request); if (typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Choose a repository folder"); return jsonResponse(await this.executionHost.discover(body.path)); }
      if (url.pathname === "/api/factory/projects" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.path !== "string" || !providers.includes(body.provider as FactoryProvider) || !["app", "github", "gitlab", "local"].includes(String(body.tracker))) return badRequest("invalid_project", "Enter a name, checkout, provider and tracker");
        if (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id) || !this.registeredMachine(body.machine_id)) throw new FactoryError("invalid_machine", "Select an execution Machine");
        const inspected = await this.runtime.inspect(body.machine_id, body.path);
        const project: FactoryProject = { ...this.store.record(), name: body.name.trim(), repository: inspected.repository, provider: body.provider as FactoryProvider, machine_id: body.machine_id, tracker: body.tracker as FactoryProject["tracker"], tracker_reference: typeof body.tracker_reference === "string" ? body.tracker_reference : "" };
        let guidance: Implementation | null = null;
        if (body.guided_setup === true) {
          const detected = await this.runtime.discover(project.machine_id, inspected.path);
          if (detected.repository !== inspected.repository || detected.head !== inspected.head) throw new FactoryError("project_changed", "Refresh the selected folder before completing setup", 409);
          const mode = body.permission_mode ?? (project.provider === "codex" && detected.permission_modes.codex.includes("approve_for_me") ? "approve_for_me" : "ask");
          if (!validPermissionMode(project.provider, mode) || !detected.permission_modes[project.provider].includes(mode)) throw new FactoryError("invalid_permissions", "Select a supported permission mode for this agent");
          const ids = body.check_ids ?? detected.checks.map((check) => check.id);
          if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string" || !detected.checks.some((check) => check.id === id))) throw new FactoryError("invalid_commands", "Choose checks detected in this repository");
          project.checks = detected.checks.filter((check) => ids.includes(check.id)).map((check) => check.args);
          project.permission_mode = mode; project.permissions = permissionDescription(mode); project.workflow_instructions = MATT_PROJECT_WORKFLOW;
          project.context_target_tokens = body.context_target_tokens === undefined ? 150000 : Number(body.context_target_tokens);
          if (![150000, 200000].includes(project.context_target_tokens)) throw new FactoryError("invalid_context_target", "Choose the 150,000 or 200,000 token handoff target");
          project.shared_paths = detected.guidance;
          if (body.github_account_id) {
            if (request.headers.get("x-herdr-machine") !== "1" || typeof body.github_account_id !== "string") return httpError(403, "invalid_origin", "Select accounts using Project setup");
            await this.runtime.accountSnapshot(project.machine_id, { github: body.github_account_id }); project.account_bindings = { [project.machine_id]: { github: body.github_account_id } };
          }
          if (body.guidance_task === true) {
            guidance = { ...this.store.record(), title: `Set up ${project.name} guidance`, description: `${MATT_PROJECT_WORKFLOW}\n\nInspect the repository and help the owner establish domain language and coding standards. Reuse existing documents; ask about unresolved terms and rules. Propose additions in the owned worktree for review. Do not invent a resolved glossary, overwrite existing guidance, publish or deploy.`, project_id: project.id, machine_id: project.machine_id, provider: project.provider, stage: "inbox", position: this.store.list<Implementation>("implementations").length, outcome: "none" };
            project.guidance_assignment_id = guidance.id;
          }
        }
        const checkout: ProjectCheckout = { ...this.store.record(), ...inspected, project_id: project.id, machine_id: body.machine_id };
        this.store.db.transaction(() => { this.store.put("projects", project); this.store.put("checkouts", checkout, project.id); if (guidance) { this.store.put("implementations", guidance); const chat: FactoryChat = { ...this.store.record(), implementation_id: guidance.id, title: "Setup" }; this.store.put("chats", chat, guidance.id); } this.store.event(null, "project_registered", { project_id: project.id, checkout_id: checkout.id }); })();
        return jsonResponse(project, 201);
      }
      const completeWork = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/complete-work$/.exec(url.pathname);
      if (completeWork && request.method === "POST") {
        const body = await this.body(request); const id = completeWork[1]!;
        const idea = this.store.get<Implementation>("implementations", id);
        const run = this.store.list<FactoryRun>("runs", id).at(-1);
        if (!idea || !run || run.id !== body.run_id || run.action !== "work" || !run.workspace_id || !run.pane_id) throw new FactoryError("direct_work_required", "Select this Assignment's latest direct work session before marking it done", 409);
        if (idea.stage === "done" && !this.activeWork(id)) return jsonResponse(idea);
        const scope = hash(JSON.stringify({project_id:idea.project_id,provider:idea.provider,machine_id:idea.machine_id,archived_at:idea.archived_at}));
        await this.retainHandoff(run.id);
        await this.runtime.stopRun(run.id, {summary:"Owner marked direct work done; its worktree is retained"});
        return jsonResponse(this.store.db.transaction(() => {
          const current = this.store.get<Implementation>("implementations", id)!;
          if (this.store.list<FactoryRun>("runs", id).at(-1)?.id !== run.id || this.activeWork(id) || hash(JSON.stringify({project_id:current.project_id,provider:current.provider,machine_id:current.machine_id,archived_at:current.archived_at})) !== scope) throw new FactoryError("scope_changed", "The Assignment changed during completion; refresh it before continuing", 409);
          const issueSourced = hasIssueSource(this.store, id);
          const delivered = ["merged", "released"].includes(current.outcome) && !!current.delivery_evidence;
          const next: Implementation = {...current,...(delivered ? {} : issueSourced ? {stage:"review" as const,activity:"awaiting_merge" as const,outcome:"implementation_complete" as const} : {stage:"done" as const,outcome:"implementation_complete" as const}),updated_at:new Date().toISOString()};
          this.store.put("implementations",next);this.store.event(id,"direct_work_completed",{run_id:run.id,owner_accepted:true});return next;
        })());
      }
      const archiveRoute = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/(archive|restore)$/.exec(url.pathname);
      if (archiveRoute && request.method === "POST") {
        await this.body(request);
        const record = this.store.get<Implementation>("implementations", archiveRoute[1]!);
        if (!record) throw new FactoryError("not_found", "Assignment not found", 404);
        if (archiveRoute[2] === "archive" && (record.stage !== "done" || this.activeWork(record.id))) throw new FactoryError("assignment_unfinished", "Finish or stop all work and complete the Assignment before archiving", 409);
        const next = { ...record, archived_at: archiveRoute[2] === "archive" ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
        this.store.put("implementations", next); this.store.event(record.id, "assignment_archive_changed", { archived_at: next.archived_at }); return jsonResponse(next);
      }
      const configured = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/configure$/.exec(url.pathname);
      if (configured && request.method === "POST") {
        const body = await this.body(request);
        const record = this.store.get<Implementation>("implementations", configured[1]!);
        if (!record) throw new FactoryError("not_found", "Implementation not found", 404);
        if (body.project_id !== undefined && body.project_id !== record.project_id && this.activeWork(record.id)) throw new FactoryError("assignment_busy", "Finish or stop active work before changing its Project", 409);
        if (body.project_id !== undefined && body.project_id !== null && (typeof body.project_id !== "string" || !this.store.get<FactoryProject>("projects", body.project_id) || this.store.get<FactoryProject>("projects", body.project_id)?.removed_at)) throw new FactoryError("invalid_project", "Select a registered Project");
        if (body.provider !== undefined && body.provider !== null && !providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a supported provider");
        if (body.machine_id !== undefined && body.machine_id !== null && (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id) || !this.registeredMachine(body.machine_id))) throw new FactoryError("invalid_machine", "Select a Machine");
        const next: Implementation = { ...record, updated_at: new Date().toISOString(), ...(body.project_id === undefined ? {} : { project_id: body.project_id as string | null }), ...(body.provider === undefined ? {} : { provider: body.provider as FactoryProvider | null }), ...(body.machine_id === undefined ? {} : { machine_id: body.machine_id as string | null }) };
        this.store.db.transaction(() => { this.store.put("implementations", next); this.store.event(record.id, "implementation_configured", { project_id: next.project_id, provider: next.provider, machine_id: next.machine_id }); })();
        return jsonResponse(next);
      }
      if (url.pathname === "/api/factory/implementations" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 || typeof body.description !== "string" || body.description.length > 100_000) return badRequest("invalid_implementation", "Enter a title and description");
        const project = typeof body.project_id === "string" ? this.store.get<FactoryProject>("projects", body.project_id) : null;
        if (body.project_id !== undefined && body.project_id !== null && (!project || project.removed_at)) throw new FactoryError("invalid_project", "Select a registered Project");
        const record: Implementation = { ...this.store.record(), title: body.title.trim(), description: body.description, project_id: project?.id ?? null, provider: null, machine_id: null, stage: "inbox", position: this.store.list("implementations").length, outcome: "none" };
        mkdirSync(join(this.store.root, "inbox", record.id), { mode: 0o700 });
        this.store.db.transaction(() => {
          this.store.put("implementations", record);
          const chat: FactoryChat = { ...this.store.record(), implementation_id: record.id, title: "Notes" };
          this.store.put("chats", chat, record.id);
          if (body.description) this.store.put<FactoryMessage>("messages", { ...this.store.record(), implementation_id: record.id, chat_id: chat.id, role: "owner", content: body.description as string, source_id: null, sequence: null }, record.id);
          this.store.event(record.id, "implementation_created", { title: record.title });
        })();
        return jsonResponse(record, 201);
      }
      const match = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const detail = this.detail(match[1]!);
        return detail ? jsonResponse(detail) : httpError(404, "not_found", "Implementation not found");
      }
      return httpError(404, "not_found", "Unknown factory endpoint");
    } catch (error) { return error instanceof FactoryError ? httpError(error.status, error.code, error.message) : error instanceof SyntaxError ? badRequest("invalid_json", "Enter valid JSON") : errorResponse(error); }
  }
  stop(): void { if (this.stopped) return; this.stopped = true; this.continuation.stop(); this.github.stop(); this.accounts.stop(); this.runtime.stop(); this.store.close(); }
}
