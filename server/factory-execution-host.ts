import { writePrivateFile } from "./factory-files.ts";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { FactoryCapabilities, FactoryOutput, FactoryRun } from "../shared/protocol.ts";
import { HerdrError } from "./herdr/client.ts";
import { paneRead, paneScrollInfo } from "./herdr/client.ts";
import { claudeInputDraft, noteSubmitted, viewportShowsLive } from "./prompt.ts";
import { FactoryError, git, hash, inspectCheckout, withinRoot } from "./factory-host.ts";
import { factoryAgentArguments, factoryNative, type FactoryNative } from "./factory-native.ts";
import { materializeSkills, provisionFactoryAgent, provisionSkills, verifySkills, type SkillManifest } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";
import { paneConversation } from "./conversation.ts";
import { FactoryWorktrees } from "./factory-worktrees.ts";
import type { FactoryCheck, FactoryWorker } from "../shared/protocol.ts";
import { factoryTrackerClient, factoryTrackerGuide } from "./factory-tracker-client.ts";
import { cleanupCheckouts, recordScaffolding } from "./factory-cleanup.ts";
import { factoryEnvironment } from "./factory-environment.ts";

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
  constructor(private readonly store: FactoryStore, private readonly sourcePath: () => string | null, native: Partial<FactoryNative> = {}) {
    this.native = { ...factoryNative, ...native };
    this.genuineNative = Object.keys(native).length === 0;
    this.worktrees = new FactoryWorktrees(store, this.native, () => this.skillPath());
    const prepared = this.store.get<{ id: string; path: string }>("host_skills", "default"); this.preparedPath = prepared?.path ?? null;
  }
  skillPath(): string | null { return this.sourcePath() ?? this.preparedPath; }
  bindPrompt(prompt: FactoryNative["prompt"]): void { this.native.prompt = prompt; this.promptBound = true; }
  async operation(id: string, action: string, body: Record<string, unknown>): Promise<unknown> {
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
        return { source_id: `${run.provider}:${hash(conversation.history_id)}`, version: conversation.version, turns: conversation.turns.map((turn) => ({ ...turn, parts: turn.parts.map((part) => part.kind === "tool" && /\.saurons-eye-access\.json/.test(part.input) ? { ...part, output: "Scoped runtime credential redacted" } : part) })), cursor: conversation.cursor };
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
      return { content, source_id: conversation.history_id, outcome: /FACTORY_REVIEW: FAIL/.test(content) ? "failed" : "passed", head: (await git(worker.worktree!, ["rev-parse", "HEAD"])).trim() };
    }
    throw new FactoryError("not_found", "Unknown worktree operation", 404);
  }
  prepare(body: Record<string, unknown>): void { this.preparedPath = materializeSkills(this.store.root, body); this.store.put("host_skills", { id: "default", path: this.preparedPath }); }
  async capabilities(): Promise<FactoryCapabilities> {
    let manifest: SkillManifest | null = null; let problem = "";
    try { manifest = verifySkills(this.skillPath()); } catch (error) { problem = error instanceof FactoryError ? error.message : "The pinned skill source could not be verified"; }
    const skills = manifest;
    const providers = await Promise.all((["codex", "claude", "opencode"] as const).map(async (provider) => {
      const version = await this.native.version(provider);
      const proof = this.store.get<{ id: string; version: string; manifest_hash: string; verified: boolean }>("provider_proofs", provider);
      const ready = this.genuineNative && proof?.verified === true && proof.version === version && proof.manifest_hash === skills?.hash;
      const reasons = [...(!version ? ["The native provider or its version is unavailable on this Machine"] : []), ...(problem ? [problem] : []), ...(!ready ? ["Verify pinned native skill loading on this provider version before factory admission"] : [])];
      return { provider, version, installed: version !== null, skills_verified: skills !== null, factory_ready: reasons.length === 0, reasons };
    }));
    return { providers, skill_manifest: skills ? { commit: skills.commit, hash: skills.hash, file_count: skills.files.length } : null, factory_host_protocol: 1 };
  }
  async launch(record: FactoryRun, access?: { token: string; url: string }, attachments: { id: string; name: string; hash: string; size: number; content_base64: string }[] = []): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native execution is disabled on a restored copy", 409);
    if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9-]{36}$/.test(record.implementation_id) || !["codex", "claude", "opencode"].includes(record.provider) || !["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets", "implement-spec", "retro", "apply-retro", "verify-provider"].includes(record.action)) throw new FactoryError("invalid_launch", "Invalid owned execution identity");
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
    const launch = this.dispatch(record, signature, attachments); this.launches.set(record.id, launch);
    try { return await launch; } finally { this.launches.delete(record.id); }
  }
  private async dispatch(run: FactoryRun, signature: string, attachments: { id: string; name: string; hash: string; size: number; content_base64: string }[]): Promise<FactoryRun> {
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
      if (run.action === "implement-spec" && !(await this.capabilities()).providers.find((entry) => entry.provider === run.provider)?.factory_ready) throw new FactoryError("provider_unavailable", "The native factory contract has not passed on this Machine", 409);
      if (run.checkout) {
        const checkout = await inspectCheckout(run.checkout);
        if (checkout.repository !== expected.checkout?.repository || checkout.head !== run.base || (await git(checkout.path, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new FactoryError("checkout_changed", "The verified checkout changed or has unpublished work; preserve it", 409);
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
      writePrivateFile(join(worktree, ".saurons-eye-context.json"), JSON.stringify({ run, tracker: { guide: factoryTrackerGuide, type: "Other: app-native", command: "bun .saurons-eye-tracker.mjs", instructions: "The app owns stable Ticket IDs, dependencies and resolution. Read contract and ticket IDs through this adapter. Question records require actual owner answers; consume records their version. The coordinator uses worker, refresh, check and integrate for the accepted dependency frontier. All native contexts and builds must use this adapter's reservations; never spawn unmanaged children or builds. Each worker writes only its own checkout. Shared progress/glossary/ADRs/migrations/lockfiles require explicit path claims. The backend merger alone writes integration. Do not accept your own work, publish or deploy. If synchronization fails, stop and retain the failure." }, environment: { cache: join(root, "cache"), state: join(root, "state"), notes: join(root, "notes"), temporary: join(root, "tmp") }, workflow: "Load only the explicitly selected pinned action. Preserve its owner question and approval gates. Reuse frozen approvals within their scope. Keep application scaffolding and attachments out of commits. Preserve the primary checkout and retain separate Standards and Spec evidence." }, null, 2), { mode: 0o600, flag: "wx" });
      if (this.stopped) throw new FactoryError("stopping", "The bridge stopped before native launch; reconcile the accepted intent", 409);
      nativeAttempted = true; save();
      const workspace = await this.native.createWorkspace({ cwd: worktree, label: `saurons-eye-run-${run.id}`, env: environment });
      run = { ...run, workspace_id: workspace.workspace.workspace_id, pane_id: workspace.root_pane.pane_id }; save();
      const skill = run.action === "setup" ? "setup-matt-pocock-skills" : run.action === "apply-retro" ? "tdd" : run.action;
      provisionFactoryAgent(worktree, run.provider, skill, skills, run.action === "implement-spec");
      recordScaffolding(this.store, run.id, worktree, run.provider, skills);
      if (this.store.get<{ closing?: boolean }>("host_leases", run.id)?.closing) return this.stopRun(run.id);
      const prompt = run.action === "verify-provider"
        ? `${skills.skills.map((entry) => `${run.provider === "codex" ? "$" : run.provider === "opencode" ? "@" : "/"}${entry.name}`).join(" ")} This is an explicitly requested native skill-loading probe. Load each of these pinned skills through your supported skill mechanism and read the project-local SKILL.md and referenced support files: ${skills.skills.map((entry) => entry.name).join(", ")}. Inspect instructions only; do not execute their workflows, publish, spawn children or change global settings. Describe question and permission differences. Use bun .saurons-eye-tracker.mjs question unused '{"question":"Confirm this read-only native verification round?"}' to record one owner question, then wait for the actual answer. When explicitly resumed, read contract and use consume with its question revision. Read .saurons-eye-context.json for this disposable scope.`
        : `${run.provider === "codex" ? "$" : run.provider === "opencode" ? "@" : "/"}${skill} Read .saurons-eye-context.json for the frozen owner scope. Follow this action's confirmation gates and await actual owner answers.`;
      const coordinator = run.action === "implement-spec";
      await this.native.startAgent({ name: `saurons-${run.id.replaceAll("-", "").slice(0, 24)}`, kind: run.provider, paneId: run.pane_id!, args: factoryAgentArguments(run.provider, worktree, prompt, coordinator), timeoutMs: 60_000 });
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
    this.store.put("provider_proofs", { id: run.provider, version, manifest_hash: manifest.hash, verified: true, run_id: id, native_history_id: conversation.history_id, evidence_hash: hash(JSON.stringify(conversation.turns)), verified_at: new Date().toISOString() });
    return this.capabilities();
  }
  async reconcile(id: string): Promise<FactoryRun> {
    const lease = this.store.get<{ id: string; signature: string; run: FactoryRun }>("host_leases", id);
    if (!lease) throw new FactoryError("native_identity_uncertain", "This host has no recorded lease; reconcile ownership before retrying", 409);
    let run = lease.run;
    try {
      const snapshot = await this.native.snapshot();
      const matches = snapshot.workspaces.filter((entry) => entry.label === `saurons-eye-run-${run.id}`);
      const workspace = run.workspace_id ? snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id) : matches.length === 1 ? matches[0] : undefined;
      const candidates = snapshot.panes.filter((entry) => entry.workspace_id === workspace?.workspace_id && entry.cwd === run.worktree);
      const pane = run.pane_id ? snapshot.panes.find((entry) => entry.pane_id === run.pane_id) : candidates.length === 1 ? candidates[0] : undefined;
      if (!pane || !workspace || workspace.label !== `saurons-eye-run-${run.id}` || !pane.cwd || realpathSync(pane.cwd) !== run.worktree) throw new FactoryError("native_identity_uncertain", "Native identity is unavailable or changed; exclusive ownership is retained", 409);
      run = { ...run, pane_id: pane.pane_id, workspace_id: workspace.workspace_id, condition: pane.agent !== run.provider ? "interrupted" : pane.agent_status === "blocked" ? "needs_you" : "working", waiting_reason: pane.agent !== run.provider ? "The workspace exists but native provider launch is unconfirmed; no retry was sent" : pane.agent_status === "blocked" ? "The native agent is waiting for an owner answer" : null };
    } catch (error) { run = { ...run, condition: "disconnected", waiting_reason: error instanceof FactoryError ? error.message : "The native Machine cannot be observed; ownership is retained" }; }
    const current = this.store.get<typeof lease>("host_leases", id);
    if (current && JSON.stringify(current) !== JSON.stringify(lease)) return current.run;
    run.updated_at = new Date().toISOString(); this.store.put("host_leases", { ...lease, run }); return run;
  }
  async stopRun(id: string): Promise<FactoryRun> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native control is disabled on a restored copy", 409);
    const lease = this.store.get<{ id: string; signature: string; run: FactoryRun }>("host_leases", id);
    if (!lease) throw new FactoryError("native_identity_uncertain", "This host has no owned lease to stop", 409);
    if (["cancelled", "completed", "failed"].includes(lease.run.condition)) return lease.run;
    const run = lease.run;
    this.store.put("host_leases", { ...lease, closing: true });
    const snapshot = await this.native.snapshot();
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id);
    const pane = snapshot.panes.find((entry) => entry.pane_id === run.pane_id);
    if (!workspace || workspace.label !== `saurons-eye-run-${id}` || !pane?.cwd || realpathSync(pane.cwd) !== run.worktree) throw new FactoryError("native_identity_uncertain", "Verify the recorded native identity before stopping it; ownership is retained", 409);
    await this.worktrees.stopWorkers(id);
    await this.native.closeWorkspace(workspace.workspace_id);
    await this.worktrees.stopChecks(id);
    const stopped: FactoryRun = { ...run, condition: "cancelled", waiting_reason: null, updated_at: new Date().toISOString() };
    this.store.put("host_leases", { ...lease, closing: true, run: stopped }); return stopped;
  }
  async send(id: string, text: string, signal: AbortSignal): Promise<void> {
    if (this.sends.has(id)) throw new FactoryError("delivery_busy", "Another selected batch is being delivered; retain this draft", 409);
    this.sends.add(id);
    try { await this.sendOwned(id, text, signal); } finally { this.sends.delete(id); }
  }
  private async sendOwned(id: string, text: string, signal: AbortSignal): Promise<void> {
    if (existsSync(join(this.store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Native input is disabled on a restored copy", 409);
    const lease = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", id);
    if (!lease || lease.closing || !["working", "needs_you"].includes(lease.run.condition)) throw new FactoryError("run_unavailable", "Reconcile the Run before submitting changes", 409);
    const run = lease.run; const snapshot = await this.native.snapshot();
    const pane = snapshot.panes.find((entry) => entry.pane_id === run.pane_id);
    const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === run.workspace_id);
    if (!pane?.cwd || realpathSync(pane.cwd) !== run.worktree || workspace?.label !== `saurons-eye-run-${id}` || pane.agent !== run.provider) throw new FactoryError("native_identity_changed", "The native Run identity changed; reconcile before sending", 409);
    if (!["idle", "done"].includes(pane.agent_status)) throw new FactoryError("agent_busy", "The native agent is working or waiting for a prompt answer; retain the draft and send explicitly when ready", 409);
    if (run.provider === "claude") {
      const before = (await paneRead({ paneId: run.pane_id!, source: "detection", format: "text" })).text;
      const scrollBefore = await paneScrollInfo(run.pane_id!);
      const shown = (await paneRead({ paneId: run.pane_id!, source: "visible", format: "ansi" })).text;
      const scrollAfter = await paneScrollInfo(run.pane_id!);
      const after = (await paneRead({ paneId: run.pane_id!, source: "detection", format: "text" })).text;
      if (before !== after || claudeInputDraft(after, viewportShowsLive(scrollBefore, scrollAfter, shown, before, after) ? shown : null)) throw new FactoryError("input_draft", "The native input box contains a draft; retain this batch and send explicitly after it is cleared", 409);
    }
    if (signal.aborted) throw new FactoryError("disconnected", "The submitting connection closed; this input was not sent", 409);
    await this.native.prompt(run.pane_id!, text, undefined, () => { const current = this.store.get<{ run: FactoryRun; closing?: boolean }>("host_leases", id); return !this.stopped && !signal.aborted && !current?.closing && ["working", "needs_you"].includes(current?.run.condition ?? ""); });
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
      return readFileSync(descriptor);
    } catch (error) { if (error instanceof FactoryError) throw error; throw new FactoryError("output_unavailable", "This Run's output is unavailable or changed during import", 409); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  outputs(id: string): FactoryOutput[] {
    const lease = this.store.get<{ run: FactoryRun }>("host_leases", id);
    if (!lease?.run.worktree) throw new FactoryError("invalid_run", "This Machine has no owned Run outputs", 409);
    const root = join(dirname(lease.run.worktree), "notes");
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > 200) throw new FactoryError("outputs_too_large", "Import at most 200 named research outputs per Run", 413);
    const types: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
    const result: FactoryOutput[] = [];
    for (const entry of entries) {
      const mediaType = types[extname(entry.name).toLowerCase()];
      if (!entry.isFile() || !mediaType || entry.name.startsWith(".")) continue;
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
