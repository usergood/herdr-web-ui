import { assignmentProgress } from "../shared/factory-board.ts";
import { factoryCapacity } from "./factory-capacity.ts";
import { mkdirSync } from "node:fs";
import { permissionDescription, validPermissionMode } from "../shared/agent-permissions.ts";
import { MATT_PROJECT_WORKFLOW } from "../shared/project-setup.ts";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { FactoryHostRequests, FactoryArtifact, FactoryChat, FactoryDetail, FactoryMessage, FactoryProject, FactoryProvider, FactoryRun, FactorySettings, Implementation, ProjectCheckout } from "../shared/protocol.ts";
import { badRequest, errorResponse, httpError, isJsonObject, jsonResponse } from "./http.ts";
import { FactoryStore } from "./factory-store.ts";
import { FactoryDeletion } from "./factory-deletion.ts";
import { GitHubDeletion } from "./github-deletion.ts";
import { FactoryError, hash, inspectCheckout } from "./factory-host.ts";
import { FactoryArtifacts } from "./factory-artifacts.ts";
import { FactoryWorkflow } from "./factory-workflow.ts";
import { FactoryBackup } from "./factory-backup.ts";
import { FactoryHumanApprovalService } from "./factory-human-approval.ts";
import { FactoryHumanReview } from "./factory-human-review.ts";
import { FactoryExecution } from "./factory-execution.ts";
import { FactoryPlanning } from "./factory-planning.ts";
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
import { sameOrigin } from "./machine-security.ts";
import { workflowConversations } from "../shared/factory-conversations.ts";
import { parseModelSelection, resolveModelSelection } from "./agent-model-selection.ts";

