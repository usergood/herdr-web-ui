import { nativeSessionRef } from "../../shared/native-pane.ts";
import { AGENT_PERMISSION_MODES, permissionDescription } from "../../shared/agent-permissions.ts";
import { MATT_PROJECT_WORKFLOW } from "../../shared/project-setup.ts";
/** Fictional browser-owned records. No server or filesystem imports. */
import type { FactoryDetail, FactoryOverview, FactoryProject, FactoryRecord, Implementation, ProjectCheckout, ProjectReference } from "../../shared/factory.ts";
import { projectReferenceTemplate } from "../../shared/project-references.ts";
import { projectFactoryBoard } from "../../shared/factory-board.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AccountProfile, AccountService } from "../../shared/accounts.ts";
import type { ProjectGitHubOverview, ProjectGitHubPolicy } from "../../shared/github-project.ts";
import { fictionalGitHubPull } from "./github-fixtures.ts";
import type { ProjectSchedulesOverview } from "../../shared/project-schedules.ts";
import type { ProjectQueueOverview } from "../../shared/project-queue.ts";

const storageKey = "saurons-eye:demo-factory";
const details = new Map<string, FactoryDetail>();
let projects: FactoryProject[] = []; let checkouts: ProjectCheckout[] = [];
let settings: FactoryOverview["settings"] = { provider: "codex", max_implementations: 6, max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };
const blobs = new Map<string, string>();
let referenceVersions: ProjectReference[] = []; let referenceHeads: string[] = [];
let paneArchives: import("../../shared/factory.ts").FactoryPaneArchive[] = [];
const accountProfiles: AccountProfile[] = [];
const githubViews = new Map<string, ProjectGitHubOverview>();
const queuePolicies = new Map<string, { revision: string; max_implementations: number; paused: boolean }>();
function record(): FactoryRecord { const now = new Date().toISOString(); return { id: crypto.randomUUID(), created_at: now, updated_at: now }; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function failure(code: string, message: string, status = 409): Response { return json({ error: { code, message } }, status); }
function save(): void { try { localStorage.setItem(storageKey, JSON.stringify({ details: [...details], projects, checkouts, settings, blobs: [...blobs], referenceVersions, referenceHeads, paneArchives, queuePolicies: [...queuePolicies] })); } catch { /* demo storage can be blocked or full; records remain in this page */ } }
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) for (const [id, policy] of JSON.parse(raw).queuePolicies ?? []) queuePolicies.set(id, policy);
  if (raw) { const saved = JSON.parse(raw); if (Array.isArray(saved.details)) for (const [id, detail] of saved.details) details.set(id, { workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], ...detail }); referenceVersions = saved.referenceVersions ?? []; referenceHeads = saved.referenceHeads ?? []; paneArchives = saved.paneArchives ?? []; projects = saved.projects ?? []; checkouts = saved.checkouts ?? []; settings = saved.settings ?? settings; if (Array.isArray(saved.blobs)) for (const [id, content] of saved.blobs) blobs.set(id, content); }
} catch { /* fictional fixtures do not depend on persistent storage */ }
function capture(title: string, description: string): Implementation {
  const implementation: Implementation = { ...record(), title, description, project_id: null, provider: null, machine_id: null, stage: "inbox", position: details.size, outcome: "none" };
  const chat = { ...record(), implementation_id: implementation.id, title: "Notes" };
  details.set(implementation.id, { implementation, graph_hash: "demo-empty-graph", question_revision: "demo-empty-questions", chats: [chat], messages: description ? [{ ...record(), implementation_id: implementation.id, chat_id: chat.id, role: "owner", content: description, source_id: null, sequence: null }] : [], specifications: [], tickets: [], approvals: [], questions: [], artifacts: [], runs: [], snapshots: [], comments: [], workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], events: [{ ...record(), implementation_id: implementation.id, kind: "implementation_created", data: { title } }] });
  return implementation;
}
if (!details.size) capture("Explore release notes", "A fictional Inbox idea: keep release research and decisions in one place before selecting a Project.");

