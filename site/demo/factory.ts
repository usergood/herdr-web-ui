import { nativeSessionRef } from "../../shared/native-pane.ts";
import { AGENT_PERMISSION_MODES, permissionDescription } from "../../shared/agent-permissions.ts";
import { MATT_PROJECT_WORKFLOW } from "../../shared/project-setup.ts";
/** Fictional browser-owned records. No server or filesystem imports. */
import type { FactoryDetail, FactoryOverview, FactoryProject, FactoryRecord, Implementation, ProjectCheckout, ProjectReference } from "../../shared/factory.ts";
import { projectReferenceTemplate } from "../../shared/project-references.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AccountProfile, AccountService } from "../../shared/accounts.ts";
import type { IssueQueue, ProjectQueuePolicy } from "../../shared/issue-queue.ts";
import type { ProjectGitHubIssueRevision, ProjectGitHubOverview, ProjectGitHubPolicy } from "../../shared/github-project.ts";
import { issueReadiness, TRIAGE_ROLES, type ProjectReadinessPolicy, type TriageLabels } from "../../shared/github-readiness.ts";
import { fictionalGitHubPull } from "./github-fixtures.ts";

const storageKey = "saurons-eye:demo-factory";
const details = new Map<string, FactoryDetail>();
let projects: FactoryProject[] = []; let checkouts: ProjectCheckout[] = [];
let settings: FactoryOverview["settings"] = { provider: "codex", max_implementations: 6, max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };
const blobs = new Map<string, string>();
let referenceVersions: ProjectReference[] = []; let referenceHeads: string[] = [];
let paneArchives: import("../../shared/factory.ts").FactoryPaneArchive[] = [];
const accountProfiles: AccountProfile[] = [];
const queuePolicies = new Map<string, ProjectQueuePolicy>();
const queuePreviews = new Map<string, NonNullable<IssueQueue["preview"]>>();
const githubViews = new Map<string, ProjectGitHubOverview>();
function readinessView(view: ProjectGitHubOverview): ProjectGitHubOverview {
  return { ...view, readiness_policy: view.readiness_policy ?? null, sources: view.sources.map(source => source.kind === "issue" ? { ...source, readiness: issueReadiness(view.readiness_policy ?? null, source) } : source) };
}
function record(): FactoryRecord { const now = new Date().toISOString(); return { id: crypto.randomUUID(), created_at: now, updated_at: now }; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function failure(code: string, message: string, status = 409): Response { return json({ error: { code, message } }, status); }
function save(): void { try { localStorage.setItem(storageKey, JSON.stringify({ details: [...details], queuePolicies: [...queuePolicies], queuePreviews: [...queuePreviews], githubViews: [...githubViews], projects, checkouts, settings, blobs: [...blobs], referenceVersions, referenceHeads, paneArchives })); } catch { /* demo storage can be blocked or full; records remain in this page */ } }
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) { const saved = JSON.parse(raw); if (Array.isArray(saved.queuePolicies)) for (const [id, policy] of saved.queuePolicies) queuePolicies.set(id, policy); if (Array.isArray(saved.queuePreviews)) for (const [id, preview] of saved.queuePreviews) queuePreviews.set(id, preview); if (Array.isArray(saved.githubViews)) for (const [id, view] of saved.githubViews) githubViews.set(id, view); if (Array.isArray(saved.details)) for (const [id, detail] of saved.details) details.set(id, { workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], ...detail }); referenceVersions = saved.referenceVersions ?? []; referenceHeads = saved.referenceHeads ?? []; paneArchives = saved.paneArchives ?? []; projects = saved.projects ?? []; checkouts = saved.checkouts ?? []; settings = saved.settings ?? settings; if (Array.isArray(saved.blobs)) for (const [id, content] of saved.blobs) blobs.set(id, content); }
} catch { /* fictional fixtures do not depend on persistent storage */ }
function capture(title: string, description: string): Implementation {
  const implementation: Implementation = { ...record(), title, description, project_id: null, provider: null, machine_id: null, stage: "inbox", position: details.size, outcome: "none" };
  const chat = { ...record(), implementation_id: implementation.id, title: "Notes" };
  details.set(implementation.id, { implementation, graph_hash: "demo-empty-graph", question_revision: "demo-empty-questions", chats: [chat], messages: description ? [{ ...record(), implementation_id: implementation.id, chat_id: chat.id, role: "owner", content: description, source_id: null, sequence: null }] : [], specifications: [], tickets: [], approvals: [], questions: [], artifacts: [], runs: [], snapshots: [], comments: [], workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], events: [{ ...record(), implementation_id: implementation.id, kind: "implementation_created", data: { title } }] });
  return implementation;
}
if (!details.size) capture("Explore release notes", "A fictional Inbox idea: keep release research and decisions in one place before selecting a Project.");

