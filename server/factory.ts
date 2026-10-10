import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { FactoryArtifact, FactoryChat, FactoryDetail, FactoryMessage, FactoryProject, FactoryProvider, FactoryRun, FactorySettings, Implementation, ProjectCheckout } from "../shared/protocol.ts";
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
import { FactoryRetrospectives } from "./factory-retrospective.ts";
import { HerdrError } from "./herdr/client.ts";
import { factoryTrackerGuide } from "./factory-tracker-client.ts";

const providers: FactoryProvider[] = ["codex", "claude", "opencode"];
const initialSettings: FactorySettings = { provider: "codex", max_implementations: 2, max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };

export class FactoryService {
  readonly store: FactoryStore;
  private readonly artifacts: FactoryArtifacts;
  private readonly workflow: FactoryWorkflow;
  private readonly backup: FactoryBackup;
  private readonly runtime: FactoryRuntime;
  private readonly review: FactoryReview;
  private readonly executionHost: FactoryExecutionHost;
  private readonly pipeline: FactoryPipeline;
  private readonly retrospectives: FactoryRetrospectives;
  private stopped = false;
  constructor(stateDir: string, private readonly skillsPath: string | null = null, native: Partial<FactoryNative> = {}, endpoint: MachineEndpoint = () => undefined, publicUrl: string | null = null) {
    this.store = new FactoryStore(stateDir); this.artifacts = new FactoryArtifacts(this.store); this.workflow = new FactoryWorkflow(this.store); this.backup = new FactoryBackup(this.store, this.artifacts);
    this.executionHost = new FactoryExecutionHost(this.store, () => this.settings().skills_path, native);
    this.runtime = new FactoryRuntime(this.store, this.workflow, () => this.settings(), this.executionHost, endpoint, (record) => this.artifacts.read(record), publicUrl); this.review = new FactoryReview(this.store, (machine, path, base, mode) => this.runtime.capture(machine, path, base, mode), (machine, path) => this.runtime.inspect(machine, path));
    this.pipeline = new FactoryPipeline(this.store, this.runtime, this.workflow, () => this.settings());
    this.retrospectives = new FactoryRetrospectives(this.store);
  }
  settings(): FactorySettings { return this.store.get<{ id: string; value: FactorySettings }>("settings", "default")?.value ?? { ...initialSettings, skills_path: this.skillsPath }; }
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
    return value;
  }
  detail(id: string): FactoryDetail | null {
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) return null;
    const runs = this.store.list<FactoryRun>("runs", id); const runIds = new Set(runs.map((run) => run.id));
    return { implementation, graph_hash: this.workflow.graphHash(id), question_revision: this.workflow.questionRevision(id), chats: this.store.list("chats", id), messages: this.store.list("messages", id), specifications: this.store.list("specifications", id), tickets: this.workflow.tickets(id), approvals: this.store.list("approvals", id), questions: this.store.list("questions", id), artifacts: this.store.list("artifacts", id), runs, snapshots: this.store.list("snapshots", id), comments: this.store.list("comments", id), events: this.store.list("events", id), native_snapshots: this.store.list<import("../shared/protocol.ts").NativeConversationSnapshot>("native_snapshots").filter((record) => runIds.has(record.run_id)), workers: this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").filter((worker) => runIds.has(worker.run_id)), checks: this.store.list<import("../shared/protocol.ts").FactoryCheck>("checks").filter((check) => runIds.has(check.run_id)), review_evidence: this.store.list<import("../shared/protocol.ts").FactoryReviewEvidence>("review_evidence").filter((report) => runIds.has(report.run_id)), retrospectives: implementation.project_id ? this.store.list("retrospectives", implementation.project_id) : [], frontier: runs.at(-1)?.action === "implement-spec" ? this.pipeline.frontier(runs.at(-1)!) : [] };
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
      const route = /^\/api\/factory-agent\/([a-zA-Z0-9-]+)\/(contract|question|consume|worker|checks|artifact|specification|tickets|proposal|ticket\/[a-zA-Z0-9-]+|worker\/[a-zA-Z0-9-]+\/[a-z-]+)$/.exec(url.pathname);
      if (!route) throw new FactoryError("not_found", "Unknown scoped tracker operation", 404);
      if (!this.agentAuthenticated(request, url)) throw new FactoryError("unauthorized", "Use this Run's scoped tracker credential", 401);
      const run = this.store.get<FactoryRun>("runs", route[1]!);
      if (!run || ["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_closed", "This Run's control scope has ended", 409);
      if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) throw new FactoryError("invalid_origin", "Use the scoped tracker on its authenticated app origin", 403);
      const action = route[2]!;
      if (action === "contract" && request.method === "GET") return jsonResponse({ tracker_guide: factoryTrackerGuide, run, workers: this.store.list("workers", run.id), checks: this.store.list("checks", run.id), review_batches: this.store.list("review_batches", run.implementation_id), messages: this.store.list<FactoryMessage>("messages", run.implementation_id).filter((message) => (run.manifest as { context_message_ids?: string[] }).context_message_ids?.includes(message.id)), question_revision: this.workflow.questionRevision(run.implementation_id), questions: this.store.list("questions", run.implementation_id), frontier: run.action === "implement-spec" ? this.pipeline.frontier(run) : [], artifacts: this.store.list("artifacts", run.implementation_id) });
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
      if (action === "consume") {
        const revision = this.workflow.questionRevision(run.implementation_id);
        const questions = this.store.list<{ answer: string | null }>("questions", run.implementation_id);
        if (body.revision !== revision || questions.some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Consume the exact answered question revision", 409);
        if (body.worker_id !== undefined && (!this.store.get<{ run_id: string }>("workers", String(body.worker_id)) || this.store.get<{ run_id: string }>("workers", String(body.worker_id))!.run_id !== run.id)) throw new FactoryError("invalid_worker", "Consume answers for a worker in this Run");
        const receipt = { ...this.store.record(), run_id: run.id, worker_id: body.worker_id ?? null, revision };
        this.store.put("answer_consumption", receipt, run.id); this.store.event(run.implementation_id, "answers_consumed", receipt); return jsonResponse({ receipt, questions });
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
      if (previous) return previous;
      const record = { ...this.store.record(), ...captured, run_id: id, sequence: snapshots.filter((entry) => entry.source_id === captured.source_id).length };
      this.store.put("native_snapshots", record, id); this.store.event(run.implementation_id, "native_snapshot_retained", { snapshot_id: record.id, source_id: record.source_id, sequence: record.sequence, version: record.version }); return record;
    }).immediate();
  }
  observe(paneId: string, status: string, agent: string | null, ended = false): void {
    if (this.stopped) return;
    const nextCondition = ended ? "interrupted" : status === "blocked" ? "needs_you" : "working";
    const reason = ended ? "The native pane ended without an accepted outcome; retained work needs reconciliation" : status === "blocked" ? "The native agent is waiting for an owner answer" : null;
    for (const run of this.store.list<FactoryRun>("runs")) if (run.machine_id === "local" && run.pane_id === paneId && ["working", "needs_you", "blocked"].includes(run.condition)) {
      if (!ended && agent !== run.provider) continue;
      const pending = this.store.list<import("../shared/protocol.ts").FactoryQuestion>("questions", run.implementation_id).find((question) => question.run_id === run.id && question.answer === null);
      const condition = pending && !ended ? "needs_you" : nextCondition;
      const waiting = pending && !ended ? pending.question : reason;
      if (run.condition !== condition || run.waiting_reason !== waiting) { this.store.put("runs", { ...run, condition, waiting_reason: waiting, updated_at: new Date().toISOString() }, run.implementation_id); this.store.event(run.implementation_id, "native_condition_changed", { run_id: run.id, condition }); }
    }
    for (const worker of this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers")) if (worker.pane_id === paneId && ["working", "needs_you", "blocked"].includes(worker.condition)) {
      const run = this.store.get<FactoryRun>("runs", worker.run_id);
      if (run?.machine_id !== "local") continue;
      const condition = ended ? "interrupted" : ["blocked", "idle", "done"].includes(status) ? "needs_you" : "working";
      const waiting = !ended && ["idle", "done"].includes(status) ? "Native worker is ready; reconcile its candidate and explicitly refresh, check and integrate it" : reason;
      if (worker.condition !== condition || worker.waiting_reason !== waiting) { this.store.put("workers", { ...worker, condition, waiting_reason: waiting, updated_at: new Date().toISOString() }, worker.run_id); this.store.event(run.implementation_id, "worker_condition_changed", { worker_id: worker.id, condition }); }
    }
  }
  async handle(request: Request, url: URL): Promise<Response> {
    try {
      if (request.method !== "GET" && request.headers.get("x-herdr-factory") !== "1") return httpError(403, "invalid_origin", "Use factory controls from this app");
      if (url.pathname === "/api/factory-host/capabilities" && request.method === "GET") return jsonResponse(await this.executionHost.capabilities());
      if (url.pathname === "/api/factory-host/prepare" && request.method === "POST") { this.executionHost.prepare(await this.body(request, 4 * 1024 * 1024)); return jsonResponse(await this.executionHost.capabilities()); }
      if (url.pathname === "/api/factory-host/inspect" && request.method === "POST") { const body = await this.body(request); if (typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Enter an absolute checkout path"); return jsonResponse(await inspectCheckout(body.path)); }
      if (url.pathname === "/api/factory-host/review" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.path !== "string" || typeof body.base !== "string" || !/^[a-f0-9]{40,64}$/.test(body.base) || !["branch", "workspace"].includes(String(body.mode))) throw new FactoryError("invalid_snapshot", "Select a verified checkout, base and review mode");
        const checkout = await inspectCheckout(body.path);
        return jsonResponse({ repository: checkout.repository, ...await captureReview(checkout.path, body.base, body.mode as "branch" | "workspace") });
      }
      if (url.pathname === "/api/factory-host/launch" && request.method === "POST") { const body = await this.body(request, 90 * 1024 * 1024); if (!isJsonObject(body.run)) throw new FactoryError("invalid_launch", "Enter an accepted Run identity"); return jsonResponse(await this.executionHost.launch(body.run as unknown as import("../shared/protocol.ts").FactoryRun, isJsonObject(body.access) && typeof body.access.token === "string" && typeof body.access.url === "string" ? { token: body.access.token, url: body.access.url } : undefined, Array.isArray(body.attachments) ? body.attachments : []), 202); }
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
      const hostSend = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/send$/.exec(url.pathname);
      if (hostSend && request.method === "POST") { const body = await this.body(request); if (typeof body.text !== "string" || body.text.length > 250_000) throw new FactoryError("invalid_input", "Enter a bounded change request"); await this.executionHost.send(hostSend[1]!, body.text, request.signal); return jsonResponse({ ok: true }); }
      const hostOutputs = /^\/api\/factory-host\/runs\/([a-zA-Z0-9-]+)\/artifacts(\/content)?$/.exec(url.pathname);
      if (hostOutputs && request.method === "GET") return jsonResponse(hostOutputs[2] ? this.executionHost.output(hostOutputs[1]!, url.searchParams.get("name") ?? "", url.searchParams.get("hash") ?? "") : this.executionHost.outputs(hostOutputs[1]!));
      const prepareRoute = /^\/api\/factory\/machines\/([a-zA-Z0-9_-]+)\/prepare$/.exec(url.pathname);
      if (prepareRoute && request.method === "POST") return jsonResponse(await this.runtime.prepare(prepareRoute[1]!));
      if (url.pathname === "/api/factory" && request.method === "GET") return jsonResponse({ implementations: this.store.list<Implementation>("implementations").sort((a, b) => a.position - b.position), projects: this.store.list("projects"), checkouts: this.store.list("checkouts"), settings: this.settings(), activity: this.store.list<Implementation>("implementations").flatMap((idea) => { const run = this.store.list<FactoryRun>("runs", idea.id).at(-1); return run ? [{ implementation_id: idea.id, run_id: run.id, condition: run.condition, action: run.action, waiting_reason: run.waiting_reason, completed_tickets: this.workflow.tickets(idea.id).filter((ticket) => ticket.status === "done").length, total_tickets: this.workflow.tickets(idea.id).length }] : []; }) });
      if (url.pathname === "/api/factory/settings" && request.method === "POST") {
        const body = await this.body(request); const settings = { ...this.settings() };
        const known = new Set(Object.keys(settings));
        if (Object.keys(body).some((key) => !known.has(key))) throw new FactoryError("invalid_settings", "Unknown factory setting");
        if (body.provider !== undefined) { if (!providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a supported provider"); settings.provider = body.provider as FactoryProvider; }
        for (const [key, maximum] of [["max_implementations", 3], ["max_agents", 32], ["max_builds", 16], ["max_artifact_bytes", 64 * 1024 * 1024], ["max_storage_bytes", Number.MAX_SAFE_INTEGER]] as const) {
          const value = body[key]; if (value === undefined) continue;
          if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new FactoryError("invalid_limit", "Enter a positive limit within supported capacity");
          settings[key] = value as number;
        }
        if (body.skills_path !== undefined) { if (body.skills_path !== null && typeof body.skills_path !== "string") throw new FactoryError("invalid_skills_path", "Select an absolute pinned skill source"); settings.skills_path = body.skills_path as string | null; }
        this.store.db.transaction(() => { this.store.put("settings", { id: "default", value: settings }); this.store.event(null, "factory_settings_changed", settings); })(); return jsonResponse(settings);
      }
      if (url.pathname === "/api/factory/providers" && request.method === "GET") return jsonResponse(await this.runtime.capabilities(url.searchParams.get("machine_id") ?? "local"));
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
      const projectRoute = /^\/api\/factory\/projects\/([a-zA-Z0-9-]+)\/(configure|checkouts)$/.exec(url.pathname);
      if (projectRoute && request.method === "POST") {
        const project = this.store.get<FactoryProject>("projects", projectRoute[1]!);
        if (!project) throw new FactoryError("not_found", "Project not found", 404);
        const body = await this.body(request);
        if (projectRoute[2] === "checkouts") {
          if (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id) || typeof body.path !== "string") throw new FactoryError("invalid_checkout", "Select a Machine and absolute checkout path");
          const inspected = await this.runtime.inspect(body.machine_id, body.path);
          if (inspected.repository !== project.repository) throw new FactoryError("wrong_checkout", "This checkout belongs to a different repository", 409);
          const previous = this.store.list<ProjectCheckout>("checkouts", project.id).find((entry) => entry.machine_id === body.machine_id);
          const checkout: ProjectCheckout = { ...(previous ?? this.store.record()), ...inspected, updated_at: new Date().toISOString(), project_id: project.id, machine_id: body.machine_id };
          this.store.put("checkouts", checkout, project.id); this.store.event(null, "checkout_configured", { project_id: project.id, checkout_id: checkout.id });
          return jsonResponse(checkout, 201);
        }
        const next = { ...project, updated_at: new Date().toISOString() };
        for (const key of ["checks", "setup"] as const) if (body[key] !== undefined) {
          if (!Array.isArray(body[key]) || body[key].length > 20 || body[key].some((args: unknown) => !Array.isArray(args) || !args.length || args.length > 100 || args.some((arg: unknown) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")))) throw new FactoryError("invalid_commands", "Configure bounded command argument arrays");
          next[key] = body[key] as string[][];
        }
        if (body.environment !== undefined) {
          if (!isJsonObject(body.environment) || Object.entries(body.environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,99}$/.test(key) || /^(HOME|CODEX_HOME|PATH|GIT_|HERDR_|LD_|DYLD_)/.test(key) || typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new FactoryError("invalid_environment", "Use task-specific environment names and bounded values");
          next.environment = body.environment as Record<string, string>;
        }
        if (body.permissions !== undefined) { if (typeof body.permissions !== "string" || !body.permissions.trim() || body.permissions.length > 20000) throw new FactoryError("invalid_permissions", "Record the Project's explicit execution permissions"); next.permissions = body.permissions; }
        if (body.shared_paths !== undefined) { if (!Array.isArray(body.shared_paths) || body.shared_paths.some((path: unknown) => typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))) throw new FactoryError("invalid_shared_paths", "Select repository-relative shared documents"); next.shared_paths = body.shared_paths as string[]; }
        if (body.provider !== undefined) { if (!providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a provider"); next.provider = body.provider as FactoryProvider; }
        if (body.machine_id !== undefined) { if (typeof body.machine_id !== "string" || !this.store.list<ProjectCheckout>("checkouts", project.id).some((entry) => entry.machine_id === body.machine_id)) throw new FactoryError("checkout_required", "Configure this Machine's checkout first"); next.machine_id = body.machine_id; }
        this.store.put("projects", next); this.store.event(null, "project_configured", { project_id: project.id }); return jsonResponse(next);
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
      if (startRoute && request.method === "POST") {
        const body = await this.body(request);
        return jsonResponse(await this.runtime.start(startRoute[1]!, body, url.origin), 202);
      }
      const reconcileRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/reconcile$/.exec(url.pathname);
      if (reconcileRoute && request.method === "POST") return jsonResponse(await this.runtime.reconcile(reconcileRoute[1]!));
      const stopRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/stop$/.exec(url.pathname);
      if (stopRoute && request.method === "POST") {
        const body = await this.body(request);
        try { await this.retainNative(stopRoute[1]!); } catch { const run = this.store.get<FactoryRun>("runs", stopRoute[1]!); if (run) this.store.event(run.implementation_id, "native_snapshot_unavailable", { run_id: run.id, native_store_retained: true }); }
        return jsonResponse(await this.runtime.stopRun(stopRoute[1]!, body));
      }
      const nativeImport = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/import-conversation$/.exec(url.pathname);
      if (nativeImport && request.method === "POST") { const body = await this.body(request); return jsonResponse(await this.retainNative(nativeImport[1]!, typeof body.before === "string" ? body.before : undefined)); }
      const answerDelivery = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/send-answers$/.exec(url.pathname);
      if (answerDelivery && request.method === "POST") {
        const run = this.store.get<FactoryRun>("runs", answerDelivery[1]!); if (!run) throw new FactoryError("not_found", "Run not found", 404);
        const body = await this.body(request); const revision = this.workflow.questionRevision(run.implementation_id);
        if (typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_delivery", "Send answered context with an explicit receipt key");
        if (body.revision !== revision || this.store.list<{ answer: string | null }>("questions", run.implementation_id).some((question) => question.answer === null)) throw new FactoryError("answers_unready", "Send the current answered question revision explicitly", 409);
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
        const run = this.store.get<FactoryRun>("runs", cleanup[1]!);
        if (!run || !["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_owned", "Stop and observe this Run before cleanup", 409);
        const result = await this.runtime.operation(run, "cleanup"); this.store.event(run.implementation_id, "clean_checkouts_removed", { run_id: run.id, result }); return jsonResponse(result);
      }
      const importRoute = /^\/api\/factory\/runs\/([a-zA-Z0-9-]+)\/import-artifacts$/.exec(url.pathname);
      if (importRoute && request.method === "POST") {
        const run = this.store.get<FactoryRun>("runs", importRoute[1]!);
        if (!run) throw new FactoryError("not_found", "Run not found", 404);
        const chat = this.store.list<FactoryChat>("chats", run.implementation_id)[0]!;
        const imported: FactoryArtifact[] = [];
        for (const output of await this.runtime.outputs(run)) {
          const origin = `${run.machine_id}:run-${run.id}:artifact-${hash(output.name).slice(0, 48)}`;
          const existing = this.store.list<FactoryArtifact>("artifacts", run.implementation_id).find((artifact) => artifact.origin === origin && artifact.hash === output.hash);
          imported.push(existing ?? this.artifacts.create(run.implementation_id, { ...output, ...await this.runtime.output(run, output), chat_id: chat.id, origin }, this.settings()));
        }
        return jsonResponse(imported, 201);
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
      if (url.pathname === "/api/factory/projects" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.path !== "string" || !providers.includes(body.provider as FactoryProvider) || !["app", "github", "gitlab", "local"].includes(String(body.tracker))) return badRequest("invalid_project", "Enter a name, checkout, provider and tracker");
        if (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id)) throw new FactoryError("invalid_machine", "Select an execution Machine");
        const inspected = await this.runtime.inspect(body.machine_id, body.path);
        const project: FactoryProject = { ...this.store.record(), name: body.name.trim(), repository: inspected.repository, provider: body.provider as FactoryProvider, machine_id: body.machine_id, tracker: body.tracker as FactoryProject["tracker"], tracker_reference: typeof body.tracker_reference === "string" ? body.tracker_reference : "" };
        const checkout: ProjectCheckout = { ...this.store.record(), ...inspected, project_id: project.id, machine_id: body.machine_id };
        this.store.db.transaction(() => { this.store.put("projects", project); this.store.put("checkouts", checkout, project.id); this.store.event(null, "project_registered", { project_id: project.id, checkout_id: checkout.id }); })();
        return jsonResponse(project, 201);
      }
      const configured = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)\/configure$/.exec(url.pathname);
      if (configured && request.method === "POST") {
        const record = this.store.get<Implementation>("implementations", configured[1]!);
        if (!record) throw new FactoryError("not_found", "Implementation not found", 404);
        const body = await this.body(request);
        if (body.project_id !== undefined && body.project_id !== null && (typeof body.project_id !== "string" || !this.store.get("projects", body.project_id))) throw new FactoryError("invalid_project", "Select a registered Project");
        if (body.provider !== undefined && body.provider !== null && !providers.includes(body.provider as FactoryProvider)) throw new FactoryError("invalid_provider", "Select a supported provider");
        if (body.machine_id !== undefined && body.machine_id !== null && (typeof body.machine_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.machine_id))) throw new FactoryError("invalid_machine", "Select a Machine");
        const next: Implementation = { ...record, updated_at: new Date().toISOString(), ...(body.project_id === undefined ? {} : { project_id: body.project_id as string | null }), ...(body.provider === undefined ? {} : { provider: body.provider as FactoryProvider | null }), ...(body.machine_id === undefined ? {} : { machine_id: body.machine_id as string | null }) };
        this.store.db.transaction(() => { this.store.put("implementations", next); this.store.event(record.id, "implementation_configured", { project_id: next.project_id, provider: next.provider, machine_id: next.machine_id }); })();
        return jsonResponse(next);
      }
      if (url.pathname === "/api/factory/implementations" && request.method === "POST") {
        const body = await this.body(request);
        if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 || typeof body.description !== "string" || body.description.length > 100_000) return badRequest("invalid_implementation", "Enter a title and description");
        const record: Implementation = { ...this.store.record(), title: body.title.trim(), description: body.description, project_id: null, provider: null, machine_id: null, stage: "inbox", position: this.store.list("implementations").length, outcome: "none" };
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
  stop(): void { if (this.stopped) return; this.stopped = true; this.runtime.stop(); this.store.close(); }
}
