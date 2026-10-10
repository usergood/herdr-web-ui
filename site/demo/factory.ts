/** Fictional browser-owned records. No server or filesystem imports. */
import type { FactoryDetail, FactoryOverview, FactoryProject, FactoryRecord, Implementation, ProjectCheckout } from "../../shared/factory.ts";

const storageKey = "saurons-eye:demo-factory";
const details = new Map<string, FactoryDetail>();
let projects: FactoryProject[] = []; let checkouts: ProjectCheckout[] = [];
let settings: FactoryOverview["settings"] = { provider: "codex", max_implementations: 2, max_agents: 6, max_builds: 2, max_artifact_bytes: 25 * 1024 * 1024, max_storage_bytes: 2 * 1024 * 1024 * 1024, skills_path: null };
const blobs = new Map<string, string>();
function record(): FactoryRecord { const now = new Date().toISOString(); return { id: crypto.randomUUID(), created_at: now, updated_at: now }; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function failure(code: string, message: string, status = 409): Response { return json({ error: { code, message } }, status); }
function save(): void { try { localStorage.setItem(storageKey, JSON.stringify({ details: [...details], projects, checkouts, settings, blobs: [...blobs] })); } catch { /* demo storage can be blocked or full; records remain in this page */ } }
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) { const saved = JSON.parse(raw); if (Array.isArray(saved.details)) for (const [id, detail] of saved.details) details.set(id, { workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], ...detail }); projects = saved.projects ?? []; checkouts = saved.checkouts ?? []; settings = saved.settings ?? settings; if (Array.isArray(saved.blobs)) for (const [id, content] of saved.blobs) blobs.set(id, content); }
} catch { /* fictional fixtures do not depend on persistent storage */ }
function capture(title: string, description: string): Implementation {
  const implementation: Implementation = { ...record(), title, description, project_id: null, provider: null, machine_id: null, stage: "inbox", position: details.size, outcome: "none" };
  const chat = { ...record(), implementation_id: implementation.id, title: "Notes" };
  details.set(implementation.id, { implementation, graph_hash: "demo-empty-graph", question_revision: "demo-empty-questions", chats: [chat], messages: description ? [{ ...record(), implementation_id: implementation.id, chat_id: chat.id, role: "owner", content: description, source_id: null, sequence: null }] : [], specifications: [], tickets: [], approvals: [], questions: [], artifacts: [], runs: [], snapshots: [], comments: [], workers: [], checks: [], review_evidence: [], frontier: [], retrospectives: [], native_snapshots: [], events: [{ ...record(), implementation_id: implementation.id, kind: "implementation_created", data: { title } }] });
  return implementation;
}
if (!details.size) capture("Explore release notes", "A fictional Inbox idea: keep release research and decisions in one place before selecting a Project.");

export async function factoryDemo(url: URL, method: string, body: Record<string, unknown>): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/factory" && method === "GET") return json({ implementations: [...details.values()].map((detail) => detail.implementation).sort((a, b) => a.position - b.position), projects, checkouts, settings, activity: [] } satisfies FactoryOverview);
  if (path === "/api/factory/settings" && method === "POST") { settings = { ...settings, ...body } as typeof settings; save(); return json(settings); }
  if (path === "/api/factory/providers" || /\/machines\/[^/]+\/prepare$/.test(path)) return json({ factory_host_protocol: 1, skill_manifest: null, providers: ["codex", "claude", "opencode"].map((provider) => ({ provider, version: "demo", installed: false, skills_verified: false, factory_ready: false, reasons: ["Native agents and SSH preparation require a real execution Machine. The demo retains fictional records only."] })) });
  if (path === "/api/factory/implementations" && method === "POST") { if (typeof body.title !== "string" || !body.title.trim()) return failure("invalid_implementation", "Enter an idea title", 400); const idea = capture(body.title, typeof body.description === "string" ? body.description : ""); save(); return json(idea, 201); }
  if (path === "/api/factory/projects" && method === "POST") {
    const project: FactoryProject = { ...record(), name: String(body.name), repository: "fictional-demo-repository", provider: body.provider as FactoryProject["provider"], machine_id: String(body.machine_id ?? "local"), tracker: "app", tracker_reference: "demo" };
    projects.push(project); checkouts.push({ ...record(), project_id: project.id, machine_id: project.machine_id, path: String(body.path), repository: project.repository, head: "0000000000000000000000000000000000000000", branch: "demo", instructions: [] }); save(); return json(project, 201);
  }
  const projectRoute = /^\/api\/factory\/projects\/([^/]+)\/(configure|checkouts|retrospectives)$/.exec(path);
  if (projectRoute && method === "POST") {
    const project = projects.find((entry) => entry.id === projectRoute[1]); if (!project) return failure("not_found", "Project not found", 404);
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
  const match = /^\/api\/factory\/implementations\/([a-zA-Z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
  if (match) {
    const detail = details.get(match[1]!); if (!detail) return failure("not_found", "Implementation not found", 404);
    const action = match[2];
    if (!action && method === "GET") return json(detail);
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
      else if (action === "approvals") { const kind = body.kind as FactoryDetail["approvals"][number]["kind"]; const revision = kind === "ticket_graph" ? detail.graph_hash : kind === "shared_understanding" ? detail.question_revision : detail.specifications.at(-1)?.id; if (body.revision !== revision || kind === "ticket_graph" && !detail.tickets.length) return failure("stale_approval", "Select the current revision"); const approval = { ...record(), implementation_id: detail.implementation.id, kind, revision: String(body.revision), scope: String(body.scope) }; detail.approvals.push(approval); if (kind === "ticket_graph") detail.implementation.stage = "ready"; result = approval; }
      else if (action === "questions") { const question = { ...record(), implementation_id: detail.implementation.id, run_id: null, question: String(body.question), answer: null, revision: crypto.randomUUID() }; detail.questions.push(question); detail.question_revision = crypto.randomUUID(); result = question; }
      else if (action === "order") { const ordered = [...details.values()].map((entry) => entry.implementation).sort((a, b) => a.position - b.position); const from = ordered.findIndex((entry) => entry.id === detail.implementation.id); const to = from + Number(body.direction); if (to >= 0 && to < ordered.length) [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!]; ordered.forEach((entry, position) => entry.position = position); result = { ok: true }; }
      else return failure("demo_unavailable", "Native execution, repository review and external publication require a real Machine");
      detail.events.push({ ...record(), implementation_id: detail.implementation.id, kind: `${action}_saved`, data: result }); save(); return json(result, action === "configure" || action === "order" ? 200 : 201);
    }
  }
  const answer = /^\/api\/factory\/implementations\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(path);
  if (answer && method === "POST") { const detail = details.get(answer[1]!); const question = detail?.questions.find((entry) => entry.id === answer[2]); if (!question || question.revision !== body.revision || question.answer !== null) return failure("stale_question", "This asking is no longer active"); question.answer = String(body.answer); detail!.question_revision = crypto.randomUUID(); save(); return json(question); }
  if (path.startsWith("/api/factory") || path.startsWith("/api/factory-host")) return failure("demo_unavailable", "This operation needs a real Machine; the browser demo keeps fictional records only");
  return failure("not_found", "Unknown demo factory endpoint", 404);
}