export async function factoryDemo(url: URL, method: string, body: Record<string, unknown>, machines: Machine[] = []): Promise<Response> {
  if (method === "POST" && /^\/api\/factory\/runs\/[^/]+\/(accept|reconcile)$/.test(url.pathname)) return failure("demo_unavailable", "Implementation completion requires checked native execution and independent reviews; the demo cannot provide that evidence");
  const path = url.pathname;
  if (method === "POST" && /^\/api\/factory\/implementations\/[^/]+\/runs$/.test(path)) return failure("demo_unavailable", "Guarded issue admission needs a real execution Machine; the demo keeps fictional records only");
  if (method === "POST" && /^\/api\/factory\/runs\/[^/]+\/retry$/.test(path)) return failure("demo_unavailable", "Retry and retired-work recovery need a real execution Machine; the demo retains fictional attempts only");
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
  const githubRoute = /^\/api\/factory\/projects\/([^/]+)\/github(?:\/(configure|sync|readiness|queue|preview)|\/pulls\/(\d+)\/(merge|update|rerequest|import|files)|\/issues\/(\d+)\/(approve|prepare|delivery))?$/.exec(path);
  if (githubRoute) {
    const id = githubRoute[1]!; if (!projects.some((project) => project.id === id)) return failure("not_found", "Fictional Project not found", 404);
    const view: ProjectGitHubOverview = githubViews.get(id) ?? { policy: null, pulls: [], sources: [], mutations: [], last_sync: null, problem: null };
    if (githubRoute[2] === "queue" || githubRoute[2] === "preview") {
      const policy = queuePolicies.get(id) ?? { project_id: id, revision: null, automatic_implementation: false, paused: false, max_implementations: 1 };
      // Demo planning/verification operations are deliberately unavailable: never invent eligibility.
      const entries: IssueQueue["entries"] = readinessView(view).sources.filter(source => source.kind === "issue").map(source => ({ source_id: source.id, implementation_id: source.implementation_id, number: source.number, title: source.current?.title ?? "", position: details.get(source.implementation_id)?.implementation.position ?? 0, eligible: false, lane: "inbox" as const, reasons: [...(source.readiness?.blockers ?? []).map(code => ({ code: "readiness_" + code, detail: "" })), { code: "planning_required", detail: "" }, { code: "dependencies_stale", detail: "" }] })).sort((a,b) => a.position-b.position);
      async function queueRevision(policy: ProjectQueuePolicy): Promise<string> {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([policy, settings.max_implementations, view, entries])));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
      }
      if (method === "POST" && githubRoute[2] === "queue") {
        if (body.expected_revision !== policy.revision) return failure("queue_policy_changed", "Refresh the fictional queue settings");
        if (body.automatic_implementation === true) {
          const preview = queuePreviews.get(id);
          const revision = await queueRevision(policy);
          if (!preview || preview.revision !== revision || body.preview_revision !== revision) return failure("queue_preview_required", "Review the current eligible backlog before enabling automatic implementation");
          return failure("demo_unavailable", "Automatic execution requires an owned Machine; the demo keeps fictional records only");
        }
        if (body.automatic_implementation !== false || typeof body.paused !== "boolean" || !Number.isInteger(body.max_implementations) || Number(body.max_implementations) < 1 || Number(body.max_implementations) > settings.max_implementations) return failure("invalid_queue_policy", "Select pause and a limit within global capacity", 400);
        queuePolicies.set(id, { ...policy, revision: crypto.randomUUID(), automatic_implementation: false, paused: body.paused, max_implementations: Number(body.max_implementations) }); save();
      }
      const currentPolicy = queuePolicies.get(id) ?? policy;
      const revision = await queueRevision(currentPolicy);
      if (method === "POST" && githubRoute[2] === "preview") { queuePreviews.set(id, { revision, created_at: new Date().toISOString(), eligible_count: 0 }); save(); }
      const preview = queuePreviews.get(id) ?? null;
      return json({ policy: currentPolicy, dispatch_problem: null, global_limit: settings.max_implementations, effective_limit: Math.min(currentPolicy.max_implementations, settings.max_implementations), implementing_count: 0, available_slots: Math.min(currentPolicy.max_implementations, settings.max_implementations), revision, eligible_count: 0, entries, preview, preview_current: preview?.revision === revision } satisfies IssueQueue);
    }
    if (method === "GET" && githubRoute[4] === "files") return json({ head: fictionalGitHubPull.headRefOid, base: fictionalGitHubPull.baseRefOid, files: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n # Fictional Project\n+An example improvement." }] });
    if (method === "GET") return json(readinessView(view));
    if (githubRoute[2] === "configure") {
      if (body.expected_revision !== (view.policy?.revision ?? null)) return failure("github_policy_changed", "Refresh the fictional Project policy");
      view.policy = { ...record(), ...body, id, project_id: id, revision: crypto.randomUUID() } as ProjectGitHubPolicy; githubViews.set(id, view); save(); return json(view.policy);
    }
    if (!view.policy) return failure("github_not_configured", "Configure the fictional GitHub policy");
    if (githubRoute[2] === "readiness") {
      if (body.expected_revision !== (view.readiness_policy?.revision ?? null)) return failure("readiness_policy_changed", "Refresh the fictional readiness settings");
      const account = accountProfiles.find(profile => profile.id === body.account_profile_id && profile.service === "github" && profile.state === "ready" && profile.verified_identity);
      if (!account) return failure("account_scope_required", "Select a verified fictional readiness account");
      const overrides = body.triage_labels as Partial<TriageLabels> | undefined;
      if (!overrides || Object.keys(overrides).some(role => !TRIAGE_ROLES.includes(role as typeof TRIAGE_ROLES[number]))) return failure("invalid_readiness_policy", "Select fictional triage labels");
      const labels = Object.fromEntries(TRIAGE_ROLES.map(role => [role, overrides[role] ?? role])) as TriageLabels;
      if ([...Object.values(labels), body.blocked_label].some(label => typeof label !== "string" || !label.trim() || label.length > 100)) return failure("invalid_readiness_policy", "Enter bounded fictional labels");
      view.readiness_policy = { ...record(), id, project_id: id, revision: crypto.randomUUID(), repository: view.policy.repository, project_scope: view.policy.project_scope, account_profile_id: account.id, owner: account.verified_identity!, triage_labels: labels, blocked_label: String(body.blocked_label) } satisfies ProjectReadinessPolicy;
      githubViews.set(id, view); save(); return json(view.readiness_policy);
    }
    if (githubRoute[5] && githubRoute[6] === "prepare") return failure("demo_unavailable", "Issue plan preparation needs retained trusted planning; the demo keeps fictional records only", 409);
    if (githubRoute[5] && githubRoute[6] === "delivery") return failure("demo_unavailable", "Delivery verification requires owned repository evidence; the demo keeps fictional records only", 409);
    if (githubRoute[5]) {
      const source = view.sources.find(source => source.kind === "issue" && source.number === Number(githubRoute[5]));
      const policy = view.readiness_policy;
      if (!source || !policy || body.source_revision !== source.revision || body.policy_revision !== policy.revision) return failure("readiness_changed", "Refresh the fictional issue revision");
      if (issueReadiness(policy, source).blockers.some(reason => !["evidence_missing", "untrusted", "stale"].includes(reason))) return failure("readiness_blocked", "Resolve fictional readiness blockers");
      source.readiness_approvals = [...source.readiness_approvals ?? [], { id: crypto.randomUUID(), evidence_revision: source.readiness_evidence!.revision, source_revision: source.revision, policy_revision: policy.revision, approved_at: new Date().toISOString(), actor: policy.owner, provenance: "app_owner", event_id: null }];
      save(); return json(readinessView(view));
    }
    if (githubRoute[2] === "sync") {
      if (view.policy.import_issues) {
        const prior = view.sources.find(source => source.kind === "issue");
        const revision: ProjectGitHubIssueRevision = { title: "Fictional issue acceptance", body: "Keep the owner's notes while showing the current issue source.", labels: ["needs-plan"], state: "open", source_updated_at: "2026-10-01T12:00:00Z", repository: view.policy.repository, url: `https://github.com/${view.policy.repository}/issues/12`, native_dependencies: [], revision: "fictional-issue-revision-1", fetched_at: new Date().toISOString(), account_profile_id: view.policy.account_profile_id, policy_revision: view.policy.revision };
        if (prior) prior.current = revision;
        else {
          const idea = capture(revision.title, revision.body); idea.project_id = id;
          view.sources.push({ ...record(), project_id: id, external_id: "fictional-issue-12", number: 12, kind: "issue", implementation_id: idea.id, revision: revision.revision, url: revision.url, state: revision.state, current: revision, history: [revision] });
        }
        const source = view.sources.find(source => source.kind === "issue")!;
        source.dependencies = { revision: "fictional-native-dependencies-1", source_revision: source.revision, fetched_at: revision.fetched_at, account_profile_id: view.policy.account_profile_id, policy_revision: view.policy.revision, complete: true, fresh: true, satisfied: true, target_branch: "main", conflicts: [], edges: [] };
      }
      for (const source of view.sources) if (source.kind === "issue" && view.readiness_policy) source.readiness_evidence = { revision: source.revision + ":" + view.readiness_policy.revision, source_revision: source.revision, policy_revision: view.readiness_policy.revision, complete: true, problem: null, label_event: null };
      view.last_sync = new Date().toISOString(); view.pulls = [{ ...record(), project_id: id, pull: structuredClone(fictionalGitHubPull), blockers: ["Requested reviews are still pending"], observed_at: view.last_sync, fix_implementation_id: null }]; githubViews.set(id, view); save(); return json(readinessView(view)); }
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
  if (path === "/api/factory" && method === "GET") return json({ implementations: [...details.values()].map((detail) => detail.implementation).sort((a, b) => a.position - b.position), projects, checkouts, settings, activity: [], pane_links: [...details.values()].flatMap((d) => d.runs.flatMap((run) => [...(run.pane_id ? [{ project_id: d.implementation.project_id, implementation_id: d.implementation.id, run_id: run.id, worker_id: null, worktree: run.worktree, workspace_id: run.workspace_id, machine_id: run.machine_id, pane_id: run.pane_id, provider: run.provider, title: run.action, condition: run.condition }] : []), ...d.workers.filter((w) => w.run_id === run.id && w.pane_id).map((w) => ({ project_id: d.implementation.project_id, implementation_id: d.implementation.id, run_id: run.id, worker_id: w.id, worktree: w.worktree, workspace_id: w.workspace_id, machine_id: run.machine_id, pane_id: w.pane_id!, provider: run.provider, title: w.role, condition: w.condition }))])), pane_archives: paneArchives } satisfies FactoryOverview);
  if (path === "/api/factory/settings" && method === "POST") { settings = { ...settings, ...body } as typeof settings; save(); return json(settings); }
  if ((path === "/api/factory/model-catalog" || path === "/api/factory-host/model-catalog") && method === "POST") return json({ protocol: 1, provider: body.provider, models: [{ id: "fictional-demo-model", name: "Fictional demo model", reasoning: [{ id: "medium", name: "Medium" }, { id: "xhigh", name: "Extra high" }], default_reasoning: "medium" }], problem: null });
  if (path === "/api/factory/providers" || /\/machines\/[^/]+\/prepare$/.test(path)) return json({ factory_host_protocol: 1, implementation_rework_protocol: 1, skill_manifest: null, providers: ["codex", "claude", "opencode"].map((provider) => ({ provider, version: "demo", installed: false, skills_verified: false, factory_ready: false, reasons: ["Native agents and SSH preparation require a real execution Machine. The demo retains fictional records only."] })) });
  if (path === "/api/factory/implementations" && method === "POST") { if (typeof body.title !== "string" || !body.title.trim()) return failure("invalid_implementation", "Enter an idea title", 400); const project = projects.find((p) => p.id === body.project_id && !p.removed_at); if (body.project_id != null && !project) return failure("invalid_project", "Select a registered Project", 400); const idea = capture(body.title, typeof body.description === "string" ? body.description : ""); idea.project_id = project?.id ?? null; save(); return json(idea, 201); }
  if (path === "/api/factory/projects" && method === "POST") {
    const project: FactoryProject = { ...record(), name: String(body.name), repository: "fictional-demo-repository", provider: body.provider as FactoryProject["provider"], machine_id: String(body.machine_id ?? "local"), tracker: "app", tracker_reference: "demo" };
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
    if (!action && method === "GET") {
      const sources = [...githubViews.values()].flatMap(view => readinessView(view).sources).filter(source => source.implementation_id === detail.implementation.id);
      const sync = sources[0] ? githubViews.get(sources[0].project_id) : null;
      return json({ ...detail, github_sources: sources, github_sync: sync ? { last_sync: sync.last_sync, problem: sync.problem } : null });
    }
    if (method === "POST") {
      let result: unknown;
      if (action === "configure") { detail.implementation = { ...detail.implementation, ...body } as Implementation; result = detail.implementation; }
      else if (action === "messages") { const message = { ...record(), implementation_id: detail.implementation.id, chat_id: String(body.chat_id), role: body.role as "owner" | "agent" | "system", content: String(body.content), source_id: null, sequence: null }; detail.messages.push(message); result = message; }
      else if (action === "chats") { const chat = { ...record(), implementation_id: detail.implementation.id, title: String(body.title) }; detail.chats.push(chat); result = chat; }
      else if (action === "artifacts") {
        const bytes = Uint8Array.from(atob(String(body.content_base64)), (character) => character.charCodeAt(0));
        if (bytes.length > settings.max_artifact_bytes) return failure("artifact_too_large", "This attachment exceeds the size limit", 413);
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
        const item = { ...record(), implementation_id: detail.implementation.id, chat_id: String(body.chat_id), name: String(body.name), media_type: String(body.media_type), hash: digest, size: bytes.length, version: detail.artifacts.filter((entry) => entry.name === body.name).length + 1, origin: "demo upload", note: "" };
        detail.artifacts.push(item); blobs.set(item.id, String(body.content_base64)); result = item;
      }
      else if (action === "specifications") { const specification = { ...record(), implementation_id: detail.implementation.id, revision: detail.specifications.length + 1, content: String(body.content), hash: crypto.randomUUID() }; detail.specifications.push(specification); detail.tickets = []; detail.implementation.stage = "specifying"; result = specification; }
      else if (action === "tickets") {
        const spec = detail.specifications.at(-1); if (!spec || body.specification_id !== spec.id) return failure("stale_specification", "Select the latest specification", 409);
        const planned = Array.isArray(body.tickets) ? body.tickets as { key: string; title: string; acceptance: string; dependencies: string[] }[] : [];
        const ids = new Map(planned.map((ticket) => [ticket.key, crypto.randomUUID()]));
        const visiting = new Set<string>(); const visited = new Set<string>();
        const visit = (key: string): void => { if (visiting.has(key)) throw new Error(); if (visited.has(key)) return; const ticket = planned.find((entry) => entry.key === key); if (!ticket) throw new Error(); visiting.add(key); ticket.dependencies.forEach(visit); visiting.delete(key); visited.add(key); };
        try { planned.forEach((ticket) => visit(ticket.key)); } catch { return failure("cyclic_graph", "Ticket dependencies must form a complete acyclic graph", 400); }
        detail.tickets = planned.map((ticket) => ({ ...record(), id: ids.get(ticket.key)!, implementation_id: detail.implementation.id, specification_id: spec.id, title: ticket.title, acceptance: ticket.acceptance, dependencies: ticket.dependencies.map((key) => ids.get(key)!), status: "proposed", tracker_reference: null })); detail.graph_hash = crypto.randomUUID(); result = { hash: detail.graph_hash, tickets: detail.tickets };
      }
      else if (action === "approvals") {
        const kind = body.kind as FactoryDetail["approvals"][number]["kind"];
        const revision = kind === "ticket_graph" ? detail.graph_hash : kind === "shared_understanding" ? detail.question_revision : detail.specifications.at(-1)?.id;
        if (body.revision !== revision || kind === "ticket_graph" && !detail.tickets.length) return failure("stale_approval", "Select the current revision");
        const source = [...githubViews.values()].flatMap(view => view.sources).find(source => source.kind === "issue" && source.implementation_id === detail.implementation.id && source.current);
        const selected = body.issue_scope as { source_id?: unknown; source_revision?: unknown } | null | undefined;
        if (selected !== undefined && (!source || selected?.source_id !== source.id || selected.source_revision !== source.revision)) return failure("issue_changed", "Review the current issue scope before approving retained planning");
        const current = source?.current;
        const issueScope = source && selected !== undefined && ["specification", "testing_seams", "ticket_graph"].includes(kind) ? { source_id: source.id, source_revision: source.revision, scope_hash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source.id, current?.repository, current?.title, current?.body, current?.native_dependencies]))))].map(byte => byte.toString(16).padStart(2, "0")).join("") } : undefined;
        const approval = { ...record(), implementation_id: detail.implementation.id, kind, revision: String(body.revision), scope: String(body.scope), ...(issueScope ? { issue_scope: issueScope } : {}) };
        detail.approvals.push(approval); if (kind === "ticket_graph") detail.implementation.stage = "ready"; result = approval;
      }
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
