import { discoverProject } from "./project-discovery.ts";
import { nativeSessionRef } from "../shared/native-pane.ts";
import { projectWorkflowPrompt } from "./factory-project-policy.ts";
import { writePrivateFile } from "./factory-files.ts";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { FactoryCapabilities, FactoryOutput, FactoryRun } from "../shared/protocol.ts";
import { HerdrError } from "./herdr/client.ts";
import { paneRead, paneScrollInfo } from "./herdr/client.ts";
import { claudeInputDraft, noteSubmitted, viewportShowsLive } from "./prompt.ts";
import { FactoryError, git, hash, inspectCheckout, withinRoot } from "./factory-host.ts";
import { factoryPaneResting, factoryWorkspaceGone, factoryAgentArguments, factoryNative, type FactoryNative } from "./factory-native.ts";
import { materializeSkills, provisionFactoryAgent, provisionSkills, verifySkills, type SkillManifest } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";
import { paneConversation } from "./conversation.ts";
import { FactoryWorktrees } from "./factory-worktrees.ts";
import type { FactoryCheck, FactoryWorker } from "../shared/protocol.ts";
import { factoryTrackerClient, factoryTrackerGuide } from "./factory-tracker-client.ts";
import { cleanupCheckouts, recordScaffolding } from "./factory-cleanup.ts";
import { factoryEnvironment } from "./factory-environment.ts";
import { materializeProjectReferences, preparedProjectReferences } from "./factory-reference-context.ts";
import type { CodexReferenceContext, ProjectReferencePayload } from "../shared/protocol.ts";
import type { AccountBindingSnapshot } from "../shared/accounts.ts";
import type { ProjectIssueExecutionScope } from "../shared/github-project.ts";
import type { MachineAccounts } from "./accounts.ts";
import { withAccountEnvironment } from "./account-execution.ts";
import { stagePlanningDocuments } from "./factory-planning-docs.ts";
import { prepareFactoryPrompt } from "./factory-prompt.ts";

function providerProofId(provider: string, snapshot?: AccountBindingSnapshot | null): string {
  const profile = snapshot?.profiles.find((entry) => entry.service === provider);
  return profile ? `${provider}:${hash(JSON.stringify(profile))}` : provider;
}

