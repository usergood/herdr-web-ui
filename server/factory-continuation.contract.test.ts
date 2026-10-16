import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, type WorkspaceCreateResult } from "./herdr/client.ts";
import type { FactoryRun } from "../shared/protocol.ts";
import type { FactoryNative } from "./factory-native.ts";
import { FactoryStore } from "./factory-store.ts";

async function fixture(hostToken = "", overrides: Partial<FactoryNative> = {}) {
  const root = mkdtempSync(join(tmpdir(), "saurons-continuation-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned continuation fixture\n");
  for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const owned: string[] = [];
  const app = createServer({ port: 0, token: hostToken, stateDir: join(root, "state"), machines: false, factory: { accountDiscoveryHome: root, native: {
    version: async () => "owned-continuation-fixture",
    createWorkspace: async options => { const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; },
    startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); },
    ...overrides,
  } } });
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1", ...(hostToken ? { authorization: `Bearer ${hostToken}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const project = await request("/projects", { name: "Continuation Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
  const idea = await request("/implementations", { title: "Continue approved work", description: "", project_id: project.id }).then(r => r.json());
  const prefix = `/implementations/${idea.id}`;
  const start = (action: string, key: string): Promise<FactoryRun> => request(`${prefix}/runs`, { action, idempotency_key: key }).then(r => r.json());
  const agent = (run: FactoryRun, path: string, body?: unknown) => {
    const access = JSON.parse(readFileSync(join(run.worktree!, ".saurons-eye-access.json"), "utf8"));
    return fetch(`${access.url}/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { app, repo, prefix, request, start, agent, close: async () => { app.stop(); for (const id of owned) await workspaceClose(id).catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
}

describe("continuing approved workflow steps", () => {
  it("pauses native owned execution while keeping its dirty worktree and retained Run available", async () => {
    const f = await fixture("owned-pause");
    try {
      const run = await f.start("work", "pause-native");
      expect(run.worktree).toBeTruthy();
      writeFileSync(join(run.worktree!, "README.md"), "Unfinished owner-preserved work\n");
      writeFileSync(join(run.worktree!, ".gitignore"), "ignored-work.txt\n");
      writeFileSync(join(run.worktree!, "ignored-work.txt"), "Owned ignored progress\n");
      const paused = await f.request(`${f.prefix}/pause`, {}).then(r => r.json());
      expect(paused.pause).toMatchObject({ condition: "paused", reasons: [] });
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree, suspension: { condition: "stopped" } });
      for (const [name, content] of [["README.md", "Unfinished owner-preserved work\n"], ["ignored-work.txt", "Owned ignored progress\n"]]) {
        const response = await fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(join(run.worktree!, name!))}`, { headers: { authorization: "Bearer owned-pause" } });
        expect(await response.text()).toBe(content!);
      }
      const native = await fetch(`http://localhost:${f.app.port}/api/session`, { headers: { authorization: "Bearer owned-pause" } }).then(r => r.json());
      expect(native.snapshot.panes.some((p: { pane_id: string }) => p.pane_id === run.pane_id)).toBe(false);
    } finally { await f.close(); }
  }, 60_000);
  it("resumes native execution in the retained worktree without replacing the Run or discarding dirty progress", async () => {
    const f = await fixture("owned-native-resume");
    try {
      const run = await f.start("work", "native-resume");
      writeFileSync(join(run.worktree!, "README.md"), "Retained unfinished work\n");
      await f.request(`${f.prefix}/pause`, {});
      await f.request(`${f.prefix}/resume`, {});
      let detail: any;
      const deadline = Date.now() + 8_000;
      do {
        detail = await f.request(f.prefix).then(r => r.json());
        if (!detail.runs[0].suspension) break;
        await Bun.sleep(30);
      } while (Date.now() < deadline);
      expect(detail.runs[0].suspension).toBeUndefined();
      expect(detail.runs).toHaveLength(1);
      expect(detail.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree });
      expect(detail.runs[0].pane_id).not.toBe(run.pane_id);
      const response = await fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(join(run.worktree!, "README.md"))}`, { headers: { authorization: "Bearer owned-native-resume" } });
      expect(await response.text()).toBe("Retained unfinished work\n");
    } finally { await f.close(); }
  }, 60_000);
  it.skipIf(process.platform === "win32")("stops an owned child and running build before acknowledging the whole Assignment as Paused", async () => {
    const f = await fixture("owned-child-build-pause");
    try {
      const detail = await f.request(f.prefix).then(r => r.json());
      await f.request(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "-e", "setInterval(() => {}, 1000)"]], permissions: "Owned unpaid test fixtures only" });
      const run = await f.start("work", "child-build-pause");
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "owned-reviewer" }).then(r => r.json());
      const checking = f.request(`/runs/${run.id}/checks`, {});
      const deadline = Date.now() + 8_000;
      let running: any;
      do {
        running = await f.request(f.prefix).then(r => r.json());
        if (running.checks.some((c: any) => c.condition === "working")) break;
        await Bun.sleep(30);
      } while (Date.now() < deadline);
      expect(running.checks[0].condition).toBe("working");
      expect((await f.request(`${f.prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      await checking;
      const paused = await f.request(f.prefix).then(r => r.json());
      expect(paused.workers[0]).toMatchObject({ id: worker.id, suspension: { condition: "stopped" } });
      expect(paused.checks[0]).toMatchObject({ condition: "cancelled", pause_id: paused.implementation.pause.id });
      expect((await f.request("").then(r => r.json())).capacity.builds.used).toBe(0);
    } finally { await f.close(); }
  }, 60_000);
  for (const action of ["pause", "delete"] as const) it.skipIf(process.platform === "win32")(`${action} stops a SIGTERM-resistant owned build descendant after its leader exits`, async () => {
    const f = await fixture(`owned-descendant-${action}`); let descendant = 0;
    const ready = join(f.repo, "..", "descendant-ready");
    const child = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
    const running = () => { try { const state = readFileSync(`/proc/${descendant}/stat`, "utf8").split(") ")[1]?.[0]; return state !== "Z"; } catch { try { process.kill(descendant, 0); return true; } catch { return false; } } };
    try {
      const detail = await f.request(f.prefix).then(r => r.json());
      await f.request(`/projects/${detail.implementation.project_id}/configure`, { checks: [["node", "-e", parent]], permissions: "Owned unpaid test fixtures only" });
      const run = await f.start("work", `descendant-${action}`);
      const checking = f.request(`/runs/${run.id}/checks`, {});
      for (const deadline = Date.now() + 8000; !existsSync(ready) && Date.now() < deadline;) await Bun.sleep(20);
      expect(existsSync(ready)).toBe(true); descendant = Number(readFileSync(ready, "utf8")); expect(running()).toBe(true);
      const response = await f.request(`${f.prefix}/${action}`, {});
      expect(response.ok).toBe(true);
      const result = await response.json();
      if (action === "pause") expect(result.pause.condition).toBe("paused");
      else expect(result.condition).toBe("deleted");
      expect(running()).toBe(false);
      await checking;
      expect((await f.request("").then(r => r.json())).capacity.builds.used).toBe(0);
    } finally { if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} } await f.close(); }
  }, 60000);
  it("preserves a genuine configured validation failure when the owner later pauses and resumes", async () => {
    const f = await fixture("owned-failed-check-pause");
    try {
      const detail = await f.request(f.prefix).then(r => r.json());
      await f.request(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "-e", "process.exit(3)"]], permissions: "Owned unpaid test fixtures only" });
      const run = await f.start("work", "genuine-validation-failure");
      const failed = await f.request(`/runs/${run.id}/checks`, {}).then(r => r.json());
      expect(failed.condition).toBe("failed"); expect(failed.commands[0].exit_code).toBe(3);
      expect((await f.request(`${f.prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      await f.request(`${f.prefix}/resume`, {});
      const retained = await f.request(f.prefix).then(r => r.json());
      expect(retained.checks).toHaveLength(1);
      expect(retained.checks[0]).toMatchObject({ id: failed.id, condition: "failed", head: failed.head });
      expect(retained.checks[0].pause_id).toBeUndefined();
      expect(retained.checks[0].commands[0]).not.toHaveProperty("cancelled");
    } finally { await f.close(); }
  }, 60000);
  it("replays the confirmed Machine shutdown acknowledgment after a lost response without stopping the child twice", async () => {
    const f = await fixture("owned-pause-replay");
    try {
      const run = await f.start("work", "pause-replay");
      await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "reviewer" });
      const paused = await f.request(`${f.prefix}/pause`, {}).then(r => r.json());
      expect(paused.pause.condition).toBe("paused");
      const response = await fetch(`http://localhost:${f.app.port}/api/factory-host/runs/${run.id}/operations/pause`, { method: "POST", headers: { authorization: "Bearer owned-pause-replay", "x-herdr-machine": "1", "x-herdr-factory": "1", "content-type": "application/json" }, body: JSON.stringify({ pause_id: paused.pause.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ run: { id: run.id, suspension: { pause_id: paused.pause.id, condition: "stopped" } } });
    } finally { await f.close(); }
  }, 60_000);
  it("still stops native contexts when a restored build has no cancellation proof", async () => {
    const f = await fixture("owned-uncertain-build");
    try {
      const run = await f.start("work", "uncertain-build");
      const store = new FactoryStore(join(f.repo, "..", "state"));
      store.put("host_checks", { ...store.record(), run_id: run.id, worker_id: null, head: run.base, workspace_hash: "", commands: [], condition: "interrupted" }, run.id);
      store.close();
      const paused = await f.request(`${f.prefix}/pause`, {}).then(r => r.json());
      expect(paused.pause.condition).toBe("pending");
      expect(paused.pause.reasons.join(" ")).toContain("build");
      const native = await fetch(`http://localhost:${f.app.port}/api/session`, { headers: { authorization: "Bearer owned-uncertain-build" } }).then(r => r.json());
      expect(native.snapshot.panes.some((p: { pane_id: string }) => p.pane_id === run.pane_id)).toBe(false);
    } finally { await f.close(); }
  }, 60_000);
  it("stops the known root while retaining a changed child identity for reconciliation", async () => {
    const f = await fixture("owned-uncertain-child");
    try {
      const run = await f.start("work", "uncertain-child");
      const store = new FactoryStore(join(f.repo, "..", "state"));
      store.put("host_workers", { ...store.record(), run_id: run.id, ticket_id: run.id, role: "standards", condition: "disconnected", base: run.base, head: null, integration_tip: run.base, worktree: run.worktree, branch: run.branch, workspace_id: "missing-owned-child", pane_id: "missing-owned-child:p1", shared_paths: [], waiting_reason: "Unknown restored native identity", rework_batch_id: null }, run.id);
      store.close();
      expect((await f.request(`${f.prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("pending");
      const native = await fetch(`http://localhost:${f.app.port}/api/session`, { headers: { authorization: "Bearer owned-uncertain-child" } }).then(r => r.json());
      expect(native.snapshot.panes.some((p: { pane_id: string }) => p.pane_id === run.pane_id)).toBe(false);
    } finally { await f.close(); }
  }, 60_000);
  it("automatically confirms a child shutdown whose native close acknowledgment was lost", async () => {
    let loseClose = false;
    const f = await fixture("owned-close-recovery", { closeWorkspace: async id => { const result = await workspaceClose(id); if (loseClose) { loseClose = false; throw new Error("Owned lost native close acknowledgment"); } return result; } });
    try {
      const run = await f.start("work", "close-recovery");
      await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "reviewer" });
      loseClose = true;
      expect((await f.request(`${f.prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("pending");
      let detail: any;
      const deadline = Date.now() + 8_000;
      do { detail = await f.request(f.prefix).then(r => r.json()); if (detail.implementation.pause.condition === "paused") break; await Bun.sleep(30); } while (Date.now() < deadline);
      expect(detail.implementation.pause.condition).toBe("paused");
      expect((await f.request("").then(r => r.json())).capacity.normal.used).toBe(0);
    } finally { await f.close(); }
  }, 60_000);
  it("accounts for a child workspace whose allocation acknowledgment was lost before native IDs were saved", async () => {
    const owned: string[] = [];
    const f = await fixture("owned-lost-child-allocation", { createWorkspace: async options => {
      const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false });
      owned.push(result.workspace.workspace_id);
      if (options.label?.startsWith("saurons-eye-worker-")) throw new Error("Owned lost child allocation acknowledgment");
      return result;
    } });
    try {
      const run = await f.start("work", "lost-child-allocation");
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "reviewer" }).then(r => r.json());
      await f.request(`${f.prefix}/pause`, {});
      const native = await fetch(`http://localhost:${f.app.port}/api/session`, { headers: { authorization: "Bearer owned-lost-child-allocation" } }).then(r => r.json());
      expect(native.snapshot.workspaces.some((w: { label: string }) => w.label === `saurons-eye-worker-${worker.id}`)).toBe(false);
    } finally { await f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("sends answered context to a decorated finished turn but refuses background work", async () => {
    let prompted = 0; let background = false;
    const f = await fixture("", {
      snapshot: async () => { const s = await sessionSnapshot(); return { ...s, panes: s.panes.map(pane => pane.agent === "codex" ? { ...pane, agent_status: "unknown" } : pane) }; },
      paneState: async id => { const pane = (await sessionSnapshot()).panes.find(p => p.pane_id === id); return pane ? { ...pane, agent_status: "done", background_tasks: background ? 1 : 0 } : null; },
      prompt: async () => { prompted++; },
    });
    try {
      const run = await f.start("grill-with-docs", "decorated-answer-delivery");
      const question = await f.agent(run, "question", { question: "Which scope?" }).then(r => r.json());
      await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The retained approved scope" });
      let detail = await f.request(f.prefix).then(r => r.json());
      const sent = await f.request(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "decorated-done" }).then(r => r.json());
      expect(sent.condition).toBe("sent"); expect(prompted).toBe(1);
      const replay = await f.request(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "decorated-done" }).then(r => r.json());
      expect(replay.id).toBe(sent.id); expect(prompted).toBe(1);
      background = true;
      const next = await f.agent(run, "question", { question: "Confirm the next scope?" }).then(r => r.json());
      await f.request(`${f.prefix}/questions/${next.id}/answer`, { revision: next.revision, answer: "This explicit fixture answer" });
      detail = await f.request(f.prefix).then(r => r.json());
      const blocked = await f.request(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "background-blocked" }).then(r => r.json());
      expect(blocked.condition).toBe("blocked"); expect(prompted).toBe(1);
    } finally { await f.close(); }
  }, 60_000);

  it("retains execution capacity when native background work appears before answer delivery", async () => {
    let background = false;
    const f = await fixture("", { paneState: async id => { const pane = (await sessionSnapshot()).panes.find(pane => pane.pane_id === id); return pane ? { ...pane, background_tasks: background ? 1 : 0 } : null; } });
    try {
      await f.request("/settings", { max_agents: 1 });
      const run = await f.start("work", "background-capacity-race");
      const question = await f.agent(run, "question", { question: "Which owned behavior?" }).then(r => r.json());
      await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The accepted capacity behavior" });
      expect((await f.request(`/runs/${run.id}/reconcile`, {}).then(r => r.json())).condition).toBe("ready");
      background = true;
      const detail = await f.request(f.prefix).then(r => r.json());
      const delivery = await f.request(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "background-send" }).then(r => r.json());
      expect(delivery.condition).toBe("blocked");
      const overview = await f.request("").then(r => r.json());
      expect(overview.capacity.normal.used).toBe(1);
      expect(overview.capacity.contexts[0].condition).toBe("working");
    } finally { await f.close(); }
  }, 60_000);

  it("resumes only an authenticated resting owned child and keeps native permission prompts", async () => {
    const prompts: string[] = [];
    const f = await fixture("owned-child-send", { prompt: async paneId => { prompts.push(paneId); } });
    try {
      const run = await f.start("work", "child-send-host");
      const child = await f.agent(run, "worker", { role: "standards", idempotency_key: "native-child-send" }).then(r => r.json());
      expect(child.pane_id).toBeString();
      const send = (headers: Record<string, string> = { authorization: "Bearer owned-child-send", "x-herdr-factory": "1" }) => fetch(`http://localhost:${f.app.port}/api/factory-host/runs/${run.id}/operations/send-worker`, { method: "POST", headers, body: JSON.stringify({ worker_id: child.id, text: "Retain this exact child conversation" }) });
      expect((await send({ "x-herdr-factory": "1" })).status).toBe(401);
      expect((await send({ authorization: "Bearer owned-child-send" })).status).toBe(403);
      await herdrRpc("pane.report_agent", { pane_id: child.pane_id, source: "manual", agent: "codex", state: "blocked" });
      expect((await send()).status).toBe(409);
      expect(prompts).toHaveLength(0);
      await herdrRpc("pane.report_agent", { pane_id: child.pane_id, source: "manual", agent: "codex", state: "idle" });
      expect((await send()).status).toBe(200);
      expect(prompts).toEqual([child.pane_id]);
      await workspaceClose(child.workspace_id);
      expect((await send()).status).toBe(409);
      expect(prompts).toHaveLength(1);
    } finally { await f.close(); }
  }, 60_000);

  it("rejects a checkout changed during asynchronous handoff before successor admission", async () => {
    let armed = false; let reads = 0; let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    const f = await fixture("", { snapshot: async () => { if (armed && ++reads === 2) { entered(); await gate; } return sessionSnapshot(); } });
    try {
      const run = await f.start("work", "handoff-checkout-race");
      armed = true;
      const continued = f.request(`${f.prefix}/continue`, { action: "grill-with-docs", run_id: run.id, idempotency_key: "handoff-guard", allow_partial_handoff: true });
      await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Handoff observation did not reach the fixture gate")), 5_000))]);
      const other = f.repo + "-replacement";
      execFileSync("git", ["clone", "--quiet", f.repo, other], { stdio: "ignore" });
      const detail = await f.request(f.prefix).then(r => r.json());
      const configured = await f.request(`/projects/${detail.implementation.project_id}/checkouts`, { machine_id: "local", path: other });
      expect(configured.status).toBe(201);
      release();
      const response = await continued;
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("scope_changed");
      expect((await f.request(f.prefix).then(r => r.json())).runs).toHaveLength(1);
    } finally { release(); await f.close(); }
  }, 60_000);

  it("covers the host finish route with authentication, busy and lost-identity guards", async () => {
    const f = await fixture("owned-finish-route");
    const finish = (run: FactoryRun, headers: Record<string, string> = { authorization: "Bearer owned-finish-route", "x-herdr-factory": "1" }) => fetch(`http://localhost:${f.app.port}/api/factory-host/runs/${run.id}/finish`, { method: "POST", headers, body: "{}" });
    try {
      const run = await f.start("work", "host-finish-contract");
      expect((await finish(run, { "x-herdr-factory": "1" })).status).toBe(401);
      expect((await finish(run, { authorization: "Bearer owned-finish-route" })).status).toBe(403);
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "working" });
      const busy = await finish(run);
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe("agent_busy");
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      const completed = await finish(run);
      expect(completed.status).toBe(200); expect(await completed.json()).toMatchObject({ id: run.id, condition: "completed", worktree: run.worktree, pane_id: run.pane_id });
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === run.pane_id)).toBe(true);
      expect((await finish(run).then(r => r.json())).condition).toBe("completed");
      await f.request(`/runs/${run.id}/reconcile`, {});
      const lost = await f.start("grill-with-docs", "lost-host-identity");
      await workspaceClose(lost.workspace_id!);
      const uncertain = await finish(lost);
      expect(uncertain.status).toBe(409); expect((await uncertain.json()).error.code).toBe("native_identity_uncertain");
    } finally { await f.close(); }
  }, 60_000);

  it("covers scoped native answer synchronization, exact response scope and cursor authorization", async () => {
    const host = await fixture("owned-sync-host");
    const state = mkdtempSync(join(tmpdir(), "native-sync-contract-"));
    let questionTime = "";
    const proxy = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/operations/transcript")) {
        const body = await request.json() as { before?: string };
        return Response.json({ source_id: "owned-transcript-fixture", version: "fixture-page", cursor: body.before ? null : "older-owned-page", turns: body.before ? [] : [
          { role: "user", ts: new Date(Date.parse(questionTime) - 1000).toISOString(), parts: [{ kind: "text", text: "Owned initial context" }] },
          { role: "user", ts: new Date(Date.parse(questionTime) + 1000).toISOString(), parts: [{ kind: "text", text: "Retain the workflow history" }] },
        ] });
      }
      const response = await fetch(`http://localhost:${host.app.port}${url.pathname}${url.search}`, request);
      const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
      return new Response(response.body, { status: response.status, headers });
    } });
    const app = createServer({ port: 0, stateDir: state, token: "", machines: false, factory: { machineEndpoint: id => id === "external-host" ? { url: `http://localhost:${proxy.port}`, token: "owned-sync-host" } : undefined } });
    const api = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const idea = await api("/implementations", { title: "Native synchronization contract", description: "Owned transport fixture" }).then(r => r.json());
      await api(`/implementations/${idea.id}/configure`, { provider: "codex", machine_id: "external-host" });
      const run = await api(`/implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "sync-route-contract" }).then(r => r.json());
      const question = await host.agent(run, "question", { question: "What should continuation retain?" }).then(r => r.json());
      questionTime = question.created_at;
      const unauthorized = await fetch(`http://localhost:${app.port}/api/factory-agent/${run.id}/sync-answers`, { method: "POST", headers: { "x-herdr-factory": "1", "content-type": "application/json" }, body: "{}" });
      expect(unauthorized.status).toBe(401);
      const invalid = await host.agent(run, "sync-answers", { before: "unowned-cursor" });
      expect(invalid.status).toBe(400); expect((await invalid.json()).error.code).toBe("invalid_cursor");
      const response = await host.agent(run, "sync-answers", {});
      expect(response.status).toBe(200);
      const result = await response.json();
      expect({ ...result, questions: structuredClone(result.questions) }).toMatchObject({ snapshot_id: expect.any(String), cursor: "older-owned-page", question_revision: expect.any(String), questions: [{ id: question.id, answer: "Retain the workflow history" }] });
      const replay = await host.agent(run, "sync-answers", {}).then(r => r.json());
      expect(replay.snapshot_id).toBe(result.snapshot_id);
      expect((await host.agent(run, "consume", { revision: result.question_revision })).status).toBe(200);
      expect((await host.agent(run, "sync-answers", { before: result.cursor })).status).toBe(200);
      const detail = await api(`/implementations/${idea.id}`).then(r => r.json());
      expect(detail.approvals).toHaveLength(0);
    } finally { app.stop(); await proxy.stop(); await host.close(); rmSync(state, { recursive: true, force: true }); }
  }, 60_000);

  it.each([[false, false, false, false], [true, false, false, false], [false, true, false, false], [false, false, true, false], [false, false, false, true]])("observes remote readiness and fences scope changes (checkout: %s, prompt: %s, verification: %s, question: %s)", async (changeCheckout, nativePrompt, changeDuringVerification, changeProductQuestion) => {
    const host = await fixture("owned-continuation-host");
    const state = mkdtempSync(join(tmpdir(), "remote-continuation-"));
    let verificationRequests = 0; let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    const proxy = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/verify-provider")) {
        verificationRequests++;
        if (changeDuringVerification || changeProductQuestion) {
          entered(); await gate;
          // No stand-in grants proof: this successful observation still reports
          // factory_ready false. A changed scope must be rejected before admission.
          return host.request("/providers");
        }
      }
      const response = await fetch(`http://localhost:${host.app.port}${url.pathname}${url.search}`, request);
      const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
      return new Response(response.body, { status: response.status, headers });
    } });
    const app = createServer({ port: 0, stateDir: state, token: "", machines: false, factory: { machineEndpoint: id => id === "external-host" ? { url: `http://localhost:${proxy.port}`, token: "owned-continuation-host" } : undefined } });
    const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const project = await request("/projects", { name: "Remote continuation", path: host.repo, machine_id: "external-host", provider: "codex", tracker: "app" }).then(r => r.json());
      await request(`/projects/${project.id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixture only", shared_paths: [] });
      const idea = await request("/implementations", { title: "Remote accepted fixture", description: "", project_id: project.id }).then(r => r.json());
      const prefix = `/implementations/${idea.id}`;
      const spec = await request(`${prefix}/specifications`, { content: "Owned continuation acceptance fixture" }).then(r => r.json());
      for (const kind of ["specification", "testing_seams"]) await request(`${prefix}/approvals`, { kind, revision: spec.id, scope: "Predeclared fixture decision" });
      const graph = await request(`${prefix}/tickets`, { specification_id: spec.id, tickets: [{ key: "fixture", title: "Owned fixture", acceptance: "Owned fixture only", dependencies: [] }] }).then(r => r.json());
      await request(`${prefix}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Predeclared fixture graph" });
      const accepted = await request(`${prefix}/continue`, { action: "implement-spec", run_id: null, idempotency_key: "remote-continued-proof" });
      expect(accepted.status).toBe(202);
      const run = await accepted.json();
      expect(run.action).toBe("verify-provider");
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "working" });
      const question = await host.agent(run, "question", { question: "Confirm the owned remote probe?" }).then(r => r.json());
      await request(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Explicit owned fixture answer" });
      const contract = await host.agent(run, "contract").then(r => r.json());
      expect((await host.agent(run, "consume", { revision: contract.question_revision })).status).toBe(200);
      if (nativePrompt) {
        await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "blocked" });
        const deadline = Date.now() + 3_000;
        let blocked = false;
        do {
          const detail = await request(prefix).then(r => r.json());
          blocked = detail.runs.some((entry: FactoryRun) => entry.id === run.id && entry.condition === "needs_you");
          if (blocked) break;
          await Bun.sleep(50);
        } while (Date.now() < deadline);
        expect(blocked).toBe(true);
      }
      if (changeCheckout) {
        const other = join(state, "other-checkout");
        execFileSync("git", ["clone", "--quiet", host.repo, other], { stdio: "ignore" });
        const changed = await request(`/projects/${project.id}/checkouts`, { machine_id: "external-host", path: other });
        expect(changed.status).toBe(201);
      }
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      if (changeDuringVerification || changeProductQuestion) {
        await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Remote verification did not reach the fixture gate")), 5_000))]);
        const configured = changeProductQuestion
          ? await request(`${prefix}/questions`, { question: "Which newly requested product scope?" })
          : await request(`/projects/${project.id}/configure`, { permissions: "Changed fixture execution scope" });
        expect(configured.status).toBe(changeProductQuestion ? 201 : 200);
        release();
      }
      const expectedProblem = changeCheckout || changeDuringVerification || changeProductQuestion ? "Project settings or the approved scope changed" : "not finished recording native verification evidence";
      const deadline = Date.now() + 8_000;
      let detail;
      do {
        detail = await request(prefix).then(r => r.json());
        if ((changeCheckout || changeDuringVerification || changeProductQuestion || verificationRequests >= 2) && detail.events.some((event: { kind: string; data: { message?: string } }) => event.kind === "continuation_waiting" && event.data.message?.includes(expectedProblem))) break;
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      expect(detail.events.some((event: { kind: string; data: { message?: string } }) => event.kind === "continuation_waiting" && event.data.message?.includes(expectedProblem)), JSON.stringify({ runs: detail.runs.map((r: FactoryRun)=>({ id:r.id, condition:r.condition, waiting_reason:r.waiting_reason })), events: detail.events.filter((e: {kind:string})=>e.kind.includes("continuation")) })).toBe(true);
      expect(detail.runs.some((entry: FactoryRun) => entry.action === "implement-spec")).toBe(false);
      if (changeCheckout) expect(verificationRequests).toBe(0); else if (changeDuringVerification || changeProductQuestion) expect(verificationRequests).toBe(1); else expect(verificationRequests).toBeGreaterThanOrEqual(2);
    } finally { release(); app.stop(); await proxy.stop(); await host.close(); rmSync(state, { recursive: true, force: true }); }
  }, 60_000);

  it("confirms shared understanding once without inventing text answers or approving obsolete probes", async () => {
    const f = await fixture();
    try {
      const old = await f.start("verify-provider", "old-confirmation-probe");
      const obsolete = await f.agent(old, "question", { question: "Confirm the old probe?" }).then(r => r.json());
      await f.request(`/runs/${old.id}/stop`, {});
      const run = await f.start("grill-with-docs", "shared-understanding");
      const text = await f.agent(run, "question", { question: "Which result?" }).then(r => r.json());
      const confirmation = await f.agent(run, "question", { question: "Confirm the agreed scope?", answer_kind: "confirmation" }).then(r => r.json());
      let detail = await f.request(f.prefix).then(r => r.json());
      const approval = () => f.request(`${f.prefix}/approvals`, { kind: "shared_understanding", revision: detail.question_revision, scope: "The owner's agreed scope" });
      expect((await approval()).status).toBe(409);
      await f.request(`${f.prefix}/questions/${text.id}/answer`, { revision: text.revision, answer: "The retained workflow repair" });
      detail = await f.request(f.prefix).then(r => r.json());
      const accepted = await approval();
      expect(accepted.status).toBe(201);
      const receipt = await accepted.json();
      detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.questions.find((q: { id: string }) => q.id === confirmation.id).answer).toBe("Confirmed");
      expect(detail.questions.find((q: { id: string }) => q.id === obsolete.id).answer).toBeNull();
      expect(receipt.revision).toBe(detail.question_revision);
      expect((await f.agent(run, "consume", { revision: receipt.revision })).status).toBe(200);
    } finally { await f.close(); }
  }, 60_000);

  it("retains an ordinary Work result for review while continuing without closing its chat or accepting delivery", async () => {
    const f = await fixture();
    try {
      const work = await f.start("work", "bootstrap-repair");
      writeFileSync(join(work.worktree!, "repair.txt"), "Preserve this repair for review\n");
      const continued = await f.request(`${f.prefix}/continue`, { action: "verify-provider", run_id: work.id, idempotency_key: "continue-repair", allow_partial_handoff: true });
      expect(continued.status, JSON.stringify(await continued.clone().json())).toBe(202);
      expect(readFileSync(join(work.worktree!, "repair.txt"), "utf8")).toBe("Preserve this repair for review\n");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === work.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.implementation.stage).not.toBe("done"); expect(detail.implementation.outcome).toBe("none");
      expect(detail.approvals.some((approval: { kind: string }) => approval.kind === "review")).toBe(false);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps product understanding approved when a native probe is abandoned", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "product-plan");
      const question = await f.agent(plan, "question", { question: "Which product should we improve?" }).then(r => r.json());
      await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The fictional receipt preview." });
      const before = await f.request(f.prefix).then(r => r.json());
      expect((await f.request(`${f.prefix}/approvals`, { kind: "shared_understanding", revision: before.question_revision, scope: "The fictional receipt preview." })).status).toBe(201);
      await f.request(`/runs/${plan.id}/stop`, {});
      const probe = await f.start("verify-provider", "abandoned-probe");
      await f.agent(probe, "question", { question: "Confirm this native probe?" });
      await f.request(`/runs/${probe.id}/stop`, {});
      const after = await f.request(f.prefix).then(r => r.json());
      expect(after.question_revision).toBe(before.question_revision);
      expect(after.question_context.questions.map((q: { id: string }) => q.id)).toEqual([question.id]);
      const continued = await f.request(`${f.prefix}/continue`, { action: "to-spec", run_id: null, idempotency_key: "continue-product" });
      expect(continued.status).toBe(202);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps a working chat and blocks continuation while a proposal or approval is missing", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "planning");
      await herdrRpc("pane.report_agent", { pane_id: plan.pane_id, source: "manual", agent: "codex", state: "working" });
      const busy = await f.request(`${f.prefix}/continue`, { action: "to-spec", run_id: plan.id, idempotency_key: "busy", allow_partial_handoff: true });
      expect(busy.status).toBe(409); expect(["step_not_ready", "agent_busy"]).toContain((await busy.json()).error.code);
      const unapproved = await f.request(`${f.prefix}/continue`, { action: "implement-spec", run_id: plan.id, idempotency_key: "unapproved" });
      expect(unapproved.status).toBe(409); expect((await unapproved.json()).error.code).toBe("scope_unaccepted");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === plan.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json()); expect(detail.runs.length).toBe(1);
    } finally { await f.close(); }
  }, 60_000);

  it("continues resting planning without closing its chat and reuses a repeated Continue request", async () => {
    const f = await fixture();
    try {
      const plan = await f.start("grill-with-docs", "planning");
      const body = { action: "to-spec", run_id: plan.id, idempotency_key: "continue-plan", allow_partial_handoff: true };
      const response = await f.request(`${f.prefix}/continue`, body);
      const next = await response.json();
      expect(response.status, JSON.stringify(next)).toBe(202); expect(next.action).toBe("to-spec");
      const repeated = await f.request(`${f.prefix}/continue`, body).then(r => r.json());
      expect(repeated.id).toBe(next.id);
      const changed = await f.request(`${f.prefix}/continue`, { ...body, action: "to-tickets" });
      expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("continuation_conflict");
      const snapshot = await sessionSnapshot();
      expect(snapshot.panes.some(pane => pane.pane_id === plan.pane_id)).toBe(true);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.runs.find((run: FactoryRun) => run.id === plan.id).condition).toBe("completed");
      expect(detail.implementation.stage).not.toBe("done");
    } finally { await f.close(); }
  }, 60_000);

  it("allows a replacement verification to consume its own answers without answering an obsolete probe", async () => {
    const f = await fixture();
    try {
      const first = await f.start("verify-provider", "first-probe");
      const oldQuestion = await f.agent(first, "question", { question: "Confirm the first native probe?" }).then(r => r.json());
      expect((await f.request(`/runs/${first.id}/stop`, {})).status).toBe(200);
      const second = await f.start("verify-provider", "second-probe");
      const question = await f.agent(second, "question", { question: "Confirm the replacement native probe?" }).then(r => r.json());
      expect((await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed for the replacement probe." })).status).toBe(200);
      const contract = await f.agent(second, "contract").then(r => r.json());
      expect(contract.questions.map((q: { id: string }) => q.id)).toEqual([question.id]);
      expect((await f.agent(second, "consume", { revision: contract.question_revision })).status).toBe(200);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.questions.find((q: { id: string }) => q.id === oldQuestion.id).answer).toBeNull();
      // An owned stand-in must still never certify a genuine native provider.
      const verification = await f.request(`/runs/${second.id}/verify-provider`, {});
      expect(verification.status).toBe(409);
      expect((await verification.json()).error.code).toBe("native_evidence_required");
    } finally { await f.close(); }
  }, 60_000);
});