const providers: FactoryProvider[] = ["codex", "claude", "opencode"];
const initialSettings: FactorySettings = { provider: "codex", max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };

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
  private readonly planning: FactoryPlanning;
  private readonly execution: FactoryExecution;
  private readonly humanApproval: FactoryHumanApprovalService;
  private readonly humanReview: FactoryHumanReview;
  private readonly retrospectives: FactoryRetrospectives;
  private readonly references: FactoryReferences;
  private readonly accounts: MachineAccounts;
  private readonly github: ProjectGitHub;
  private readonly deletion: FactoryDeletion;
  private stopped = false;
  constructor(stateDir: string, private readonly skillsPath: string | null = null, native: Partial<FactoryNative> = {}, endpoint: MachineEndpoint = () => undefined, publicUrl: string | null = null, accountTools: AccountTools = {}, private readonly registeredMachine: (id: string) => boolean = (id) => id === "local" || !!endpoint(id), accountDiscoveryHome?: string) {
    this.accounts = new MachineAccounts(stateDir, accountTools, false, accountDiscoveryHome);
    this.store = new FactoryStore(stateDir); this.artifacts = new FactoryArtifacts(this.store, (text) => this.accounts.assertPublic(text)); this.workflow = new FactoryWorkflow(this.store); this.backup = new FactoryBackup(this.store, this.artifacts);
    this.accounts.usage((id) => [...this.store.list<FactoryRun>("runs"), ...this.store.list<{ run: FactoryRun; closing?: boolean }>("host_leases").map((lease) => lease.run)].some((run) => ["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted"].includes(run.condition) && (run.manifest as { account_snapshot?: import("../shared/accounts.ts").AccountBindingSnapshot })?.account_snapshot?.profiles.some((profile) => profile.id === id)));
    this.references = new FactoryReferences(this.store, this.artifacts);
    this.executionHost = new FactoryExecutionHost(this.store, () => this.settings().skills_path, native, this.accounts);
    this.runtime = new FactoryRuntime(this.store, this.workflow, () => this.settings(), this.executionHost, endpoint, (record) => this.artifacts.read(record), publicUrl, this.references, this.accounts); this.review = new FactoryReview(this.store, (machine, path, base, mode) => this.runtime.capture(machine, path, base, mode), (machine, path) => this.runtime.inspect(machine, path));
    this.runtime.retainBeforePause = async (id, workerId) => { await this.retainNative(id, undefined, workerId); };
    this.pipeline = new FactoryPipeline(this.store, this.runtime, this.workflow, () => this.settings(), id => this.retainHandoff(id));
    this.continuation = new FactoryContinuation(this.store, this.workflow, this.runtime, async (id, allowPartial) => {
      await this.retainHandoff(id);
      const events = this.store.list<import("../shared/protocol.ts").FactoryEvent>("events", this.store.get<FactoryRun>("runs", id)!.implementation_id).filter(event => (event.data as { run_id?: string })?.run_id === id);
      const latest = (kinds: string[]) => events.filter(event => kinds.includes(event.kind)).at(-1)?.kind;
      if (!allowPartial && (latest(["native_snapshot_unavailable", "planning_handoff_retained"]) === "native_snapshot_unavailable" || latest(["planning_documents_unavailable", "planning_documents_retained"]) === "planning_documents_unavailable")) throw new FactoryError("handoff_incomplete", "Some planning context could not be retained. Review the warning and choose Continue with available context", 409);
    });
    this.planning = new FactoryPlanning(this.store, this.workflow, this.runtime, async id => {
      await this.retainHandoff(id);
      const run = this.store.get<FactoryRun>("runs", id)!;
      const events = this.store.list<import("../shared/protocol.ts").FactoryEvent>("events", run.implementation_id).filter(event => (event.data as { run_id?: string })?.run_id === id);
      const latest = (kinds: string[]) => events.filter(event => kinds.includes(event.kind)).at(-1)?.kind;
      if (latest(["native_snapshot_unavailable", "planning_handoff_retained"]) === "native_snapshot_unavailable" || latest(["planning_documents_unavailable", "planning_documents_retained"]) === "planning_documents_unavailable") throw new FactoryError("handoff_incomplete", "The accepted Specification is retained, but some native planning evidence is unavailable; inspect the preserved conversation before continuing", 409);
    });
    this.humanApproval = new FactoryHumanApprovalService(this.store, this.runtime);
    this.humanReview = new FactoryHumanReview(this.store, this.runtime, this.review, id => this.retainNative(id));
    const maintenance = this.runtime.queue.maintenance;
    this.runtime.queue.maintenance = async () => { await maintenance?.(); await this.humanApproval.maintain(); for (const run of this.store.list<FactoryRun>("runs")) { try { await this.humanReview.retainAssistant(run); } catch { /* Machine unavailability preserves retained history. */ } } };
    this.execution = new FactoryExecution(this.store, this.workflow, this.runtime, this.pipeline, run => this.humanReview.handoff(run));
    this.retrospectives = new FactoryRetrospectives(this.store);
    this.github = new ProjectGitHub(this.store, this.accounts, (machineId, path) => this.runtime.discover(machineId, path));
    this.deletion = new FactoryDeletion(this.store, (run, deletionId) => this.runtime.deleteAttempt(run, deletionId), id => this.backup.purge(id), new GitHubDeletion(this.store, this.accounts));
    this.runtime.reconcileDeletion = id => this.deletion.reconcile(id);
  }
  settings(): FactorySettings {
    const saved = this.store.get<{ id: string; value: Partial<FactorySettings> & { max_implementations?: number } }>("settings", "default");
    const { max_implementations: removed, ...value } = saved?.value ?? {};
    const settings = { ...initialSettings, skills_path: this.skillsPath, ...value };
    if (removed !== undefined) this.store.put("settings", { id: "default", value: settings });
    return settings;
  }
  private boardAssignments(): Implementation[] {
    const ages = new Map<string, string>();
    for (const wait of this.store.list<import("../shared/factory.ts").FactoryCapacityWait>("capacity_waits")) {
      if (!ages.has(wait.implementation_id) || wait.created_at < ages.get(wait.implementation_id)!) ages.set(wait.implementation_id, wait.created_at);
    }
    return this.store.list<Implementation>("implementations").sort((a, b) => (ages.get(a.id) ?? a.created_at).localeCompare(ages.get(b.id) ?? b.created_at));
  }
  private boardProgress(idea: Implementation): import("../shared/factory.ts").FactoryAssignmentProgress {
    const runs = this.store.list<FactoryRun>("runs", idea.id);
    const executing = runs.filter(run => run.action === "implement-spec" && !["completed", "cancelled", "failed"].includes(run.condition)).at(-1);
    const tickets = executing ? this.workflow.executionTickets(executing) : this.workflow.tickets(idea.id);
    const waiting = this.store.list<import("../shared/factory.ts").FactoryCapacityWait & { request?: { ticket_id?: string } }>("capacity_waits").map(wait => ({ ...wait, ticket_id: wait.request?.ticket_id }));
    return assignmentProgress(idea, tickets, runs, this.store.list("workers"), this.store.list("checks"), waiting);
  }
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
  private conversations(implementation: Implementation) {
    const runs = this.store.list<FactoryRun>("runs", implementation.id);
    return workflowConversations({
      implementation, runs, tickets: this.workflow.tickets(implementation.id),
      workers: runs.flatMap(run => this.store.list<FactoryDetail["workers"][number]>("workers", run.id)),
      native_snapshots: runs.flatMap(run => this.store.list<FactoryDetail["native_snapshots"][number]>("native_snapshots", run.id)),
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
  detail(id: string): FactoryDetail | null {
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) return null;
    const runs = this.store.list<FactoryRun>("runs", id); const runIds = new Set(runs.map((run) => run.id));
    const active = [...runs].reverse().find(run => !["completed", "cancelled", "failed"].includes(run.condition));
    const questionRunId = active?.action === "verify-provider" ? active.id : undefined;
    const detail: FactoryDetail = { human_feedback_batches: this.store.list<import("../shared/factory.ts").FactoryHumanFeedbackBatch>("review_batches", id).filter(b => b.origin === "human"), human_review_approvals: this.store.list("human_review_approvals", id), human_reviews: this.store.list("human_reviews", id), human_review_deliveries: this.store.list<import("../shared/factory.ts").FactoryHumanReviewDelivery & { origin: string }>("human_review_messages", id).map(({ origin: _origin, ...receipt }) => receipt), automatic_review_batches: this.store.list("automatic_review_batches", id), pull_requests: this.store.list("pull_requests", id), automatic_review: this.store.list("automatic_review", id), automatic_execution: this.store.list("automatic_execution", id), automatic_planning: this.store.list("automatic_planning", id), execution_plans: this.store.list("execution_plans", id), implementation, capacity_waiting: factoryCapacity(this.store, this.settings()).waiting.filter(wait => wait.implementation_id === id), question_context: { run_id: questionRunId ?? null, revision: this.workflow.questionRevision(id, questionRunId), questions: this.workflow.questions(id, questionRunId) }, graph_hash: this.workflow.graphHash(id), question_revision: this.workflow.questionRevision(id), chats: this.store.list("chats", id), messages: this.store.list("messages", id), specifications: this.store.list("specifications", id), tickets: this.workflow.tickets(id), approvals: this.store.list("approvals", id), questions: this.store.list("questions", id), artifacts: this.store.list("artifacts", id), runs, snapshots: this.store.list("snapshots", id), comments: this.store.list("comments", id), events: this.store.list("events", id), native_snapshots: this.store.list<import("../shared/protocol.ts").NativeConversationSnapshot>("native_snapshots").filter((record) => runIds.has(record.run_id)), workers: this.store.list<import("../shared/protocol.ts").FactoryWorker>("workers").filter((worker) => runIds.has(worker.run_id)), checks: this.store.list<import("../shared/protocol.ts").FactoryCheck>("checks").filter((check) => runIds.has(check.run_id)), review_evidence: this.store.list<import("../shared/protocol.ts").FactoryReviewEvidence>("review_evidence").filter((report) => runIds.has(report.run_id)), retrospectives: implementation.project_id ? this.store.list("retrospectives", implementation.project_id) : [], frontier: runs.at(-1)?.action === "implement-spec" ? this.pipeline.frontier(runs.at(-1)!) : [] };
