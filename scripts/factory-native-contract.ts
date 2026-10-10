/** Optional genuine-provider boundary check. Never substitutes a fake or writes a user's repository. */
import "./test-herdr.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { FactoryCheck, FactoryDetail, FactoryRun, FactoryWorker, InteractivePrompt, ReviewSnapshot } from "../shared/protocol.ts";

const provider = process.argv[2] ?? "codex";
if (!["codex", "claude", "opencode"].includes(provider)) throw new Error("Select codex, claude or opencode");
const resumeAt = process.argv.indexOf("--resume-state");
const resumed = resumeAt < 0 ? null : process.argv[resumeAt + 1];
if (resumeAt >= 0 && (!resumed || !new RegExp(`^${tmpdir()}/saurons-eye-native-[A-Za-z0-9]{6}$`).test(resumed) || realpathSync(resumed) !== resumed)) throw new Error("Resume only an owned native fixture directory");
const state = resumed ?? mkdtempSync(join(tmpdir(), "saurons-eye-native-"));
const app = createServer({ port: 0, stateDir: state, machines: false });
const origin = `http://localhost:${app.port}`;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${value.error?.code}`); return value;
}
let run: FactoryRun | undefined;
let succeeded = false;
async function answerOwnedMenu(paneId: string): Promise<void> {
  let prompt: InteractivePrompt | null;
  try { ({ prompt } = await api<{ prompt: InteractivePrompt | null }>(`/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`)); }
  catch (error) { if (error instanceof Error && error.message === "404: pane_not_found") return; throw error; }
  if (!prompt) return;
  const safe = prompt.options.findIndex((option) => /yes.*(?:once|proceed)|trust.*directory|trust and continue|yes,.*trust/i.test(option.label));
  let text = [prompt.question, prompt.body, prompt.title].filter(Boolean).join("\n");
  if (/Trust this folder\?/.test(text) && !text.includes(state)) text += (await api<{ read: { text: string } }>(`/api/pane/read?pane_id=${encodeURIComponent(paneId)}&source=detection&format=text`)).read.text;
  const command = prompt.body?.split("$ ").at(-1)?.replace(/\s+/g, " ").trim() ?? "";
  const knownGit = /^git merge (?:--ff-only|--no-edit) (?:refs\/heads\/)?saurons-eye\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(command)
    || /^git merge --no-edit [a-f0-9]{40,64}$/.test(command)
    || /^git add(?: --)? (?:greet\.ts greet\.test\.ts|greet\.test\.ts greet\.ts)(?: && git commit -m [^;$`]+)?$/.test(command)
    || /^git commit -m [^;$`]+$/.test(command);
  let ownedGit = false;
  if (knownGit && run?.action === "implement-spec") {
    const { snapshot } = await api<{ snapshot: { panes: { pane_id: string; cwd: string | null }[] } }>("/api/session");
    ownedGit = snapshot.panes.some((pane) => pane.pane_id === paneId && pane.cwd?.startsWith(join(state, "factory", "worktrees", run!.id) + "/"));
  }
  if (safe >= 0 && !prompt.fallback && (text.includes(state) || text.includes(".saurons-eye-tracker.mjs") || ownedGit)) await api("/api/pane/prompt/answer", { pane_id: paneId, prompt_id: prompt.id, option_index: safe });
}
async function journey(): Promise<void> {
  const repo = join(state, "repository-" + crypto.randomUUID()); mkdirSync(repo);
  writeFileSync(join(repo, ".gitignore"), ".agents/skills/\n.claude/skills/\n.opencode/skills/\n.saurons-eye-*\n");
  writeFileSync(join(repo, "README.md"), "# Owned greeting fixture\nUse Bun tests. No dependencies, network, publication or deployment.\n");
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Factory acceptance"], ["config", "user.email", "factory@example.invalid"], ["add", "."], ["commit", "-m", "owned baseline"]]) if (Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode !== 0) throw new Error("Owned Git fixture initialization failed");
  const idea = await api<{ id: string }>("/api/factory/implementations", { title: "Genuine greeting factory", description: "Automated owned acceptance fixture. All owner decisions below are predefined fixture input. Do not ask for access outside this disposable repository. No publication or external services." });
  let detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
  const artifact = await api<{ id: string }>(`/api/factory/implementations/${idea.id}/artifacts`, { chat_id: detail.chats[0]!.id, name: "research.md", media_type: "text/markdown", content_base64: Buffer.from("Greeting examples: Ada => Hello, Ada!; surrounding whitespace is trimmed.").toString("base64") });
  const project = await api<{ id: string }>("/api/factory/projects", { name: "Owned native fixture", path: repo, machine_id: "local", provider, tracker: "app" });
  await api(`/api/factory/projects/${project.id}/configure`, { checks: [["bun", "test"]], permissions: "Only this disposable repository and app-owned worktrees/state. Native agent and known Bun checks authorized. No pushes, publication, unrelated filesystem access or unmanaged children.", shared_paths: [] });
  await api(`/api/factory/implementations/${idea.id}/configure`, { project_id: project.id });
  const specification = await api<{ id: string }>(`/api/factory/implementations/${idea.id}/specifications`, { content: "Create greet.ts exporting greet(name: string): string. Trim surrounding whitespace; return `Hello, ${trimmedName}!`, using `world` if the trimmed name is empty. Add Bun tests for Ada, blank input, and surrounding whitespace. No dependencies. Use app-native Other tracker; one Ticket, isolated writer and backend merger. Public exported function and bun:test are confirmed testing seams for this disposable fixture. Every approval is already explicit in app records; reuse these decisions and do not repeat them. Keep app scaffolding/pinned skills out of commits. Follow TDD and commit the candidate. The coordinator must allocate its implementer through bun .saurons-eye-tracker.mjs worker, then refresh/check/integrate using the returned stable worker ID. The fixture owner explicitly controls candidate reconciliation/checks/integration and starts independent Standards and Spec contexts after integration. As coordinator, allocate the accepted implementer and return; wait for an explicit selected Request changes batch before allocating its rework worker. The fixture owner retains reports and final checks. Never call accept; the fixture owner accepts the reviewed head." });
  for (const kind of ["specification", "testing_seams"]) await api(`/api/factory/implementations/${idea.id}/approvals`, { kind, revision: specification.id, scope: "Explicit owned fixture acceptance: exported greet function, Bun tests, one Ticket and app-owned orchestration." });
  const graph = await api<{ hash: string }>(`/api/factory/implementations/${idea.id}/tickets`, { specification_id: specification.id, tickets: [{ key: "greet", title: "Implement the accepted greeting function", acceptance: "Exact greet.ts behavior and all three Bun regressions in the accepted specification; committed candidate, no app scaffolding.", dependencies: [] }] });
  await api(`/api/factory/implementations/${idea.id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "One greeting Ticket with no dependencies, explicitly approved." });
  run = await api(`/api/factory/implementations/${idea.id}/runs`, { action: "implement-spec", idempotency_key: "genuine-factory-journey" });
  if (run.condition !== "working") throw new Error(`Factory launch ${run.condition}: ${run.waiting_reason}`);
  console.log(`${provider}: genuine factory coordinator launched`);
  const deadline = Date.now() + 900_000; let last = "";
  let draft: { id: string; snapshot_id: string } | null = null; let reworkBatch: string | null = null;
  while (Date.now() < deadline) {
    detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
    const status = `${detail.implementation.stage}; workers=${detail.workers.map((worker) => `${worker.role}:${worker.condition}`).join(",")}; checks=${detail.checks.map((check) => check.condition).join(",")}; reports=${detail.review_evidence.map((report) => `${report.axis}:${report.outcome}`).join(",")}`;
    if (status !== last) { console.log(status); last = status; }
    for (const paneId of [run.pane_id, ...detail.workers.filter((worker) => !["completed", "cancelled", "failed"].includes(worker.condition)).map((worker) => worker.pane_id)]) if (paneId) await answerOwnedMenu(paneId);
    const pending = detail.questions.filter((question) => question.answer === null);
    if (pending.length) {
      for (const question of pending) await api(`/api/factory/implementations/${idea.id}/questions/${question.id}/answer`, { revision: question.revision, answer: "This acceptance fixture explicitly confirms the frozen specification, exported-function/Bun testing seams, one Ticket, app-native Other tracker and worktree/check permissions. Use only that scope; preserve the fixture's no-publication boundary." });
      detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
      await api(`/api/factory/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: crypto.randomUUID() });
    }
    // These are explicit fixture-owner controls, the same manual actions exposed by the UI.
    for (const worker of detail.workers.filter((worker) => worker.role === "implementer" && ["needs_you", "disconnected"].includes(worker.condition))) {
      const observed = await api<FactoryWorker>(`/api/factory/runs/${run.id}/workers/${worker.id}/reconcile`, {});
      if (observed.condition !== "needs_you" || !observed.waiting_reason?.includes("ready")) continue;
      await api(`/api/factory/runs/${run.id}/workers/${worker.id}/refresh`, {});
      const checked = await api<FactoryCheck>(`/api/factory/runs/${run.id}/workers/${worker.id}/check`, {});
      if (checked.condition !== "passed") throw new Error("Genuine candidate checks failed");
      await api(`/api/factory/runs/${run.id}/workers/${worker.id}/integrate`, {});
    }
    detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
    const candidate = detail.workers.filter((worker) => worker.role === "implementer" && worker.condition === "completed").at(-1);
    if (candidate?.head && !detail.workers.some((worker) => worker.role === "implementer" && !["completed", "cancelled", "failed"].includes(worker.condition))) {
      for (const role of ["standards", "spec"] as const) if (!detail.workers.some((worker) => worker.role === role && worker.base === candidate.head && !["cancelled", "failed"].includes(worker.condition))) await api(`/api/factory/runs/${run.id}/workers`, { role, idempotency_key: `owner-${role}-${candidate.head}` });
      for (const worker of detail.workers.filter((worker) => worker.role !== "implementer" && worker.condition === "needs_you")) {
        try { await api(`/api/factory/runs/${run.id}/workers/${worker.id}/review-evidence`, {}); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("409: review_evidence_required")) throw error; }
      }
    }
    detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
    if (detail.review_evidence.some((report) => report.outcome === "failed")) throw new Error("The genuine independent review found a failure; retained evidence requires rework");
    const reviewed = candidate?.head && ["standards", "spec"].every((axis) => detail.review_evidence.some((report) => report.axis === axis && report.outcome === "passed" && report.head === candidate.head));
    if (reviewed && !reworkBatch) {
      if (!draft) {
        const capture = await api<ReviewSnapshot>(`/api/factory/implementations/${idea.id}/snapshots`, { run_id: run.id, mode: "branch" });
        const comment = await api<{ id: string }>(`/api/factory/implementations/${idea.id}/comments`, { snapshot_id: capture.id, path: "greet.ts", side: "new", line_start: 1, line_end: 1, content: "Add an explicit Bun regression for tab/newline whitespace around Ada, using the already accepted trim behavior. This is an owned fixture Request changes. Allocate one fresh rework worker for this batch and return; the fixture owner performs integration and starts fresh independent reviews." });
        draft = { id: comment.id, snapshot_id: capture.id };
      }
      const batch = await api<{ id: string; status: string }>(`/api/factory/implementations/${idea.id}/request-changes`, { run_id: run.id, snapshot_id: draft.snapshot_id, comment_ids: [draft.id], idempotency_key: crypto.randomUUID() });
      if (batch.status === "sent") { reworkBatch = batch.id; console.log(`${provider}: genuine selected Request changes delivered`); }
      else if (batch.status !== "blocked") throw new Error("Rework delivery was uncertain and will not be replayed");
    }
    if (reviewed && reworkBatch && candidate?.rework_batch_id === reworkBatch) break;
    if (Date.now() + 1000 >= deadline) throw new Error("Genuine Ticket factory deadline: inspect retained native evidence");
    await Bun.sleep(1000);
  }
  if (detail.implementation.stage !== "review") throw new Error("Integrated factory work did not enter owner Review");
  const check = await api<FactoryCheck>(`/api/factory/runs/${run.id}/checks`, {});
  if (check.condition !== "passed") throw new Error("Genuine final checks failed");
  if (!draft || !reworkBatch) throw new Error("Selected genuine rework was not exercised");
  await api(`/api/factory/implementations/${idea.id}/comments/${draft.id}/resolve`, { head: check.head, summary: "Fixture owner inspected new checks and both fresh genuine review axes after the explicitly requested whitespace regression." });
  const snapshot = await api<ReviewSnapshot>(`/api/factory/implementations/${idea.id}/snapshots`, { run_id: run.id, mode: "branch" });
  if (!snapshot.files.some((file) => file.path === "greet.ts")) throw new Error("Branch review did not retain the genuine source change");
  if ((await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`)).comments.find((comment) => comment.id === draft!.id)?.status !== "resolved") throw new Error("An unchanged review capture invalidated the owner resolution");
  await api(`/api/factory/runs/${run.id}/import-conversation`, {});
  await api(`/api/factory/runs/${run.id}/accept`, { head: check.head });
  detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
  if (detail.implementation.stage !== "done" || detail.implementation.outcome !== "implementation_complete" || !detail.artifacts.some((entry) => entry.id === artifact.id) || !detail.native_snapshots.length) throw new Error("Acceptance lost durable history or outcome");
  if (Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo }).stdout.toString().trim() || readFileSync(join(repo, "README.md"), "utf8").indexOf("Owned greeting fixture") < 0) throw new Error("The factory modified its primary checkout");
  console.log(`${provider}: genuine Ticket integration, current checks, independent reviews, owner acceptance and history passed`);
}
try {
  const retainedProof = resumed && (await api<{ providers: { provider: string; factory_ready: boolean }[] }>("/api/factory/providers?machine_id=local")).providers.find((entry) => entry.provider === provider)?.factory_ready;
  if (!retainedProof) {
  const idea = await api<{ id: string }>("/api/factory/implementations", { title: "Owned native verification probe", description: "Read-only fixture: inspect local pinned instructions, record the fixed verification question and consume its explicit fixture answer. No source edits, publication or global setup." });
  await api(`/api/factory/implementations/${idea.id}/configure`, { provider, machine_id: "local" });
  run = await api(`/api/factory/implementations/${idea.id}/runs`, { action: "verify-provider", idempotency_key: "owned-native-verification" });
  if (!run.pane_id || run.condition !== "working") throw new Error(`Native launch ${run.condition}: ${run.waiting_reason}`);
  console.log(`${provider}: genuine native probe launched on an owned workspace`);
  const deadline = Date.now() + 300_000; const answered = new Set<string>(); let sent = false;
  while (Date.now() < deadline) {
    const detail = await api<FactoryDetail>(`/api/factory/implementations/${idea.id}`);
    const questions = detail.questions.filter((question) => question.run_id === run!.id);
    for (const question of questions) if (question.answer === null && !answered.has(question.id)) {
      if (!/Confirm this read-only native verification round\?/i.test(question.question)) throw new Error("The native provider asked outside this fixture's predeclared decision");
      await api(`/api/factory/implementations/${idea.id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed for this owned read-only verification fixture." }); answered.add(question.id);
    }
    const menu = await api<{ prompt: InteractivePrompt | null }>(`/api/pane/prompt?pane_id=${encodeURIComponent(run.pane_id)}`);
    if (menu.prompt) {
      // Actual key navigation via the public responder; never digit injection or session-wide permission.
      const safe = menu.prompt.options.findIndex((option) => /yes.*(?:once|proceed)|trust.*directory|trust and continue|yes,.*trust/i.test(option.label));
      const text = [menu.prompt.question, menu.prompt.body, menu.prompt.title].filter(Boolean).join("\n");
      if (safe >= 0 && (text.includes(state) || text.includes(".saurons-eye-tracker.mjs"))) await api("/api/pane/prompt/answer", { pane_id: run.pane_id, prompt_id: menu.prompt.id, option_index: safe });
    }
    if (questions.length && questions.every((question) => question.answer !== null) && !sent) {
      const delivery = await api<{ condition: string }>(`/api/factory/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: crypto.randomUUID() });
      if (delivery.condition === "uncertain" || delivery.condition === "sending") throw new Error("Native answered-context delivery is uncertain; it was not replayed");
      sent = delivery.condition === "sent";
    }
    if (sent) {
      try { const capabilities = await api<{ providers: { provider: string; factory_ready: boolean }[] }>(`/api/factory/runs/${run.id}/verify-provider`, {}); if (capabilities.providers.find((entry) => entry.provider === provider)?.factory_ready) { console.log(`${provider}: native loading and recorded owner-question round verified`); break; } }
      catch { /* incomplete evidence never certifies a provider */ }
    }
    if (Date.now() + 500 >= deadline) throw new Error("Native verification deadline: loading/question evidence remains unverified");
    await Bun.sleep(500);
  }
  } else console.log(`${provider}: retained genuine proof revalidated against current provider and complete pinned source`);
  if (process.argv.includes("--journey")) {
    if (run) await api(`/api/factory/runs/${run.id}/stop`, { summary: "Pinned native verification completed before factory acceptance" });
    await journey();
  }
  succeeded = true;
} finally {
  if (run?.workspace_id) { try { await api(`/api/factory/runs/${run.id}/stop`, { summary: "Owned native fixture finished" }); } catch { /* isolated check runner closes its own Herdr session */ } }
  app.stop();
  if (succeeded && !resumed) rmSync(state, { recursive: true, force: true });
  else console.log(`Owned ${succeeded ? "native" : "failure"} evidence retained at ${state}`);
}