export async function factoryDemo(url: URL, method: string, body: Record<string, unknown>, machines: Machine[] = []): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/factory-host/publication") return failure("demo_unavailable", "Native PR publication is unavailable in the fictional demo");
  const publication = /^\/api\/factory\/runs\/([^/]+)\/publication(?:\/(publish|reconcile))?$/.exec(path);
  if (publication) {
    const detail = [...details.values()].find(d => d.runs.some(r => r.id === publication[1]));
    const run = detail?.runs.find(r => r.id === publication[1]);
    if (!run) return failure("not_found", "Run not found", 404);
    if (method === "GET" && !publication[2]) return json({ run_id: run.id, head: run.accepted_result?.head ?? null, repository: detail!.implementation.delivery_scope?.github_repository ?? null, branch: run.branch, target_branch: detail!.implementation.delivery_scope?.branch ?? null, eligible: false, publication: null, problem: "The fictional demo cannot publish a GitHub PR." } satisfies import("../../shared/factory-publication.ts").PublicationOverview);
    return failure("demo_unavailable", "PR publication requires a real Machine, current checks and independent reviews");
  }
  if (/^\/api\/factory\/implementations\/[^/]+\/delivery(?:\/sync)?$/.test(path)) {
    const id = path.split("/")[4]!;
    return method === "GET" ? json(details.get(id)?.implementation.delivery ?? null) : failure("demo_unavailable", "Verifying PR and release delivery requires a real repository and selected GitHub account", 409);
  }
  if (path === "/api/factory-host/delivery-read") return failure("demo_unavailable", "GitHub delivery evidence is unavailable in the fictional demo", 409);
  if (/^\/api\/factory\/implementations\/[^/]+\/retry$/.test(path)) return failure("demo_only", "Retry requires an observed failed attempt on a real connection server.");
  const queueRoute = /^\/api\/factory\/projects\/([^/]+)\/queue(?:\/(configure))?$/.exec(path);
  if (queueRoute) {
    const id = queueRoute[1]!;
    if (!projects.some(project => project.id === id)) return failure("not_found", "Fictional Project not found", 404);
    let policy = queuePolicies.get(id);
    const maximum = Math.min(settings.max_implementations, settings.max_agents, settings.max_builds);
    if (method === "POST" && queueRoute[2] === "configure") {
      if (body.expected_revision !== (policy?.revision ?? null)) return failure("queue_changed", "Refresh the fictional queue");
      if (!Number.isSafeInteger(body.max_implementations) || Number(body.max_implementations) < 1 || Number(body.max_implementations) > maximum && body.max_implementations !== (policy?.max_implementations ?? 1) || typeof body.paused !== "boolean") return failure("invalid_queue", "Select a Project limit within the global limits", 400);
      policy = { revision: crypto.randomUUID(), max_implementations: Number(body.max_implementations), paused: body.paused };
      queuePolicies.set(id, policy); save();
    } else if (method !== "GET" || queueRoute[2]) return failure("invalid_operation", "Select a fictional queue operation", 400);
    const view: ProjectQueueOverview = { project_id: id, revision: policy?.revision ?? null, max_implementations: policy?.max_implementations ?? 1, effective_limit: Math.min(policy?.max_implementations ?? 1, maximum), paused: policy?.paused ?? false, next_implementation_id: null, capacity: { project_implementations: 0, implementations: 0, agents: 0, builds: 0, max_implementations: settings.max_implementations, max_agents: settings.max_agents, max_builds: settings.max_builds }, items: [...details.values()].map(detail => detail.implementation).filter(idea => idea.project_id === id && !idea.archived_at && idea.stage !== "done").sort((a, b) => a.position - b.position).map(idea => ({ implementation_id: idea.id, title: idea.title, priority: idea.position, eligible: false, reasons: ["planning_required", ...(policy?.paused ? ["queue_paused"] : [])], failed_run_id: null, problem: null })) };
    return json(view);
  }
  if (/^\/api\/factory\/implementations\/[^/]+\/completion-evidence$/.test(path)) return json({ repository_changes: "unknown", quiescent: false, reason: "The fictional demo cannot verify repository changes or native ownership.", checked_at: new Date().toISOString() });
  if (/^\/api\/factory-agent\/[^/]+\/sync-answers$/.test(path)) return failure("demo_unavailable", "Native answer synchronization needs a real agent conversation");
  if (method === "POST" && (/^\/api\/factory\/implementations\/[^/]+\/continue$/.test(path) || /^\/api\/factory-host\/runs\/[^/]+\/finish$/.test(path))) return failure("demo_unavailable", "Workflow continuation needs a real execution Machine; the demo keeps fictional records only");
  if (path === "/api/factory/project-discovery" || path === "/api/factory-host/project-discovery") return json({ protocol: 1, path: String(body.path), name: String(body.path).split("/").filter(Boolean).at(-1) ?? "Demo Project", repository: "fictional-demo-repository", head: "0000000000000000000000000000000000000000", checks: [{ id: "script:test", name: "test", args: ["bun", "run", "test"] }], guidance: ["AGENTS.md"], providers: ["codex", "claude", "opencode"].map(provider=>({provider,installed:true,version:"0.162.1"})), permission_modes: AGENT_PERMISSION_MODES, github: { repository: "fictional/project", account_hint: null, directory_scoped: false }, warnings: [] });
  if (/\/accounts\/discovery$/.test(path)) return json({ protocol: 1, sources: [{ id: "fictional-source", service: "github", login: "fictional-work", active: true, available: true, existing_profile_id: accountProfiles.find(p=>p.expected_login==="fictional-work")?.id??null }], warnings: [] });
  if (/\/accounts\/import$/.test(path)) { const profile: AccountProfile={id:crypto.randomUUID(),revision:crypto.randomUUID(),name:"fictional-work",service:"github",expected_login:"fictional-work",expected_account_id:null,state:"ready",verified_identity:{login:"fictional-work",account_id:null,auth_method:"oauth"},public_key:null,fingerprint:null,problem:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};accountProfiles.push(profile);return json(profile,201); }
  if (/\/github\/settings$/.test(path)) return json({ repository: "fictional/project", default_branch: "main", reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], protected: false });
  const guidance = /^\/api\/factory\/projects\/([^/]+)\/guidance$/.exec(path);
  if (guidance) { const project=projects.find(p=>p.id===guidance[1]);if(!project)return failure("not_found","Project not found",404);if(project.guidance_assignment_id)return json(details.get(project.guidance_assignment_id)?.implementation);const idea=capture(`Set up ${project.name} guidance`,MATT_PROJECT_WORKFLOW);idea.project_id=project.id;project.guidance_assignment_id=idea.id;save();return json(idea,201); }
  if (path === "/api/factory-host/pane-state") return failure("demo_only", "Native state is unavailable in the fictional demo", 409);
  if (path === "/api/factory/pane-archives" && method === "POST") {
    const previous = paneArchives.find((a) => a.machine_id === body.machine_id && a.pane_id === body.pane_id);
    const pane = machines.find((m) => m.id === body.machine_id)?.snapshot?.panes.find((p) => p.pane_id === body.pane_id) as import("../../shared/protocol.ts").HerdrPane | undefined;
    if (body.archived && (!pane || !["idle", "done"].includes(pane.agent_status) || (pane.background_tasks ?? 0) > 0)) return failure("pane_busy", "Finish native work before archiving");
    if (body.archived && (pane?.terminal_id !== body.terminal_id || pane && nativeSessionRef(pane) !== body.session_ref)) return failure("pane_identity_changed", "Refresh the native chat");
    const next = { ...(previous ?? record()), ...(body.archived && pane ? { terminal_id: pane.terminal_id, session_ref: nativeSessionRef(pane), title: pane.label || pane.title || pane.pane_id } : {}), machine_id: String(body.machine_id), pane_id: String(body.pane_id), archived_at: body.archived ? new Date().toISOString() : null };
    paneArchives = [...paneArchives.filter((a) => a.id !== previous?.id), next]; save(); return json(next);
  }
  const schedulesRoute = /^\/api\/factory\/projects\/([^/]+)\/github\/schedules(?:\/(configure|run|reconcile))?$/.exec(path);
  if (schedulesRoute) {
    const id = schedulesRoute[1]!;
    if (!projects.some(project => project.id === id)) return failure("not_found", "Fictional Project not found", 404);
    if (method !== "GET" || schedulesRoute[2]) return failure("demo_only", "Scheduled synchronization needs a real connection server. The demo enables no recurring jobs.");
    const policy = githubViews.get(id)?.policy;
    const overview: ProjectSchedulesOverview = { schedules: [
      { job: "github_sync", enabled: false, cadence: "interval", interval_minutes: policy?.poll_minutes ?? 15, local_time: "03:00", time_zone: "America/Mexico_City", revision: null, next_execution: null, condition: "idle", failure_count: 0, retry_at: null },
      { job: "upstream_sync", enabled: false, cadence: "daily", interval_minutes: 1440, local_time: "03:00", time_zone: "America/Mexico_City", revision: null, next_execution: null, condition: "idle", failure_count: 0, retry_at: null },
    ], results: [], upstream: { repository: policy?.upstream_repository ?? null, detected: null, active: null, candidate: null } };
    return json(overview);
  }
  if (/^\/api\/factory\/projects\/[^/]+\/github\/issues\/\d+\/approve$/.test(path)) return failure("demo_only", "Issue readiness needs verified GitHub evidence on a real connection server.");
  const issueBatchesRoute = /^\/api\/factory\/implementations\/([^/]+)\/issue-batches(?:\/([^/]+)\/(review|publish|resume))?$/.exec(path);
  if (issueBatchesRoute) {
    const detail = details.get(issueBatchesRoute[1]!);
    if (!detail?.implementation.project_id) return failure("project_required", "Select a fictional Project for the plan");
    // Public reads have an answer on the demo; owner publication needs real scoped GitHub evidence.
    if (method === "GET" && !issueBatchesRoute[2]) return json({ batches: [] } satisfies import("../../shared/issue-batches.ts").IssueBatchesOverview);
    return failure("demo_only", "Issue batch proposals, review and publication need a real connection server. The demo publishes no GitHub issues.");
  }
  if (/^\/api\/factory-agent\/[^/]+\/issue-batch$/.test(path)) return failure("demo_only", "Planning proposals need a real app-owned Run. The demo grants no publication authority.");
  const githubRoute = /^\/api\/factory\/projects\/([^/]+)\/github(?:\/(configure|sync)|\/pulls\/(\d+)\/(merge|update|rerequest|import|files))?$/.exec(path);
  if (githubRoute) {
    const id = githubRoute[1]!; if (!projects.some((project) => project.id === id)) return failure("not_found", "Fictional Project not found", 404);
    const view = githubViews.get(id) ?? { policy: null, pulls: [], sources: [], mutations: [], last_sync: null, problem: null };
    if (method === "GET" && githubRoute[4] === "files") return json({ head: fictionalGitHubPull.headRefOid, base: fictionalGitHubPull.baseRefOid, files: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n # Fictional Project\n+An example improvement." }] });
    if (method === "GET") return json(view);
    if (githubRoute[2] === "configure") {
      if (body.expected_revision !== (view.policy?.revision ?? null)) return failure("github_policy_changed", "Refresh the fictional Project policy");
      view.policy = { ...record(), ...body, id, project_id: id, revision: crypto.randomUUID() } as ProjectGitHubPolicy; githubViews.set(id, view); return json(view.policy);
    }
    if (!view.policy) return failure("github_not_configured", "Configure the fictional GitHub policy");
    if (githubRoute[2] === "sync") { view.last_sync = new Date().toISOString(); view.pulls = [{ ...record(), project_id: id, pull: structuredClone(fictionalGitHubPull), blockers: ["Requested reviews are still pending"], observed_at: view.last_sync, fix_implementation_id: null }]; githubViews.set(id, view); return json(view); }
    return failure("github_fixture_only", "The demo never changes a real GitHub PR");
  }
  const accountCollection = /^\/api\/factory\/machines\/[^/]+\/accounts$/.test(path) || path === "/api/factory-host/accounts";
  if (accountCollection && method === "GET") return json({ protocol: 1, host_id: "fictional-demo-host", profiles: accountProfiles });
  if (accountCollection && method === "POST") {
    if (!["github", "codex", "claude", "cf", "wrangler"].includes(String(body.service))) return failure("invalid_account_profile", "Select a supported demo service", 400);
    const profile: AccountProfile = { ...record(), revision: crypto.randomUUID(), name: String(body.name), service: body.service as AccountService, expected_login: String(body.expected_login), expected_account_id: typeof body.expected_account_id === "string" ? body.expected_account_id : null, state: "needs_login", verified_identity: null, public_key: null, fingerprint: null, problem: "Fictional profile: native sign-in and keys require a real Machine." };
    accountProfiles.push(profile); return json(profile, 201);
  }
  const accountOperation = /^\/api\/factory(?:\/machines\/[^/]+|\-host)\/accounts\/([^/]+)\/(key|verify|setup|register-key|configure|disable|recover)(?:\/(status|input|cancel))?$/.exec(path);
  if (accountOperation) {
    const profile = accountProfiles.find((entry) => entry.id === accountOperation[1]);
    if (!profile) return failure("account_not_found", "Demo profile not found", 404);
    if (accountOperation[2] === "disable") { profile.state = "disabled"; profile.revision = crypto.randomUUID(); return json(profile); }
    if (accountOperation[2] === "configure") { profile.name = String(body.name ?? profile.name); profile.expected_login = String(body.expected_login ?? profile.expected_login); profile.revision = crypto.randomUUID(); return json(profile); }
    return failure("demo_only", "Native sign-in, verification and SSH keys require a real execution Machine.");
  }
  if (path === "/api/factory-host/accounts/snapshot" || /\/projects\/[^/]+\/accounts\/verify$/.test(path)) return json({ host_id: "fictional-demo-host", profiles: [] });
  if (path === "/api/factory/reference-template" && method === "GET") return json(projectReferenceTemplate);
  const referenceRoute = /^\/api\/factory\/projects\/([^/]+)\/references(?:\/([^/]+)(?:\/(source|preview|download|remove))?)?$/.exec(path);
  if (referenceRoute) {
    const projectId = referenceRoute[1]!; if (!projects.some((entry) => entry.id === projectId)) return failure("not_found", "Project not found", 404);
    const entries = referenceVersions.filter((entry) => entry.project_id === projectId && referenceHeads.includes(entry.id)).sort((a, b) => a.name.localeCompare(b.name));
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const revision = await digest(new TextEncoder().encode(JSON.stringify({ project_id: projectId, entries })));
    if (referenceRoute[2] === "prepare") return failure("unsupported", "Preparing Codex reference files requires a real execution Machine.");
    if (referenceRoute[3]) {
      const entry = referenceVersions.find((item) => item.id === referenceRoute[2] && item.project_id === projectId); if (!entry) return failure("not_found", "Project reference not found", 404);
      if (referenceRoute[3] === "remove" && method === "POST") { if (body.expected_revision !== revision) return failure("references_changed", "Refresh the Project references"); referenceHeads = referenceHeads.filter((id) => id !== entry.id); save(); return json({ ok: true }); }
      if (method === "GET" && referenceRoute[3] !== "remove") { const bytes = Uint8Array.from(atob(blobs.get(entry.id) ?? ""), (character) => character.charCodeAt(0)); return new Response(bytes, { headers: { "content-type": referenceRoute[3] === "source" ? "text/plain; charset=utf-8" : entry.media_type, "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(referenceRoute[3] === "download" ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}` } : {}) } }); }
    } else if (!referenceRoute[2]) {
      if (method === "GET") return json({ project_id: projectId, revision, entries });
      if (method === "POST") {
        if (body.expected_revision !== revision) return failure("references_changed", "Refresh the Project references");
        if (typeof body.name !== "string" || typeof body.title !== "string" || !body.title.trim() || typeof body.content_base64 !== "string" || !["always", "reference"].includes(String(body.read_policy))) return failure("invalid_reference", "Enter Project reference guidance", 400);
        const bytes = Uint8Array.from(atob(body.content_base64), (character) => character.charCodeAt(0)); const hash = await digest(bytes);
        const previous = referenceVersions.filter((entry) => entry.project_id === projectId && entry.name === body.name).at(-1);
        const entry: ProjectReference = { ...record(), project_id: projectId, reference_id: previous?.reference_id ?? crypto.randomUUID(), name: body.name, title: body.title, media_type: String(body.media_type), hash, size: bytes.length, version: (previous?.version ?? 0) + 1, usage_note: String(body.usage_note ?? ""), read_policy: body.read_policy as ProjectReference["read_policy"], caption: String(body.caption ?? "") };
        referenceVersions.push(entry); referenceHeads = referenceHeads.filter((id) => referenceVersions.find((item) => item.id === id)?.reference_id !== entry.reference_id); referenceHeads.push(entry.id); blobs.set(entry.id, body.content_base64); save(); return json(entry, 201);
      }
    }
    return failure("unsupported", "This reference action is unavailable in the demo.");
  }
  if (path === "/api/factory" && method === "GET") return json({ board: [...details.values()].map(d => projectFactoryBoard(d.implementation, d)), implementations: [...details.values()].map((detail) => detail.implementation).sort((a, b) => a.position - b.position), projects, checkouts, settings, activity: [], pane_links: [...details.values()].flatMap((d) => d.runs.flatMap((run) => [...(run.pane_id ? [{ project_id: d.implementation.project_id, implementation_id: d.implementation.id, run_id: run.id, worker_id: null, worktree: run.worktree, workspace_id: run.workspace_id, machine_id: run.machine_id, pane_id: run.pane_id, provider: run.provider, title: run.action, condition: run.condition }] : []), ...d.workers.filter((w) => w.run_id === run.id && w.pane_id).map((w) => ({ project_id: d.implementation.project_id, implementation_id: d.implementation.id, run_id: run.id, worker_id: w.id, worktree: w.worktree, workspace_id: w.workspace_id, machine_id: run.machine_id, pane_id: w.pane_id!, provider: run.provider, title: w.role, condition: w.condition }))])), pane_archives: paneArchives } satisfies FactoryOverview);
  if (path === "/api/factory/settings" && method === "POST") { settings = { ...settings, ...body } as typeof settings; save(); return json(settings); }
  if ((path === "/api/factory/model-catalog" || path === "/api/factory-host/model-catalog") && method === "POST") return json({ protocol: 1, provider: body.provider, models: [{ id: "fictional-demo-model", name: "Fictional demo model", reasoning: [{ id: "medium", name: "Medium" }, { id: "xhigh", name: "Extra high" }], default_reasoning: "medium" }], problem: null });
  if (path === "/api/factory/providers" || /\/machines\/[^/]+\/prepare$/.test(path)) return json({ factory_host_protocol: 1, skill_manifest: null, providers: ["codex", "claude", "opencode"].map((provider) => ({ provider, version: "demo", installed: false, skills_verified: false, factory_ready: false, reasons: ["Native agents and SSH preparation require a real execution Machine. The demo retains fictional records only."] })) });
  if (path === "/api/factory/implementations" && method === "POST") { if (typeof body.title !== "string" || !body.title.trim()) return failure("invalid_implementation", "Enter an idea title", 400); const project = projects.find((p) => p.id === body.project_id && !p.removed_at); if (body.project_id != null && !project) return failure("invalid_project", "Select a registered Project", 400); const idea = capture(body.title, typeof body.description === "string" ? body.description : ""); idea.project_id = project?.id ?? null; save(); return json(idea, 201); }
  if (path === "/api/factory/projects" && method === "POST") {
    const project: FactoryProject = { ...record(), name: String(body.name), repository: "fictional-demo-repository", provider: body.provider as FactoryProject["provider"], machine_id: String(body.machine_id ?? "local"), tracker: "app", tracker_reference: "demo", auto_publish_pr: false };
    if (body.guided_setup) { project.permission_mode = body.permission_mode as FactoryProject["permission_mode"]; project.permissions = permissionDescription(project.permission_mode ?? "ask"); project.checks = [["bun", "run", "test"]]; project.workflow_instructions = MATT_PROJECT_WORKFLOW; project.context_target_tokens = Number(body.context_target_tokens ?? 150000); if(body.guidance_task){const idea=capture(`Set up ${project.name} guidance`,MATT_PROJECT_WORKFLOW);idea.project_id=project.id;project.guidance_assignment_id=idea.id;} }
    projects.push(project); checkouts.push({ ...record(), project_id: project.id, machine_id: project.machine_id, path: String(body.path), repository: project.repository, head: "0000000000000000000000000000000000000000", branch: "demo", instructions: [] }); save(); return json(project, 201);
  }
  const projectRoute = /^\/api\/factory\/projects\/([^/]+)\/(configure|checkouts|retrospectives|remove|restore)$/.exec(path);
  if (projectRoute && method === "POST") {
    const project = projects.find((entry) => entry.id === projectRoute[1]); if (!project) return failure("not_found", "Project not found", 404);
    if (["remove", "restore"].includes(projectRoute[2]!)) { project.removed_at = projectRoute[2] === "remove" ? new Date().toISOString() : null; save(); return json(project); }
    if (projectRoute[2] === "configure") { Object.assign(project, body, { updated_at: new Date().toISOString() }); save(); return json(project); }
    if (projectRoute[2] === "checkouts") { const previous = checkouts.find((entry) => entry.project_id === project.id && entry.machine_id === body.machine_id); const next = { ...(previous ?? record()), project_id: project.id, machine_id: String(body.machine_id), path: String(body.path), repository: project.repository, head: "0000000000000000000000000000000000000000", branch: "demo", instructions: [] }; checkouts = checkouts.filter((entry) => entry.id !== previous?.id); checkouts.push(next); save(); return json(next, 201); }
    const selected = [...details.values()].filter((detail) => detail.implementation.project_id === project.id);
    const available = selected.flatMap((detail) => [...detail.messages, ...detail.artifacts, ...detail.runs, ...detail.checks, ...detail.events]);
    if (!Array.isArray(body.evidence_ids) || !body.evidence_ids.length || body.evidence_ids.some((id) => !available.some((entry) => entry.id === id))) return failure("invalid_evidence_scope", "Select evidence for this Project", 400);
    const retro = { ...record(), project_id: project.id, evidence_ids: body.evidence_ids as string[], scope_hash: crypto.randomUUID(), proposal: String(body.proposal ?? ""), approved: false, applied_run_id: null }; for (const detail of selected) detail.retrospectives.push(retro); save(); return json(retro, 201);
  }
  const retroApproval = /^\/api\/factory\/retrospectives\/([^/]+)\/approve$/.exec(path);
  if (retroApproval && method === "POST") { const retro = [...details.values()].flatMap((detail) => detail.retrospectives).find((entry) => entry.id === retroApproval[1]); if (!retro || body.scope_hash !== retro.scope_hash || !retro.proposal) return failure("retrospective_stale", "Approve the retained proposal"); retro.approved = true; save(); return json(retro); }
  const annotation = /^\/api\/factory\/artifacts\/([^/]+)\/(note|delete)$/.exec(path);
  if (annotation && method === "POST") { const detail = [...details.values()].find((entry) => entry.artifacts.some((artifact) => artifact.id === annotation[1])); const artifact = detail?.artifacts.find((entry) => entry.id === annotation[1]); if (!artifact) return failure("not_found", "Attachment not found", 404); if (annotation[2] === "note") { artifact.note = String(body.note); save(); return json(artifact); } if (body.hash !== artifact.hash) return failure("artifact_changed", "Delete the exact version"); detail!.artifacts = detail!.artifacts.filter((entry) => entry.id !== artifact.id); blobs.delete(artifact.id); save(); return json({ ok: true }); }
  const artifact = /^\/api\/factory\/artifacts\/([a-zA-Z0-9-]+)\/(source|preview|download)$/.exec(path);
  if (artifact && method === "GET") {
    const metadata = [...details.values()].flatMap((detail) => detail.artifacts).find((item) => item.id === artifact[1]);
    const encoded = metadata ? blobs.get(metadata.id) : null;
    if (!metadata || encoded === undefined || encoded === null) return failure("not_found", "Attachment not found", 404);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": artifact[2] === "source" ? "text/plain" : metadata.media_type, "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'", "x-content-type-options": "nosniff" } });
  }
  const archived = /^\/api\/factory\/implementations\/([^/]+)\/(archive|restore)$/.exec(path);
  if (archived && method === "POST") { const d = details.get(archived[1]!); if (!d) return failure("not_found", "Assignment not found", 404); if (archived[2] === "archive" && d.implementation.stage !== "done") return failure("assignment_unfinished", "Complete the Assignment before archiving"); d.implementation.archived_at = archived[2] === "archive" ? new Date().toISOString() : null; save(); return json(d.implementation); }
  const match = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
  if (match) {
    const detail = details.get(match[1]!); if (!detail) return failure("not_found", "Implementation not found", 404);
    const action = match[2];
    if (!action && method === "GET") return json({ ...detail, board: projectFactoryBoard(detail.implementation, detail) });
    if (method === "POST") {
      let result: unknown;
      if (action === "configure") { detail.implementation = { ...detail.implementation, ...body } as Implementation; result = detail.implementation; }
      else if (action === "discard") {
        if (detail.runs.some(run => !["completed", "cancelled", "failed"].includes(run.condition)) || detail.workers.some(worker => !["completed", "cancelled", "failed"].includes(worker.condition)) || detail.checks.some(check => ["working", "interrupted"].includes(check.condition))) return failure("demo_unavailable", "Confirming native stops requires a real Machine; the demo retains the owned work");
        detail.implementation = { ...detail.implementation, stage: "done", outcome: "discarded", discard_requested_at: detail.implementation.discard_requested_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }; result = detail.implementation;
      }
      else if (action === "messages") { const message = { ...record(), implementation_id: detail.implementation.id, chat_id: String(body.chat_id), role: body.role as "owner" | "agent" | "system", content: String(body.content), source_id: null, sequence: null }; detail.messages.push(message); result = message; }
      else if (action === "chats") { const chat = { ...record(), implementation_id: detail.implementation.id, title: String(body.title) }; detail.chats.push(chat); result = chat; }
      else if (action === "artifacts") {
        const bytes = Uint8Array.from(atob(String(body.content_base64)), (character) => character.charCodeAt(0));
        if (bytes.length > settings.max_artifact_bytes) return failure("artifact_too_large", "This attachment exceeds the size limit", 413);
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
        const item = { ...record(), implementation_id: detail.implementation.id, chat_id: String(body.chat_id), name: String(body.name), media_type: String(body.media_type), hash: digest, size: bytes.length, version: detail.artifacts.filter((entry) => entry.name === body.name).length + 1, origin: "demo upload", note: "" };
        detail.artifacts.push(item); blobs.set(item.id, String(body.content_base64)); result = item;
      }
      else if (action === "specifications") { const specification = { ...record(), implementation_id: detail.implementation.id, revision: detail.specifications.length + 1, content: String(body.content), hash: crypto.randomUUID(), ...(detail.implementation.upstream_update ? { upstream_update: detail.implementation.upstream_update } : {}) }; detail.specifications.push(specification); detail.tickets = []; detail.implementation.stage = "specifying"; result = specification; }
      else if (action === "tickets") {
        const spec = detail.specifications.at(-1); if (!spec || body.specification_id !== spec.id) return failure("stale_specification", "Select the latest specification", 409);
        const planned = Array.isArray(body.tickets) ? body.tickets as { key: string; title: string; acceptance: string; dependencies: string[] }[] : [];
        const ids = new Map(planned.map((ticket) => [ticket.key, crypto.randomUUID()]));
        const visiting = new Set<string>(); const visited = new Set<string>();
        const visit = (key: string): void => { if (visiting.has(key)) throw new Error(); if (visited.has(key)) return; const ticket = planned.find((entry) => entry.key === key); if (!ticket) throw new Error(); visiting.add(key); ticket.dependencies.forEach(visit); visiting.delete(key); visited.add(key); };
        try { planned.forEach((ticket) => visit(ticket.key)); } catch { return failure("cyclic_graph", "Ticket dependencies must form a complete acyclic graph", 400); }
        detail.tickets = planned.map((ticket) => ({ ...record(), id: ids.get(ticket.key)!, implementation_id: detail.implementation.id, specification_id: spec.id, title: ticket.title, acceptance: ticket.acceptance, dependencies: ticket.dependencies.map((key) => ids.get(key)!), status: "proposed", tracker_reference: null })); detail.graph_hash = crypto.randomUUID(); result = { hash: detail.graph_hash, tickets: detail.tickets };
      }
      else if (action === "approvals") { const kind = body.kind as FactoryDetail["approvals"][number]["kind"]; const revision = kind === "ticket_graph" ? detail.graph_hash : kind === "shared_understanding" ? detail.question_revision : detail.specifications.at(-1)?.id; if (body.revision !== revision || kind === "ticket_graph" && !detail.tickets.length) return failure("stale_approval", "Select the current revision"); const approval = { ...record(), implementation_id: detail.implementation.id, kind, revision: String(body.revision), scope: String(body.scope) }; detail.approvals.push(approval); if (kind === "ticket_graph") detail.implementation.stage = "ready"; result = approval; }
      else if (action === "questions") { const question = { ...record(), implementation_id: detail.implementation.id, run_id: null, question: String(body.question), answer: null, revision: crypto.randomUUID() }; detail.questions.push(question); detail.question_revision = crypto.randomUUID(); result = question; }
      else if (action === "order") { const ordered = [...details.values()].map((entry) => entry.implementation).sort((a, b) => a.position - b.position); const from = ordered.findIndex((entry) => entry.id === detail.implementation.id); const to = from + Number(body.direction); if (to >= 0 && to < ordered.length) [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!]; ordered.forEach((entry, position) => entry.position = position); result = { ok: true }; }
      else return failure("demo_unavailable", "Native execution, repository review and external publication require a real Machine");
      detail.events.push({ ...record(), implementation_id: detail.implementation.id, kind: `${action}_saved`, data: result }); save(); return json(result, action === "configure" || action === "order" ? 200 : 201);
    }
  }
  const answer = /^\/api\/factory\/implementations\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(path);
  if (/^\/api\/factory\/implementations\/[^/]+\/complete-work$/.test(path)) return failure("demo_unavailable", "Completing a native work session requires a real Machine; the demo cannot certify work");
  if (answer && method === "POST") { const detail = details.get(answer[1]!); const question = detail?.questions.find((entry) => entry.id === answer[2]); if (!question || question.revision !== body.revision || question.answer !== null) return failure("stale_question", "This asking is no longer active"); question.answer = String(body.answer); detail!.question_revision = crypto.randomUUID(); save(); return json(question); }
  if (path.startsWith("/api/factory") || path.startsWith("/api/factory-host")) return failure("demo_unavailable", "This operation needs a real Machine; the browser demo keeps fictional records only");
  return failure("not_found", "Unknown demo factory endpoint", 404);
}