/** Machine-owned execution leases, not a second writable tracker or conversation history. */
export class FactoryExecutionHost {
  private readonly launches = new Map<string, Promise<FactoryRun>>();
  private readonly sends = new Set<string>();
  private promptBound = false;
  private readonly native: FactoryNative;
  private stopped = false;
  private preparedPath: string | null;
  private readonly genuineNative: boolean;
  readonly worktrees: FactoryWorktrees;
  constructor(private readonly store: FactoryStore, private readonly sourcePath: () => string | null, native: Partial<FactoryNative> = {}, private readonly accounts?: MachineAccounts) {
    this.native = { ...factoryNative, ...native };
    this.genuineNative = Object.keys(native).every((key) => key === "paneState") && accounts?.native.genuine !== false;
    this.worktrees = new FactoryWorktrees(store, this.native, () => this.skillPath(), accounts);
    const prepared = this.store.get<{ id: string; path: string }>("host_skills", "default"); this.preparedPath = prepared?.path ?? null;
  }
  discover(path: string) { return discoverProject(path, this.native, this.accounts?.discoveryHome); }
  async modelCatalog(provider: import("../shared/factory.ts").FactoryProvider, path: string, repository: string, snapshot?: AccountBindingSnapshot | null) {
    if (this.stopped || existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native model reads are disabled on a stopped or restored bridge", 409);
    const checkout = await inspectCheckout(path);
    if (checkout.repository !== repository) throw new FactoryError("wrong_checkout", "The selected checkout belongs to a different repository", 409);
    const environment = await this.accounts?.environment(snapshot, false, checkout.path) ?? {};
    const catalog = await withAccountEnvironment(environment, () => this.native.modelCatalog(provider, checkout.path));
    if (catalog.protocol !== 1 || catalog.provider !== provider || !Array.isArray(catalog.models)) throw new FactoryError("model_catalog_unavailable", "The Machine returned an incompatible model catalog", 409);
    this.accounts?.assertPublic(JSON.stringify(catalog));
    return catalog;
  }
  skillPath(): string | null { return this.sourcePath() ?? this.preparedPath; }
  async prepareReferences(payload: ProjectReferencePayload & { machine_id: string; checkout: { path: string; repository: string } }): Promise<CodexReferenceContext> {
    if (this.stopped || existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("preparation_disabled", "Reference preparation is disabled on this bridge", 409);
    if (typeof payload?.checkout?.path !== "string" || typeof payload.checkout.repository !== "string" || typeof payload.machine_id !== "string") throw new FactoryError("invalid_checkout", "Select a verified Machine checkout");
    const inspected = await inspectCheckout(payload.checkout.path);
    if (this.stopped) throw new FactoryError("stopping", "The bridge stopped during preparation", 409);
    if (inspected.repository !== payload.checkout.repository) throw new FactoryError("wrong_checkout", "The reference context belongs to another repository", 409);
    const context = materializeProjectReferences(this.store.root, payload);
    return { project_id: payload.library.project_id, machine_id: payload.machine_id, revision: payload.library.revision, ...context };
  }
  bindPrompt(prompt: FactoryNative["prompt"]): void { this.native.prompt = prompt; this.promptBound = true; }
  async paneState(paneId: string) {
    const pane = this.native.paneState ? await this.native.paneState(paneId) : (await this.native.snapshot()).panes.find((entry) => entry.pane_id === paneId);
    if (!pane) throw new FactoryError("pane_not_found", "This native pane is no longer available", 404);
    const decorated = pane as import("../shared/protocol.ts").HerdrPane;
    return { pane_id: decorated.pane_id, terminal_id: decorated.terminal_id, session_ref: nativeSessionRef(decorated), title: decorated.label?.trim() || decorated.terminal_title_stripped?.trim() || decorated.title?.trim() || decorated.pane_id, agent_status: decorated.agent_status, background_tasks: decorated.background_tasks, background_wait: decorated.background_wait };
  }
  async operation(id: string, action: string, body: Record<string, unknown>): Promise<unknown> {
    const run = this.store.get<{ run: FactoryRun }>("host_leases", id)?.run;
    const controlOnly = ["cleanup", "check-reconcile", "reconcile-worker", "stop-worker", "head", "transcript"].includes(action);
    const environment = controlOnly ? {} : await this.accounts?.environment((run?.manifest as { account_snapshot?: AccountBindingSnapshot } | undefined)?.account_snapshot, true) ?? {};
    return withAccountEnvironment(environment, () => this.performOperation(id, action, body));
  }
  private async performOperation(id: string, action: string, body: Record<string, unknown>): Promise<unknown> {
    if (action === "cleanup") {
      const lease = this.store.get<{ run: FactoryRun }>("host_leases", id);
      if (!lease) throw new FactoryError("not_found", "Owned Run not found", 404);
      return cleanupCheckouts(this.store, this.native, lease.run);
    }
    if (action === "check-reconcile" && typeof body.check_id === "string") return this.worktrees.reconcileCheck(id, body.check_id);
    if (action === "transcript") {
      const run = this.store.get<{ run: FactoryRun }>("host_leases", id)?.run;
      if (!run?.pane_id) throw new FactoryError("native_evidence_required", "The Run has no retained native identity", 409);
      const snapshot = await this.native.snapshot();
      const pane = snapshot.panes.find((entry) => entry.pane_id === run.pane_id);
      const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id);
      if (!pane?.cwd || realpathSync(pane.cwd) !== run.worktree || workspace?.label !== `saurons-eye-run-${id}` || pane.agent !== run.provider) throw new FactoryError("native_identity_changed", "The native transcript identity changed", 409);
      try {
        const conversation = await paneConversation(run.pane_id, undefined, typeof body.before === "string" ? { before: body.before } : {});
        if (conversation.source !== `${run.provider}-transcript`) throw new FactoryError("native_identity_changed", "This history belongs to another provider", 409);
        const bound = this.store.get<{ id: string; history_id: string }>("host_native_identity", id);
        if (bound && bound.history_id !== conversation.history_id) throw new FactoryError("native_identity_changed", "The pane now holds another native session; its earlier history remains retained", 409);
        this.store.put("host_native_identity", { id, history_id: conversation.history_id });
        if (JSON.stringify(conversation.turns).length > 4 * 1024 * 1024) throw new FactoryError("native_history_too_large", "Capture a smaller page of this native history", 413);
        const captured = { source_id: `${run.provider}:${hash(conversation.history_id)}`, version: conversation.version, turns: conversation.turns.map((turn) => ({ ...turn, parts: turn.parts.map((part) => part.kind === "tool" && (/\.saurons-eye-access\.json/.test(part.input) || Boolean(this.accounts && part.input.includes(this.accounts.root))) ? { ...part, output: "Scoped runtime credential redacted" } : part) })), cursor: conversation.cursor };
        const token = this.store.get<{ token: string }>("host_access", id)?.token;
        const redacted = token ? JSON.parse(JSON.stringify(captured).split(token).join("[scoped credential redacted]")) as typeof captured : captured;
        return this.accounts?.sanitize(redacted) ?? redacted;
      } catch (error) { if (error instanceof FactoryError) throw error; throw new FactoryError("native_evidence_required", "This exact native history is unavailable; its original store remains on the Machine", 409); }
    }
    if (action === "head") return this.worktrees.head(id);
    if (action === "worker" && body.worker && typeof body.worker === "object") return this.worktrees.create(id, body.worker as FactoryWorker, body.context, this.store.get("host_access", id));
    if (action === "check" && body.check && typeof body.check === "object") return this.worktrees.check(id, typeof body.worker_id === "string" ? body.worker_id : null, body.check as FactoryCheck);
    if (typeof body.worker_id !== "string") throw new FactoryError("invalid_worker", "Select a worker identity");
    if (action === "refresh") return this.worktrees.refresh(id, body.worker_id);
    if (action === "integrate" && typeof body.tip === "string") return this.worktrees.integrate(id, body.worker_id, body.tip);
    if (action === "reconcile-worker") return this.worktrees.reconcile(id, body.worker_id);
    if (action === "stop-worker") { await this.worktrees.stop(id, body.worker_id); return { ok: true }; }
    if (action === "review-evidence") {
      const worker = this.store.get<FactoryWorker>("host_workers", body.worker_id);
      if (!worker?.pane_id || worker.run_id !== id || !["standards", "spec"].includes(worker.role)) throw new FactoryError("invalid_worker", "Select an independent review context");
      let conversation;
      try { conversation = await paneConversation(worker.pane_id); }
      catch { throw new FactoryError("native_evidence_required", "The review context has no readable native transcript; retain its reservation", 409); }
      const content = conversation.turns.filter((turn) => turn.role === "assistant").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : [])).join("\n\n");
      if (!/FACTORY_REVIEW: (PASS|FAIL)/.test(content) || !conversation.turns.some((turn) => turn.parts.some((part) => (part.kind === "tool" || part.kind === "skill") && part.skill?.name === "code-review" && part.skill.status === "loaded"))) throw new FactoryError("review_evidence_required", "Retain actual native code-review loading and a completed axis report", 409);
      return { content: this.accounts?.sanitize(content) ?? content, source_id: hash(conversation.history_id), outcome: /FACTORY_REVIEW: FAIL/.test(content) ? "failed" : "passed", head: (await git(worker.worktree!, ["rev-parse", "HEAD"])).trim() };
    }
    throw new FactoryError("not_found", "Unknown worktree operation", 404);
  }
  prepare(body: Record<string, unknown>): void { this.preparedPath = materializeSkills(this.store.root, body); this.store.put("host_skills", { id: "default", path: this.preparedPath }); }
  async capabilities(snapshot?: AccountBindingSnapshot | null): Promise<FactoryCapabilities> {
    if (snapshot) await this.accounts?.environment(snapshot);
    let manifest: SkillManifest | null = null; let problem = "";
    try { manifest = verifySkills(this.skillPath()); } catch (error) { problem = error instanceof FactoryError ? error.message : "The pinned skill source could not be verified"; }
    const skills = manifest;
    const providers = await Promise.all((["codex", "claude", "opencode"] as const).map(async (provider) => {
      const version = await this.native.version(provider);
      const proof = this.store.get<{ id: string; version: string; manifest_hash: string; verified: boolean }>("provider_proofs", providerProofId(provider, snapshot));
      const ready = this.genuineNative && proof?.verified === true && proof.version === version && proof.manifest_hash === skills?.hash;
      const reasons = [...(!version ? ["The native provider or its version is unavailable on this Machine"] : []), ...(problem ? [problem] : []), ...(!ready ? ["Verify pinned native skill loading on this provider version before factory admission"] : [])];
      return { provider, version, installed: version !== null, skills_verified: skills !== null, factory_ready: reasons.length === 0, reasons };
    }));
    return { providers, skill_manifest: skills ? { commit: skills.commit, hash: skills.hash, file_count: skills.files.length } : null, factory_host_protocol: 1, project_reference_protocol: 1, account_profile_protocol: 1 };
  }
  async launch(record: FactoryRun, access?: { token: string; url: string }, attachments: { id: string; name: string; hash: string; size: number; content_base64: string }[] = [], references?: ProjectReferencePayload): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native execution is disabled on a restored copy", 409);
    if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9-]{36}$/.test(record.implementation_id) || !["codex", "claude", "opencode"].includes(record.provider) || !["work", "setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets", "implement-spec", "retro", "apply-retro", "verify-provider"].includes(record.action)) throw new FactoryError("invalid_launch", "Invalid owned execution identity");
    const signature = hash(JSON.stringify(record));
    const accepted = this.store.db.transaction(() => {
      const previous = this.store.get<{ id: string; signature: string; run: FactoryRun }>("host_leases", record.id);
      if (previous) { if (previous.signature !== signature) throw new FactoryError("launch_conflict", "This native lease already belongs to a different scope", 409); return { run: previous.run, fresh: false }; }
      if (this.stopped) throw new FactoryError("stopping", "The execution host is stopping", 409);
      if (this.store.list<{ run: FactoryRun }>("host_leases").some((lease) => lease.run.implementation_id === record.implementation_id && !["completed", "cancelled", "failed"].includes(lease.run.condition))) throw new FactoryError("host_owned", "This host retains an active or uncertain lease for the Implementation", 409);
      this.store.put("host_leases", { id: record.id, signature, run: record }); return { run: record, fresh: true };
    }).immediate();
    const pending = this.launches.get(record.id); if (pending) return pending;
    if (!accepted.fresh) return accepted.run;
    if (access) this.store.put("host_access", { id: record.id, ...access });
    const launch = (async () => {
      let environment: Record<string, string>;
      try { environment = await this.accounts?.environment((record.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot, true, record.checkout ?? undefined) ?? {}; }
      catch {
        const failed: FactoryRun = { ...record, condition: "failed", waiting_reason: "The frozen account scope is unavailable before native allocation" };
        this.store.put("host_leases", { id: record.id, signature, run: failed, native_attempted: false }); return failed;
      }
      return withAccountEnvironment(environment, () => this.dispatch(record, signature, attachments, references));
    })(); this.launches.set(record.id, launch);
    try { return await launch; } finally { this.launches.delete(record.id); }
  }
  private async dispatch(run: FactoryRun, signature: string, attachments: { id: string; name: string; hash: string; size: number; content_base64: string }[], references?: ProjectReferencePayload): Promise<FactoryRun> {
    let nativeAttempted = false;
    const save = (): void => {
      if (this.stopped) return;
      const current = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", run.id);
      if (current && ["cancelled", "completed", "failed"].includes(current.run.condition)) { run = current.run; return; }
      this.store.put("host_leases", { ...current, id: run.id, signature, run, native_attempted: nativeAttempted });
    };
    try {
      const skills = verifySkills(this.skillPath());
      const expected = run.manifest as { skills?: { hash?: string }; checkout?: { repository?: string }; provider_version?: string };
      if (expected.skills?.hash !== skills.hash || expected.provider_version !== await this.native.version(run.provider)) throw new FactoryError("host_changed", "The Machine's provider version or skill source changed after admission", 409);
      if (run.action === "implement-spec" && !(await this.capabilities((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot)).providers.find((entry) => entry.provider === run.provider)?.factory_ready) throw new FactoryError("provider_unavailable", "The native factory contract has not passed on this Machine", 409);
      if (run.checkout) {
        const checkout = await inspectCheckout(run.checkout);
        if (checkout.repository !== expected.checkout?.repository || checkout.head !== run.base || run.action === "implement-spec" && (await git(checkout.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new FactoryError("checkout_changed", "The verified checkout changed or has unpublished work; preserve it", 409);
      }
      const root = run.checkout ? join(this.store.root, "worktrees", run.id) : join(this.store.root, "inbox", run.implementation_id, run.id);
      const worktree = join(root, run.checkout ? "integration" : "workspace");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (existsSync(worktree)) throw new FactoryError("worktree_owned", "Unexpected work exists at the proposed working directory; preserve it", 409);
      const branch = run.checkout ? `saurons-eye/${run.implementation_id}/${run.id}` : null;
      if (run.checkout) await git(run.checkout, ["worktree", "add", "-b", branch!, worktree, run.base!]); else mkdirSync(worktree, { mode: 0o700 });
      if (realpathSync(worktree) !== worktree) throw new FactoryError("wrong_worktree", "The owned working directory changed", 409);
      run = { ...run, worktree, branch, updated_at: new Date().toISOString() }; save();
      const project = (run.manifest as { project?: { environment?: Record<string, string> } }).project;
      const environment = factoryEnvironment(root, run.id, project?.environment);
      Object.assign(environment, await this.accounts?.environment((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot, true));
      const library = (run.manifest as { project_references?: import("../shared/protocol.ts").ProjectReferenceLibrary }).project_references;
      let referenceContext;
      if (library?.entries.length) {
        if (run.provider !== "codex" || !references?.library || hash(JSON.stringify(references.library)) !== hash(JSON.stringify(library))) throw new FactoryError("invalid_references", "The Project reference payload does not match the frozen Run", 409);
        materializeProjectReferences(this.store.root, references);
        referenceContext = preparedProjectReferences(this.store.root, library);
      }
      let attachmentBytes = 0;
      const research = [];
      for (const attachment of attachments) {
        if (!/^[a-f0-9-]{36}$/.test(attachment.id) || !attachment.name || attachment.name.length > 200 || /[\x00-\x1f/\\:]/.test(attachment.name) || [".", ".."].includes(attachment.name)) throw new FactoryError("invalid_attachment", "Invalid retained research identity");
        const bytes = Buffer.from(attachment.content_base64, "base64"); attachmentBytes += bytes.length;
        if (bytes.length !== attachment.size || hash(bytes) !== attachment.hash || attachmentBytes > 64 * 1024 * 1024) throw new FactoryError("artifact_mismatch", "Retained research failed the size/hash materialization check");
        const extension = extname(attachment.name).toLowerCase();
        const filename = attachment.id + (/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".txt");
        writePrivateFile(join(root, "notes", filename), bytes, { flag: "wx", mode: 0o600 });
        research.push({ id: attachment.id, name: attachment.name, hash: attachment.hash, file: filename });
      }
      writePrivateFile(join(root, "notes", ".research-index.json"), JSON.stringify(research), { flag: "wx", mode: 0o600 });
      provisionSkills(worktree, run.provider, skills);
      const access = this.store.get("host_access", run.id);
      if (access) { writePrivateFile(join(worktree, ".saurons-eye-access.json"), JSON.stringify(access), { mode: 0o600, flag: "wx" }); writePrivateFile(join(worktree, ".saurons-eye-tracker.mjs"), factoryTrackerClient, { mode: 0o600, flag: "wx" }); }
      writePrivateFile(join(worktree, ".saurons-eye-context.json"), JSON.stringify({ run, project_reference_context: referenceContext, tracker: { guide: factoryTrackerGuide, type: "Other: app-native", command: "bun .saurons-eye-tracker.mjs", instructions: run.action === "work" ? "This is direct owner-requested work in this owned workspace. Read the frozen idea, notes and Project guidance; native CLI skills and subagents follow the selected native permission controls. Edit this workspace directly. No factory Ticket graph is required. The primary checkout and separately authorized publication scope remain preserved." : "The app owns stable Ticket IDs, dependencies and resolution. Read contract and ticket IDs through this adapter. Question records require actual owner answers; consume records their version. The coordinator uses worker, refresh, check and integrate for the accepted dependency frontier. All native contexts and builds must use this adapter's reservations; never spawn unmanaged children or builds. Each worker writes only its own checkout. Shared progress/glossary/ADRs/migrations/lockfiles require explicit path claims. The backend merger alone writes integration. Do not accept your own work, publish or deploy. If synchronization fails, stop and retain the failure." }, environment: { cache: join(root, "cache"), state: join(root, "state"), notes: join(root, "notes"), temporary: join(root, "tmp") }, workflow: run.action === "work" ? "Follow the Project workflow and coding standards using its native skills. Ask actual owner questions in chat and preserve separate publication/acceptance gates." : "Load only the explicitly selected pinned action. Preserve its owner question and approval gates. Reuse frozen approvals within their scope. Keep application scaffolding and attachments out of commits. Preserve the primary checkout and retain separate Standards and Spec evidence." }, null, 2), { mode: 0o600, flag: "wx" });
      if (this.stopped) throw new FactoryError("stopping", "The bridge stopped before native launch; reconcile the accepted intent", 409);
      nativeAttempted = true; save();
      const workspace = await this.native.createWorkspace({ cwd: worktree, label: `saurons-eye-run-${run.id}`, env: environment });
      run = { ...run, workspace_id: workspace.workspace.workspace_id, pane_id: workspace.root_pane.pane_id }; save();
      const skill = run.action === "setup" ? "setup-matt-pocock-skills" : run.action === "apply-retro" ? "tdd" : run.action;
      const readOnly = run.action === "implement-spec" || run.action === "verify-provider";
      provisionFactoryAgent(worktree, run.provider, skill, skills, readOnly, (run.manifest as { project?: import("../shared/factory.ts").FactoryProject }).project?.permission_mode, (run.manifest as { execution_preset?: import("../shared/agent-models.ts").AgentExecutionPreset }).execution_preset);
      recordScaffolding(this.store, run.id, worktree, run.provider, skills);
      if (this.store.get<{ closing?: boolean }>("host_leases", run.id)?.closing) return this.stopRun(run.id);
      const skillPrefix = run.action === "work" ? "" : run.action === "verify-provider" ? skills.skills.map(entry => `${run.provider === "codex" ? "$" : run.provider === "opencode" ? "@" : "/"}${entry.name}`).join(" ") : `${run.provider === "codex" ? "$" : run.provider === "opencode" ? "@" : "/"}${skill}`;
      let prompt = run.action === "verify-provider"
        ? `${skillPrefix} This is an explicitly requested native skill-loading probe. Load each of these pinned skills through your supported skill mechanism and read the project-local SKILL.md and referenced support files: ${skills.skills.map((entry) => entry.name).join(", ")}. Inspect instructions only; do not execute their workflows, publish, spawn children or change global settings. Describe question and permission differences. Use bun .saurons-eye-tracker.mjs question unused '{"question":"Confirm this read-only native verification round?"}' to record one owner question, then wait for the actual answer. When explicitly resumed, read contract and use consume with its question revision. Read .saurons-eye-context.json for this disposable scope.`
        : `${skillPrefix} Read .saurons-eye-context.json for the frozen owner scope. Read contract through bun .saurons-eye-tracker.mjs for retained owner messages and the previous planning discussion; read the notes .research-index.json and planning indexes for retained glossary, decisions and documents. Follow this action's confirmation gates and await actual owner answers.`;
      if (run.action === "work") {
        const idea = (run.manifest as { implementation: import("../shared/factory.ts").Implementation }).implementation;
        const issueScope = (run.manifest as { issue_scope?: ProjectIssueExecutionScope }).issue_scope;
        const workScope = issueScope ? `${issueScope.issue.title}\n\n${issueScope.issue.body}\n\nApproved issue plan:\n${JSON.stringify(issueScope.approval.plan, null, 2)}` : `${idea.title}\n\n${idea.description}`;
        prompt = `Work on this Project idea:\n\n${workScope}\n\nRead the repository's guidance and .saurons-eye-context.json for the selected Project scope. Read contract through bun .saurons-eye-tracker.mjs for retained owner messages and the notes .research-index.json for attachments. This is a direct owner-requested work session. Preserve the primary checkout; this workspace starts from its committed revision. Follow the Project's coding standards and native permissions. Ask for missing decisions in this chat. Publication and deployment require their separately authorized scope.`;
        if (issueScope) prompt += " Use only the frozen approved issue requirements and testing decisions. Use the scoped tracker to ask the owner about missing requirements or any new design/testing choice, then wait for the actual answer.";
      }
      if (run.action === "implement-spec" && (run.manifest as { issue_scope?: ProjectIssueExecutionScope }).issue_scope) prompt += " Implement the frozen trusted issue scope using its reused planning and testing receipts. Do not repeat the accepted interview. Allocate bounded Ticket workers through the scoped tracker, retain Project checks and independent Standards and Spec reviews at the checked head, and ask the owner only about missing requirements or new decisions. Rest after verification so the app can release the implementing slot while awaiting manual merge. Do not merge or deploy.";
      prompt += projectWorkflowPrompt((run.manifest as { project?: import("../shared/factory.ts").FactoryProject }).project);
      if (referenceContext) prompt += ` ${referenceContext.prompt}`;
      const launchPrompt = prepareFactoryPrompt(worktree, prompt, skillPrefix);
      recordScaffolding(this.store, run.id, worktree, run.provider, skills);
      await this.native.startAgent({ name: `saurons-${run.id.replaceAll("-", "").slice(0, 24)}`, kind: run.provider, paneId: run.pane_id!, args: factoryAgentArguments(run.provider, worktree, launchPrompt, readOnly, Boolean((run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot?.profiles.some((entry) => entry.service === run.provider)), (run.manifest as { project?: import("../shared/factory.ts").FactoryProject }).project?.permission_mode, run.action === "work", (run.manifest as { execution_preset?: import("../shared/agent-models.ts").AgentExecutionPreset }).execution_preset), timeoutMs: 60_000 });
      const afterLaunch = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", run.id);
      if (afterLaunch?.closing || afterLaunch && ["cancelled", "completed", "failed"].includes(afterLaunch.run.condition)) return this.stopRun(run.id);
      run = { ...run, condition: "working", waiting_reason: null, updated_at: new Date().toISOString() }; save(); return run;
    } catch (error) {
      const reason = error instanceof FactoryError ? error.message : error instanceof HerdrError ? `Native launch failed (${error.code}); reconcile the recorded identity before retrying` : "Launch did not finish; inspect the owned working directory and reconcile native identity";
      run = { ...run, condition: nativeAttempted ? "interrupted" : "failed", waiting_reason: reason, updated_at: new Date().toISOString() }; save(); return run;
    }
  }
  async verifyProvider(id: string): Promise<FactoryCapabilities> {
    if (!this.genuineNative) throw new FactoryError("native_evidence_required", "A stand-in adapter cannot certify a native provider", 409);
    const lease = this.store.get<{ run: FactoryRun }>("host_leases", id);
    if (!lease || lease.run.action !== "verify-provider" || !lease.run.pane_id || !lease.run.worktree) throw new FactoryError("verification_run_required", "Start an explicit native verification Run first", 409);
    const run = await this.reconcile(id);
    if (run.condition === "disconnected") throw new FactoryError("native_identity_uncertain", "Reconcile the verification pane first", 409);
    const manifest = verifySkills(this.skillPath());
    const expected = run.manifest as { skills: { hash: string }; provider_version: string };
    const version = await this.native.version(run.provider);
    if (version !== expected.provider_version || manifest.hash !== expected.skills.hash) throw new FactoryError("verification_stale", "The provider or skill source changed during verification", 409);
    let conversation;
    try { conversation = await paneConversation(run.pane_id!); }
    catch { throw new FactoryError("native_evidence_required", "The exact verification pane has no readable native transcript", 409); }
    if (conversation.source !== `${run.provider === "claude" ? "claude" : run.provider}-transcript`) throw new FactoryError("native_evidence_required", "The verification transcript belongs to another provider", 409);
    const loaded = new Set<string>();
    const directory = join(run.worktree!, run.provider === "claude" ? ".claude" : run.provider === "opencode" ? ".opencode" : ".agents", "skills");
    for (const turn of conversation.turns) for (const part of turn.parts) {
      let path: string | undefined;
      if ((part.kind === "skill" || part.kind === "tool") && part.skill?.status === "loaded" && part.skill.path) path = part.skill.path;
      if (part.kind === "tool" && !part.error && ["Read", "read", "read_file"].includes(part.name)) {
        try { const input = JSON.parse(part.input); path = input.file_path ?? input.filePath ?? input.path; } catch { /* a display summary is not path evidence */ }
      }
      if (typeof path !== "string") continue;
      for (const skill of manifest.skills) {
        const expectedPath = join(directory, skill.name, "SKILL.md");
        if (resolve(run.worktree!, path) !== expectedPath) continue;
        const locked = manifest.files.find((file) => file.path === `${skill.path}/SKILL.md`)!;
        if (realpathSync(expectedPath) !== expectedPath || hash(readFileSync(expectedPath)) !== locked.sha256) throw new FactoryError("verification_stale", "The loaded project skill changed during verification", 409);
        loaded.add(skill.name);
      }
    }
    const missing = manifest.skills.filter((skill) => !loaded.has(skill.name));
    if (missing.length) throw new FactoryError("native_evidence_required", `Native loading evidence is missing for: ${missing.map((skill) => skill.name).join(", ")}`, 409);
    const accountSnapshot = (run.manifest as { account_snapshot?: AccountBindingSnapshot }).account_snapshot;
    if (accountSnapshot) await this.accounts?.environment(accountSnapshot);
    this.store.put("provider_proofs", { id: providerProofId(run.provider, accountSnapshot), version, manifest_hash: manifest.hash, verified: true, run_id: id, native_history_id: conversation.history_id, evidence_hash: hash(JSON.stringify(conversation.turns)), verified_at: new Date().toISOString() });
    return this.capabilities(accountSnapshot);
  }
  async reconcile(id: string): Promise<FactoryRun> {
    const lease = this.store.get<{ id: string; signature: string; run: FactoryRun }>("host_leases", id);
    if (!lease) throw new FactoryError("native_identity_uncertain", "This host has no recorded lease; reconcile ownership before retrying", 409);
    let run = lease.run;
    if (["completed", "cancelled", "failed"].includes(run.condition)) return run;
    try {
      const snapshot = await this.native.snapshot();
      const matches = snapshot.workspaces.filter((entry) => entry.label === `saurons-eye-run-${run.id}`);
      const workspace = run.workspace_id ? snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id) : matches.length === 1 ? matches[0] : undefined;
      const candidates = snapshot.panes.filter((entry) => entry.workspace_id === workspace?.workspace_id && entry.cwd === run.worktree);
      const pane = run.pane_id ? snapshot.panes.find((entry) => entry.pane_id === run.pane_id) : candidates.length === 1 ? candidates[0] : undefined;
      if (!pane || !workspace || workspace.label !== `saurons-eye-run-${run.id}` || !pane.cwd || realpathSync(pane.cwd) !== run.worktree) throw new FactoryError("native_identity_uncertain", "Native identity is unavailable or changed; exclusive ownership is retained", 409);
      const resting = await factoryPaneResting(this.native, pane, run.provider);
      run = { ...run, pane_id: pane.pane_id, workspace_id: workspace.workspace_id, condition: pane.agent !== run.provider ? "interrupted" : pane.agent_status === "blocked" ? "needs_you" : resting ? "ready" : "working", waiting_reason: pane.agent !== run.provider ? "The workspace exists but native provider launch is unconfirmed; no retry was sent" : pane.agent_status === "blocked" ? "The native agent is waiting for an owner answer" : null };
    } catch (error) { run = { ...run, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The native Machine cannot be observed; ownership is retained" }; }
    const current = this.store.get<typeof lease>("host_leases", id);
    if (current && JSON.stringify(current) !== JSON.stringify(lease)) return current.run;
    run.updated_at = new Date().toISOString(); this.store.put("host_leases", { ...lease, run }); return run;
  }
  async stopRun(id: string): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const lease = this.store.get<{ id: string; signature: string; run: FactoryRun }>("host_leases", id);
    if (!lease) throw new FactoryError("native_identity_uncertain", "This host has no owned lease to stop", 409);
    if (["cancelled", "completed", "failed"].includes(lease.run.condition)) { await this.worktrees.stopChecks(id); await this.worktrees.stopWorkers(id); return lease.run; }
    const run = lease.run;
    this.store.put("host_leases", { ...lease, closing: true });
    await this.worktrees.stopChecks(id);
    const snapshot = await this.native.snapshot();
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id);
    const pane = snapshot.panes.find((entry) => entry.pane_id === run.pane_id);
    let unchangedWorktree = false;
    try { unchangedWorktree = !!run.worktree && realpathSync(run.worktree) === run.worktree; } catch { /* Changed or unavailable worktrees retain ownership. */ }
    const couldOwnDirectory = (cwd: string | null | undefined): boolean => {
      if (!cwd || !run.worktree) return false;
      const lexical = resolve(cwd);
      if (lexical === run.worktree || withinRoot(run.worktree, lexical)) return true;
      let path: string; try { path = realpathSync(cwd); } catch { return true; }
      return path === run.worktree || withinRoot(run.worktree, path);
    };
    // A complete fresh snapshot can prove recorded identities have ended. Missing IDs,
    // a moved pane or another candidate retain ownership instead of guessing a target.
    const alreadyClosed = unchangedWorktree && !!run.workspace_id && !!run.pane_id && !workspace && !pane
      && !snapshot.workspaces.some(entry => entry.label === `saurons-eye-run-${id}`)
      && !snapshot.panes.some(entry => !entry.cwd && !entry.foreground_cwd || couldOwnDirectory(entry.cwd) || couldOwnDirectory(entry.foreground_cwd));
    if (!alreadyClosed && (!workspace || workspace.label !== `saurons-eye-run-${id}` || !pane?.cwd || realpathSync(pane.cwd) !== run.worktree)) throw new FactoryError("native_identity_uncertain", "Verify the recorded native identity before stopping it; ownership is retained", 409);
    let childFailure: unknown;
    try { await this.worktrees.stopWorkers(id); } catch (error) { childFailure = error; }
    if (!alreadyClosed) await this.native.closeWorkspace(workspace!.workspace_id);
    if (!factoryWorkspaceGone(await this.native.snapshot(), run, `saurons-eye-run-${id}`)) throw new FactoryError("native_stop_uncertain", "The native Run has not been confirmed stopped; ownership is retained", 409);
    await this.worktrees.stopChecks(id);
    if (childFailure) throw childFailure;
    const stopped: FactoryRun = { ...run, condition: "cancelled", waiting_reason: null, updated_at: new Date().toISOString() };
    this.store.put("host_leases", { ...lease, closing: true, run: stopped }); return stopped;
  }
  /** Finish a resting workflow step while keeping its native chat available. */
  async finishStep(id: string): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const lease = this.store.get<{ id: string; run: FactoryRun; closing?: boolean }>("host_leases", id);
    if (!lease || !["work", "grill-me", "grill-with-docs", "setup", "to-spec", "to-tickets", "verify-provider"].includes(lease.run.action)) throw new FactoryError("planning_step_required", "Continue a planning or verification step; repository work requires its review controls", 409);
    if (lease.run.condition === "completed") return lease.run;
    if (lease.closing || ["cancelled", "failed", "disconnected", "interrupted"].includes(lease.run.condition)) throw new FactoryError("step_uncertain", "Reconcile this step's ownership before continuing", 409);
    const run = lease.run;
    const snapshot = await this.native.snapshot();
    const pane = snapshot.panes.find(entry => entry.pane_id === run.pane_id);
    const workspace = snapshot.workspaces.find(entry => entry.workspace_id === run.workspace_id);
    if (!pane?.cwd || !run.worktree || realpathSync(pane.cwd) !== run.worktree || workspace?.label !== `saurons-eye-run-${id}`) throw new FactoryError("native_identity_uncertain", "The recorded chat identity changed; reconcile before continuing", 409);
    const checkout = run.checkout ? await inspectCheckout(run.worktree) : null;
    if (checkout && (checkout.repository !== (run.manifest as { checkout?: { repository: string } }).checkout?.repository || checkout.branch !== run.branch)) throw new FactoryError("worktree_changed", "The owned repository or branch changed; reconcile before continuing", 409);
    if (!await factoryPaneResting(this.native, pane, run.provider)) throw new FactoryError("agent_busy", "The agent is still working or awaiting a prompt answer", 409);
    if (this.store.list<FactoryWorker>("host_workers").some(worker => worker.run_id === id && !["completed", "cancelled", "failed"].includes(worker.condition)) || this.store.list<FactoryCheck>("host_checks").some(check => check.run_id === id && ["working", "interrupted"].includes(check.condition))) throw new FactoryError("step_owned", "Reconcile this step's workers and builds before continuing", 409);
    if (hash(JSON.stringify(this.store.get("host_leases", id))) !== hash(JSON.stringify(lease))) throw new FactoryError("step_changed", "The workflow step changed while finishing; refresh its state", 409);
    const finished: FactoryRun = { ...run, condition: "completed", waiting_reason: null, updated_at: new Date().toISOString() };
    this.store.put("host_leases", { ...lease, closing: true, run: finished });
    return finished;
  }
  async send(id: string, text: string, signal: AbortSignal): Promise<void> {
    if (this.sends.has(id)) throw new FactoryError("delivery_busy", "Another selected batch is being delivered; retain this draft", 409);
    this.sends.add(id);
    try { await this.sendOwned(id, text, signal); } finally { this.sends.delete(id); }
  }
  private async sendOwned(id: string, text: string, signal: AbortSignal): Promise<void> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native input is disabled on a restored copy", 409);
    const lease = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", id);
    if (!lease || lease.closing || !["working", "ready", "needs_you"].includes(lease.run.condition)) throw new FactoryError("run_unavailable", "Reconcile the Run before submitting changes", 409);
    const run = lease.run; const snapshot = await this.native.snapshot();
    const pane = snapshot.panes.find((entry) => entry.pane_id === run.pane_id);
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id);
    if (!pane?.cwd || realpathSync(pane.cwd) !== run.worktree || workspace?.label !== `saurons-eye-run-${id}` || pane.agent !== run.provider) throw new FactoryError("native_identity_changed", "The native Run identity changed; reconcile before sending", 409);
    if (!await factoryPaneResting(this.native, pane, run.provider)) throw new FactoryError("agent_busy", "The native agent is working or waiting for a prompt answer; retain the draft and send explicitly when ready", 409);
    if (run.provider === "claude") {
      const before = (await paneRead({ paneId: run.pane_id!, source: "detection", format: "text" })).text;
      const scrollBefore = await paneScrollInfo(run.pane_id!);
      const shown = (await paneRead({ paneId: run.pane_id!, source: "visible", format: "ansi" })).text;
      const scrollAfter = await paneScrollInfo(run.pane_id!);
      const after = (await paneRead({ paneId: run.pane_id!, source: "detection", format: "text" })).text;
      if (before !== after || claudeInputDraft(after, viewportShowsLive(scrollBefore, scrollAfter, shown, before, after) ? shown : null)) throw new FactoryError("input_draft", "The native input box contains a draft; retain this batch and send explicitly after it is cleared", 409);
    }
    if (signal.aborted) throw new FactoryError("disconnected", "The submitting connection closed; this input was not sent", 409);
    await this.native.prompt(run.pane_id!, text, undefined, () => { const current = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", id); return !this.stopped && !signal.aborted && !current?.closing && ["working", "ready", "needs_you"].includes(current?.run.condition ?? ""); });
    if (!this.promptBound) noteSubmitted(run.pane_id!, text);
  }
  private outputBytes(id: string, name: string): Buffer {
    const lease = this.store.get<{ run: FactoryRun }>("host_leases", id);
    if (!lease?.run.worktree) throw new FactoryError("invalid_run", "This Machine has no retained working directory for the Run", 409);
    if (!name || name.length > 200 || name.startsWith(".") || /[\x00-\x1f/\\:]/.test(name)) throw new FactoryError("invalid_artifact_path", "Select a named output in this Run's notes directory");
    const root = join(dirname(lease.run.worktree), "notes"); const file = join(root, name);
    let descriptor: number | undefined;
    try {
      if (realpathSync(root) !== root || lstatSync(file).isSymbolicLink() || !withinRoot(root, realpathSync(file))) throw new FactoryError("artifact_escape", "The output must remain inside this Run's owned notes directory", 403);
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink > 1 || info.size > 25 * 1024 * 1024) throw new FactoryError("invalid_output", "This output exceeds the import budget or is not an owned regular file", 413);
      const bytes = readFileSync(descriptor); const text = bytes.toString("utf8"); this.accounts?.assertPublic(text);
      const token = this.store.get<{ token: string }>("host_access", id)?.token;
      if (token && text.includes(token)) throw new FactoryError("private_runtime_material", "Scoped credentials cannot be retained in Run outputs", 409);
      return bytes;
    } catch (error) { if (error instanceof FactoryError) throw error; throw new FactoryError("output_unavailable", "This Run's output is unavailable or changed during import", 409); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  async outputs(id: string): Promise<FactoryOutput[]> {
    const lease = this.store.get<{ run: FactoryRun }>("host_leases", id);
    if (!lease?.run.worktree) throw new FactoryError("invalid_run", "This Machine has no owned Run outputs", 409);
    const currentPlanning = await stagePlanningDocuments(lease.run, text => {
      this.accounts?.assertPublic(text);
      const token = this.store.get<{ token: string }>("host_access", id)?.token;
      if (token && text.includes(token)) throw new FactoryError("private_runtime_material", "Scoped credentials cannot be retained in planning documents", 409);
    });
    const root = join(dirname(lease.run.worktree), "notes");
    const inputs = existsSync(join(root, ".research-index.json")) ? JSON.parse(readFileSync(join(root, ".research-index.json"), "utf8")) as { file: string }[] : [];
    const materialized = new Set(inputs.map(input => input.file));
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > 200) throw new FactoryError("outputs_too_large", "Import at most 200 named research outputs per Run", 413);
    const types: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
    const result: FactoryOutput[] = [];
    for (const entry of entries) {
      const mediaType = types[extname(entry.name).toLowerCase()];
      if (!entry.isFile() || !mediaType || entry.name.startsWith(".") || materialized.has(entry.name) || currentPlanning && /^planning-(?:[a-f0-9]{16}-|index-)/.test(entry.name) && !currentPlanning.has(entry.name)) continue;
      const bytes = this.outputBytes(id, entry.name); result.push({ name: entry.name, media_type: mediaType, size: bytes.length, hash: hash(bytes) });
    }
    return result;
  }
  output(id: string, name: string, expectedHash: string): { content_base64: string } {
    const bytes = this.outputBytes(id, name);
    if (hash(bytes) !== expectedHash) throw new FactoryError("output_changed", "The output changed after inspection; capture it again", 409);
    return { content_base64: bytes.toString("base64") };
  }
  stop(): void { this.stopped = true; this.worktrees.shutdown(); }
}
