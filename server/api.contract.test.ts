import { nativeSessionRef } from "../shared/native-pane.ts";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConversationMonitor } from "./conversation-monitor.ts";
import { createServer } from "./index.ts";
import type { AgentKind, AgentStatus, ApiError, HealthAuth, IntegrationsResponse, LanExposure, PortalStatus, PushKey, RemoteAccess, SessionSnapshot, TabMoved, PaneFindResponse, PaneReadResult, UsageReport, WorkspaceCreated, WorktreeListing, WorktreeOpened, WorktreeRemoved } from "../shared/protocol.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import { PortalService } from "./portal.ts";
import { noInstalledNotes, unmanagedUpdateStatus, type HerdrUpdateStatus, type InstalledNotes, type UpdateNotes } from "../shared/update.ts";
import { USAGE_PROVIDERS, UsageService } from "./usage.ts";
import { VoiceService } from "./voice.ts";
import { herdrRpc, ping, sessionSnapshot, tabCreate, workspaceCreate, workspaceClose } from "./herdr/client.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { descriptorPath, type BridgeDescriptor } from "./bridge.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import { TailnetIdentitySource } from "./tailscale.ts";
import { forgetTranscriptState } from "./conversation.ts";
import type { FactoryAction, FactoryRun } from "../shared/factory.ts";
import type { FactoryNative } from "./factory-native.ts";
import { githubScheduleFixture } from "./github-schedules.fixture.ts";
import { batchProposal, githubIssueBatchFixture } from "./github-issue-batches.fixture.ts";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";

async function factoryBoardFixture(native: Partial<FactoryNative> = {}) {
  const state = mkdtempSync(join(tmpdir(), "saurons-eye-board-live-")); const repo = join(state, "repo");
  mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned board fixture\n");
  for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Board fixture", "-c", "user.email=board@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
  const workspaces: string[] = [];
  const app = createServer({ port: 0, token: "", stateDir: state, machines: false, factory: { accountDiscoveryHome: state, native: {
    version: async () => "owned-board-fixture",
    createWorkspace: async options => { const result = await herdrRpc<import("./herdr/client.ts").WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); workspaces.push(result.workspace.workspace_id); return result; },
    startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
    ...native,
  } } });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  const project = await request("/projects", { name: "Board Project", path: repo, provider: "codex", machine_id: "local", tracker: "app" });
  const idea = await request("/implementations", { title: "Observable board activity", description: "", project_id: project.id });
  const prefix = `/implementations/${idea.id}`;
  return { app, request, prefix, start: (action: FactoryAction = "work") => request(`${prefix}/runs`, { action, idempotency_key: `board-${action}` }) as Promise<FactoryRun>, close: async () => { app.stop(); for (const id of workspaces) await workspaceClose(id).catch(() => {}); rmSync(state, { recursive: true, force: true }); } };
}

/**
 * Contract test for herdr-web-ui's HTTP + WS surface.
 * Runs against the REAL herdr server on the developer's machine: these are the
 * integration seams the browser UI depends on, so a mock here would prove nothing.
 * Tests never mutate a user's pane; mutation cases create labeled workspaces and close them in afterAll.
 * Every server here keeps its push state (VAPID key, subscriptions) in a temp dir: the
 * user's ~/.config/herdr-web-ui holds their real devices, which a test must never page.
 */
let server: { port: number; stop: () => void };
const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-contract-"));

beforeAll(() => {
  server = createServer({ port: 0, stateDir, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
});

afterAll(() => {
  server?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${server.port}`;

describe("Project queue contract", () => {
  it("reports capacity and rejects foreign or unmarked queue mutations without changing its revision", async () => {
    const f = await githubScheduleFixture();
    try {
      const route = f.route.replace(/\/github$/, "/queue");
      const original = await f.request(route);
      expect(original.status).toBe(200);
      expect(original.body.capacity).toMatchObject({ project_implementations: 0, agents: 0, builds: 0 });
      const body = { expected_revision: original.body.revision, max_implementations: 1, paused: true };
      for (const headers of [{ ...f.headers, origin: "https://fictional-foreign.invalid" }, { "content-type": "application/json" }]) {
        const response = await fetch(f.origin() + "/api/factory" + route + "/configure", { method: "POST", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("invalid_origin");
      }
      expect((await f.request(route)).body.revision).toBe(original.body.revision);
      expect((await f.request(route + "/configure", body)).body.paused).toBe(true);
    } finally { f.close(); }
  });
});

describe("Assignment discard", () => {
  it("does not let an in-flight research acceptance replace the owner's explicit Discard outcome", async () => {
    const f = await factoryDeliveryFixture(true);
    try {
      const run = await f.start();
      f.changeDuringHandoff(async () => {
        expect((await f.request(`${f.prefix}/discard`, {}).then(r => r.json())).outcome).toBe("discarded");
      });
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(409);
      expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("discarded");
    } finally { await f.close(); }
  }, 30_000);
  it("can discard after a child fails before any native workspace is allocated", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      const hook = join(f.repo, ".git", "hooks", "post-checkout");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "provisioning-failed" }).then(r => r.json());
      expect(worker).toMatchObject({ condition: "failed", workspace_id: null, pane_id: null });
      const response = await f.request(`${f.prefix}/discard`, {});
      expect(await response.json()).toMatchObject({ stage: "done", outcome: "discarded" });
      expect((await f.request(f.prefix).then(r => r.json())).workers[0].condition).toBe("failed");
    } finally { await f.close(); }
  }, 30_000);
  it("keeps capacity reserved while a pending Discard observes a resting but still owned remote Run", async () => {
    const f = await factoryDeliveryFixture(true);
    try {
      await f.request("/settings", { max_agents: 1 });
      await f.start();
      f.disconnect();
      await f.request(`${f.prefix}/discard`, {});
      f.reconnect();
      const next = await f.request("/implementations", { title: "Wait for owned stop", description: "", project_id: f.project.id }).then(r => r.json());
      const response = await f.request(`/implementations/${next.id}/runs`, { action: "work", idempotency_key: "reserved-until-stopped" });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("capacity_exhausted");
      expect((await f.request(`${f.prefix}/discard`, {}).then(r => r.json())).outcome).toBe("discarded");
      expect((await f.request(`/implementations/${next.id}/runs`, { action: "work", idempotency_key: "capacity-after-stop" })).status).toBe(202);
    } finally { await f.close(); }
  }, 30_000);
  it("continues stopping other owned contexts when one child's stop is uncertain", async () => {
    let heldWorkspace = "";
    const f = await factoryDeliveryFixture(false, false, { closeWorkspace: async id => { if (id !== heldWorkspace) await workspaceClose(id); } });
    try {
      const run = await f.start();
      const held = await f.request(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "held-child" }).then(r => r.json());
      heldWorkspace = held.workspace_id;
      const other = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "other-child" }).then(r => r.json());
      expect((await f.request(`${f.prefix}/discard`, {}).then(r => r.json())).outcome).toBe("none");
      const snapshot = await sessionSnapshot();
      expect(snapshot.panes.some(pane => pane.pane_id === held.pane_id)).toBe(true);
      expect(snapshot.panes.some(pane => pane.pane_id === other.pane_id || pane.pane_id === run.pane_id)).toBe(false);
      heldWorkspace = "";
      expect((await f.request(`${f.prefix}/discard`, {}).then(r => r.json())).outcome).toBe("discarded");
    } finally { await f.close(); }
  }, 30_000);
  it("cancels an owned build and reconciles a lost check response before completing Discard", async () => {
    const started = Promise.withResolvers<void>();
    const observed = Bun.serve({ port: 0, fetch() { started.resolve(); return new Response("Observed owned build"); } });
    const f = await factoryDeliveryFixture(true);
    let checkResponse: Promise<Response> | undefined;
    try {
      await f.request(`/projects/${f.project.id}/configure`, { checks: [[process.execPath, "-e", `await fetch('http://localhost:${observed.port}'); setInterval(() => {}, 1000);`]] });
      const run = await f.start();
      f.loseCheckResponse();
      checkResponse = f.request(`/runs/${run.id}/checks`, {});
      await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned build did not start")), 5000))]);
      await f.request(`${f.prefix}/discard`, {});
      const interrupted = await (await checkResponse).json();
      expect(interrupted.condition).toBe("interrupted");
      const reconciled = await f.request(`${f.prefix}/discard`, {});
      expect(await reconciled.json()).toMatchObject({ stage: "done", outcome: "discarded" });
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.checks).toHaveLength(1);
      expect(detail.checks[0]).toMatchObject({ id: interrupted.id, condition: "failed" });
      expect(detail.checks[0].commands[0].exit_code).not.toBe(0);
      expect(detail.board).toMatchObject({ lane: "done", sidebar_hidden: true });
    } finally { await f.close(); observed.stop(); await checkResponse?.catch(() => {}); }
  }, 30_000);
  it("requires a fresh observation of closed native identities instead of trusting a stop acknowledgement", async () => {
    let closeConfirmed = false;
    const f = await factoryDeliveryFixture(false, false, { closeWorkspace: async id => { if (closeConfirmed) await workspaceClose(id); } });
    try {
      const run = await f.start();
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "unconfirmed-stop" }).then(r => r.json());
      const response = await f.request(`${f.prefix}/discard`, {});
      expect(response.status).toBe(200);
      expect((await response.json()).outcome).toBe("none");
      const pending = await f.request(f.prefix).then(r => r.json());
      expect(pending.board).toMatchObject({ lane: "needs_you", activity: "discard_pending", sidebar_hidden: false });
      expect(pending.workers[0].condition).toBe("disconnected");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === worker.pane_id)).toBe(true);
      expect((await f.request(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "no-work-during-discard" })).status).toBe(409);
      closeConfirmed = true;
      expect((await f.request(`${f.prefix}/discard`, {}).then(r => r.json())).outcome).toBe("discarded");
      expect((await sessionSnapshot()).panes.some(pane => pane.pane_id === worker.pane_id || pane.pane_id === run.pane_id)).toBe(false);
    } finally { await f.close(); }
  }, 30_000);
  it("retains an unreachable Run and child as Discard pending until the owner reconciles them", async () => {
    const f = await factoryDeliveryFixture(true);
    try {
      const run = await f.start();
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "remote-discard-child" }).then(r => r.json());
      f.disconnect();
      const pending = await f.request(`${f.prefix}/discard`, {});
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({ outcome: "none", discard_requested_at: expect.any(String) });
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.board).toMatchObject({ lane: "needs_you", activity: "discard_pending", sidebar_hidden: false });
      expect(detail.runs[0].condition).toBe("disconnected");
      expect(detail.workers.find((entry: { id: string }) => entry.id === worker.id).condition).toBe("disconnected");
      expect((await f.start("discard-must-not-restart") as any).error.code).toBe("assignment_discarded");
      f.reconnect();
      const reconciled = await f.request(`${f.prefix}/discard`, {});
      expect(reconciled.status).toBe(200);
      expect(await reconciled.json()).toMatchObject({ stage: "done", outcome: "discarded" });
      const finished = await f.request(f.prefix).then(r => r.json());
      expect(finished.board).toMatchObject({ lane: "done", sidebar_hidden: true });
      expect(finished.runs[0].condition).toBe("cancelled");
      expect(finished.workers[0].condition).toBe("cancelled");
    } finally { await f.close(); }
  }, 30_000);
  it("stops owned native work and retains the Assignment's evidence without archiving or deleting its branch", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      const worker = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "discard-child" }).then(r => r.json());
      const before = await f.request(f.prefix).then(r => r.json());
      const artifact = await f.request(`${f.prefix}/artifacts`, { chat_id: before.chats[0].id, name: "findings.md", media_type: "text/markdown", content_base64: Buffer.from("Retained findings\n").toString("base64") }).then(r => r.json());
      writeFileSync(join(run.worktree!, "unfinished.md"), "Retained repository work\n");
      const snapshot = await f.request(`${f.prefix}/snapshots`, { run_id: run.id, mode: "workspace" }).then(r => r.json());
      const response = await f.request(`${f.prefix}/discard`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stage: "done", outcome: "discarded" });
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.board).toMatchObject({ lane: "done", busy: false });
      expect(detail.implementation.archived_at ?? null).toBeNull();
      expect(detail.runs[0].condition).toBe("cancelled");
      expect(detail.workers.find((entry: { id: string }) => entry.id === worker.id).condition).toBe("cancelled");
      expect(detail.chats).toEqual(before.chats);
      expect(detail.artifacts.some((entry: { id: string }) => entry.id === artifact.id)).toBe(true);
      expect(detail.snapshots.some((entry: { id: string }) => entry.id === snapshot.id)).toBe(true);
      expect(f.git(["branch", "--show-current"], run.worktree! ).trim()).toBe(run.branch!);
      expect(readFileSync(join(run.worktree!, "unfinished.md"), "utf8")).toBe("Retained repository work\n");
      expect((await f.request(`${f.prefix}/discard`, {})).status).toBe(200);
    } finally { await f.close(); }
  }, 30_000);
});

describe("GitHub planned issue batch publication", () => {
  it("retains a scoped planning Run's whole issue proposal without granting remote publication", async () => {
    let proposalStatus: number | undefined;
    const f = await factoryBoardFixture({ startAgent: async options => {
      const cwd = options.args![1]!;
      const access = JSON.parse(readFileSync(join(cwd, ".saurons-eye-access.json"), "utf8"));
      const response = await fetch(access.url + "/issue-batch", { method: "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(batchProposal) });
      proposalStatus = response.status;
      expect((await fetch(access.url + "/issue-batch/publish", { method: "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: "{}" })).status).toBe(404);
      await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" });
    } });
    try {
      const run = await f.start("grill-with-docs");
      expect(proposalStatus).toBe(201); expect(run.condition).toBe("working");
      const proposed = await f.request(f.prefix + "/issue-batches");
      expect(proposed.batches).toHaveLength(1);
      expect(proposed.batches[0]).toMatchObject({ run_id: run.id, condition: "proposed", dispatch_ready: false, items: batchProposal.items });
    } finally { await f.close(); }
  });

  it("requires origin and owner mutation headers for reviewing, publishing and resuming the exact batch", async () => {
    const f = await githubIssueBatchFixture();
    try {
      const policy = (await f.request(f.githubRoute + "/configure", f.policy)).body;
      const batch = (await f.request(f.route, batchProposal)).body;
      const proof = { revision: batch.revision, policy_revision: policy.revision };
      const endpoint = f.origin() + "/api/factory" + f.route + "/" + batch.id;
      for (const action of ["review", "publish", "resume"]) {
        for (const headers of [{ "content-type": "application/json", "x-herdr-factory": "1" }, { ...f.headers, origin: "https://fictional-other.invalid" }]) {
          const response = await fetch(`${endpoint}/${action}`, { method: "POST", headers, body: JSON.stringify(proof) });
          expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("invalid_origin");
        }
      }
      expect((await f.request(`${f.route}/${batch.id}/publish`, proof)).body.error.code).toBe("issue_batch_review_required");
      expect((await f.request(`${f.route}/${batch.id}/resume`, proof)).body.error.code).toBe("issue_batch_review_required");
      expect(f.calls().some(args => args.includes("POST") || args.includes("PATCH"))).toBe(false);
      expect((await f.request(`${f.route}/${batch.id}/review`, proof)).status).toBe(200);
      const published = await f.request(`${f.route}/${batch.id}/publish`, proof);
      expect(published.status).toBe(200); expect(published.body.condition).toBe("confirmed");
      const before = f.calls().length;
      const resumed = await f.request(`${f.route}/${batch.id}/resume`, proof);
      expect(resumed.status).toBe(200); expect(resumed.body).toEqual(published.body);
      expect(f.calls()).toHaveLength(before);
    } finally { f.close(); }
  });
});

describe("Assignment delivery policy", () => {
  it("rejects invalid delivery branches instead of freezing an undeliverable Assignment scope", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const response = await f.request(`/projects/${f.project.id}/configure`, { delivery_branch: "delivery/.hidden" });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_delivery_branch");
      expect((await f.request("").then(r => r.json())).projects.find((project: { id: string }) => project.id === f.project.id).delivery_branch).toBe("main");
    } finally { await f.close(); }
  }, 30_000);
  it("retains repository-change evidence from an earlier review even if the current worktree is reset clean", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      writeFileSync(join(run.worktree!, "findings.md"), "Retained intended repository change\n");
      f.git(["add", "findings.md"], run.worktree!);
      f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "retained findings"], run.worktree!);
      const review = await f.request(`${f.prefix}/snapshots`, { run_id: run.id, mode: "branch" }).then(r => r.json());
      expect(review.files.some((entry: { path: string }) => entry.path === "findings.md")).toBe(true);
      f.git(["reset", "--hard", run.base!], run.worktree!);
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("repository_delivery_required");
      expect((await f.request(f.prefix).then(r => r.json())).snapshots.some((entry: { id: string }) => entry.id === review.id)).toBe(true);
    } finally { await f.close(); }
  }, 30_000);
  it("keeps inspected no-change research in Needs you until the owner explicitly accepts it", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      await f.request(`/runs/${run.id}/stop`, {});
      expect((await f.request(`${f.prefix}/completion-evidence`).then(r => r.json())).repository_changes).toBe("none");
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.board).toMatchObject({ lane: "needs_you", activity: "researching", busy: false });
      expect(detail.board.waiting_reason).toContain("Accept");
      expect(detail.implementation.stage).not.toBe("done");
      expect((await f.request(`${f.prefix}/complete-work`, { run_id: run.id })).status).toBe(200);
    } finally { await f.close(); }
  }, 30_000);
  it("rejects research acceptance when repository changes arrive during native handoff capture", async () => {
    const f = await factoryDeliveryFixture(true);
    try {
      const run = await f.start();
      f.changeDuringHandoff(() => writeFileSync(join(run.worktree!, "late-findings.md"), "Late repository documentation\n"));
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("repository_delivery_required");
      expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
    } finally { await f.close(); }
  }, 30_000);
  it("accepts reviewed repository work while keeping the Assignment awaiting delivery", async () => {
    const f = await factoryDeliveryFixture(true, true);
    try {
      await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
      const run = await f.start();
      writeFileSync(join(run.worktree!, "findings.md"), "Reviewed repository change\n");
      f.git(["add", "findings.md"], run.worktree!);
      f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "reviewed findings"], run.worktree!);
      const head = f.git(["rev-parse", "HEAD"], run.worktree!).trim(); f.setReviewHead(head);
      expect((await f.request(`/runs/${run.id}/checks`, {})).status).toBe(200);
      for (const role of ["standards", "spec"]) {
        const worker = await f.request(`/runs/${run.id}/workers`, { role, idempotency_key: `delivery-${role}` }).then(r => r.json());
        expect((await f.request(`/runs/${run.id}/workers/${worker.id}/review-evidence`, {})).status).toBe(200);
      }
      expect((await f.request(`/runs/${run.id}/accept`, { head })).status).toBe(200);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.implementation).toMatchObject({ stage: "review", outcome: "implementation_complete" });
      expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge", busy: false });
      expect(detail.runs[0].condition).toBe("completed");
    } finally { await f.close(); }
  }, 30_000);
  it("reports an unavailable Machine as unknown and requires owner attention instead of accepting research", async () => {
    const f = await factoryDeliveryFixture(true);
    try {
      const run = await f.start();
      expect(run.condition).toBe("working");
      f.disconnect();
      const inspection = await f.request(`${f.prefix}/completion-evidence`);
      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({ repository_changes: "unknown", quiescent: false });
      expect((await f.request(`${f.prefix}/complete-work`, { run_id: run.id })).status).toBe(409);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.board).toMatchObject({ lane: "needs_you" });
      expect(detail.board.waiting_reason).toContain("Reconnect");
      expect(detail.implementation.stage).not.toBe("done");
    } finally { await f.close(); }
  }, 30_000);
  it("requires delivery for changes retained in a stopped child even when the parent has no changes", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      const workerResponse = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "research-child" });
      expect(workerResponse.status).toBe(200);
      const worker = await workerResponse.json();
      writeFileSync(join(worker.worktree, "child-findings.md"), "Retained child documentation\n");
      expect((await f.request(`/runs/${run.id}/workers/${worker.id}/stop`, {})).status).toBe(200);
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("repository_delivery_required");
      expect((await f.request(f.prefix).then(r => r.json())).implementation.completion_evidence.repository_changes).toBe("changes");
    } finally { await f.close(); }
  }, 30_000);
  it("accepts app-held research only after verifying no repository changes and resting owned work", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      const detail = await f.request(f.prefix).then(r => r.json());
      const artifact = await f.request(`${f.prefix}/artifacts`, { chat_id: detail.chats[0].id, name: "research.md", media_type: "text/markdown", content_base64: Buffer.from("App-held research\n").toString("base64") }).then(r => r.json());
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stage: "done", outcome: "research_accepted", completion_evidence: { repository_changes: "none", quiescent: true } });
      const completed = await f.request(f.prefix).then(r => r.json());
      expect(completed.artifacts.some((entry: { id: string }) => entry.id === artifact.id)).toBe(true);
      expect(completed.board.lane).toBe("done");
      expect((await f.request(`${f.prefix}/complete-work`, { run_id: run.id })).status).toBe(200);
    } finally { await f.close(); }
  }, 30_000);
  it("rejects manual completion of committed documentation despite a clean worktree", async () => {
    const f = await factoryDeliveryFixture();
    try {
      const run = await f.start();
      writeFileSync(join(run.worktree!, "findings.md"), "Research intended for repository delivery\n");
      f.git(["add", "findings.md"], run.worktree!);
      f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "retain findings"], run.worktree!);
      const response = await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("repository_delivery_required");
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.implementation.stage).not.toBe("done");
      expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge", busy: false });
      expect(detail.board.waiting_reason).toContain("delivery");
    } finally { await f.close(); }
  }, 30_000);
  it("defaults to verified merge and freezes the repository, branch and milestone on first start", async () => {
    const f = await factoryDeliveryFixture();
    try {
      expect(f.project).toMatchObject({ delivery_policy: "merge", delivery_branch: "main" });
      expect((await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "release", delivery_branch: "stable" })).status).toBe(200);
      const run = await f.start();
      const scope = { milestone: "release", repository: f.project.repository, branch: "stable", base: run.base };
      expect((await f.request(f.prefix).then(r => r.json())).implementation.delivery_scope).toEqual(scope);
      await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "merge", delivery_branch: "main" });
      await f.request(`/runs/${run.id}/stop`, {});
      const next = await f.start("delivery-successor");
      expect((await f.request(f.prefix).then(r => r.json())).implementation.delivery_scope).toEqual(scope);
      expect((next.manifest as any).implementation.delivery_scope).toEqual(scope);
    } finally { await f.close(); }
  }, 30_000);
});

describe("GitHub issue readiness", () => {
  it("binds issue readiness to the owner-approved revision and current Project scope across restart", async () => {
    const f = await githubScheduleFixture();
    try {
      const issue = { number: 12, node_id: "fictional-ready-12", title: "Retain decisions", body: "Keep local notes", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      const source = (await f.request(f.route + "/sync", {})).body.sources[0];
      const proof = { policy_revision: policy.revision, issue_revision: source.revision, plan: { acceptance_criteria: "Keep local notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] } };
      const endpoint = f.origin() + "/api/factory" + f.route + "/issues/12/approve";
      const foreign = await fetch(endpoint, { method: "POST", headers: { ...f.headers, origin: "https://foreign.invalid" }, body: JSON.stringify(proof) });
      expect(foreign.status).toBe(403); expect((await foreign.json()).error.code).toBe("invalid_origin");
      const missingHeader = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(proof) });
      expect(missingHeader.status).toBe(403);
      const incomplete = await f.request(f.route + "/issues/12/approve", { ...proof, plan: { ...proof.plan, testing_seams: [] } });
      expect(incomplete.status).toBe(400); expect(incomplete.body.error.code).toBe("github_plan_required");
      const approved = await f.request(f.route + "/issues/12/approve", proof);
      expect(approved.status).toBe(200); expect(approved.body.sources[0].readiness.eligible).toBe(true);
      f.restart();
      expect((await f.request(f.route)).body.sources[0].readiness.eligible).toBe(true);
      const projectId = f.route.split("/")[2];
      expect((await f.request(`/projects/${projectId}/configure`, { account_bindings: { local: { github: f.policy.account_profile_id } } })).status).toBe(200);
      expect((await f.request(f.route)).body.sources[0].readiness.eligible).toBe(false);
    } finally { f.close(); }
  });
});

describe("Project schedules", () => {
  it("offers disabled built-in defaults without enabling GitHub policy", async () => {
    const f = await githubScheduleFixture();
    try {
      const response = await f.request(f.route + "/schedules");
      expect(response.status).toBe(200);
      expect(response.body.schedules).toMatchObject([
        { job: "github_sync", enabled: false, cadence: "interval", interval_minutes: 15, time_zone: "America/Mexico_City", next_execution: null },
        { job: "upstream_sync", enabled: false, cadence: "daily", local_time: "03:00", time_zone: "America/Mexico_City", next_execution: null },
      ]);
      expect((await f.request(f.route)).body.policy).toBeNull();
    } finally { f.close(); }
  });
  it("preserves existing polling and saves a daily due time in the selected time zone across restart", async () => {
    const f = await githubScheduleFixture();
    try {
      expect((await f.request(f.route + "/configure", { ...f.policy, poll_minutes: 30 })).status).toBe(200);
      expect((await f.request(f.route + "/schedules")).body.schedules[0].interval_minutes).toBe(30);
      const saved = await f.request(f.route + "/schedules/configure", { job: "upstream_sync", expected_revision: null, enabled: true, cadence: "daily", interval_minutes: 1440, local_time: "03:00", time_zone: "America/Mexico_City" });
      expect(saved.status).toBe(200);
      expect(saved.body.schedules[1]).toMatchObject({ enabled: true, time_zone: "America/Mexico_City", next_execution: "2026-10-14T09:00:00.000Z" });
      f.restart();
      expect((await f.request(f.route + "/schedules")).body).toEqual(saved.body);
      expect((await f.request(f.route)).body.policy).toMatchObject({ sync_enabled: false, poll_minutes: 30 });
    } finally { f.close(); }
  });
  it("performs one overdue catch-up and shares result ownership with Run now", async () => {
    const f = await githubScheduleFixture();
    try {
      await f.request(f.route + "/configure", f.policy);
      const configured = await f.request(f.route + "/schedules/configure", { job: "github_sync", expected_revision: null, enabled: true, cadence: "interval", interval_minutes: 15, local_time: "03:00", time_zone: "America/Mexico_City" });
      expect(configured.status).toBe(200);
      f.advance("2026-10-17T08:59:00Z"); f.restart();
      await f.tick(); await f.tick();
      const caughtUp = (await f.request(f.route + "/schedules")).body;
      expect(caughtUp.results).toMatchObject([{ job: "github_sync", trigger: "scheduled", condition: "succeeded" }]);
      expect(caughtUp.schedules[0].next_execution).toBe("2026-10-17T09:14:00.000Z");
      expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(1);
      expect((await f.request(f.route + "/sync", {})).status).toBe(200);
      expect((await f.request(f.route + "/schedules")).body.results).toMatchObject([
        { trigger: "scheduled", condition: "succeeded" }, { trigger: "manual", condition: "succeeded" },
      ]);
    } finally { f.close(); }
  });
  it("shows bounded retry backoff and requires an explicit sync after retries are exhausted", async () => {
    const f = await githubScheduleFixture();
    try {
      await f.request(f.route + "/configure", f.policy);
      await f.request(f.route + "/schedules/configure", { job: "github_sync", expected_revision: null, enabled: true, cadence: "interval", interval_minutes: 15, local_time: "03:00", time_zone: "America/Mexico_City" });
      writeFileSync(f.responses, JSON.stringify({ fail: true }));
      f.advance("2026-10-14T09:14:00Z"); await f.tick();
      const failed = (await f.request(f.route + "/schedules")).body;
      expect(failed.schedules[0]).toMatchObject({ condition: "failed", failure_count: 1, retry_at: "2026-10-14T09:15:00.000Z", next_execution: "2026-10-14T09:15:00.000Z" });
      expect(failed.results[0]).toMatchObject({ condition: "failed", problem: expect.any(String) });
      await f.tick(); expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(1);
      for (const time of ["09:15", "09:17", "09:21"]) { f.advance(`2026-10-14T${time}:00Z`); await f.tick(); }
      expect((await f.request(f.route + "/schedules")).body.schedules[0]).toMatchObject({ failure_count: 4, retry_at: null, next_execution: null });
      f.advance("2026-10-15T09:22:00Z"); f.restart(); await f.tick();
      expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(4);
      writeFileSync(f.responses, "{}"); expect((await f.request(f.route + "/sync", {})).status).toBe(200);
      expect((await f.request(f.route + "/schedules")).body.schedules[0]).toMatchObject({ condition: "idle", failure_count: 0, retry_at: null, next_execution: "2026-10-15T09:37:00.000Z" });
    } finally { f.close(); }
  });
  it("retains an interrupted sync's ownership until explicit reconciliation and never overlaps Run now", async () => {
    const f = await githubScheduleFixture(); let pending: Promise<void> | undefined;
    try {
      await f.request(f.route + "/configure", f.policy);
      await f.request(f.route + "/schedules/configure", { job: "github_sync", expected_revision: null, enabled: true, cadence: "interval", interval_minutes: 15, local_time: "03:00", time_zone: "America/Mexico_City" });
      writeFileSync(f.responses, JSON.stringify({ pause: true }));
      f.advance("2026-10-14T09:14:00Z"); pending = f.tick();
      const deadline = Date.now() + 5000;
      while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(f.root, "reading"))).toBe(true);
      const running = (await f.request(f.route + "/schedules")).body;
      expect(running.schedules[0].condition).toBe("running");
      expect((await f.request(f.route + "/sync", {})).status).toBe(409);
      await f.tick(); expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(1);
      f.restart(); writeFileSync(join(f.root, "continue"), "continue"); await pending;
      const interrupted = (await f.request(f.route + "/schedules")).body;
      expect(interrupted.schedules[0]).toMatchObject({ condition: "uncertain", next_execution: null });
      expect(interrupted.results[0].condition).toBe("uncertain");
      f.advance("2026-10-15T09:14:00Z"); await f.tick();
      expect((await f.request(f.route + "/sync", {})).status).toBe(409);
      expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(1);
      const reconciled = await f.request(f.route + "/schedules/reconcile", { job: "github_sync", result_id: running.results[0].id });
      expect(reconciled.status).toBe(200);
      expect(reconciled.body.schedules[0]).toMatchObject({ condition: "idle", next_execution: "2026-10-15T09:29:00.000Z" });
      expect(reconciled.body.results).toMatchObject([{ condition: "reconciled" }, { trigger: "reconcile", condition: "succeeded" }]);
    } finally { writeFileSync(join(f.root, "continue"), "continue"); await pending; f.close(); }
  });
  it("keeps legacy GitHub controls and saved schedules consistent when the owner explicitly disables polling", async () => {
    const f = await githubScheduleFixture();
    try {
      await f.request(f.route + "/configure", f.policy);
      await f.request(f.route + "/schedules/configure", { job: "github_sync", expected_revision: null, enabled: true, cadence: "interval", interval_minutes: 15, local_time: "03:00", time_zone: "America/Mexico_City" });
      const policy = (await f.request(f.route)).body.policy;
      expect((await f.request(f.route + "/configure", { ...f.policy, expected_revision: policy.revision, poll_minutes: 60, sync_enabled: false })).status).toBe(200);
      expect((await f.request(f.route + "/schedules")).body.schedules[0]).toMatchObject({ enabled: false, interval_minutes: 60, next_execution: null });
      f.advance("2026-10-17T08:59:00Z"); await f.tick();
      expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(0);
    } finally { f.close(); }
  });
  it("runs daily sync once per local date across a daylight-saving repeated hour", async () => {
    const f = await githubScheduleFixture();
    try {
      await f.request(f.route + "/configure", f.policy); f.advance("2026-11-01T05:29:00Z");
      const response = await f.request(f.route + "/schedules/configure", { job: "github_sync", expected_revision: null, enabled: true, cadence: "daily", interval_minutes: 15, local_time: "01:30", time_zone: "America/New_York" });
      expect(response.body.schedules[0].next_execution).toBe("2026-11-01T05:30:00.000Z");
      f.advance("2026-11-01T05:30:00Z"); await f.tick();
      expect((await f.request(f.route + "/schedules")).body.schedules[0].next_execution).toBe("2026-11-02T06:30:00.000Z");
      f.advance("2026-11-01T06:30:00Z"); await f.tick();
      expect(f.calls().filter(args => args[1] === "graphql")).toHaveLength(1);
    } finally { f.close(); }
  });
  it("rejects stale, invalid and foreign-origin schedule changes without enabling any job", async () => {
    const f = await githubScheduleFixture();
    try {
      const value = { job: "upstream_sync", expected_revision: null, enabled: false, cadence: "daily", interval_minutes: 1440, local_time: "03:00", time_zone: "America/Mexico_City" };
      for (const invalid of [{ time_zone: "fictional/invalid" }, { local_time: "24:00" }, { interval_minutes: 0 }, { job: "shell" }, { enabled: "true" }]) {
        const response = await f.request(f.route + "/schedules/configure", { ...value, ...invalid });
        expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_schedule");
      }
      expect((await f.request(f.route + "/schedules/configure", value)).status).toBe(200);
      expect((await f.request(f.route + "/schedules/configure", { ...value, enabled: true })).status).toBe(409);
      for (const action of ["configure", "run", "reconcile"]) {
        const response = await fetch(f.origin() + "/api/factory" + f.route + "/schedules/" + action, { method: "POST", headers: { ...f.headers, origin: "https://fictional-foreign.invalid" }, body: JSON.stringify(value) });
        expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("invalid_origin");
      }
      expect((await f.request(f.route + "/schedules")).body.schedules.every((schedule: { enabled: boolean }) => !schedule.enabled)).toBe(true);
    } finally { f.close(); }
  });
  it("keeps failed reconciliation uncertain through settings edits and clears only verified recovery", async () => {
    const f = await githubScheduleFixture(); let pending: Promise<void> | undefined;
    try {
      await f.request(f.route + "/configure", { ...f.policy, sync_enabled: true });
      writeFileSync(f.responses, JSON.stringify({ pause: true })); f.advance("2026-10-14T09:04:00Z"); pending = f.tick();
      const deadline = Date.now() + 5000;
      while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(f.root, "reading"))).toBe(true);
      f.restart(); writeFileSync(join(f.root, "continue"), "continue"); await pending;
      const first = (await f.request(f.route + "/schedules")).body;
      const oldResult = first.results.at(-1).id;
      writeFileSync(f.responses, JSON.stringify({ fail: true }));
      expect((await f.request(f.route + "/schedules/reconcile", { job: "github_sync", result_id: oldResult })).status).toBe(409);
      const schedule = (await f.request(f.route + "/schedules")).body.schedules[0];
      expect((await f.request(f.route + "/schedules/configure", { ...schedule, expected_revision: schedule.revision, enabled: false })).status).toBe(200);
      expect((await f.request(f.route + "/schedules")).body.schedules[0]).toMatchObject({ condition: "uncertain", retry_at: null, next_execution: null });
      expect((await f.request(f.route + "/schedules/reconcile", { job: "github_sync", result_id: oldResult })).status).toBe(409);
      writeFileSync(f.responses, "{}");
      const latestResult = (await f.request(f.route + "/schedules")).body.results.at(-1).id;
      const recovered = await f.request(f.route + "/schedules/reconcile", { job: "github_sync", result_id: latestResult });
      expect(recovered.status).toBe(200);
      expect(recovered.body.results.map((result: { condition: string }) => result.condition)).toEqual(["reconciled", "reconciled", "succeeded"]);
    } finally { writeFileSync(join(f.root, "continue"), "continue"); await pending; f.close(); }
  });

});

describe("shared browser preferences", () => {
  it("requires owner controls and a scoped request for workflow continuation", async () => {
    const path = `${base()}/api/factory/implementations/00000000-0000-0000-0000-000000000000/continue`;
    const denied = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(403);
    const invalid = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: "{}" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_continuation");
  });

  it("keeps unexpected persistence errors opaque", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-preferences-error-"));
    const app = createServer({ port: 0, stateDir: state });
    try {
      mkdirSync(join(state, "preferences.json"));
      const response = await fetch(`http://localhost:${app.port}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { theme: "light" } }) });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.error.code).toBe("internal_error");
      expect(body.error.message).toMatch(/^internal error \([0-9a-f]+\)$/);
      expect(JSON.stringify(body)).not.toContain(state);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });

  it("persists shared choices, broadcasts them, and rejects unauthorized changes", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-preferences-api-"));
    const app = createServer({ port: 0, stateDir: state, token: "preferences-fixture-token" });
    const origin = `http://localhost:${app.port}`;
    const headers = { authorization: "Bearer preferences-fixture-token", "content-type": "application/json", origin };
    let stream: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      expect((await fetch(`${origin}/api/preferences`)).status).toBe(401);
      const first = await fetch(`${origin}/api/preferences`, { headers });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json()).toEqual({ revision: 0, settings: {} });
      stream = await fetch(`${origin}/api/machines/events`, { headers });
      reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      // SSE's initial document can share a chunk with the machine roster.
      let events = "";
      const readUntil = async (text: string) => {
        const deadline = Date.now() + 5000;
        while (!events.includes(text)) {
          const chunk = await Promise.race([reader!.read(), new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Preferences event timed out")), Math.max(1, deadline - Date.now()));
            timeout.unref();
          })]);
          if (chunk.done) throw new Error("Preferences stream ended");
          events += decoder.decode(chunk.value, { stream: true });
        }
      };
      await readUntil('"revision":0');
      const put = (body: unknown, extra: Record<string, string> = {}) => fetch(`${origin}/api/preferences`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      expect((await put({ settings: { theme: "light" } }, { origin: "https://elsewhere.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await put({ settings: [] })).status).toBe(400);
      const changed = await put({ settings: { theme: "light" }, pins: ["local:p-fixture"] });
      expect(changed.status).toBe(200);
      const document = await changed.json();
      expect(document).toEqual({ revision: 1, settings: { theme: "light" }, pins: ["local:p-fixture"] });
      await readUntil('"revision":1');
      expect(events).toContain('"type":"preferences"');
      expect(await (await fetch(`${origin}/api/preferences`, { headers })).json()).toEqual(document);
      expect(JSON.parse(readFileSync(join(state, "preferences.json"), "utf8"))).toEqual(document);
    } finally { await reader?.cancel(); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("HTML file previews", () => {
  it("renders owned HTML under a sandbox and refuses cross-site subresource reads", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-html-api-"));
    const file = join(state, "preview.html");
    writeFileSync(file, "<!doctype html><title>Owned preview</title><h1>Fixture</h1>");
    const app = createServer({ port: 0, stateDir: join(state, "app") });
    const url = `http://localhost:${app.port}/api/fs/file?path=${encodeURIComponent(file)}`;
    try {
      const raw = await fetch(url);
      expect(raw.headers.get("content-type")).toStartWith("text/plain");
      const page = await fetch(`${url}&render=1`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toStartWith("text/html");
      const policy = page.headers.get("content-security-policy")!;
      expect(policy).toStartWith("sandbox allow-scripts;");
      expect(policy).not.toContain("allow-same-origin");
      expect(await page.text()).toContain("Owned preview");
      const refused = await fetch(`${url}&render=1`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "iframe" } });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "cross_site" } });
      const navigated = await fetch(`${url}&render=1`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
      expect(navigated.status).toBe(200);
      expect(navigated.headers.get("content-type")).toStartWith("text/html");
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("factory records", () => {
  it("projects an untouched Assignment into Inbox without empty Ticket progress", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-board-"));
    const app = createServer({ port: 0, token: "", stateDir: state, machines: false, factory: { accountDiscoveryHome: state } });
    try {
      const idea = await fetch(`http://localhost:${app.port}/api/factory/implementations`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ title: "Unselected idea", description: "Retain the owner's idea" }) }).then(r => r.json());
      const overview = await fetch(`http://localhost:${app.port}/api/factory?navigation=1`).then(r => r.json());
      expect(overview.board).toEqual([{ implementation_id: idea.id, lane: "inbox", activity: null, condition: null, run_id: null, busy: false, waiting_reason: null, ticket_progress: null }]);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r => r.json());
      expect(detail.board).toEqual(overview.board[0]);
      expect(detail.implementation.stage).toBe("inbox");
      expect(detail.messages[0].content).toBe("Retain the owner's idea");
      await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}/questions`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ question: "Choose the public behavior before starting" }) });
      const asked = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r => r.json());
      expect(asked.board).toMatchObject({ lane: "needs_you", condition: "needs_you", busy: false, waiting_reason: "Choose the public behavior before starting", run_id: null });
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("queues an approved Ticket graph with meaningful zero-completed progress", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-board-plan-"));
    const app = createServer({ port: 0, token: "", stateDir: state, machines: false, factory: { accountDiscoveryHome: state } });
    const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(r => r.json());
    try {
      const idea = await request("/implementations", { title: "Approved bounded work", description: "" });
      const prefix = `/implementations/${idea.id}`;
      const specification = await request(`${prefix}/specifications`, { content: "Two independently observable behaviors" });
      expect((await request(prefix)).board).toMatchObject({ lane: "needs_you", activity: "specifying", busy: false, run_id: null });
      await request(`${prefix}/approvals`, { kind: "specification", revision: specification.id, scope: "Owned fixture scope" });
      const graph = await request(`${prefix}/tickets`, { specification_id: specification.id, tickets: [{ key: "first", title: "First behavior", acceptance: "First public outcome", dependencies: [] }, { key: "second", title: "Second behavior", acceptance: "Second public outcome", dependencies: [] }] });
      await request(`${prefix}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Owned fixture graph" });
      const detail = await request(prefix);
      expect(detail.board).toMatchObject({ lane: "queued", activity: null, busy: false, ticket_progress: { completed: 0, total: 2 } });
      expect((await request("")).board.find((entry: { implementation_id: string }) => entry.implementation_id === idea.id)).toEqual(detail.board);
      expect(detail.implementation.stage).toBe("ready");
      expect(detail.events.some((event: { kind: string }) => event.kind === "specification_created")).toBe(true);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it.each([["to-spec", "specifying"], ["work", "implementing"], ["verify-provider", "validating"]] as const)("shows %s as Running with readable %s activity", async (action, activity) => {
    const f = await factoryBoardFixture();
    try {
      const run = await f.start(action);
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "running", activity, condition: "working", run_id: run.id, busy: true, ticket_progress: null });
    } finally { await f.close(); }
  }, 30_000);
  it("keeps connection recovery Running and exposes unresolved interruption as Needs you", async () => {
    let unavailable = false;
    const f = await factoryBoardFixture({ snapshot: async () => { if (unavailable) throw new Error("Owned connection is recovering"); return sessionSnapshot(); } });
    try {
      const run = await f.start();
      unavailable = true;
      await f.request(`/runs/${run.id}/reconcile`, {});
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "running", activity: "implementing", condition: "disconnected", busy: true });
      unavailable = false;
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "claude", state: "idle" });
      await f.request(`/runs/${run.id}/reconcile`, {});
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "needs_you", activity: "implementing", condition: "interrupted", busy: false, waiting_reason: expect.any(String) });
    } finally { await f.close(); }
  }, 30_000);
  it("keeps Reviewing visible in Needs you while another independent worker continues", async () => {
    const f = await factoryBoardFixture();
    try {
      const run = await f.start();
      const first = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "board-standards" });
      await f.request(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "board-spec" });
      await herdrRpc("pane.report_agent", { pane_id: first.pane_id, source: "manual", agent: "codex", state: "blocked" });
      await f.request(`/runs/${run.id}/workers/${first.id}/reconcile`, {});
      const detail = await f.request(f.prefix);
      expect(detail.board).toMatchObject({ lane: "needs_you", activity: "reviewing", condition: "needs_you", busy: true, waiting_reason: expect.any(String) });
      expect(detail.workers.some((worker: { role: string; condition: string }) => worker.role === "spec" && worker.condition === "working")).toBe(true);
      expect((await f.request("")).board.find((entry: { implementation_id: string }) => entry.implementation_id === detail.implementation.id)).toEqual(detail.board);
    } finally { await f.close(); }
  }, 30_000);
  it("shows a resting planning checkpoint in Needs you and retains earlier attempts after continuing", async () => {
    const f = await factoryBoardFixture();
    try {
      const first = await f.start("grill-with-docs");
      await herdrRpc("pane.report_agent", { pane_id: first.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`/runs/${first.id}/reconcile`, {});
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "needs_you", activity: "specifying", condition: "ready", busy: false });
      await f.request(`${f.prefix}/continue`, { action: "to-spec", run_id: first.id, idempotency_key: "board-continue", allow_partial_handoff: true });
      const detail = await f.request(f.prefix);
      expect(detail.board).toMatchObject({ lane: "running", activity: "specifying", busy: true });
      expect(detail.runs).toHaveLength(2);
      expect(detail.runs[0]).toMatchObject({ id: first.id, action: "grill-with-docs", condition: "completed" });
    } finally { await f.close(); }
  }, 30_000);
  it("projects completed work into Done while retaining its Run and completion history", async () => {
    const f = await factoryBoardFixture();
    try {
      const run = await f.start();
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`${f.prefix}/complete-work`, { run_id: run.id });
      const detail = await f.request(f.prefix);
      expect(detail.board).toMatchObject({ lane: "done", activity: null, busy: false, run_id: run.id });
      expect(detail.runs[0].id).toBe(run.id);
      expect(detail.events.some((event: { kind: string }) => event.kind === "direct_work_completed")).toBe(true);
    } finally { await f.close(); }
  }, 30_000);
  it("shows resting implementation as Awaiting checks without busy activity", async () => {
    const f = await factoryBoardFixture();
    try {
      const run = await f.start();
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`/runs/${run.id}/reconcile`, {});
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "running", activity: "awaiting_checks", busy: false, condition: "ready" });
    } finally { await f.close(); }
  }, 30_000);
  it("shows Validating while owned checks execute and needs attention when they fail", async () => {
    let release!: () => void; let entered!: () => void;
    const reached = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    const tool = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { entered(); await gate; return new Response("Owned failing check", { status: 500 }); } });
    const f = await factoryBoardFixture(); let pending: Promise<unknown> | undefined;
    try {
      const detail = await f.request(f.prefix);
      await f.request(`/projects/${detail.implementation.project_id}/configure`, { checks: [[process.execPath, "-e", `const response = await fetch('http://127.0.0.1:${tool.port}'); process.exit(response.ok ? 0 : 1);`]] });
      const run = await f.start();
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`/runs/${run.id}/reconcile`, {});
      pending = f.request(`/runs/${run.id}/checks`, {});
      await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned check never reached the fixture")), 5000))]);
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "running", activity: "validating", busy: true });
      release(); await pending;
      expect((await f.request(f.prefix)).board).toMatchObject({ lane: "needs_you", activity: "validating", busy: false, condition: "failed" });
    } finally { release(); await pending?.catch(() => {}); tool.stop(true); await f.close(); }
  }, 30_000);
  it("persists a global six-task limit and validates its supported range", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-capacity-settings-"));
    let app = createServer({ port: 0, stateDir: state, machines: false });
    const post = (value: unknown) => fetch(`http://localhost:${app.port}/api/factory/settings`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(value) });
    try {
      expect((await post({ max_implementations: 2 })).status).toBe(200);
      const saved = await post({ max_implementations: 6, max_agents: 6 }); expect(saved.status).toBe(200); expect((await saved.json()).max_implementations).toBe(6);
      for (const value of [0, 33, 1.5, "6"]) { const rejected = await post({ max_implementations: value }); expect(rejected.status).toBe(400); expect((await rejected.json()).error.code).toBe("invalid_limit"); }
      app.stop(); app = createServer({ port: 0, stateDir: state, machines: false });
      const overview = await fetch(`http://localhost:${app.port}/api/factory`).then(response => response.json()); expect(overview.settings.max_implementations).toBe(6); expect(overview.settings.max_agents).toBe(6);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  for (const location of ["local", "remote"]) it(`discovers model choices for the selected ${location} Project checkout through the owner API`, async () => {
    const root=mkdtempSync(join(tmpdir(),"saurons-model-catalog-"));const repo=join(root,"repo");mkdirSync(repo);writeFileSync(join(repo,"README.md"),"Owned catalog fixture\n");
    for(const args of [["init","-b","main"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial"]])expect(Bun.spawnSync(["git",...args],{cwd:repo}).exitCode).toBe(0);
    const calls:{provider:string;path:string}[]=[];
    const host=createServer({port:0,stateDir:join(root,"state"),machines:false,token:location === "remote" ? "owned-catalog-host" : undefined,factory:{accountDiscoveryHome:root,native:{version:async()=>"owned-cli-fixture",modelCatalog:async(provider,path)=>{calls.push({provider,path});return {protocol:1,provider,models:[{id:"owned-model",name:"Owned model",reasoning:[{id:"medium",name:"Medium"},{id:"xhigh",name:"Extra high"}],default_reasoning:"medium"}],problem:null};}}}});
    const selectedMachine = location === "remote" ? "catalog-host" : "local";
    const app = location === "remote" ? createServer({ port: 0, stateDir: join(root, "owner"), machines: false, factory: { accountDiscoveryHome: root, machineEndpoint: id => id === "catalog-host" ? { url: `http://localhost:${host.port}`, token: "owned-catalog-host" } : undefined } }) : host;
    const post=(path:string,body:unknown,header=true)=>fetch(`http://localhost:${app.port}/api/factory${path}`,{method:"POST",headers:{"content-type":"application/json",...(header?{"x-herdr-factory":"1"}:{})},body:JSON.stringify(body)});
    try{
      const project=await post("/projects",{name:"Models fixture",path:repo,machine_id:selectedMachine,provider:"codex",tracker:"app"}).then(r=>r.json());
      const body={project_id:project.id,machine_id:selectedMachine,provider:"codex"};
      const response=await post("/model-catalog",body);expect(response.status).toBe(200);expect((await response.json()).models).toEqual([{id:"owned-model",name:"Owned model",reasoning:[{id:"medium",name:"Medium"},{id:"xhigh",name:"Extra high"}],default_reasoning:"medium"}]);expect(calls).toEqual([{provider:"codex",path:repo}]);
      expect((await post("/model-catalog",body,false)).status).toBe(403);expect((await post("/model-catalog",{...body,project_id:"absent"})).status).toBe(404);expect(calls).toHaveLength(1);
      rmSync(join(repo, ".git"), { recursive: true, force: true });
      writeFileSync(join(repo, "README.md"), "A different owned repository\n");
      for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "replacement"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
      const replaced = await post("/model-catalog", body);
      expect(replaced.status).toBe(409); expect((await replaced.json()).error.code).toBe(location === "remote" ? "remote_factory_unavailable" : "wrong_checkout");
      const save = await post(`/projects/${project.id}/configure`, { execution_preset: { model: "owned-model", reasoning: "xhigh" } });
      expect(save.status).toBe(409); expect((await save.json()).error.code).toBe(location === "remote" ? "remote_factory_unavailable" : "wrong_checkout");
      expect(calls).toHaveLength(1);
    }finally{app.stop();if(app!==host)host.stop();rmSync(root,{recursive:true,force:true});}
  });
  it("requires a currently registered host when changing Project execution defaults", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-host-default-")); const repo = join(state, "repo"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned host fixture\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const remote = createServer({ port: 0, stateDir: join(state, "remote"), machines: false, token: "owned-fixture-token" }); let registered = true;
    const app = createServer({ port: 0, stateDir: join(state, "connection"), machines: false, factory: { machineEndpoint: (id) => registered && id === "fixture-host" ? { url: `http://localhost:${remote.port}`, token: "owned-fixture-token" } : undefined } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const response = await request("/projects", { name: "Registered host", path: repo, machine_id: "fixture-host", provider: "codex", tracker: "app" }); expect(response.status).toBe(201); const project = await response.json();
      registered = false;
      const saved = await request(`/projects/${project.id}/configure`, { machine_id: "fixture-host" }); expect(saved.status).toBe(400); expect((await saved.json()).error.code).toBe("invalid_machine");
    } finally { app.stop(); remote.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("archives an idle native chat durably, refuses working chats, and restores without closing a pane", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-pane-archive-"));
    const workspace = await workspaceCreate({ label: "herdr-web-ui-test-project-archive" });
    const paneId = workspace.root_pane.pane_id;
    let app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${body ? "/pane-archives" : ""}`, body ? { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) } : {});
    try {
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "working" });
      const busy = await request({ machine_id: "local", pane_id: paneId, terminal_id: workspace.root_pane.terminal_id, session_ref: nativeSessionRef(workspace.root_pane), archived: true }); expect(await busy.json()).toMatchObject({ error: { code: "pane_busy" } }); expect(busy.status).toBe(409);
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle" });
      expect((await request({ machine_id: "local", pane_id: paneId, terminal_id: "another-terminal", session_ref: null, archived: true })).status).toBe(409);
      expect((await request({ machine_id: "local", pane_id: paneId, terminal_id: workspace.root_pane.terminal_id, session_ref: "another-history", archived: true })).status).toBe(409);
      expect((await request({ machine_id: "local", pane_id: paneId, terminal_id: workspace.root_pane.terminal_id, session_ref: nativeSessionRef(workspace.root_pane), archived: true })).status).toBe(200);
      app.stop(); app = createServer({ port: 0, stateDir: state, machines: false });
      const retained = await request().then((r) => r.json()); expect(retained.pane_archives[0]).toMatchObject({ machine_id: "local", pane_id: paneId, archived_at: expect.any(String) });
      expect((await sessionSnapshot()).panes.some((p) => p.pane_id === paneId)).toBe(true);
      expect((await request({ machine_id: "local", pane_id: paneId, archived: false })).status).toBe(200);
      expect((await request().then((r) => r.json())).pane_archives[0].archived_at).toBeNull();
    } finally { app.stop(); await workspaceClose(workspace.workspace.workspace_id); rmSync(state, { recursive: true, force: true }); }
  });
  it("retains Project workflow targets and refuses archiving unfinished Assignments", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-project-workflow-")); const repo = join(state, "repo");
    mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned workflow fixture\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("/projects", { name: "Workflow", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((r) => r.json());
      const saved = await request(`/projects/${project.id}/configure`, { workflow_instructions: "Use TDD and independent review", context_target_tokens: 150000 }); expect(saved.status).toBe(200);
      expect((await saved.json()).context_target_tokens).toBe(150000);
      expect((await request(`/projects/${project.id}/configure`, { context_target_tokens: 250000 })).status).toBe(400);
      const retained = (await request("").then((r) => r.json())).projects[0]; expect(retained.workflow_instructions).toBe("Use TDD and independent review"); expect(retained.context_target_tokens).toBe(150000);
      const idea = await request("/implementations", { title: "Not finished", description: "", project_id: project.id }).then((r) => r.json());
      const archive = await request(`/implementations/${idea.id}/archive`, {}); expect(archive.status).toBe(409); expect((await archive.json()).error.code).toBe("assignment_unfinished");
      expect((await request(`/implementations/${idea.id}`).then((r) => r.json())).implementation.archived_at).toBeUndefined();
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("edits and removes a Project registration while retaining its assigned ideas and history", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-project-lifecycle-")); const repo = join(state, "repo");
    mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Owned lifecycle fixture\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("/projects", { name: "Original", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((r) => r.json());
      const edited = await request(`/projects/${project.id}/configure`, { name: "Renamed" });
      expect(edited.status).toBe(200); expect((await edited.json()).name).toBe("Renamed");
      const ideaResponse = await request("/implementations", { title: "Owned idea", description: "Preserve these notes", project_id: project.id });
      expect(ideaResponse.status).toBe(201); const idea = await ideaResponse.json(); expect(idea.project_id).toBe(project.id);
      expect((await request(`/projects/${project.id}/remove`, {})).status).toBe(200);
      const overview = await request("").then((r) => r.json()); expect(overview.projects[0].removed_at).toEqual(expect.any(String));
      const retained = await request(`/implementations/${idea.id}`).then((r) => r.json()); expect(retained.messages[0].content).toBe("Preserve these notes");
      const rejected = await request("/implementations", { title: "Another", description: "", project_id: project.id }); expect(rejected.status).toBe(400);
      expect((await request(`/projects/${project.id}/restore`, {})).status).toBe(200);
      expect((await request("").then((r) => r.json())).projects[0].removed_at).toBeNull();
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("recovers an allocated child's identity after a missing native creation receipt", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-child-recovery-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const workspaces: string[] = []; let starts = 0;
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "owned-fixture", createWorkspace: async (options) => { const result = await workspaceCreate(options); workspaces.push(result.workspace.workspace_id); if (options.label?.startsWith("saurons-eye-worker-")) throw new Error("Native receipt unavailable"); return result; }, startAgent: async (options) => { starts++; await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("projects", { name: "Receipt recovery", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Observe accepted child", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      await request(`projects/${project.id}/configure`, { workflow_instructions: "Use bounded child contexts", context_target_tokens: 150000 });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "recover-parent" }).then((response) => response.json());
      const worker = await request(`runs/${run.id}/workers`, { role: "standards", idempotency_key: "uncertain-child" }).then((response) => response.json());
      expect(worker.condition).toBe("interrupted"); expect(worker.workspace_id).toBeNull();
      const recovered = await request(`runs/${run.id}/workers/${worker.id}/reconcile`, {}).then((response) => response.json());
      expect(recovered.workspace_id).toBe(workspaces[1]); expect(recovered.pane_id).not.toBeNull(); expect(recovered.condition).toBe("interrupted"); expect(starts).toBe(1);
      expect((await request(`implementations/${idea.id}/configure`, { project_id: null })).status).toBe(409);
      const navigation = await fetch(`http://localhost:${app.port}/api/factory`).then((response) => response.json());
      expect(navigation.pane_links).toContainEqual(expect.objectContaining({ implementation_id: idea.id, run_id: run.id, worker_id: worker.id, pane_id: recovered.pane_id, provider: "codex", title: "standards" }));
      await request(`projects/${project.id}/configure`, { context_target_tokens: 200000 });
      const frozen = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(frozen.runs[0].manifest.project.context_target_tokens).toBe(150000);
      expect((await request(`projects/${project.id}/remove`, {})).status).toBe(409);
      expect((await request(`runs/${run.id}/workers/${worker.id}/stop`, {})).status).toBe(200);
      expect((await sessionSnapshot()).workspaces.some((entry) => entry.workspace_id === workspaces[1])).toBe(false);
    } finally { for (const id of workspaces) await workspaceClose(id).catch(() => {}); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it.each(["allocation", "launch response", "reconciliation"])("preserves parent Stop after a late child %s", async (phase) => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-stop-child-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    let release!: () => void; let allocated!: () => void; let starts = 0; let holdSnapshot = false; let held = false; const workspaces: string[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; }); const allocation = new Promise<void>((resolve) => { allocated = resolve; });
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "owned-fixture", snapshot: async () => { const snapshot = await sessionSnapshot(); if (holdSnapshot && !held) { held = true; allocated(); await gate; } return snapshot; }, createWorkspace: async (options) => { const result = await workspaceCreate(options); workspaces.push(result.workspace.workspace_id); if (phase === "allocation" && options.label?.startsWith("saurons-eye-worker-")) { allocated(); await gate; } return result; }, startAgent: async (options) => { starts++; await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); if (phase === "launch response" && options.name.startsWith("eye-worker-")) { allocated(); await gate; } } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("projects", { name: "Owned Stop race", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Stop accepted child", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "parent-stop" }).then((response) => response.json());
      let child = request(`runs/${run.id}/workers`, { role: "standards", idempotency_key: "accepted-child" });
      if (phase === "reconciliation") { const worker = await child.then((response) => response.json()); holdSnapshot = true; child = request(`runs/${run.id}/workers/${worker.id}/reconcile`, {}); }
      await allocation;
      expect((await request(`runs/${run.id}/stop`, {})).status).toBe(200);
      release(); const worker = await child.then((response) => response.json());
      expect(worker.condition).toBe("cancelled"); expect(starts).toBe(phase === "allocation" ? 1 : 2);
      expect((await sessionSnapshot()).workspaces.some((workspace) => workspaces.includes(workspace.workspace_id))).toBe(false);
      expect(existsSync(worker.worktree)).toBe(true);
    } finally { release(); for (const id of workspaces) await workspaceClose(id).catch(() => {}); app.stop(); rmSync(state, { recursive: true, force: true }); }
  }, 15_000);
  it.each(["launch response", "reconciliation"])("preserves Stop after a late coordinator %s", async (phase) => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-stop-root-"));
    let release!: () => void; let reached!: () => void; let held = false; let holdSnapshot = false; let workspaceId: string | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const barrier = new Promise<void>((resolve) => { reached = resolve; });
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "owned-fixture", snapshot: async () => { const snapshot = await sessionSnapshot(); if (holdSnapshot && !held) { held = true; reached(); await gate; } return snapshot; }, startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); if (phase === "launch response") { reached(); await gate; } } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Terminal Stop barrier", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const start = request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "stop-barrier" });
      let pending: Promise<Response>; let run;
      if (phase === "launch response") { await barrier; run = (await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json())).runs[0]; pending = start; }
      else { run = await start.then((response) => response.json()); workspaceId = run.workspace_id; holdSnapshot = true; pending = request(`runs/${run.id}/reconcile`, {}); await barrier; }
      expect((await request(`runs/${run.id}/stop`, {})).status).toBe(200); workspaceId = null;
      release(); expect((await pending.then((response) => response.json())).condition).toBe("cancelled");
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(detail.runs[0].condition).toBe("cancelled");
      const retry = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "new-owner-start" }).then((response) => response.json()); workspaceId = retry.workspace_id;
      expect(retry.condition).toBe("working");
    } finally { release(); if (workspaceId) await workspaceClose(workspaceId).catch(() => {}); app.stop(); rmSync(state, { recursive: true, force: true }); }
  }, 15_000);
  it("releases admission when provider revalidation proves native launch never began", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-prelaunch-"));
    let reads = 0; let launches = 0;
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async (provider) => provider === "codex" ? ++reads % 2 ? "before" : "changed" : null, createWorkspace: async () => { launches++; throw new Error("Unexpected native allocation"); } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Recover provisioning failure", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const first = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "failed-before-native" }).then((response) => response.json());
      expect(first.condition).toBe("failed"); expect(first.workspace_id).toBeNull(); expect(launches).toBe(0);
      const retry = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "explicit-retry" });
      expect(retry.status).toBe(202); expect((await retry.json()).id).not.toBe(first.id); expect(launches).toBe(0);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("removes only stopped clean checkouts and preserves unexpected work and branches", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-cleanup-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const project = await request("projects", { name: "Safe cleanup", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Keep unexpected files", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "cleanup-owned-worktree" }).then((response) => response.json()); workspaceId = run.workspace_id;
      expect((await request(`runs/${run.id}/cleanup`, {})).status).toBe(409);
      writeFileSync(join(run.worktree, "unfinished.txt"), "Keep this work");
      await request(`runs/${run.id}/stop`, {}); workspaceId = null;
      expect((await request(`runs/${run.id}/cleanup`, {})).status).toBe(409);
      expect(readFileSync(join(run.worktree, "unfinished.txt"), "utf8")).toBe("Keep this work");
      rmSync(join(run.worktree, "unfinished.txt"));
      const cleaned = await request(`runs/${run.id}/cleanup`, {}); expect(cleaned.status).toBe(200);
      expect(existsSync(run.worktree)).toBe(false);
      expect(Bun.spawnSync(["git", "rev-parse", "--verify", run.branch], { cwd: repo }).exitCode).toBe(0);
      expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("base\n");
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("gives successive projectless attempts separate working directories and state", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-attempts-"));
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const idea = await request("implementations", { title: "Separate attempts", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const first = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "first-attempt" }).then((response) => response.json()); workspaceId = first.workspace_id;
      await request(`runs/${first.id}/stop`, {}); workspaceId = null;
      const second = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "second-attempt" }).then((response) => response.json()); workspaceId = second.workspace_id;
      expect(second.condition).toBe("working");
      const firstContext = JSON.parse(readFileSync(join(first.worktree, ".saurons-eye-context.json"), "utf8"));
      const secondContext = JSON.parse(readFileSync(join(second.worktree, ".saurons-eye-context.json"), "utf8"));
      expect(first.worktree).not.toBe(second.worktree); expect(firstContext.environment.state).not.toBe(secondContext.environment.state);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("reserves independent review contexts within the global native limit", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-review-context-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    const workspaces: string[] = [];
    try {
      await request("settings", { max_agents: 2 });
      const project = await request("projects", { name: "Independent reviews", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Review both axes", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "review-owned-worktree" }).then((response) => response.json()); workspaces.push(run.workspace_id);
      const worker = await request(`runs/${run.id}/workers`, { role: "standards", idempotency_key: "independent-standards" }).then((response) => response.json());
      expect(worker.error).toBeUndefined();
      expect(worker.condition).toBe("working"); workspaces.push(worker.workspace_id);
      await herdrRpc("pane.report_agent", { pane_id: worker.pane_id, source: "manual", agent: "codex", state: "blocked" });
      const waiting = await request(`runs/${run.id}/workers/${worker.id}/reconcile`, {}).then((response) => response.json());
      expect(waiting.condition).toBe("needs_you"); expect(waiting.waiting_reason).toContain("owner answer");
      await herdrRpc("pane.report_agent", { pane_id: worker.pane_id, source: "manual", agent: "codex", state: "idle" });
      const ready = await request(`runs/${run.id}/workers/${worker.id}/reconcile`, {}).then((response) => response.json());
      expect(ready.condition).toBe("ready"); expect(ready.waiting_reason).toContain("ready");
      expect(worker.worktree).not.toBe(run.worktree); expect(worker.base).toBe(run.base);
      const specResponse = await request(`runs/${run.id}/workers`, { role: "spec", idempotency_key: "independent-spec" }); expect(specResponse.status).toBe(200);
      const specWorker = await specResponse.json(); workspaces.push(specWorker.workspace_id);
      expect((await request(`runs/${run.id}/workers`, { role: "standards", idempotency_key: "another-review" })).status).toBe(409);
      expect((await request(`runs/${run.id}/workers`, { role: "standards", idempotency_key: "independent-standards" }).then((response) => response.json())).id).toBe(worker.id);
      expect((await request(`runs/${run.id}/workers/${worker.id}/review-evidence`, {})).status).toBe(409);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json()); expect(detail.review_evidence).toEqual([]);
    } finally { for (const workspace of workspaces) if (workspace) await workspaceClose(workspace); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("runs configured checks in isolated state and enforces the global build cap", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-checks-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const project = await request("projects", { name: "Known checks", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      await request(`projects/${project.id}/configure`, { checks: [["bun", "-e", "console.log(process.env.FACTORY_DATABASE)"]], permissions: "Owned test fixture only" });
      await request("settings", { max_builds: 1 });
      const idea = await request("implementations", { title: "Retain check evidence", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "check-owned-worktree" }).then((response) => response.json()); workspaceId = run.workspace_id;
      const [first, second] = await Promise.all([request(`runs/${run.id}/checks`, {}), request(`runs/${run.id}/checks`, {})]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const result = await (first.status === 200 ? first : second).json();
      expect(result.condition).toBe("passed");
      expect(result.commands[0].output.trim()).toBe(join(state, "factory", "worktrees", run.id, "state", "tests.sqlite"));
      expect(result.head).toBe(run.base);
      expect((await request(`runs/${run.id}/accept`, { head: result.head })).status).toBe(409);
      expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("base\n");
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("grants a native Run only its tracker scope and revokes control when stopped", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-scope-"));
    const app = createServer({ port: 0, stateDir: state, token: "owner-scope-contract", machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { authorization: "Bearer owner-scope-contract", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const idea = await request("implementations", { title: "Scoped native question", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "owned-scoped-run" }).then((response) => response.json()); workspaceId = run.workspace_id;
      const access = JSON.parse(readFileSync(join(run.worktree, ".saurons-eye-access.json"), "utf8"));
      const scoped = (path: string, body?: unknown) => fetch(`${access.url}/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const asking = await scoped("question", { question: "Which acceptance matters?" }); expect(asking.status).toBe(201);
      expect((await scoped("approvals", { kind: "specification" })).status).toBe(404);
      expect((await fetch(`http://localhost:${app.port}/api/factory`, { headers: { authorization: `Bearer ${access.token}` } })).status).toBe(401);
      const contract = await scoped("contract").then((response) => response.json());
      expect(contract.tracker_guide).toContain("idempotency_key");
      expect(contract.questions[0].answer).toBeNull(); expect(contract.run.manifest.token).toBeUndefined();
      await request(`runs/${run.id}/stop`, {}); workspaceId = null;
      expect((await scoped("question", { question: "Too late" })).status).toBe(409);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("retains artifact annotations and scopes retrospective proposals to their Project", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-retention-")); const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "scope-fixture", createWorkspace: async () => { throw new Error("No native execution in this scope test"); } } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("projects", { name: "Scoped retro", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Owned evidence", description: "Preserve the decision" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      const artifact = await request(`implementations/${idea.id}/artifacts`, { chat_id: detail.chats[0].id, name: "decision.md", media_type: "text/markdown", content_base64: Buffer.from("# Evidence").toString("base64") }).then((response) => response.json());
      expect((await request(`artifacts/${artifact.id}/note`, { note: "Keep through the review" })).status).toBe(200);
      const proposal = await request(`projects/${project.id}/retrospectives`, { evidence_ids: [artifact.id, detail.messages[0].id], proposal: "Add a deterministic environment check" });
      expect(proposal.status).toBe(201);
      const retro = await proposal.json();
      expect(retro.approved).toBe(false);
      expect((await request(`retrospectives/${retro.id}/approve`, { scope_hash: "stale" })).status).toBe(409);
      expect((await request(`retrospectives/${retro.id}/approve`, { scope_hash: retro.scope_hash })).status).toBe(200);
      expect((await request(`projects/${project.id}/retrospectives`, { evidence_ids: ["unrelated-session"], proposal: "No inferred access" })).status).toBe(400);
      const deleted = await request(`artifacts/${artifact.id}/delete`, { hash: artifact.hash }); expect(deleted.status).toBe(200);
      expect((await fetch(`http://localhost:${app.port}/api/factory/artifacts/${artifact.id}/source`)).status).toBe(404);
      const retained = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(retained.events.some((event: { kind: string }) => event.kind === "artifact_deleted")).toBe(true);
      expect(retained.retrospectives[0].proposal).toBe("Add a deterministic environment check");
      const duplicate = await request(`implementations/${idea.id}/artifacts`, { chat_id: detail.chats[0].id, name: "duplicate.md", media_type: "text/markdown", content_base64: Buffer.from("# Evidence").toString("base64") }).then((response) => response.json());
      expect((await request(`artifacts/${duplicate.id}/delete`, { hash: duplicate.hash })).status).toBe(200);
      const backup = await request("backups", {});
      expect(backup.status).toBe(201);
      expect((await backup.json()).blobs).toContainEqual({ hash: artifact.hash, size: artifact.size });
      const other = await request("implementations", { title: "Project retrospective", description: "" }).then((response) => response.json());
      await request(`implementations/${other.id}/configure`, { project_id: project.id });
      const start = await request(`implementations/${other.id}/runs`, { action: "retro", retrospective_id: retro.id, idempotency_key: "selected-cross-implementation-evidence" });
      expect(start.status).toBe(202);
      const run = await start.json();
      expect(run.manifest.artifacts.map((entry: { id: string }) => entry.id)).toEqual([artifact.id]);
      rmSync(join(state, "factory", "blobs", artifact.hash));
      const corruptBackup = await request("backups", {});
      expect(corruptBackup.status).toBe(409);
      expect((await corruptBackup.json()).error.code).toBe("artifact_corrupt");
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("never certifies a stand-in native provider from a claimed verification result", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-proof-"));
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "stand-in", startAgent: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const idea = await request("implementations", { title: "Native contract probe", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const response = await request(`implementations/${idea.id}/runs`, { action: "verify-provider", idempotency_key: "native-probe" });
      expect(response.status).toBe(202);
      const run = await response.json(); workspaceId = run.workspace_id;
      expect((await request(`runs/${run.id}/verify-provider`, { verified: true })).status).toBe(409);
      const capabilities = await fetch(`http://localhost:${app.port}/api/factory/providers`).then((response) => response.json());
      expect(capabilities.providers.every((entry: { factory_ready: boolean }) => !entry.factory_ready)).toBe(true);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("configures a Project's checks and verifies a cloned machine checkout", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-project-config-"));
    const repo = join(state, "repo"); const clone = join(state, "clone");
    const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "base\n");
    mkdirSync(join(repo, "nested")); writeFileSync(join(repo, "nested", "AGENTS.md"), "Only the nested module owns its files.\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "clone", repo, clone]).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("projects", { name: "Configured repository", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const configured = await request(`projects/${project.id}/configure`, { provider: "claude", checks: [["bun", "test"]], setup: [], environment: { FACTORY_DATABASE: "owned.sqlite" }, permissions: "Repository writes; ask before network or publication", shared_paths: ["bun.lock"] });
      expect(configured.status).toBe(200);
      expect((await configured.json()).checks).toEqual([["bun", "test"]]);
      const checkout = await request(`projects/${project.id}/checkouts`, { machine_id: "local", path: clone });
      expect(checkout.status).toBe(201);
      expect((await checkout.json()).repository).toBe(project.repository);
      expect((await request(`projects/${project.id}/configure`, { checks: ["bun test"] })).status).toBe(400);
      expect((await request(`projects/${project.id}/configure`, { environment: { HOME: "wrong" } })).status).toBe(400);
      const overview = await fetch(`http://localhost:${app.port}/api/factory`).then((response) => response.json());
      expect(overview.checkouts.filter((entry: { project_id: string }) => entry.project_id === project.id)).toHaveLength(1);
      expect(overview.checkouts[0].instructions).toContainEqual(expect.objectContaining({ path: "nested/AGENTS.md", content: "Only the nested module owns its files.\n" }));
      const navigation = await fetch(`http://localhost:${app.port}/api/factory?navigation=1`).then((response) => response.json());
      expect(navigation.checkouts[0].instructions).toBeUndefined(); expect(navigation.checkouts[0].path).toBe(realpathSync(clone));
      expect(overview.projects[0].provider).toBe("claude");
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("submits only selected review drafts once to their owned Run", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-batch-"));
    const repo = join(state, "repo"); const { mkdirSync } = await import("node:fs"); mkdirSync(repo); writeFileSync(join(repo, "notes.txt"), "before\n");
    for (const args of [["init", "-b", "main"], ["add", "notes.txt"], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); }, prompt: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const project = await request("projects", { name: "Batch sample", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Selected rework", description: "" }).then((response) => response.json());
      const prefix = `implementations/${idea.id}`;
      await request(`${prefix}/configure`, { project_id: project.id });
      const run = await request(`${prefix}/runs`, { action: "grill-with-docs", idempotency_key: "owned-rework" }).then((response) => response.json());
      workspaceId = run.workspace_id;
      expect(run.condition).toBe("working");
      writeFileSync(join(run.worktree, "notes.txt"), "after\n");
      const snapshot = await request(`${prefix}/snapshots`, { run_id: run.id, mode: "workspace" }).then((response) => response.json());
      expect(snapshot.files.some((file: { path: string }) => file.path === ".saurons-eye-access.json")).toBe(false);
      const anchor = { snapshot_id: snapshot.id, path: "notes.txt", side: "new", line_start: 1, line_end: 1 };
      const first = await request(`${prefix}/comments`, { ...anchor, content: "Selected finding" }).then((response) => response.json());
      const second = await request(`${prefix}/comments`, { ...anchor, content: "Keep this draft" }).then((response) => response.json());
      const submission = { run_id: run.id, snapshot_id: snapshot.id, comment_ids: [first.id], idempotency_key: "same-selected-batch" };
      const sent = await request(`${prefix}/request-changes`, submission);
      expect(sent.status).toBe(200);
      const batch = await sent.json();
      const repeated = await request(`${prefix}/request-changes`, submission).then((response) => response.json());
      expect(repeated.id).toBe(batch.id);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/${prefix}`).then((response) => response.json());
      expect(detail.comments.find((comment: { id: string }) => comment.id === first.id).status).toBe("submitted");
      expect(detail.comments.find((comment: { id: string }) => comment.id === second.id).status).toBe("draft");
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("retains generated remote research centrally so it remains readable while the host is offline", async () => {
    const centralState = mkdtempSync(join(tmpdir(), "saurons-eye-import-"));
    const hostState = mkdtempSync(join(tmpdir(), "saurons-eye-generated-"));
    const host = createServer({ port: 0, stateDir: hostState, token: "owned-artifact-host", machines: false, factory: { native: { version: async () => "remote-contract-fixture", startAgent: async (options) => { const context = JSON.parse(readFileSync(join(options.args![1]!, ".saurons-eye-context.json"), "utf8")); writeFileSync(join(context.environment.notes, "research.md"), "# Remote research\nRetain this centrally"); } } } });
    const app = createServer({ port: 0, stateDir: centralState, machines: false, factory: { machineEndpoint: (id) => id === "research-host" ? { url: `http://localhost:${host.port}`, token: "owned-artifact-host" } : undefined } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      await request("machines/research-host/prepare", {});
      const idea = await request("implementations", { title: "Remote research evidence", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "research-host", provider: "codex" });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "import-owned-notes" }).then((response) => response.json());
      workspaceId = run.workspace_id;
      expect(run.condition).toBe("working");
      const imported = await request(`runs/${run.id}/import-artifacts`, {});
      expect(imported.status).toBe(201);
      const artifacts = await imported.json();
      expect(artifacts).toHaveLength(1);
      expect((await request(`runs/${run.id}/import-artifacts`, {}).then((response) => response.json()))[0].id).toBe(artifacts[0].id);
      host.stop();
      expect(await fetch(`http://localhost:${app.port}/api/factory/artifacts/${artifacts[0].id}/source`).then((response) => response.text())).toBe("# Remote research\nRetain this centrally");
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); host.stop(); rmSync(centralState, { recursive: true, force: true }); rmSync(hostState, { recursive: true, force: true }); }
  });
  it("stops only its owned native workspace while retaining the assignment and Run history", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-stop-"));
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: { native: { version: async () => "contract-fixture", startAgent: async () => {} } } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const idea = await request("implementations", { title: "Retained after Stop", description: "Original history" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "local" });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "stop-owned-run" }).then((response) => response.json());
      workspaceId = run.workspace_id;
      expect(run.condition).toBe("working");
      const stopped = await request(`runs/${run.id}/stop`, { summary: "Owner stopped this attempt" });
      expect(stopped.status).toBe(200);
      expect((await stopped.json()).condition).toBe("cancelled");
      expect((await sessionSnapshot()).workspaces.some((workspace) => workspace.workspace_id === workspaceId)).toBe(false);
      workspaceId = null;
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(detail.messages).toMatchObject([{ content: "Original history" }]);
      expect(detail.runs).toHaveLength(1);
      expect(detail.events.some((event: { kind: string }) => event.kind === "run_stopped")).toBe(true);
      expect(existsSync(run.worktree)).toBe(true);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("prepares an external bridge and keeps the selected Machine's owned Run after disconnect", async () => {
    const centralState = mkdtempSync(join(tmpdir(), "saurons-eye-central-"));
    const hostState = mkdtempSync(join(tmpdir(), "saurons-eye-host-"));
    const host = createServer({ port: 0, stateDir: hostState, token: "owned-remote-contract", machines: false, factory: { native: { version: async () => "remote-contract-fixture", startAgent: async () => {} } } });
    const app = createServer({ port: 0, stateDir: centralState, machines: false, factory: { skillsPath: join(import.meta.dir, "../vendor/matt-skills"), machineEndpoint: (id) => id === "external-host" ? { url: `http://localhost:${host.port}`, token: "owned-remote-contract" } : undefined } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const prepared = await request("machines/external-host/prepare", {});
      expect(prepared.status).toBe(200);
      const capabilities = await prepared.json();
      expect(capabilities.skill_manifest.file_count).toBe(159);
      const idea = await request("implementations", { title: "Remote research", description: "Keep the original host" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { machine_id: "external-host", provider: "codex" });
      const run = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "remote-owner-click" }).then((response) => response.json());
      expect(run.condition).toBe("working");
      expect(run.machine_id).toBe("external-host");
      expect(run.worktree.startsWith(join(hostState, "factory", "inbox"))).toBe(true);
      workspaceId = run.workspace_id;
      host.stop();
      const reconciled = await request(`runs/${run.id}/reconcile`, {}).then((response) => response.json());
      expect(reconciled.condition).toBe("disconnected");
      const duplicate = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "remote-owner-click" }).then((response) => response.json());
      expect(duplicate.id).toBe(run.id);
      const elsewhere = await request(`implementations/${idea.id}/runs`, { action: "grill-me", idempotency_key: "new-click" });
      expect(elsewhere.status).toBe(409);
      const retained = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(retained.messages).toMatchObject([{ content: "Keep the original host" }]);
      expect(retained.runs).toHaveLength(1);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); host.stop(); rmSync(centralState, { recursive: true, force: true }); rmSync(hostState, { recursive: true, force: true }); }
  });
  it("claims a Start key once and freezes the selected provider and owned working directory", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-dispatch-"));
    const app = createServer({ port: 0, stateDir: state, machines: false, factory: {
      skillsPath: join(import.meta.dir, "../vendor/matt-skills"),
      native: { version: async () => "contract-fixture", startAgent: async () => {} },
    } });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    let workspaceId: string | null = null;
    try {
      const idea = await request("implementations", { title: "Isolated setup", description: "" }).then((response) => response.json());
      await request(`implementations/${idea.id}/configure`, { provider: "codex", machine_id: "local" });
      const start = { action: "setup", idempotency_key: "same-owner-click" };
      const [first, second] = await Promise.all([request(`implementations/${idea.id}/runs`, start).then((response) => response.json()), request(`implementations/${idea.id}/runs`, start).then((response) => response.json())]);
      expect(first.id).toBe(second.id);
      expect(first.condition).toBe("working");
      expect(first.provider).toBe("codex");
      expect(first.machine_id).toBe("local");
      workspaceId = first.workspace_id;
      expect(first.worktree.startsWith(join(state, "factory", "inbox"))).toBe(true);
      await request(`implementations/${idea.id}/configure`, { provider: "claude" });
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(detail.runs).toHaveLength(1);
      expect(detail.runs[0].provider).toBe("codex");
      const snapshot = await sessionSnapshot();
      expect(snapshot.workspaces.filter((entry) => entry.label === `saurons-eye-run-${first.id}`)).toHaveLength(1);
      expect((await request(`implementations/${idea.id}/runs`, { ...start, action: "grill-me" })).status).toBe(409);
    } finally { if (workspaceId) await workspaceClose(workspaceId); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("anchors durable review drafts to a captured workspace and marks them outdated after edits", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-review-"));
    const repo = join(state, "repo"); const { mkdirSync } = await import("node:fs"); mkdirSync(repo);
    writeFileSync(join(repo, "notes.txt"), "old line\n");
    for (const args of [["init", "-b", "main"], ["add", "notes.txt"], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    let app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const project = await request("projects", { name: "Review sample", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then((response) => response.json());
      const idea = await request("implementations", { title: "Review changes", description: "" }).then((response) => response.json());
      const prefix = `implementations/${idea.id}`;
      await request(`${prefix}/configure`, { project_id: project.id });
      writeFileSync(join(repo, "notes.txt"), "new line\n");
      const captured = await request(`${prefix}/snapshots`, { mode: "workspace" });
      expect(captured.status).toBe(201);
      const snapshot = await captured.json();
      expect(snapshot.files).toMatchObject([{ path: "notes.txt", status: "unstaged:M" }]);
      expect(snapshot.files[0].diff).toContain("+new line");
      const drafted = await request(`${prefix}/comments`, { snapshot_id: snapshot.id, path: "notes.txt", side: "new", line_start: 1, line_end: 1, content: "Please make this clearer" });
      expect(drafted.status).toBe(201);
      const comment = await drafted.json();
      writeFileSync(join(repo, "notes.txt"), "another edit\n");
      await request(`${prefix}/snapshots`, { mode: "workspace" });
      app.stop(); app = createServer({ port: 0, stateDir: state, machines: false });
      const detail = await fetch(`http://localhost:${app.port}/api/factory/${prefix}`).then((response) => response.json());
      expect(detail.comments).toMatchObject([{ id: comment.id, snapshot_id: snapshot.id, status: "outdated", content: "Please make this clearer" }]);
      expect(detail.snapshots[0].files[0].diff).toContain("+new line");
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("refuses factory dispatch with missing scope and does not substitute an unavailable provider", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-admission-"));
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "No implicit start", description: "" }).then((response) => response.json());
      const rejected = await request(`implementations/${idea.id}/runs`, { action: "implement-spec", idempotency_key: "owner-click-one" });
      expect(rejected.status).toBe(409);
      expect((await rejected.json()).error.code).toBe("project_required");
      const providers = await fetch(`http://localhost:${app.port}/api/factory/providers`).then((response) => response.json());
      expect(providers.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["codex", "claude", "opencode"]);
      expect(providers.providers.every((provider: { factory_ready: boolean }) => provider.factory_ready === false)).toBe(true);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(detail.runs).toEqual([]);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("restores a coherent backup into separate state without replacing the original", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-recovery-"));
    const app = createServer({ port: 0, stateDir: state, machines: false });
    let restored: ReturnType<typeof createServer> | undefined;
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Recover me", description: "Retained evidence" }).then((response) => response.json());
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      const artifact = await request(`implementations/${idea.id}/artifacts`, { chat_id: detail.chats[0].id, name: "note.txt", media_type: "text/plain", content_base64: "cHJlc2VydmVk", origin: "upload" }).then((response) => response.json());
      const backupResponse = await request("backups", {});
      expect(backupResponse.status).toBe(201);
      const backup = await backupResponse.json();
      await request("implementations", { title: "After backup", description: "" });
      const restoreResponse = await request(`backups/${backup.id}/restore`, {});
      expect(restoreResponse.status).toBe(201);
      const recovery = await restoreResponse.json();
      restored = createServer({ port: 0, stateDir: recovery.state_dir, machines: false });
      const retained = await fetch(`http://localhost:${restored.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(retained.messages).toMatchObject([{ content: "Retained evidence" }]);
      expect(await fetch(`http://localhost:${restored.port}/api/factory/artifacts/${artifact.id}/source`).then((response) => response.text())).toBe("preserved");
      const original = await fetch(`http://localhost:${app.port}/api/factory`).then((response) => response.json());
      expect(original.implementations).toHaveLength(2);
      const copy = await fetch(`http://localhost:${restored.port}/api/factory`).then((response) => response.json());
      expect(copy.implementations).toHaveLength(1);
    } finally { restored?.stop(); app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("retains unanswered questions and reorders the board without starting work", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-questions-"));
    let app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const first = await request("implementations", { title: "First", description: "" }).then((response) => response.json());
      const second = await request("implementations", { title: "Second", description: "" }).then((response) => response.json());
      expect((await request(`implementations/${second.id}/order`, { direction: -1 })).status).toBe(200);
      const questionResponse = await request(`implementations/${first.id}/questions`, { question: "Which public interface should be tested?" });
      expect(questionResponse.status).toBe(201);
      const question = await questionResponse.json();
      app.stop(); app = createServer({ port: 0, stateDir: state, machines: false });
      const board = await fetch(`http://localhost:${app.port}/api/factory`).then((response) => response.json());
      expect(board.implementations.map((idea: { title: string }) => idea.title)).toEqual(["Second", "First"]);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${first.id}`).then((response) => response.json());
      expect(detail.questions).toMatchObject([{ id: question.id, answer: null }]);
      expect((await request(`implementations/${first.id}/approvals`, { kind: "shared_understanding", revision: detail.question_revision, scope: "Confirm" })).status).toBe(409);
      expect(detail.runs).toEqual([]);
      expect((await request(`implementations/${first.id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Public API and browser" })).status).toBe(200);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("keeps specifications immutable and refuses stale acceptance and cyclic Tickets", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-specification-"));
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Stable contract", description: "" }).then((response) => response.json());
      const prefix = `implementations/${idea.id}`;
      const firstResponse = await request(`${prefix}/specifications`, { content: "Version one" });
      expect(firstResponse.status).toBe(201);
      const first = await firstResponse.json();
      const second = await request(`${prefix}/specifications`, { content: "Version two" }).then((response) => response.json());
      expect((await request(`${prefix}/approvals`, { kind: "specification", revision: first.id, scope: "Accept version one" })).status).toBe(409);
      expect((await request(`${prefix}/approvals`, { kind: "specification", revision: second.id, scope: "Accept version two" })).status).toBe(201);
      const cycle = await request(`${prefix}/tickets`, { specification_id: second.id, tickets: [{ key: "a", title: "A", acceptance: "A works", dependencies: ["b"] }, { key: "b", title: "B", acceptance: "B works", dependencies: ["a"] }] });
      expect(cycle.status).toBe(400);
      expect((await cycle.json()).error.code).toBe("cyclic_graph");
      const graph = await request(`${prefix}/tickets`, { specification_id: second.id, tickets: [{ key: "a", title: "A", acceptance: "A works", dependencies: [] }, { key: "b", title: "B", acceptance: "B works", dependencies: ["a"] }] });
      expect(graph.status).toBe(201);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/${prefix}`).then((response) => response.json());
      expect(detail.specifications.map((spec: { content: string }) => spec.content)).toEqual(["Version one", "Version two"]);
      expect(detail.tickets).toHaveLength(2);
      expect(detail.tickets[1].dependencies).toEqual([detail.tickets[0].id]);
      expect(detail.runs).toEqual([]);
      expect((await request(`${prefix}/approvals`, { kind: "ticket_graph", revision: detail.graph_hash, scope: "Accept version two Tickets" })).status).toBe(201);
      const third = await request(`${prefix}/specifications`, { content: "Version three changes acceptance" }).then((response) => response.json());
      await request(`${prefix}/approvals`, { kind: "specification", revision: third.id, scope: "Accept revised scope" });
      expect((await request(`${prefix}/approvals`, { kind: "ticket_graph", revision: detail.graph_hash, scope: "Reuse obsolete Tickets" })).status).toBe(409);
      const revised = await fetch(`http://localhost:${app.port}/api/factory/${prefix}`).then((response) => response.json());
      expect(revised.tickets).toEqual([]);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("imports native messages once and retains versioned attachments after restart", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-artifacts-"));
    let app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Artifact research", description: "" }).then((response) => response.json());
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      const chatId = detail.chats[0].id;
      const native = { chat_id: chatId, role: "agent", content: "Retained answer", source_id: "local:codex:owned-rollout", sequence: 1 };
      const first = await request(`implementations/${idea.id}/messages`, native);
      expect(first.status).toBe(201);
      const imported = await first.json();
      const duplicate = await request(`implementations/${idea.id}/messages`, native).then((response) => response.json());
      expect(duplicate.id).toBe(imported.id);
      const artifactResponse = await request(`implementations/${idea.id}/artifacts`, { chat_id: chatId, name: "research.md", media_type: "text/markdown", content_base64: Buffer.from("# Research\nKeep me").toString("base64"), origin: "upload" });
      expect(artifactResponse.status).toBe(201);
      const artifact = await artifactResponse.json();
      app.stop(); app = createServer({ port: 0, stateDir: state, machines: false });
      const stored = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(stored.messages).toHaveLength(1);
      expect(stored.artifacts).toMatchObject([{ id: artifact.id, name: "research.md", version: 1, size: 18 }]);
      const source = await fetch(`http://localhost:${app.port}/api/factory/artifacts/${artifact.id}/source`);
      expect(await source.text()).toBe("# Research\nKeep me");
      expect((await request(`implementations/${idea.id}/artifacts`, { chat_id: "other-chat", name: "escape", media_type: "text/plain", content_base64: "eA==", origin: "upload" })).status).toBe(400);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("attaches a captured idea to a verified Project without replacing its history", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-project-"));
    const repo = join(state, "repo");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);
    for (const args of [["init", "-b", "main"], ["-c", "user.name=Factory test", "-c", "user.email=factory@example.invalid", "commit", "--allow-empty", "-m", "initial"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    }
    const app = createServer({ port: 0, stateDir: state, machines: false });
    const request = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    try {
      const idea = await request("implementations", { title: "Research first", description: "Original evidence" }).then((response) => response.json());
      const projectResponse = await request("projects", { name: "Sample", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
      expect(projectResponse.status).toBe(201);
      const project = await projectResponse.json();
      const attached = await request(`implementations/${idea.id}/configure`, { project_id: project.id });
      expect(attached.status).toBe(200);
      const detail = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(detail.implementation).toMatchObject({ id: idea.id, project_id: project.id });
      expect(detail.messages).toMatchObject([{ content: "Original evidence" }]);
      const invalid = await request("projects", { name: "Wrong", path: join(repo, "missing"), machine_id: "local", provider: "codex", tracker: "app" });
      expect(invalid.status).toBe(400);
    } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
  });
  it("retains an unassigned idea and its chat across a server restart", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-eye-records-"));
    let app = createServer({ port: 0, stateDir: state, machines: false });
    try {
      const created = await fetch(`http://localhost:${app.port}/api/factory/implementations`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" },
        body: JSON.stringify({ title: "Explore offline notes", description: "Keep research across machines" }),
      });
      expect(created.status).toBe(201);
      const idea = await created.json();
      expect(idea).toMatchObject({ title: "Explore offline notes", project_id: null, stage: "inbox" });
      app.stop();
      app = createServer({ port: 0, stateDir: state, machines: false });
      const retained = await fetch(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then((response) => response.json());
      expect(retained.implementation.id).toBe(idea.id);
      expect(retained.messages).toMatchObject([{ content: "Keep research across machines", role: "owner" }]);
      expect(retained.chats).toHaveLength(1);
    } finally {
      app.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("Grok conversation API", () => {
  it.skipIf(process.platform !== "linux")("uses exact process/session evidence, validators and revision-bound output refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-grok-contract-"));
    const id = "00000000-0000-4000-8000-000000000001";
    const directory = join(root, "sessions", "%2Ffictional", id);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "updates.jsonl");
    const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: id, update } }) + "\n";
    const user = event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "fictional prompt" }, _meta: { promptIndex: 0 } });
    const call = event({ sessionUpdate: "tool_call", toolCallId: "fictional-call", title: "Read", rawInput: { path: "fiction.txt" } });
    const output = (text: string) => event({ sessionUpdate: "tool_call_update", toolCallId: "fictional-call", content: [{ type: "content", content: { type: "text", text } }] });
    writeFileSync(path, user + call + output("x".repeat(5000)));
    const events = join(directory, "events.jsonl");
    writeFileSync(events, "");
    // The test runtime is a native stand-in that only sleeps and holds the fd; renamed uutils sleep cannot run.
    const executable = join(root, "grok");
    copyFileSync(process.execPath, join(root, "grok-1.0.50-linux-x86_64")); symlinkSync("grok-1.0.50-linux-x86_64", executable); chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-grok-api" });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable} -e 'await Bun.sleep(600_000)' 3<${events}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "grok") break;
        if (Date.now() > deadline) throw new Error("fixture Grok process did not start");
        await Bun.sleep(50);
      }
      let reportSequence = 0;
      // Stands in for the SessionStart report Grok's herdr integration makes: Herdr 0.9.3
      // replaces a Grok ID only for a newer "new" report.
      const report = (session: string, source = "new") => herdrRpc("pane.report_agent_session", { pane_id: paneId, agent: "grok", source: "herdr:grok", seq: ++reportSequence, agent_session_id: session, session_start_source: source });
      await report(id);
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), grokHome: root });
      const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
      const first = await fetch(url);
      const body = await first.json();
      expect(body.source).toBe("grok-transcript");
      expect(body.activity).toBe("working");
      expect(body.turns[0].parts[0].text).toBe("fictional prompt");
      expect((await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } })).status).toBe(304);
      const ref = body.turns[1].parts[0].output_ref;
      const outputUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref })}`;
      const whole = await fetch(outputUrl);
      expect(whole.headers.get("cache-control")).toBe("private, no-store");
      expect(await whole.text()).toBe("x".repeat(5000));
      appendFileSync(path, output("y".repeat(5000)));
      expect((await fetch(outputUrl)).status).toBe(404);
      const next = await fetch(url);
      expect(next.headers.get("etag")).not.toBe(first.headers.get("etag"));
      appendFileSync(path, event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fictional thought" } }));
      const thinking = await fetch(url);
      expect((await thinking.json()).activity).toBe("thinking");
      expect(thinking.headers.get("etag")).not.toBe(next.headers.get("etag"));
      appendFileSync(path, event({ sessionUpdate: "turn_completed" }));
      expect((await (await fetch(url)).json()).activity).toBe("idle");
      appendFileSync(path, event({ sessionUpdate: "rewind_marker", target_prompt_index: 0 }, true));
      expect((await fetch(`${url}&from=${encodeURIComponent(`${body.history_id}:0`)}`)).status).toBe(409);
      const local = await fetch(url.replace("/api/pane/", "/api/machines/local/pane/"));
      expect((await local.json()).turns).toEqual([]);
      const missing = "00000000-0000-4000-8000-000000000002";
      await report(missing, "resume");
      expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent_session?.value).toBe(id);
      await report(missing);
      for (const deadline = Date.now() + 5000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent_session?.value === missing) break;
        if (Date.now() > deadline) throw new Error("Herdr did not apply the second session report");
        await Bun.sleep(50);
      }
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      app?.stop(); await workspaceClose(created.workspace.workspace_id);
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Agy conversation API", () => {
  it.skipIf(process.platform !== "linux")("binds the selected held lock, honors saved rewinds and recovers from an unwritten store", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-agy-contract-"));
    const id = "00000000-0000-4000-8000-000000000031";
    const path = join(root, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(join(root, "conversations")); mkdirSync(join(root, "presence"));
    const lock = join(root, "presence", `${id}.lock`);
    writeFileSync(lock, "");
    // Another unheld lock in the same store must never select a conversation.
    writeFileSync(join(root, "presence", "00000000-0000-4000-8000-000000000032.lock"), "");
    const executable = join(root, "agy");
    // Bun preserves this native process name without a system sleep binary's multicall dispatch.
    copyFileSync(process.execPath, executable); chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-agy-api" });
    let app: ReturnType<typeof createServer> | undefined, db: Database | undefined;
    let monitor: ConversationMonitor | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable} -e 'await Bun.sleep(600_000)' 3<${lock}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "agy") break;
        if (Date.now() > deadline) throw new Error("fixture Agy process did not start");
        await Bun.sleep(50);
      }
      app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
      const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
      db = new Database(join(root, "conversations", `${id}.db`));
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
      const empty = await (await fetch(url)).json();
      expect(empty.source).toBe("agy-transcript"); expect(empty.turns).toEqual([]);
      const row = (step_index: number, type: string, content: string) => JSON.stringify({ step_index, type, status: "DONE", content }) + "\n";
      db.exec("INSERT INTO steps VALUES (0), (1)");
      writeFileSync(path, row(0, "USER_INPUT", "fictional prompt") + row(1, "GENERIC", "x".repeat(5000)));
      const first = await fetch(url), body = await first.json();
      expect(body.source).toBe("agy-transcript");
      expect(body.activity).toBe("working");
      expect(body.turns[0].parts[0].text).toBe("fictional prompt");
      expect((await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } })).status).toBe(304);
      const ref = body.turns[1].parts[0].output_ref;
      const outputUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref })}`;
      expect(await (await fetch(outputUrl)).text()).toBe("x".repeat(5000));
      db.exec("INSERT INTO steps VALUES (2)");
      appendFileSync(path, row(2, "PLANNER_RESPONSE", "Finished"));
      const completed = await fetch(url, { headers: { "if-none-match": first.headers.get("etag")! } });
      expect(completed.status).toBe(200);
      expect((await completed.json()).activity).toBe("idle");
      expect(completed.headers.get("etag")).not.toBe(first.headers.get("etag"));
      db.exec("INSERT INTO steps VALUES (3)");
      appendFileSync(path, row(3, "USER_INPUT", "New work"));
      expect((await (await fetch(url)).json()).activity).toBe("working");
      const changes: string[] = [];
      monitor = new ConversationMonitor((_pane, signature) => changes.push(signature));
      monitor.watch(paneId);
      const changed = async (count: number) => {
        for (const deadline = Date.now() + 5000; changes.length <= count;) {
          if (Date.now() > deadline) throw new Error("Agy catalog change was not pushed");
          await Bun.sleep(20);
        }
      };
      await changed(0);
      const beforeCut = changes.length;
      db.exec("DELETE FROM steps WHERE idx >= 1");
      await changed(beforeCut);
      expect((await (await fetch(url)).json()).turns).toHaveLength(1);
      expect((await fetch(`${url}&from=${encodeURIComponent(`${body.history_id}:0`)}`)).status).toBe(409);
      expect((await fetch(outputUrl)).status).toBe(404);
      forgetTranscriptState();
      const local = await fetch(url.replace("/api/pane/", "/api/machines/local/pane/"));
      expect((await local.json()).turns).toHaveLength(1);
      db.exec("DROP TABLE steps");
      expect(await (await fetch(url)).json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      monitor?.stop(); app?.stop(); db?.close(); await workspaceClose(created.workspace.workspace_id);
      forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("single-pane context lookup", () => {
  for (const route of ["commands", "files"] as const) {
    it(`rejects an unknown pane on /api/pane/${route} with the shared error envelope`, async () => {
      const response = await fetch(`${base()}/api/pane/${route}?pane_id=w9999:p9999`);
      expect(response.status).toBe(404);
      const body: ApiError = await response.json();
      expect(body.error.code).toBe("pane_not_found");
      expect(typeof body.error.message).toBe("string");
    });
  }
});

describe("GET /api/pane/plan", () => {
  it("requires GET and a pane id with the shared error envelope", async () => {
    for (const [url, method, code] of [
      [`${base()}/api/pane/plan`, "GET", "missing_pane_id"],
      [`${base()}/api/pane/plan?pane_id=w9999:p9999`, "POST", "method_not_allowed"],
    ] as const) {
      const response = await fetch(url, { method });
      expect(response.status).toBe(400);
      const body: ApiError = await response.json();
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
  });
});

describe("Devin conversation API", () => {
  it("keeps the terminal fallback rather than guessing a shell pane's session", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-web-ui-devin-contract-"));
    const created = await workspaceCreate({ cwd: state, label: "herdr-web-ui-test-devin-identity" });
    const dbPath = join(state, "sessions.db");
    let bridge: ReturnType<typeof createServer> | undefined;
    try {
      const paneId = created.root_pane.pane_id;
      const snapshot = await sessionSnapshot();
      const pane = snapshot.panes.find((entry) => entry.pane_id === paneId)!;
      const cwd = pane.foreground_cwd || pane.cwd;
      if (!cwd) throw new Error("test pane has no working directory");
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT)");
        db.query("INSERT INTO sessions VALUES ('synthetic', ?, NULL, 0, NULL)").run(cwd);
      } finally { db.close(); }
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "devin", state: "idle" });
      bridge = createServer({ port: 0, stateDir: state, devinDbPath: dbPath });
      const response = await fetch(`http://localhost:${bridge.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "scrollback", turns: [] });
    } finally {
      bridge?.stop();
      await workspaceClose(created.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("usage API", () => {
  it("returns OpenCode Go windows without exposing its credential", async () => {
    const usageState = mkdtempSync(join(tmpdir(), "herdr-opencode-contract-"));
    const token = "oc_sk_contract_only";
    const usage = new UsageService({
      home: usageState, env: { OPENCODE_API_KEY: token }, platform: "linux", now: () => Date.parse("2026-10-06T00:00:00Z"),
      keychain: async () => ({ status: "missing" }), run: async () => null,
      fetch: async (url, init) => {
        expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({ usage: {
          rolling: { percent: 12, resetsAt: "2026-10-06T01:00:00Z" },
          weekly: { percent: 34 }, monthly: { percent: 56 },
        } });
      },
    }, USAGE_PROVIDERS.filter((provider) => provider.id === "opencode"));
    const app = createServer({ port: 0, stateDir: usageState, usage, token: "report-token" });
    try {
      const url = `http://localhost:${app.port}/api/usage`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: "Bearer report-token" } });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(usageState);
      expect((JSON.parse(body) as UsageReport).providers).toMatchObject([{
        id: "opencode", account: null, plan: "Go", problem: null,
        windows: [
          { kind: "session", used_percent: 12, resets_at: "2026-10-06T01:00:00.000Z" },
          { kind: "week", used_percent: 34 }, { kind: "month", used_percent: 56 },
        ],
      }]);
    } finally { app.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });

  it("answers the report and keeps it behind the token gate", async () => {
    const usageState = mkdtempSync(join(tmpdir(), "herdr-usage-auth-"));
    const usage = new UsageService(undefined, []);
    const open = createServer({ port: 0, stateDir: usageState, usage });
    const gated = createServer({ port: 0, stateDir: usageState, usage, token: "test-usage-token" });
    try {
      const answered = await fetch(`http://localhost:${open.port}/api/usage`);
      expect(answered.status).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("no-store");
      expect(await answered.json() as UsageReport).toEqual({ providers: [] });
      expect((await fetch(`http://localhost:${gated.port}/api/usage`)).status).toBe(401);
      const withToken = await fetch(`http://localhost:${gated.port}/api/usage`, { headers: { authorization: "Bearer test-usage-token" } });
      expect(withToken.status).toBe(200);
    } finally { open.stop(); gated.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });
});

describe("voice API", () => {
  it("keeps the key on the server, refuses cross-site writes and streams a transcript", async () => {
    const voiceState = mkdtempSync(join(tmpdir(), "herdr-voice-contract-"));
    const key = "sk-contract-0123456789";
    const provider = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/audio/transcriptions") return new Response("not found", { status: 404 });
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        await request.formData();
        return new Response(`data: ${JSON.stringify({ type: "transcript.text.done", text: "git status" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const voice = new VoiceService({ stateDir: voiceState, env: { HERDR_WEB_OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1` }, fetch });
    const open = createServer({ port: 0, stateDir: voiceState, voice });
    const gated = createServer({ port: 0, stateDir: voiceState, voice, token: "test-voice-token" });
    const at = (path: string) => `http://localhost:${open.port}${path}`;
    try {
      expect((await fetch(`http://localhost:${gated.port}/api/voice`)).status).toBe(401);
      expect(await (await fetch(at("/api/voice"))).json()).toMatchObject({ configured: false, source: null });

      const crossSite = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ api_key: key }) });
      expect(crossSite.status).toBe(403);
      const saved = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key }) });
      expect(saved.status).toBe(200);
      const status = await (await fetch(at("/api/voice"))).text();
      expect(JSON.parse(status)).toMatchObject({ configured: true, source: "file" });
      expect(status).not.toContain(key);
      expect(statSync(join(voiceState, "voice.json")).mode & 0o777).toBe(0o600);

      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "voice.webm");
      form.append("mode", "chat");
      form.append("polish", "0");
      const transcribed = await fetch(at("/api/voice/transcribe"), { method: "POST", body: form });
      expect(transcribed.headers.get("content-type")).toContain("application/x-ndjson");
      expect((await transcribed.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ type: "done", text: "git status" }]);
    } finally {
      open.stop(); gated.stop(); provider.stop(true);
      rmSync(voiceState, { recursive: true, force: true });
    }
  });
});

describe("update API", () => {
  it("reports unmanaged servers without performing network discovery", async () => {
    const response = await fetch(`${base()}/api/updates`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { managed: boolean }).managed).toBe(false);
  });

  it("answers what the available update brings, and nothing where no supervisor told it", async () => {
    const none = await fetch(`${base()}/api/updates/notes`);
    expect(none.status).toBe(200);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ revision: null, releases: [], omitted: 0 });
    expect((await fetch(`${base()}/api/updates/notes`, { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(405);

    const notes: UpdateNotes = { revision: "b".repeat(40), releases: [{ version: "9.9.9", date: "2026-10-07", notes: "### Added\n- A thing." }], omitted: 2 };
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-notes-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => ({ ...unmanagedUpdateStatus(), managed: true, available: true }), notes: () => notes, installed: noInstalledNotes, request() {} } });
    try {
      expect(await (await fetch(`http://localhost:${managed.port}/api/updates/notes`)).json()).toEqual(notes);
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
  });

  it("answers what the last update brought, and nothing where no update was installed", async () => {
    const none = await fetch(`${base()}/api/updates/installed`);
    expect(none.status).toBe(200);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toEqual({ revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 });
    expect((await fetch(`${base()}/api/updates/installed`, { method: "POST", headers: { "x-herdr-update": "1" } })).status).toBe(405);

    const installed: InstalledNotes = { revision: "c".repeat(40), version: "9.9.9", previous_version: "9.9.8", installed_at: "2026-10-07T00:00:00.000Z",
      releases: [{ version: "9.9.9", date: "2026-10-07", notes: "### Added\n- A thing.", summary: { en: { new: ["A thing."] }, ko: { new: ["기능 하나."] } } }], omitted: 0 };
    const managedState = mkdtempSync(join(tmpdir(), "herdr-update-installed-"));
    const managed = createServer({ port: 0, stateDir: managedState,
      updates: { status: () => ({ ...unmanagedUpdateStatus(), managed: true }), notes: () => ({ revision: null, releases: [], omitted: 0 }), installed: () => installed, request() {} } });
    try {
      expect(await (await fetch(`http://localhost:${managed.port}/api/updates/installed`)).json()).toEqual(installed);
    } finally { managed.stop(); rmSync(managedState, { recursive: true, force: true }); }
  });

  it("refuses cross-site/form update requests and unmanaged installs", async () => {
    for (const headers of [{}, { "x-herdr-update": "1", origin: "https://untrusted.invalid" },
      { "x-herdr-update": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(response.status).toBe(409);
    expect((await response.json() as ApiError).error.code).toBe("updates_unmanaged");
  });

  it("keeps status and update actions behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-update-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-update-token" });
    try {
      for (const path of ["/api/updates", "/api/updates/notes", "/api/updates/installed", "/api/updates/check", "/api/updates/install"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}${path}`, {
          method: path === "/api/updates/check" || path === "/api/updates/install" ? "POST" : "GET", headers: { "x-herdr-update": "1" },
        });
        expect(response.status).toBe(401);
      }
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}/api/herdr/update`, { method, headers: { "x-herdr-update": "1" } });
        expect(response.status).toBe(401);
      }
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });

  it("offers no herdr update on a server started without the updater", async () => {
    const response = await fetch(`${base()}/api/herdr/update`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json() as HerdrUpdateStatus).toMatchObject({ supported: false, phase: "idle", output: null });
    expect((await fetch(`${base()}/api/herdr/update`, { method: "POST" })).status).toBe(403);
    const refused = await fetch(`${base()}/api/herdr/update`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as ApiError).error.code).toBe("herdr_update_unsupported");
  });

  it("updates herdr through the server and reports what herdr said", async () => {
    // a stand-in: the real `herdr update` would replace the herdr on PATH and hand its server off
    const state = mkdtempSync(join(tmpdir(), "herdr-update-api-"));
    const standIn = join(state, "herdr");
    writeFileSync(standIn, [
      "#!/bin/sh",
      `echo "$*" >> '${join(state, "calls")}'`,
      'case "$1" in',
      `  status) echo '{"client":{"version":"0.9.3","binary":"${standIn}"},"server":{"running":true,"version":"0.9.3","capabilities":{"live_handoff":true}},"update":{"server_binary_stale":false}}' ;;`,
      "  update) echo 'already up to date (0.9.3)' >&2 ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(standIn, 0o755);
    const server = createServer({ port: 0, stateDir: state, token: "", herdrUpdate: new HerdrUpdater({ bin: standIn }) });
    const url = `http://localhost:${server.port}/api/herdr/update`;
    try {
      expect(await (await fetch(url)).json() as HerdrUpdateStatus).toMatchObject({ supported: true, phase: "idle", server_version: "0.9.3", binary_version: "0.9.3", stale: false });
      expect((await fetch(url, { method: "POST" })).status).toBe(403);
      expect(existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "").not.toContain("update --handoff");
      const accepted = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
      expect(accepted.status).toBe(202);
      const deadline = Date.now() + 10_000;
      let status = await (await fetch(url)).json() as HerdrUpdateStatus;
      while (status.phase === "updating" || status.finished_at === null) {
        if (Date.now() >= deadline) throw new Error("Timed out: the herdr update finished");
        await Bun.sleep(20);
        status = await (await fetch(url)).json() as HerdrUpdateStatus;
      }
      expect(status).toMatchObject({ phase: "idle", output: "already up to date (0.9.3)" });
      expect(readFileSync(join(state, "calls"), "utf8")).toContain("update --handoff");
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("removed upstream telemetry API", () => {
  it("refuses reads and attempts to enable install/update reporting", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base()}/api/telemetry`, { method, headers: { "x-herdr-update": "1", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ enabled: true, notice_seen: true }) } : {}) });
      expect(response.status).toBe(404);
      expect((await response.json() as ApiError).error.code).toBe("not_found");
    }
  });
});

describe("phone access", () => {
  it("says how a phone can reach this server, whatever Tailscale is doing on this machine", async () => {
    const response = await fetch(`${base()}/api/access`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const access = (await response.json()) as RemoteAccess;
    expect(access.port).toBe(server.port);
    expect(["missing", "stopped", "running"]).toContain(access.tailscale.state);
    if (access.tailscale.state !== "running") {
      expect(access.tailscale).toEqual({ state: access.tailscale.state, dns_name: null, serving_url: null, serve_command: null, serve_url: null });
    } else {
      // either an address already works, or there is a command to make one
      expect((access.tailscale.serving_url === null) !== (access.tailscale.serve_command === null)).toBe(true);
      if (access.tailscale.serve_command !== null) expect(access.tailscale.serve_command).toContain(`http://127.0.0.1:${server.port}`);
    }
  });

  it("stays behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-access-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-access-token" });
    try {
      expect((await fetch(`http://localhost:${protectedServer.port}/api/access`)).status).toBe(401);
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });
});

describe("Portal API", () => {
  it("does not serve requests until startup cleanup completes", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-startup-gate-"));
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    class DeferredPortal extends PortalService {
      override resume(): Promise<void> { return cleanup; }
    }
    const server = createServer({ port: 0, stateDir: state, token: "", portal: new DeferredPortal({ stateDir: state }) });
    try {
      let resolved = false;
      const request = fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`).then((response) => {
        resolved = true;
        return response;
      });
      const deadline = Date.now() + 50;
      while (!resolved && Date.now() < deadline) await Bun.sleep(5);
      expect(resolved).toBe(false);
      releaseCleanup();
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, bridge_protocol: expect.any(Number) });
    } finally {
      releaseCleanup();
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("fails closed when startup cleanup rejects", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-startup-failure-"));
    class FailedPortal extends PortalService {
      override resume(): Promise<void> { return Promise.reject(new Error("Portal cleanup failed")); }
    }
    const server = createServer({ port: 0, stateDir: state, token: "", portal: new FailedPortal({ stateDir: state }) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    } finally {
      server.stop();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("opens a public address only behind the token, and closes it again", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-portal-api-"));
    const standIn = join(state, "stand-in-portal");
    writeFileSync(standIn, [
      "#!/bin/sh",
      'case "$1" in',
      "  version) echo v2.6.1 ;;",
      "  expose) trap 'exit 0' TERM; echo 'INF service ready at https://herdr-test-0123.relay.example:443'; while :; do sleep 0.05; done ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(standIn, 0o755);
    const relay = (async () => Response.json({ data: { release_version: "v2.6.1" } })) as unknown as typeof fetch;
    const server = createServer({ port: 0, stateDir: state, token: "test-portal-token", portal: new PortalService({ stateDir: state, bin: standIn, fetch: relay }) });
    const url = `http://127.0.0.1:${server.port}/api/portal`;
    const signedIn = { authorization: "Bearer test-portal-token" };
    const post = (action: string, headers: Record<string, string>) => fetch(`${url}/${action}`, { method: "POST", headers: { ...headers, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ relay: "relay.example" }) });
    const status = async (headers: Record<string, string> = signedIn) => await (await fetch(url, { headers })).json() as PortalStatus;
    try {
      expect((await fetch(url)).status).toBe(401);
      expect(await status()).toMatchObject({ supported: true, usable: true, blocked: null, phase: "idle" });
      expect((await post("start", {})).status).toBe(401);
      expect((await post("start", signedIn)).status).toBe(202);
      const deadline = Date.now() + 10_000;
      let running = await status();
      while (running.phase === "starting") {
        if (Date.now() >= deadline) throw new Error("Timed out: Portal was ready");
        await Bun.sleep(20);
        running = await status();
      }
      expect(running).toMatchObject({ phase: "running", url: "https://herdr-test-0123.relay.example", relay: "https://relay.example" });
      expect((await post("stop", signedIn)).status).toBe(202);
      expect((await status()).url).toBeNull();
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("mutation body validation", () => {
  it("rejects non-object JSON without touching herdr or losing the error envelope", async () => {
    for (const path of [
      "/api/workspace/create", "/api/tab/create", "/api/tab/rename", "/api/tab/close", "/api/tab/move", "/api/workspace/rename", "/api/workspace/move", "/api/workspace/close",
      "/api/pane/rename", "/api/pane/input", "/api/pane/keys", "/api/pane/close", "/api/pane/move", "/api/pane/image",
      "/api/pane/scroll", "/api/agent/rename",
    ]) {
      for (const body of [null, [], "text", 42, true]) {
        const response = await fetch(`${base()}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error.code).toBe("invalid_body");
      }
    }
  });

  it("rejects invalid pane identifiers and key/image fields before RPCs", async () => {
    for (const [path, body, code] of [
      ["/api/pane/input", { pane_id: true, text: "echo bad" }, "missing_pane_id"],
      ["/api/pane/close", { pane_id: 5 }, "missing_pane_id"],
      ["/api/pane/keys", { pane_id: "unknown", keys: [null] }, "missing_keys"],
      ["/api/pane/image", { pane_id: "unknown", content_type: "image/png", data_base64: {} }, "invalid_image"],
      ["/api/workspace/create", { agent: { kind: "claude", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const response = await fetch(`${base()}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
  });
});

// herdr's prefix+shift+t and prefix+shift+x, against a real herdr.
describe("tab rename and close", () => {
  const post = (path: string, body: unknown) => fetch(`${base()}/api/tab/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const tabsOf = async (workspaceId: string) => (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.tabs.filter((t) => t.workspace_id === workspaceId);

  it("validates the tab and the label before touching herdr", async () => {
    for (const path of ["rename", "close"]) {
      for (const tab_id of [undefined, null, "", 1, true]) {
        const res = await post(path, { tab_id, label: "name" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as ApiError).error.code).toBe("missing_tab_id");
      }
      expect((await fetch(`${base()}/api/tab/${path}`)).status).toBe(400);
      const missing = await post(path, { tab_id: "unknown:t9", label: "name" });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as ApiError).error.code).toBe("tab_not_found");
    }
    // herdr would keep an empty label as the tab's name
    for (const label of [undefined, null, "", "   ", 3]) {
      const res = await post("rename", { tab_id: "unknown:t9", label });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("missing_label");
    }
  });

  it("renames a tab, closes one beside another, and takes the workspace with its last tab", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-rename-close" });
    const id = owned.workspace.workspace_id;
    let closed = false;
    try {
      const second = await tabCreate({ workspaceId: id });
      const renamed = await post("rename", { tab_id: second.tab.tab_id, label: "  build  " });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ ok: true });
      expect((await tabsOf(id)).find((t) => t.tab_id === second.tab.tab_id)?.label).toBe("build");
      // the local-PC alias reaches both
      const alias = await fetch(`${base()}/api/machines/local/tab/rename`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ tab_id: second.tab.tab_id, label: "tests" }),
      });
      expect(alias.status).toBe(200);
      expect((await tabsOf(id)).find((t) => t.tab_id === second.tab.tab_id)?.label).toBe("tests");

      expect((await post("close", { tab_id: owned.tab.tab_id })).status).toBe(200);
      const left = await tabsOf(id);
      expect(left.map((t) => t.tab_id)).toEqual([second.tab.tab_id]);
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(snapshot.panes.some((p) => p.pane_id === owned.root_pane.pane_id)).toBe(false);
      expect(snapshot.panes.some((p) => p.pane_id === second.root_pane.pane_id)).toBe(true);

      expect((await post("close", { tab_id: second.tab.tab_id })).status).toBe(200);
      closed = !(await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot.workspaces.some((w) => w.workspace_id === id);
      expect(closed).toBe(true);
    } finally { if (!closed) await workspaceClose(id); }
  });
});

describe("tab reorder", () => {
  const post = (body: unknown, path = "/api/tab/move") => fetch(`${base()}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body),
  });
  it("requires a tab and a non-negative safe insertion boundary", async () => {
    expect((await fetch(`${base()}/api/tab/move`)).status).toBe(400);
    for (const tab_id of [undefined, null, "", 4, true]) {
      const result = await post({ tab_id, insert_index: 0 });
      expect(result.status).toBe(400);
      expect(((await result.json()) as ApiError).error.code).toBe("missing_tab_id");
    }
    for (const insert_index of [undefined, null, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      const result = await post({ tab_id: "unknown:t9", insert_index });
      expect(result.status).toBe(400);
      expect(((await result.json()) as ApiError).error.code).toBe("invalid_index");
    }
    const missing = await post({ tab_id: "unknown:t9", insert_index: 0 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("tab_not_found");
  });
  it("uses boundaries before removal, preserves focus and IDs, and rejects out-of-range moves", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-reorder" });
    const id = owned.workspace.workspace_id;
    try {
      const second = await tabCreate({ workspaceId: id, label: "build" });
      const third = await tabCreate({ workspaceId: id });
      const firstId = owned.tab.tab_id;
      const initial = await sessionSnapshot();
      const nativeIds = () => sessionSnapshot().then((snapshot) => snapshot.tabs.filter((tab) => tab.workspace_id === id).map((tab) => tab.tab_id));
      for (const [boundary, expected] of [[3, [second.tab.tab_id, third.tab.tab_id, firstId]], [0, [firstId, second.tab.tab_id, third.tab.tab_id]]] as const) {
        const response = await post({ tab_id: firstId, insert_index: boundary }, "/api/machines/local/tab/move");
        expect(response.status).toBe(200);
        const result = await response.json() as TabMoved;
        expect(result.ok).toBe(true);
        expect(result.tabs.map((tab) => tab.tab_id)).toEqual([...expected]);
        expect(result.tabs.find((tab) => tab.tab_id === second.tab.tab_id)?.label).toBe("build");
        expect(await nativeIds()).toEqual([...expected]);
        const snapshot = await sessionSnapshot();
        expect(snapshot.focused_pane_id).toBe(initial.focused_pane_id);
        expect(snapshot.focused_tab_id).toBe(initial.focused_tab_id);
        expect(snapshot.panes.filter((pane) => pane.workspace_id === id).map((pane) => pane.pane_id).sort()).toEqual(initial.panes.filter((pane) => pane.workspace_id === id).map((pane) => pane.pane_id).sort());
      }
      const bad = await post({ tab_id: firstId, insert_index: 4 });
      expect(bad.status).toBe(404);
      expect(((await bad.json()) as ApiError).error.code).toBe("tab_move_failed");
      expect(await nativeIds()).toEqual([firstId, second.tab.tab_id, third.tab.tab_id]);
      // Either boundary touching the source is a no-op, not a close/recreate.
      expect((await post({ tab_id: firstId, insert_index: 1 })).status).toBe(200);
      expect(await nativeIds()).toEqual([firstId, second.tab.tab_id, third.tab.tab_id]);
    } finally { await workspaceClose(id); }
  });
});

describe("agent rename", () => {
  const post = (body: unknown) => fetch(`${base()}/api/agent/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nameOf = async (paneId: string): Promise<string | null> =>
    (await herdrRpc<{ agents: Array<{ pane_id: string; name?: string | null }> }>("agent.list", {})).agents.find((agent) => agent.pane_id === paneId)?.name ?? null;

  it("sets, reads back and clears a pane's agent name, and passes herdr's refusals through", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-agent-rename" });
    const id = owned.workspace.workspace_id;
    const paneId = owned.root_pane.pane_id;
    try {
      // a shell pane has no live agent to name
      const shell = await post({ pane_id: paneId, name: "webui-rename-a" });
      expect(shell.status).toBe(404);
      expect(((await shell.json()) as ApiError).error.code).toBe("agent_not_found");

      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr-web-ui-test", agent: "claude", state: "idle" });
      const set = await post({ pane_id: paneId, name: "webui-rename-a" });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBe("webui-rename-a");
      // the browser reads it off the session snapshot's agents
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      expect(session.snapshot.agents.find((agent) => agent.pane_id === paneId)?.name).toBe("webui-rename-a");

      // herdr's rule, in herdr's words, and the name stays
      const invalid = await post({ pane_id: paneId, name: "Bad Name" });
      expect(invalid.status).toBe(404);
      const refused = (await invalid.json()) as ApiError;
      expect(refused.error.code).toBe("invalid_agent_name");
      expect(refused.error.message).toContain("lowercase");
      expect(await nameOf(paneId)).toBe("webui-rename-a");

      // unique among the session's live agents
      const second = await tabCreate({ workspaceId: id });
      await herdrRpc("pane.report_agent", { pane_id: second.root_pane.pane_id, source: "herdr-web-ui-test", agent: "codex", state: "working" });
      const taken = await post({ pane_id: second.root_pane.pane_id, name: "webui-rename-a" });
      expect(taken.status).toBe(404);
      expect(((await taken.json()) as ApiError).error.code).toBe("agent_name_taken");
      expect(await nameOf(second.root_pane.pane_id)).toBeNull();

      // the local-PC alias reaches it, and null clears
      const alias = await fetch(`${base()}/api/machines/local/agent/rename`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ pane_id: paneId, name: null }),
      });
      expect(alias.status).toBe(200);
      expect(await alias.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBeNull();
    } finally { await workspaceClose(id); }
  });

  it("forwards a remote rename with the registered bridge token, not the browser's", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-agent-rename-bridge" });
    const paneId = owned.root_pane.pane_id;
    const state = mkdtempSync(join(tmpdir(), "herdr-web-ui-agent-rename-bridge-"));
    // the other PC's bridge asks its browsers for a token of its own; the proxy holds only the bridge token it registered
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: state, tailscaleOwner: null });
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const manager = { endpoint: (id: string) => id === "rename-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    try {
      expect(registered.token).not.toBe("test-browser-token");
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr-web-ui-test", agent: "claude", state: "idle" });
      // the browser token is deliberately absent: the proxy must authenticate with the bridge token
      expect((await fetch(`${endpoint}/api/agent/rename`, { method: "POST", body: "{}" })).status).toBe(401);
      const res = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/rename-remote/agent/rename", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ pane_id: paneId, name: "webui-rename-b" }),
      }), manager);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await nameOf(paneId)).toBe("webui-rename-b");
    } finally {
      bridge.stop();
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("validates the body before asking herdr", async () => {
    for (const [body, code] of [
      [{}, "missing_pane_id"],
      [{ pane_id: "", name: "x" }, "missing_pane_id"],
      // an omitted name is not a clear: only null is
      [{ pane_id: "w1:p1" }, "invalid_name"],
      [{ pane_id: "w1:p1", name: 42 }, "invalid_name"],
    ] as const) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/agent/rename`)).status).toBe(400);
  });
});

// Tab creation shares workspace creation's agent launch (#362 by @WOULDU-pres): the cases
// below prove the tab half of that path against a real herdr.
describe("tab creation", () => {
  const post = (body: unknown) => fetch(`${base()}/api/tab/create`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("requires an explicit workspace and validates fields before creating a tab", async () => {
    for (const workspace_id of [undefined, null, "", " ", 1, true]) {
      const res = await post({ workspace_id });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("missing_workspace_id");
    }
    for (const [fields, code] of [
      [{ cwd: join(tmpdir(), crypto.randomUUID()) }, "invalid_cwd"],
      [{ cwd: 42 }, "invalid_cwd"],
      [{ label: false }, "missing_label"],
      [{ agent: {} }, "invalid_agent"],
      [{ agent: { kind: "muse", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const res = await post({ workspace_id: "unknown", ...fields });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/tab/create`)).status).toBe(400);
    const missing = await post({ workspace_id: "unknown" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.message.length).toBeGreaterThan(0);
  });

  it("creates a sibling tab with its own cwd and label without adding a workspace", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab" });
    const cwd = mkdtempSync(join(tmpdir(), "herdr-web-ui-tab-cwd-"));
    try {
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      const res = await post({ workspace_id: owned.workspace.workspace_id, cwd, label: "second tab", agent: null });
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);
      const after = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(after.workspaces.map((w) => w.workspace_id)).toEqual(before.workspaces.map((w) => w.workspace_id));
      const pane = after.panes.find((p) => p.pane_id === created.pane_id)!;
      expect(pane.workspace_id).toBe(owned.workspace.workspace_id);
      expect(pane.cwd).toBe(cwd);
      expect(pane.tab_id).not.toBe(owned.tab.tab_id);
      expect(after.tabs.find((t) => t.tab_id === pane.tab_id)?.label).toBe("second tab");
      expect(after.workspaces.find((w) => w.workspace_id === owned.workspace.workspace_id)?.tab_count).toBe(2);
      expect(after.workspaces.find((w) => w.workspace_id === owned.workspace.workspace_id)?.label).toBe(owned.workspace.label);
      // the dialog sends null for "not given": herdr then uses the workspace's folder and the tab's number
      const defaults = await post({ workspace_id: owned.workspace.workspace_id, cwd: null, label: null, agent: null });
      expect(defaults.status).toBe(200);
      const third = await defaults.json() as WorkspaceCreated;
      expect(third).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      const last = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      const thirdPane = last.panes.find((p) => p.pane_id === third.pane_id)!;
      expect(thirdPane.cwd).toBe(owned.root_pane.cwd);
      expect(last.tabs.find((t) => t.tab_id === thirdPane.tab_id)).toMatchObject({ label: "3", number: 3 });
    } finally {
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports the authenticated local-PC alias without allowing other tab routes", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-local-alias" });
    try {
      const res = await fetch(`${base()}/api/machines/local/tab/create`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ workspace_id: owned.workspace.workspace_id, agent: null }),
      });
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);
      expect((await fetch(`${base()}/api/machines/local/tab/move/extra`)).status).toBe(404);
    } finally { await workspaceClose(owned.workspace.workspace_id); }
  });

  it("forwards remote tab creation using the registered bridge token", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-bridge" });
    const state = mkdtempSync(join(tmpdir(), "herdr-web-ui-tab-bridge-"));
    const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "test-browser-token", machines: false, registerBridge: true, stateDir: state, tailscaleOwner: null });
    const registered = JSON.parse(readFileSync(descriptorPath(), "utf8")) as BridgeDescriptor;
    const endpoint = `http://127.0.0.1:${bridge.port}`;
    const manager = { endpoint: (id: string) => id === "tab-remote" ? { url: endpoint, token: registered.token } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    try {
      const request = () => new Request("http://127.0.0.1/api/machines/tab-remote/tab/create", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ workspace_id: owned.workspace.workspace_id, cwd: tmpdir(), agent: null }),
      });
      // The browser token is deliberately absent: the proxy must authenticate with the bridge token.
      expect((await fetch(`${endpoint}/api/tab/create`, { method: "POST", body: "{}" })).status).toBe(401);
      const res = await handleMachineRequest(request(), manager);
      expect(res.status).toBe(200);
      const created = await res.json() as WorkspaceCreated;
      expect(created).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false });
      expect(created.pane_id).not.toBe(owned.root_pane.pane_id);

      const createdTab = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === created.pane_id)!.tab_id;
      const moved = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/tab-remote/tab/move", {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ tab_id: createdTab, insert_index: 0 }),
      }), manager);
      expect(moved?.status).toBe(200);
      expect(((await moved!.json()) as TabMoved).tabs[0]?.tab_id).toBe(createdTab);
      const management = await fetch(`${endpoint}/api/machines`, { headers: { authorization: `Bearer ${registered.token}` } });
      expect(management.status).toBe(401);
    } finally {
      bridge.stop();
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("shares unique agent names across concurrent tabs and preserves a tab when an explicit name collides", async () => {
    const first = await fetch(`${base()}/api/workspace/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-agents", agent: { kind: "muse" } }),
    });
    const owned = await first.json() as WorkspaceCreated;
    const nameOf = async (paneId: string) => (await herdrRpc<{ agent: { name: string } }>("agent.get", { target: paneId })).agent.name;
    try {
      expect(owned.agent_started).toBeTrue();
      const names = [await nameOf(owned.pane_id)];
      const tabs = await Promise.all([post({ workspace_id: owned.workspace_id, agent: { kind: "muse" } }), post({ workspace_id: owned.workspace_id, agent: { kind: "muse" } })]);
      for (const res of tabs) {
        expect(res.status).toBe(200);
        const tab = await res.json() as WorkspaceCreated;
        expect(tab).toMatchObject({ workspace_id: owned.workspace_id, agent_started: true });
        expect(tab.error).toBeUndefined();
        names.push(await nameOf(tab.pane_id));
      }
      expect(new Set(names).size).toBe(3);
      const collision = await post({ workspace_id: owned.workspace_id, agent: { kind: "muse", name: names[0] } });
      const failed = await collision.json() as WorkspaceCreated;
      expect(collision.status).toBe(200);
      expect(failed).toMatchObject({ workspace_id: owned.workspace_id, agent_started: false, error: { code: "agent_name_taken" } });
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(snapshot.panes.some((p) => p.pane_id === failed.pane_id && p.workspace_id === owned.workspace_id)).toBeTrue();
      expect(snapshot.workspaces.find((w) => w.workspace_id === owned.workspace_id)?.tab_count).toBe(4);
    } finally { await workspaceClose(owned.workspace_id); }
  }, 20_000);

  it("returns the created tab when a shell agent is unavailable", async () => {
    const owned = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-tab-shell" });
    const bin = mkdtempSync(join(tmpdir(), "herdr-web-ui-tab-empty-path-"));
    const path = process.env["PATH"];
    try {
      process.env["PATH"] = bin;
      const res = await post({ workspace_id: owned.workspace.workspace_id, agent: { kind: "gjc" } });
      const failed = await res.json() as WorkspaceCreated;
      expect(res.status).toBe(200);
      expect(failed).toMatchObject({ workspace_id: owned.workspace.workspace_id, agent_started: false, error: { code: "agent_start_failed" } });
      expect(failed.error?.message).toContain("gjc is not on this server's PATH");
      expect(failed.pane_id).not.toBe(owned.root_pane.pane_id);
    } finally {
      process.env["PATH"] = path;
      await workspaceClose(owned.workspace.workspace_id);
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("workspace and discovery endpoints", () => {
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  const label = `herdr-web-ui-test-${Math.random().toString(36).slice(2)}`;
  const fileName = `${label}-mention.txt`;
  const directory = mkdtempSync(join(tmpdir(), "herdr-workspace-discovery-"));
  const filePath = join(directory, fileName);

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it("lists agent kinds with required fallbacks sorted by display label", async () => {
    const res = await fetch(`${base()}/api/agents`);
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: AgentKind[] };
    expect(agents.some((agent) => agent.kind === "claude")).toBeTrue();
    expect(agents.some((agent) => agent.kind === "omp")).toBeTrue();
    expect(agents.map((agent) => agent.label)).toEqual([...agents.map((agent) => agent.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("lists herdr's integrations as integration.list reports them, and refuses anything but GET", async () => {
    const res = await fetch(`${base()}/api/integrations`);
    expect(res.status).toBe(200);
    const { integrations } = (await res.json()) as IntegrationsResponse;
    const fromHerdr = (await herdrRpc<IntegrationsResponse>("integration.list", {})).integrations;
    expect(integrations).toEqual(fromHerdr);
    const claude = integrations.find((integration) => integration.target === "claude");
    expect(claude).toMatchObject({ label: "claude", command: "claude" });
    for (const integration of integrations) expect(["not_installed", "current", "outdated"]).toContain(integration.state);
    const post = await fetch(`${base()}/api/integrations`, { method: "POST" });
    expect(post.status).toBe(400);
    expect(((await post.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("offers omo and gjc, which herdr cannot start, exactly when they are on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "herdr-web-ui-shell-agents-"));
    const path = process.env["PATH"];
    const kinds = async () => ((await (await fetch(`${base()}/api/agents`)).json()) as { agents: AgentKind[] }).agents;
    try {
      process.env["PATH"] = bin;
      expect((await kinds()).map((agent) => agent.kind)).not.toContain("gjc");
      for (const name of ["omo", "gjc"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
      const offered = await kinds();
      expect(offered).toContainEqual({ kind: "omo", label: "OmO" });
      expect(offered).toContainEqual({ kind: "gjc", label: "Gajae Code" });
    } finally {
      process.env["PATH"] = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("rejects a workspace cwd that is not an existing directory", async () => {
    const res = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("invalid_cwd");
  });

  it("creates, edits, searches, inspects, and closes an owned workspace", async () => {
    // CI's CHECK_DIR is inside ignored .ci/. Give this fixture its own Git boundary
    // so a parent's ignore rules cannot hide the file the endpoint should discover.
    expect(Bun.spawnSync(["git", "init", "-q", directory], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    writeFileSync(filePath, "mention fixture");
    // the dialog sends null for "not given" (agent: null = shell only): nulls must read as absent
    const create = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: directory, label, agent: null }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as WorkspaceCreated;
    workspaceId = created.workspace_id;
    paneId = created.pane_id;
    expect(created.agent_started).toBeFalse();

    const commands = await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({ commands: [] });

    // The new shell's foreground cwd can briefly still name its launching process.
    const deadline = Date.now() + 5_000;
    let files: string[] = [];
    do {
      const response = await fetch(`${base()}/api/pane/files?pane_id=${encodeURIComponent(paneId)}&q=${encodeURIComponent(fileName)}&limit=5`);
      expect(response.status).toBe(200);
      files = ((await response.json()) as { files: string[] }).files;
      if (files.includes(fileName)) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    let diagnostic: string | undefined;
    if (!files.includes(fileName)) {
      const { snapshot } = await fetch(`${base()}/api/session`).then(response => response.json());
      const pane = snapshot.panes.find((entry: { pane_id: string }) => entry.pane_id === paneId);
      diagnostic = JSON.stringify({ directory, fixture: readFileSync(filePath, "utf8"), pane: { cwd: pane?.cwd, foreground_cwd: pane?.foreground_cwd, agent: pane?.agent, agent_status: pane?.agent_status }, files });
    }
    expect(files, diagnostic).toContain(fileName);

    const prompt = await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toEqual({ prompt: null, suggestion: null, restored: null });

    for (const [path, body] of [
      ["/api/workspace/rename", { workspace_id: workspaceId, label: `${label}-renamed` }],
      ["/api/workspace/move", { workspace_id: workspaceId, insert_index: 0 }],
      ["/api/pane/rename", { pane_id: paneId, label: "renamed pane" }],
    ] as const) {
      const changed = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ ok: true });
    }

    const close = await fetch(`${base()}/api/workspace/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ ok: true });
    workspaceId = null;
  }, 20_000);

  it("creates a worktree of an owned repository as a grouped workspace, lists it, and opens it again", async () => {
    // a repository with one commit: a worktree needs a branch to start from
    const repo = mkdtempSync(join(tmpdir(), "herdr-web-ui-worktree-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=herdr-web-ui test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "worktree fixture\n");
    expect(git("add", "README.md").exitCode).toBe(0);
    expect(git("commit", "-q", "-m", "fixture").exitCode).toBe(0);
    const parent = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-worktree-parent" });
    const owned = [parent.workspace.workspace_id];
    // the checkout lives under the test's own folders, never under the user's worktree directory
    const checkouts = `${repo}-checkouts`;
    const checkout = join(checkouts, "feature");
    const post = (path: string, body: unknown) => fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const missing = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as ApiError).error.code).toBe("missing_branch");
      const badAgent = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "herdr-web-ui-test-feature", path: checkout, agent: { kind: "muse", args: "--help" } });
      expect(badAgent.status).toBe(400);
      expect(((await badAgent.json()) as ApiError).error.code).toBe("invalid_agent");
      expect(existsSync(checkout)).toBeFalse();

      const create = await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "herdr-web-ui-test-feature", base: null, label: null, path: checkout });
      expect(create.status).toBe(200);
      const opened = (await create.json()) as WorktreeOpened;
      owned.push(opened.workspace_id);
      expect(opened.already_open).toBeFalse();
      // no agent was asked for: the answer says nothing about one
      expect(opened.agent_started).toBeUndefined();
      expect(opened.branch).toBe("herdr-web-ui-test-feature");
      expect(realpathSync(opened.path)).toBe(realpathSync(checkout));
      const child = (await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === opened.workspace_id);
      expect(child?.worktree?.is_linked_worktree).toBeTrue();

      const list = await fetch(`${base()}/api/worktree/list?workspace_id=${encodeURIComponent(parent.workspace.workspace_id)}`);
      expect(list.status).toBe(200);
      const listing = (await list.json()) as WorktreeListing;
      expect(listing.worktrees.some((entry) => entry.branch === "herdr-web-ui-test-feature" && entry.open_workspace_id === opened.workspace_id)).toBeTrue();

      const again = await post("/api/worktree/open", { workspace_id: parent.workspace.workspace_id, path: checkout });
      expect(again.status).toBe(200);
      const reopened = (await again.json()) as WorktreeOpened;
      expect(reopened.already_open).toBeTrue();
      expect(reopened.workspace_id).toBe(opened.workspace_id);

      // a dirty checkout is refused without force, in git's words; the repository's workspace
      // does not close over its open worktrees unless the group is meant
      writeFileSync(join(checkout, "unsaved.txt"), "dirty\n");
      const refused = await post("/api/worktree/remove", { workspace_id: opened.workspace_id });
      expect(refused.status).toBe(404);
      expect(((await refused.json()) as ApiError).error.code).toBe("dirty_worktree_requires_force");
      const grouped = await post("/api/workspace/close", { workspace_id: parent.workspace.workspace_id });
      expect(grouped.status).toBe(404);
      expect(((await grouped.json()) as ApiError).error.code).toBe("workspace_group_close_required");
      const removed = await post("/api/worktree/remove", { workspace_id: opened.workspace_id, force: true });
      expect(removed.status).toBe(200);
      expect((await removed.json()) as WorktreeRemoved).toMatchObject({ ok: true, forced: true });
      expect(existsSync(checkout)).toBeFalse();
      expect((await sessionSnapshot()).workspaces.some((workspace) => workspace.workspace_id === opened.workspace_id)).toBeFalse();

      // a clean worktree closes with its repository's workspace when the group is meant; its checkout stays.
      // An agent asked for with the checkout starts in its pane, as one asked for with a workspace does.
      const second = (await (await post("/api/worktree/create", { workspace_id: parent.workspace.workspace_id, branch: "herdr-web-ui-test-second", path: join(checkouts, "second"), agent: { kind: "muse" } })).json()) as WorktreeOpened;
      owned.push(second.workspace_id);
      expect(second.error).toBeUndefined();
      expect(second.agent_started).toBeTrue();
      expect((await herdrRpc<{ agent: { name: string } }>("agent.get", { target: second.pane_id })).agent.name).toStartWith("muse");
      const closedGroup = await post("/api/workspace/close", { workspace_id: parent.workspace.workspace_id, close_group: true });
      expect(closedGroup.status).toBe(200);
      const left = (await sessionSnapshot()).workspaces.map((workspace) => workspace.workspace_id);
      expect(left).not.toContain(parent.workspace.workspace_id);
      expect(left).not.toContain(second.workspace_id);
      expect(existsSync(join(checkouts, "second"))).toBeTrue();
    } finally {
      // the roster says what was made: a create whose answer was lost still left a child to remove
      const repoRoot = realpathSync(repo);
      const children = new Set(owned.slice(1));
      const snapshot = await sessionSnapshot().catch(() => null);
      for (const workspace of snapshot?.workspaces ?? []) {
        if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot) children.add(workspace.workspace_id);
      }
      for (const id of children) await herdrRpc("worktree.remove", { workspace_id: id, force: true }).catch(() => undefined);
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
      rmSync(checkouts, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts a worktree asked from a workspace on a linked checkout at the repository's own workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "herdr-web-ui-worktree-linked-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=herdr-web-ui test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "worktree fixture\n");
    expect(git("add", "README.md").exitCode).toBe(0);
    expect(git("commit", "-q", "-m", "fixture").exitCode).toBe(0);
    const checkouts = `${repo}-checkouts`;
    // a checkout git made, opened as a plain workspace: herdr does not mark it as a worktree
    expect(git("worktree", "add", "-q", "-b", "herdr-web-ui-test-linked", join(checkouts, "linked")).exitCode).toBe(0);
    const linked = await workspaceCreate({ cwd: join(checkouts, "linked"), label: "herdr-web-ui-test-worktree-linked" });
    const owned = [linked.workspace.workspace_id];
    const post = (path: string, body: unknown) => fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === linked.workspace.workspace_id)?.worktree?.is_linked_worktree).not.toBeTrue();
      // the repository's own workspace is not open: herdr's refusal is the answer
      const alone = await post("/api/worktree/create", { workspace_id: linked.workspace.workspace_id, branch: "herdr-web-ui-test-alone", path: join(checkouts, "alone") });
      expect(alone.status).toBe(404);
      expect(((await alone.json()) as ApiError).error.code).toBe("linked_worktree_source");
      expect(existsSync(join(checkouts, "alone"))).toBeFalse();

      const parent = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-worktree-linked-parent" });
      owned.push(parent.workspace.workspace_id);
      const create = await post("/api/worktree/create", { workspace_id: linked.workspace.workspace_id, branch: "herdr-web-ui-test-from-linked", path: join(checkouts, "from-linked") });
      expect(create.status).toBe(200);
      const opened = (await create.json()) as WorktreeOpened;
      owned.push(opened.workspace_id);
      expect(opened.branch).toBe("herdr-web-ui-test-from-linked");
      expect(existsSync(join(checkouts, "from-linked"))).toBeTrue();
      expect((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === opened.workspace_id)?.worktree?.is_linked_worktree).toBeTrue();

      const again = await post("/api/worktree/open", { workspace_id: linked.workspace.workspace_id, path: join(checkouts, "from-linked") });
      expect(again.status).toBe(200);
      expect((await again.json()) as WorktreeOpened).toMatchObject({ workspace_id: opened.workspace_id, already_open: true });
    } finally {
      const repoRoot = realpathSync(repo);
      const snapshot = await sessionSnapshot().catch(() => null);
      for (const workspace of snapshot?.workspaces ?? []) {
        if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot) await herdrRpc("worktree.remove", { workspace_id: workspace.workspace_id, force: true }).catch(() => undefined);
      }
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
      rmSync(checkouts, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts another agent of a kind whose name is already taken", async () => {
    // muse stands in for the agent: herdr answers agent.start once the launch is typed into the
    // pane, so the kind needs no program behind it and no real agent runs
    const kind = "muse";
    const explicit = `given-${Math.random().toString(36).slice(2, 10)}`;
    const owned: string[] = [];
    const start = async (agent: { kind: string; name?: string }) => {
      const res = await fetch(`${base()}/api/workspace/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: tmpdir(), label: `${label}-agent-${owned.length}`, agent }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as WorkspaceCreated;
      owned.push(created.workspace_id);
      expect(created.error).toBeUndefined();
      expect(created.agent_started).toBeTrue();
      return (await herdrRpc<{ agent: { name?: string | null } }>("agent.get", { target: created.pane_id })).agent.name;
    };
    try {
      const first = await start({ kind });
      const second = await start({ kind });
      expect(first).toMatch(/^muse(-\d+)?$/);
      expect(second).toMatch(/^muse-\d+$/);
      expect(second).not.toBe(first);
      // a name the client gives is used as given
      expect(await start({ kind, name: explicit })).toBe(explicit);
    } finally {
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
    }
  }, 20_000);

  it("uses the shared error envelope for malformed mutation bodies", async () => {
    for (const [path, body, code] of [
      ["/api/workspace/rename", {}, "missing_workspace_id"],
      ["/api/workspace/move", { workspace_id: "x", insert_index: -1 }, "invalid_index"],
      ["/api/workspace/close", {}, "missing_workspace_id"],
      ["/api/pane/rename", {}, "missing_pane_id"],
      ["/api/pane/focus", {}, "missing_pane_id"],
      ["/api/pane/swap", { pane_id: "x", direction: "right", target_pane_id: "y" }, "invalid_pane_swap"],
      ["/api/pane/swap", { pane_id: "x", target_pane_id: "" }, "invalid_target_pane_id"],
      ["/api/layout/ratio", {}, "missing_tab_id"],
      ["/api/layout/ratio", { tab_id: "x", path: [0], ratio: 0.5 }, "invalid_path"],
      ["/api/layout/ratio", { tab_id: "x", path: [], ratio: 1 }, "invalid_ratio"],
      ["/api/agent/rename", {}, "missing_pane_id"],
    ] as const) {
      const res = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("GET /api/pane/omo-tasks", () => {
  it("answers 400 without a pane, and no tasks for a pane that runs no OmO", async () => {
    const missing = await fetch(`${base()}/api/pane/omo-tasks`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ApiError).error.code).toBe("missing_pane_id");
    const unknown = await fetch(`${base()}/api/pane/omo-tasks?pane_id=w0:p0`);
    expect(unknown.status).toBe(200);
    const body = await unknown.json() as { tasks: unknown[]; runs: unknown[]; server_time: string };
    expect(body.tasks).toEqual([]);
    expect(body.runs).toEqual([]);
    expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  });
});

describe("GET /api/session", () => {
  it("returns the live herdr snapshot with at least one real workspace", async () => {
    const res = await fetch(`${base()}/api/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: SessionSnapshot };
    expect(Array.isArray(body.snapshot.workspaces)).toBe(true);
    expect(body.snapshot.workspaces.length).toBeGreaterThan(0);
    // Every workspace carries the identity fields the sidebar renders.
    for (const ws of body.snapshot.workspaces) {
      expect(typeof ws.workspace_id).toBe("string");
      expect(ws.workspace_id.length).toBeGreaterThan(0);
      expect(typeof ws.label).toBe("string");
    }
    expect(body.snapshot.panes.length).toBeGreaterThan(0);
  });
});

describe("POST /api/pane/find viewport results", () => {
  let workspaceId: string;
  let paneId: string;
  beforeAll(async () => {
    const created = await workspaceCreate({ cwd: stateDir, label: "herdr-web-ui-test-find-response" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    const ready = herdrRpc("pane.wait_for_output", {
      pane_id: paneId, source: "visible", match: { type: "substring", value: "find_response_ready" }, timeout_ms: 10000,
    }, undefined, 12000);
    await herdrRpc("pane.send_input", { pane_id: paneId, text: "printf 'find_response_%s\\n' ready; exec cat", keys: ["enter"] });
    await ready;
  }, 15000);
  afterAll(async () => { if (workspaceId) await workspaceClose(workspaceId); });

  it("includes bounded cell ranges and the unchanged shared viewport for jump:false", async () => {
    const before = await (await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`)).json() as { scroll: PaneFindResponse["scroll"] };
    const response = await fetch(`${base()}/api/pane/find`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId, query: "find_response_ready", direction: "backward", jump: false }),
    });
    expect(response.status).toBe(200);
    const body: PaneFindResponse = await response.json();
    expect(body.total).toBe(1);
    expect(body.matches).toEqual([body.match!]);
    expect(body.scroll).toEqual(before.scroll);
    expect(Number.isSafeInteger(body.content_revision)).toBe(true);
    const after = await (await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`)).json() as { scroll: PaneFindResponse["scroll"] };
    expect(after.scroll).toEqual(before.scroll);
  });

  it("rejects a non-boolean jump with the shared error envelope", async () => {
    const response = await fetch(`${base()}/api/pane/find`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId, query: "ready", direction: "forward", jump: "false" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_jump", message: "jump must be a boolean" } });
  });
});

describe("/api/pane/scroll and /api/pane/selection", () => {
  async function firstPane(): Promise<string> {
    const { snapshot } = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
    expect(snapshot.panes[0]).toBeDefined();
    return snapshot.panes[0]!.pane_id;
  }

  it("reads and sets the viewport position of a real pane", async () => {
    const paneId = await firstPane();
    const read = await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`);
    expect(read.status).toBe(200);
    const { scroll } = (await read.json()) as { scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } };
    expect(Number.isInteger(scroll.max_offset_from_bottom)).toBe(true);
    expect(scroll.viewport_rows).toBeGreaterThan(0);
    const set = await fetch(`${base()}/api/pane/scroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, offset_from_bottom: 0 }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { scroll: { offset_from_bottom: number } }).scroll.offset_from_bottom).toBe(0);
  });

  it("reads a selection from the pane's history", async () => {
    const paneId = await firstPane();
    const query = new URLSearchParams({ pane_id: paneId, anchor_row: "0", anchor_col: "0", cursor_row: "0", cursor_col: "0" });
    const response = await fetch(`${base()}/api/pane/selection?${query}`);
    // an empty first cell has no text: herdr's refusal still comes back as a JSON error
    const body = (await response.json()) as { text?: string; error?: { code: string } };
    if (response.ok) expect(typeof body.text).toBe("string");
    else expect(typeof body.error?.code).toBe("string");
  });

  it("rejects bad coordinates and offsets before any RPC", async () => {
    for (const query of ["", "pane_id=w1:p1&anchor_row=0&anchor_col=0&cursor_row=0", "pane_id=w1:p1&anchor_row=-1&anchor_col=0&cursor_row=0&cursor_col=0", "pane_id=w1:p1&anchor_row=1.5&anchor_col=0&cursor_row=0&cursor_col=0"]) {
      const response = await fetch(`${base()}/api/pane/selection?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(query ? "invalid_range" : "missing_pane_id");
    }
    for (const offset of [-1, 1.5, "3", null]) {
      const response = await fetch(`${base()}/api/pane/scroll`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: "w1:p1", offset_from_bottom: offset }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe("invalid_offset");
    }
    expect((await fetch(`${base()}/api/pane/scroll`)).status).toBe(400);
  });
});

describe("GET /api/pane/read", () => {
  it("returns terminal text for a real live pane", async () => {
    const snapRes = await fetch(`${base()}/api/session`);
    const { snapshot } = (await snapRes.json()) as { snapshot: SessionSnapshot };
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();

    const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane!.pane_id)}&source=visible&format=text`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: PaneReadResult };
    expect(body.read.pane_id).toBe(pane!.pane_id);
    expect(typeof body.read.text).toBe("string");
  });

  it("rejects an unknown pane id with a clean JSON error and keeps serving", async () => {
    const res = await fetch(`${base()}/api/pane/read?pane_id=w9999:p9999&source=visible&format=text`);
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(typeof body.error.code).toBe("string");
    // the server survives a bad request
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });

  it("rejects a missing pane_id parameter", async () => {
    const res = await fetch(`${base()}/api/pane/read?source=visible`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/pane/close", () => {
  /** Own workspace again: this test really kills its root pane, never a user pane. */
  let workspaceId: string | null = null;
  let paneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-close", cwd: "/tmp", focus: false },
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
  });

  it("closes the named pane and it leaves the snapshot", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // real cross-process state: fake timers cannot see herdr's snapshot, so this is
    // one of the rare genuine-delay polls (same shape as the exit test's retries)
    let gone = false;
    for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      gone = !session.snapshot.panes.some((pane) => pane.pane_id === paneId);
      if (!gone) await Bun.sleep(500);
    }
    expect(gone).toBeTrue();
  }, 20000);

  it("answers the error envelope for an unknown pane", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "no-such-pane" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBeTruthy();
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects a missing pane_id with 400 missing_pane_id", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("missing_pane_id");
  });
});

describe("POST /api/pane/image", () => {
  /** Own workspace with its own cwd: the upload writes a real file into it. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let qaCwd: string | null = null;

  // a real 1x1 png
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const post = (body: unknown) =>
    fetch(`${base()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    qaCwd = mkdtempSync(join(tmpdir(), "herdr-web-ui-image-"));
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-image", cwd: qaCwd, focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
    if (qaCwd) rmSync(qaCwd, { recursive: true, force: true });
  });

  it("stores a pasted image under the pane cwd and returns its absolute path", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    // the prompt must reference a file the agent can read without leaving its project
    expect(body.path.startsWith(qaCwd!)).toBe(true);
    expect(body.path.includes(".herdr-web-ui")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const stored = statSync(body.path);
    expect(stored.size).toBeGreaterThan(0);
    expect(stored.isFile()).toBe(true);
  });

  it("rejects an unknown pane with the shared error envelope", async () => {
    const res = await post({ pane_id: "w9999:p9999", content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pane_not_found");
  });

  it("stores any other file under its own sanitised name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/svg+xml", data_base64: svg, name: "../omo icon.SVG" });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith(join(qaCwd!, ".herdr-web-ui") + "/")).toBe(true);
    expect(basename(path)).toMatch(/^omo_icon-\d{8}-\d{6}-[0-9a-f]{8}\.svg$/);
    expect(readFileSync(path, "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    // no name, or one without a usable extension: still stored, as .bin
    const bare = (await (await post({ pane_id: qaPaneId, content_type: "", data_base64: svg })).json()) as { path: string };
    expect(basename(bare.path)).toMatch(/^file-.*\.bin$/);
  });

  it("rejects an image above the size ceiling with 413", async () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024, 1).toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: oversized });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("image_too_large");
  });

  it("rejects empty image data with 400", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_image");
  });

  it("rejects a missing pane_id with 400 and keeps serving", async () => {
    const res = await post({ content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(400);
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("WebSocket /ws", () => {
  /**
   * Uses a workspace this test creates and closes, never one of the user's:
   * attaching starts a real `herdr terminal attach` against a live terminal.
   */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
  });

  it("pushes a snapshot on connect and streams real pty bytes for an attached pane", async () => {
    const paneId = qaPaneId!;
    expect(paneId).toBeTruthy();

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const seen: any[] = [];
    const waitFor = (predicate: (msg: any) => boolean, label: string, ms: number) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
        const listener = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          seen.push(msg);
          if (predicate(msg)) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener as EventListener);
            resolve(msg);
          }
        };
        ws.addEventListener("message", listener as EventListener);
      });

    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const snapshot = await waitFor((m) => m.type === "snapshot", "snapshot", 5000);
    expect(snapshot.snapshot.workspaces.length).toBeGreaterThan(0);

    const streamed = waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "pty-data", 15000);
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 }));
    const frame = await streamed;
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "detach", pane_id: paneId }));
    ws.close();
  }, 30000);

  it("rejects a malformed websocket frame without dropping the connection", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const errored = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error frame within 5s")), 5000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (msg.type === "error") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.send("this is not json");
    const error = await errored;
    expect(error.code).toBe("invalid_json");
    ws.close();
  }, 15000);
});

type CookieWebSocketCtor = new (url: string, options: { headers: { cookie: string } }) => WebSocket;
/** A WS frame as tests read it: the discriminator plus whatever fields they assert on. */
type RecordedFrame = { type: string; [key: string]: unknown };

/** A WS client that records every frame it receives, with a bounded wait for one that matches. */
class RecordingSocket {
  readonly seen: RecordedFrame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String((event as MessageEvent).data)));
    });
  }

  static async connect(url: string): Promise<RecordingSocket> {
    const socket = new RecordingSocket(url);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    // drain the initial snapshot so callers wait only for what they named
    await socket.waitFor((message) => message.type === "snapshot", "snapshot", 10_000);
    return socket;
  }

  waitFor(predicate: (message: RecordedFrame) => boolean, label: string, ms: number): Promise<RecordedFrame> {
    const already = this.seen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<RecordedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        // what did arrive: without it a timeout cannot tell a lost frame from one that came differently
        console.error(`${label}: the last frames received were\n${this.seen.slice(-20).map((frame) => JSON.stringify(frame).slice(0, 300)).join("\n")}`);
        reject(new Error(`${label} not received within ${ms}ms`));
      }, ms);
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as RecordedFrame;
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.ws.removeEventListener("message", listener as EventListener);
        resolve(message);
      };
      this.ws.addEventListener("message", listener as EventListener);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

describe("WebSocket roles and status push", () => {
  /** Own workspace again: the role tests resize a real pty, the exit test kills a real shell. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let exitWorkspaceId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-roles", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (exitWorkspaceId) await herdrRpc("workspace.close", { workspace_id: exitWorkspaceId }).catch(() => undefined);
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId }).catch(() => undefined);
  });

  it("rejects input from a non-attached client and signals readiness to the owner", async () => {
    const owner = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stranger = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      owner.send({ type: "attach", pane_id: qaPaneId!, cols: 100, rows: 30 });
      await owner.waitFor((m) => m.type === "input-ready" && m.pane_id === qaPaneId, "input ready", 15_000);
      const captured = join(stateDir, "unicode-input.txt");
      owner.send({ type: "input", pane_id: qaPaneId!, text: `printf '%s' '한글😀' > '${captured}'\r` });
      const deadline = Date.now() + 5000;
      while (!existsSync(captured) && Date.now() < deadline) await Bun.sleep(25);
      expect(readFileSync(captured, "utf8")).toBe("한글😀");
      stranger.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      const error = await stranger.waitFor((m) => m.type === "error", "input rejection", 5000);
      expect(error.code).toBe("input_not_ready");
      owner.send({ type: "detach", pane_id: qaPaneId! });
      owner.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      expect((await owner.waitFor((m) => m.type === "error", "detached rejection", 5000)).code).toBe("input_not_ready");
    } finally { owner.close(); stranger.close(); }
  });

  it("never resizes the shared pty for an observe connection, and read-only frames answer input, keys and resize", async () => {
    const paneId = qaPaneId!;
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);

    try {
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);

      observer.send({ type: "role", mode: "observe" });
      const ack = await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      expect(ack.mode).toBe("observe");

      // an observer attaching a smaller screen must NOT resize the shared pty:
      // the attach answers with the grid to adopt (the operator's 100x30), not its own
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const adopted = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 100,
        "observer adopts geometry",
        5000,
      );
      expect(adopted.rows).toBe(30);
      expect(operator.seen.some((m) => m.type === "pane-geometry")).toBe(false);

      observer.send({ type: "resize", pane_id: paneId, cols: 40, rows: 20 });
      const resizeError = await observer.waitFor((m) => m.type === "error", "resize read_only error", 5000);
      expect(resizeError.code).toBe("read_only");

      observer.send({ type: "input", pane_id: paneId, text: "echo nope" });
      const inputError = await observer.waitFor((m) => m.type === "error", "input read_only error", 5000);
      expect(inputError.code).toBe("read_only");

      observer.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
      const keysError = await observer.waitFor((m) => m.type === "error", "keys read_only error", 5000);
      expect(keysError.code).toBe("read_only");

      // the operator keeps driving the shared grid, and everyone attached hears it
      operator.send({ type: "resize", pane_id: paneId, cols: 120, rows: 40 });
      const geometry = await operator.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "geometry broadcast", 5000);
      expect(geometry.cols).toBe(120);
      expect(geometry.rows).toBe(40);
      await observer.waitFor((m) => m.type === "pane-geometry" && m.cols === 120, "observer hears geometry", 5000);
    } finally {
      operator.close();
      observer.close();
    }
  }, 40_000);

  it("leaves the shared pty's size alone for an attach whose grid the chat lens covers", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-keep-size" });
    const paneId = created.root_pane.pane_id;
    const chat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const otherChat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    // an observer re-attaching is told the grid the shared pty has now
    const grid = async () => {
      observer.seen.length = 0;
      observer.send({ type: "attach", pane_id: paneId, cols: 30, rows: 10 });
      return observer.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "observer geometry", 5000);
    };
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);

      // a phone's chat lens attaches first: the pty starts at the pane's own grid, not 40x20
      chat.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      await chat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "chat pty-data", 15_000);
      const own = await grid();
      expect([own.cols, own.rows]).not.toEqual([40, 20]);
      // and the chat lens is told that grid, to draw the screen it reads as the pty does
      expect(await chat.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "chat geometry", 5000)).toMatchObject({ cols: own.cols, rows: own.rows });

      // another covered attach to the running pty resizes nothing either
      otherChat.send({ type: "attach", pane_id: paneId, cols: 33, rows: 11, keep_size: true });
      await otherChat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "other chat pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: own.cols, rows: own.rows });

      // a terminal lens still drives it: the same check sees a real resize
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: 100, rows: 30 });
    } finally {
      for (const socket of [chat, otherChat, observer, operator]) socket.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  it("applies a resize that arrives while a covered attach is still creating the pty", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-keep-size-switch" });
    const paneId = created.root_pane.pane_id;
    const phone = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the chat lens attaches, and the user switches to the terminal lens before the terminal
      // was looked up: both frames are on the server before the pty exists
      phone.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      phone.send({ type: "resize", pane_id: paneId, cols: 91, rows: 27 });
      // the terminal lens's grid is the pty's, not the pane's own one the covered attach left it at
      expect(await phone.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 91, "the resize applied after creation", 15_000)).toMatchObject({ cols: 91, rows: 27 });
      await phone.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "attach took", 15_000);
      // one word, "27x91": herdr may draw a space as a cursor move, and "size=27 91" then never arrives as such
      const from = phone.seen.length;
      phone.send({ type: "input", pane_id: paneId, text: "clear; echo size=$(stty size | tr ' ' x)\r" });
      // over every frame since the command: a read may end in the middle of the word
      const output = () => phone.seen.slice(from).filter((m) => m.type === "pty-data" && m.pane_id === paneId).map((m) => String(m.data)).join("");
      await phone.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId && output().includes("size=27x91"), "the shell sees the terminal lens's grid", 15_000);
    } finally {
      phone.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  it("rejects an unknown role mode with an in-band error", async () => {
    const client = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      client.send({ type: "role", mode: "wat" });
      const error = await client.waitFor((m) => m.type === "error", "invalid_role error", 5000);
      expect(error.code).toBe("invalid_role");
    } finally {
      client.close();
    }
  }, 15_000);

  it("pushes pane-status and pane-exited for a pane nobody is attached to", async () => {
    const paneId = qaPaneId!;
    const watcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the collector subscribed to this pane when it was created; prove it by pushing
      // status changes through herdr itself and seeing the frames. herdr tears down a
      // subscription batch that references a pane which vanished mid-reconcile, so the
      // collector may briefly re-subscribe - retry the report (alternating states, so
      // each is a real change) until the frame arrives instead of trusting the clock
      let seen = false;
      for (let attempt = 0; attempt < 8 && !seen; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: paneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        seen = await watcher
          .waitFor(
            (m) => m.type === "pane-status" && m.pane_id === paneId && m.agent_status === (attempt % 2 === 0 ? "blocked" : "working"),
            "unattached pane-status",
            2_500,
          )
          .then(() => true)
          .catch(() => false);
      }
      expect(seen).toBeTrue();

      // a pane ending while unattached pushes pane-exited
      const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
        "workspace.create",
        { label: "herdr-web-ui-test-exit", cwd: "/tmp", focus: false },
      );
      exitWorkspaceId = created.workspace.workspace_id;
      const exitPaneId = created.root_pane.pane_id;
      // the collector picks a brand-new pane up via pane.created -> reconcile, which is
      // debounced: retry the status report (alternating states, so each is a real
      // change) until the frame proves the subscription is live - no clock-waiting
      let subscribed = false;
      for (let attempt = 0; attempt < 8 && !subscribed; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: exitPaneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        subscribed = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === exitPaneId, "exit pane subscribed", 1_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(subscribed).toBeTrue();
      await herdrRpc("pane.send_text", { pane_id: exitPaneId, text: "exit\r" });
      const exited = await watcher.waitFor(
        (m) => m.type === "pane-exited" && m.pane_id === exitPaneId,
        "unattached pane-exited",
        10_000,
      );
      expect(exited.type).toBe("pane-exited");
    } finally {
      watcher.close();
    }
  }, 40_000);
});

describe("WebSocket observer-first attach", () => {
  /** Own pane: the observer must be the one that creates the attachment. */
  let observeWorkspaceId: string | null = null;
  let observePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-observe", cwd: "/tmp", focus: false },
    );
    observeWorkspaceId = created.workspace.workspace_id;
    observePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (observeWorkspaceId) await herdrRpc("workspace.close", { workspace_id: observeWorkspaceId }).catch(() => undefined);
  });

  it("sizes a PTY an observe connection creates from the pane, never from the observer's grid", async () => {
    // observer-FIRST attach: nobody holds the attachment, so the observer's connect
    // spawns the shared pty. The user's named scenario (a phone opens the pane first)
    // must not seed the pty with the phone's viewport.
    const paneId = observePaneId!;
    const rectOf = async (): Promise<{ width: number; height: number } | null> => {
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      return snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    };
    const rectBefore = await rectOf();
    expect(rectBefore).not.toBeNull();

    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const geometry = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId,
        "observer geometry",
        15_000,
      );
      // the spawned pty carries the pane's grid, not the observer's 40x20
      expect(geometry.cols).toBe(rectBefore!.width);
      expect(geometry.rows).toBe(rectBefore!.height);
      // herdr's layout is untouched either way
      expect(await rectOf()).toEqual(rectBefore);
    } finally {
      observer.close();
    }
  }, 30_000);
});

describe("WebSocket concurrent attach", () => {
  /** A pane nobody holds yet: the race is in CREATING the attachment. */
  let raceWorkspaceId: string | null = null;
  let racePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-race", cwd: "/tmp", focus: false },
    );
    raceWorkspaceId = created.workspace.workspace_id;
    racePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (raceWorkspaceId) await herdrRpc("workspace.close", { workspace_id: raceWorkspaceId }).catch(() => undefined);
  });

  it("shares one pty between clients whose attaches to the same pane race", async () => {
    const paneId = racePaneId!;
    const first = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const second = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: both attaches are in flight before either resolves the terminal
      first.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      second.send({ type: "attach", pane_id: paneId, cols: 120, rows: 40 });
      await first.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "first pty-data", 15_000);
      await second.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "second pty-data", 15_000);

      // one attachment means one client set: a resize reaches both. Two attachments
      // would leave one client on an orphaned record that never hears it.
      first.send({ type: "resize", pane_id: paneId, cols: 90, rows: 25 });
      await first.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "first hears resize", 5000);
      await second.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "second hears resize", 5000);
    } finally {
      first.close();
      second.close();
    }
  }, 40_000);
});

describe("WebSocket client leaving mid-attach", () => {
  /** One pane per trigger, so neither test inherits the other's attachment. */
  const leaveWorkspaceIds: string[] = [];

  async function createLeavePane(label: string): Promise<{ paneId: string; terminalId: string }> {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label, cwd: "/tmp", focus: false },
    );
    leaveWorkspaceIds.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as { terminal_id?: string } | undefined;
    expect(pane?.terminal_id).toBeTruthy();
    return { paneId, terminalId: pane!.terminal_id! };
  }

  /** The leaked resource itself: a live `herdr terminal attach` (or its sidecar) on this terminal. */
  function attachProcessCount(terminalId: string): number {
    const found = Bun.spawnSync(["pgrep", "-f", `terminal attach ${terminalId}`]);
    return found.stdout.toString().split("\n").filter(Boolean).length;
  }

  async function waitForAttachGone(terminalId: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (attachProcessCount(terminalId) > 0) {
      if (Date.now() > deadline) throw new Error(`attach on ${terminalId} still running ${ms}ms after its last client left`);
      await Bun.sleep(50);
    }
  }

  afterAll(async () => {
    for (const workspaceId of leaveWorkspaceIds) {
      await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    }
  });

  it("never pins the pty for a client that disconnects before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-close");
    expect(attachProcessCount(terminalId)).toBe(0);
    const leaver = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: the close lands while the attach is still looking up the terminal
      leaver.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      leaver.close();
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
    } finally {
      stayer.close();
    }
    // the last live client left, so nothing may keep the attach running
    await waitForAttachGone(terminalId, 5000);
  }, 40_000);

  it("never pins the pty for a client that detaches before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-detach");
    expect(attachProcessCount(terminalId)).toBe(0);
    const switcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // switching panes fast: the detach lands while the attach is still looking up the terminal
      switcher.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      switcher.send({ type: "detach", pane_id: paneId });
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
      stayer.close();
      // the switcher is still connected but detached: it must not keep the attach running
      await waitForAttachGone(terminalId, 5000);
      expect(switcher.seen.some((m) => m.type === "pty-data" && m.pane_id === paneId)).toBe(false);
    } finally {
      switcher.close();
      stayer.close();
    }
  }, 40_000);
});

/**
 * Bun's WebSocket client sends request headers, but this project compiles with lib.dom,
 * whose WebSocket type only knows subprotocols (bun-types steps aside via
 * UseLibDomIfAvailable). Reaching the real capability through a guard keeps the test
 * honest: if Bun ever stopped sending the header, the server refuses the upgrade and
 * the test fails instead of silently passing.
 */
function takesCookieHeader(value: unknown): value is CookieWebSocketCtor {
  return typeof value === "function";
}

function connectWithCookie(url: string, cookie: string): WebSocket {
  const ctor: unknown = globalThis.WebSocket;
  if (!takesCookieHeader(ctor)) throw new Error("no WebSocket constructor in this runtime");
  return new ctor(url, { headers: { cookie } });
}

describe("web push", () => {
  /** A fake push service that decrypts like a device: see push.fake.ts. */
  let fake: FakePushService;
  let pushWorkspaceId: string | null = null;
  let pushPaneId: string | null = null;

  const postJson = (path: string, body: unknown, method = "POST") =>
    fetch(`${base()}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fake = await startFakePushService();
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-push", cwd: "/tmp", focus: false },
    );
    pushWorkspaceId = created.workspace.workspace_id;
    pushPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE").catch(() => undefined);
    fake.stop();
    if (pushWorkspaceId) await herdrRpc("workspace.close", { workspace_id: pushWorkspaceId }).catch(() => undefined);
  });

  it("hands out its VAPID key and refuses what is not a subscription", async () => {
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(Buffer.from(key.public_key, "base64url").length).toBe(65);

    const malformed = await postJson("/api/push/subscribe", { subscription: { endpoint: fake.subscription.endpoint, keys: {} } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiError).error.code).toBe("invalid_subscription");

    const wrongMethod = await fetch(`${base()}/api/push/subscribe`);
    expect(wrongMethod.status).toBe(400);
    expect(((await wrongMethod.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("confirms a new device with a push it can decrypt, and forgets it on request", async () => {
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    expect((await postJson("/api/push/test", { endpoint: fake.subscription.endpoint })).status).toBe(204);
    const confirmation = await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect(confirmation.payload.pane_id).toBeNull();
    expect(confirmation.vapidValid).toBe(true);
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(confirmation.vapidKey).toBe(key.public_key);

    expect((await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE")).status).toBe(204);
    const gone = await postJson("/api/push/test", { endpoint: fake.subscription.endpoint });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as ApiError).error.code).toBe("subscription_not_found");
  });

  it("pushes a live pane's status change to a subscribed device", async () => {
    const paneId = pushPaneId!;
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    // same retry as the pane-status test: the collector may still be re-subscribing to
    // the new pane, so alternate real changes until one lands as a push
    let pushed = null;
    for (let attempt = 0; attempt < 8 && !pushed; attempt += 1) {
      const state = attempt % 2 === 0 ? "blocked" : "working";
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
      if (state !== "blocked") continue;
      pushed = await fake
        .waitFor((push) => push.payload.pane_id === paneId, "status push", 2_500)
        .catch(() => null);
    }
    expect(pushed).not.toBeNull();
    expect(pushed!.payload.body).toBe("waiting for your input");
    expect(pushed!.payload.tag).toBe(`herdr-pane-${paneId}`);
    expect(pushed!.urgency).toBe("high");
    expect(pushed!.vapidValid).toBe(true);
  }, 40_000);

  it("sends no device an alert while a connected page says it is in use, and alerts again once it is not (#751)", async () => {
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let dir: string | undefined;
    let device: FakePushService | undefined;
    let bridge: ReturnType<typeof createServer> | undefined;
    let page: RecordingSocket | undefined;
    try {
      created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-push-presence" });
      const paneId = created.root_pane.pane_id;
      dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-push-presence-"));
      device = await startFakePushService();
      bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: dir, machines: false, pushLoopbackHttp: true,
        alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const subscribe = await fetch(`http://127.0.0.1:${bridge.port}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      page = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      // a connection's frames are handled in order: the role-ack says the presence before it was read
      const tell = async (active: boolean): Promise<void> => {
        page!.seen.length = 0;
        page!.send({ type: "presence", active });
        page!.send({ type: "role", mode: "interact" });
        await page!.waitFor((message) => message.type === "role-ack", "role-ack after presence", 5_000);
      };
      const report = async (state: "working" | "blocked"): Promise<boolean> => {
        // only a frame this report caused may answer it
        page!.seen.length = 0;
        await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
        return page!.waitFor((message) => message.type === "pane-status" && message.pane_id === paneId && message.agent_status === state,
          `${state} on the page`, 2_500).then(() => true).catch(() => false);
      };
      const alerts = () => device!.received.filter((push) => push.payload.pane_id === paneId);

      await tell(true);
      // the collector may still be subscribing to the new pane: alternate until a blocked lands
      let blocked = false;
      for (let attempt = 0; attempt < 8 && !blocked; attempt++) {
        await report("working");
        blocked = await report("blocked");
      }
      expect(blocked).toBe(true);
      await bridge.alertsSettled();
      expect(alerts()).toHaveLength(0);

      await tell(false);
      expect(await report("working")).toBe(true);
      expect(await report("blocked")).toBe(true);
      const pushed = await device.waitFor((push) => push.payload.pane_id === paneId, "alert once no page is in use", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");

      // a page that leaves without saying so no longer holds the alerts back
      await tell(true);
      page.close();
      page = undefined;
      const watcher = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      page = watcher;
      // the server reads the close on its own time: alternate until an alert comes, which only
      // happens once the closed page stopped holding them back
      let alerted = false;
      for (let attempt = 0; attempt < 8 && !alerted; attempt++) {
        expect(await report("working")).toBe(true);
        expect(await report("blocked")).toBe(true);
        await bridge.alertsSettled();
        alerted = alerts().length === 2;
      }
      expect(alerted).toBe(true);
    } finally {
      page?.close();
      bridge?.stop();
      device?.stop();
      if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports a Codex unknown after work as done over WS and HTTP and delivers its completion push", async () => {
    // Exercise the real collector -> CompletionTracker -> PushService path using
    // manually reported statuses in owned panes. No Codex request or real device.
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let probe: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let dir: string | undefined;
    let cleanupDevice: FakePushService | undefined;
    let bridge: ReturnType<typeof createServer> | undefined;
    let watcher: RecordingSocket | undefined;
    try {
      created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-codex-finish" });
      probe = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-codex-probe" });
      const paneId = created.root_pane.pane_id;
      const probeId = probe.root_pane.pane_id;
      dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-finish-"));
      const device = await startFakePushService();
      cleanupDevice = device;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "unknown" });
      bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: dir, machines: false, pushLoopbackHttp: true,
        alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const origin = `http://127.0.0.1:${bridge.port}`;
      watcher = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      const subscribe = await fetch(`${origin}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription, alerts: { input: false, done: "always" } }),
      });
      expect(subscribe.status).toBe(204);

      // Prove the subscription is live before changing the watched pane exactly
      // once. Alternating a separate probe does not fabricate its work history.
      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt++) {
        const state = attempt % 2 === 0 ? "working" : "blocked";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher.waitFor((message) => message.type === "pane-status" && message.pane_id === probeId && message.agent_status === state,
          "Codex regression probe", 2_500).then(() => true).catch(() => false);
      }
      expect(live).toBe(true);

      const report = async (agent: string, state: string, expected: string) => {
        watcher!.seen.length = 0;
        await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent, state });
        await watcher!.waitFor((message) => message.type === "pane-status" && message.pane_id === paneId && message.agent_status === expected,
          `${agent}/${state} presented as ${expected}`, 5_000);
        const raw = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
        // herdr itself may promote an unfocused idle after work to done.
        const rawStatus = raw.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
        if (state === "idle") expect(rawStatus === "idle" || rawStatus === "done").toBe(true);
        else expect(rawStatus).toBe(state);
        const shown = await (await fetch(`${origin}/api/session`)).json() as { snapshot: SessionSnapshot };
        expect(shown.snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
        expect(shown.snapshot.agents.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
      };

      for (let turn = 0; turn < 2; turn++) {
        await report("codex", "working", "working");
        await report("codex", "unknown", "done");
        await device.waitFor((message) => message.payload.pane_id === paneId &&
          device.received.filter((received) => received.payload.pane_id === paneId).length === turn + 1,
          "Codex completion push", 5_000);
      }
      const finishes = () => device.received.filter((message) => message.payload.pane_id === paneId);
      expect(finishes()).toHaveLength(2);
      expect(finishes().every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

      // The same unknown status after an identity handoff is still ongoing work.
      await report("pi", "working", "working");
      await report("claude", "unknown", "working");
      expect(finishes()).toHaveLength(2);
      await report("claude", "idle", "done");
      await device.waitFor((message) => message.payload.pane_id === paneId && finishes().length === 3, "handoff completion push", 5_000);
      expect(finishes()).toHaveLength(3);
    } finally {
      if (bridge && cleanupDevice) await fetch(`http://127.0.0.1:${bridge.port}/api/push/subscribe`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: cleanupDevice.subscription.endpoint }),
      }).catch(() => undefined);
      watcher?.close();
      bridge?.stop();
      cleanupDevice?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      if (probe) await workspaceClose(probe.workspace.workspace_id).catch(() => undefined);
    }
  }, 40_000);

  it("alerts on the very first change after a restart, measured against herdr's snapshot", async () => {
    // A server restart must not cost the first alert: the collector seeds each pane's
    // status from its startup snapshot. Pane `watched` is already working when the new
    // server starts; pane `probe` shares the status subscription and proves it is live
    // before `watched` changes exactly once.
    const createPane = async (label: string) =>
      herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", {
        label,
        cwd: "/tmp",
        focus: false,
      });
    const watched = await createPane("herdr-web-ui-test-push-restart");
    const probe = await createPane("herdr-web-ui-test-push-probe");
    const watchedId = watched.root_pane.pane_id;
    const probeId = probe.root_pane.pane_id;
    const restartDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-restart-"));
    const device = await startFakePushService();
    let restarted: { port: number; stop: () => void } | null = null;
    let watcher: RecordingSocket | null = null;
    try {
      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "working" });
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(before.panes.find((pane) => pane.pane_id === watchedId)?.agent_status).toBe("working");

      restarted = createServer({ port: 0, stateDir: restartDir, alertTiming: { short: 0, long: 0, longTurn: 0 }, pushLoopbackHttp: true });
      const subscribe = await fetch(`http://localhost:${restarted.port}/api/push/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      watcher = await RecordingSocket.connect(`ws://localhost:${restarted.port}/ws`);

      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt += 1) {
        const state = attempt % 2 === 0 ? "working" : "idle";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === probeId && m.agent_status === state, "probe status", 2_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(live).toBeTrue();

      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "blocked" });
      await watcher.waitFor((m) => m.type === "pane-status" && m.pane_id === watchedId, "watched status", 5_000);
      const pushed = await device.waitFor((push) => push.payload.pane_id === watchedId, "first push after restart", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");
    } finally {
      watcher?.close();
      restarted?.stop();
      device.stop();
      rmSync(restartDir, { recursive: true, force: true });
      for (const created of [watched, probe]) {
        await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => undefined);
      }
    }
  }, 60_000);
});

describe("pairing and identity", () => {
  /** no token: the gate is where the request comes from, who Tailscale says it is, or a paired device's cookie */
  const OWNER = "owner@example.com";
  let open: { port: number; stop: () => void };
  const openState = mkdtempSync(join(tmpdir(), "herdr-pairing-"));
  beforeAll(() => { open = createServer({ port: 0, stateDir: openState, tailscaleOwner: OWNER }); });
  afterAll(() => { open?.stop(); rmSync(openState, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${open.port}`;
  /** as if `tailscale serve` or a reverse proxy had forwarded it: the test client is on loopback, like a proxy */
  const proxied = (login?: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": "100.64.0.9", ...(login ? { "tailscale-user-login": login } : {}), ...extra });
  const auth = async (headers: Record<string, string> = {}) => ((await (await fetch(`${base()}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
  const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
  let cookie = "";
  let deviceId = "";

  it("lets this PC in, and not a proxied request with no login while the PC's Tailscale login is known", async () => {
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    // tailscale serve names no person for a tagged node: it pairs, even before the first device
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
  });

  it("does not take a proxied request for this PC when the proxy sends no X-Forwarded-For", async () => {
    // a proxy that keeps the browser's Host, or sends only another forwarding header
    expect(await auth({ host: "app.example.test" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: { host: "app.example.test" } })).status).toBe(401);
    for (const name of ["x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "via"]) {
      expect(await auth({ [name]: "https" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    }
    // this PC under its other names is still this PC
    for (const host of [`localhost:${open.port}`, `herdr.localhost:${open.port}`, "localhost:5173"]) {
      expect(await auth({ host })).toMatchObject({ authenticated: true, via: "local" });
    }
  });

  it("trusts the PC's own Tailscale login and refuses another", async () => {
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("Owner@Example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
    const refused = await fetch(`${base()}/api/session`, { headers: proxied("someone@example.com") });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ApiError).error.code).toBe("other_user");
  });

  it("lets the owner's own device in with no login header, where serve is the only ingress and one login owns the tailnet", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-sole-user-"));
    const savedOwner = process.env["HERDR_WEB_TAILSCALE_OWNER"];
    const savedServeOnly = process.env["HERDR_WEB_TAILSCALE_SERVE_ONLY"];
    delete process.env["HERDR_WEB_TAILSCALE_OWNER"];
    // what `tailscale status --json` says for the reported tailnet: one login, every node untagged
    const NODE = "denisss-macbook-pro-m1.tail5cc90b.ts.net";
    const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NODE}.`, UserID: 7, TailscaleIPs: ["100.101.102.103"] }, Peer: { phone: { DNSName: "phone.tail5cc90b.ts.net.", UserID: 7 } }, User: { "7": { LoginName: OWNER } } });
    const tailnet = new TailnetIdentitySource(async () => status);
    process.env["HERDR_WEB_TAILSCALE_SERVE_ONLY"] = "1";
    const sole = createServer({ port: 0, stateDir: state, tailnet });
    if (savedServeOnly === undefined) delete process.env["HERDR_WEB_TAILSCALE_SERVE_ONLY"]; else process.env["HERDR_WEB_TAILSCALE_SERVE_ONLY"] = savedServeOnly;
    const off = createServer({ port: 0, stateDir: state, tailscaleServeOnly: false, tailnet });
    const named = createServer({ port: 0, stateDir: state, tailscaleOwner: OWNER, tailscaleServeOnly: true, tailnet });
    const other = createServer({ port: 0, stateDir: state, tailscaleOwner: "named@example.com", tailscaleServeOnly: true, tailnet });
    const at = async (port: number, headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
    try {
      // the captain's phone: tailscale serve proxied it, names no person, and the address is this PC's Tailscale name
      const phone = { ...proxied(), host: NODE };
      expect(await at(sole.port, phone)).toMatchObject({ authenticated: true, via: "tailscale" });
      expect((await fetch(`http://127.0.0.1:${sole.port}/api/session`, { headers: phone })).status).not.toBe(401);
      // the same name in another case, or this PC's tailnet address, is the same PC
      expect(await at(sole.port, { ...proxied(), host: NODE.toUpperCase() })).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(sole.port, { ...proxied(), host: "100.101.102.103:7317" })).toMatchObject({ authenticated: true, via: "tailscale" });
      // a rebinding page or a public domain forwarded here presents its own Host, and pairs
      expect(await at(sole.port, { ...proxied(), host: "evil.example:7317" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect((await fetch(`http://127.0.0.1:${sole.port}/api/session`, { headers: { ...proxied(), host: "evil.example:7317" } })).status).toBe(401);
      // and the floor stays where it was: another login, Funnel and a LAN client gain nothing
      expect(await at(sole.port, { ...phone, "tailscale-user-login": "someone@example.com" })).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(sole.port, { ...phone, "tailscale-funnel-request": "?1" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect(await at(sole.port, { ...phone, "tailscale-user-login": OWNER })).toMatchObject({ authenticated: true, via: "tailscale" });
      // where the operator did not declare serve the only ingress, the same request pairs, with or without the tailnet's name as Host
      expect(await at(off.port, proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect(await at(off.port, phone)).toMatchObject({ authenticated: false, reason: "pairing_required" });
      expect((await fetch(`http://127.0.0.1:${off.port}/api/session`, { headers: proxied() })).status).toBe(401);
      // a named owner is read the same way: the sole login it matches is let in, another name is not
      expect(await at(named.port, phone)).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(other.port, phone)).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      sole.stop();
      off.stop();
      named.stop();
      other.stop();
      if (savedOwner === undefined) delete process.env["HERDR_WEB_TAILSCALE_OWNER"]; else process.env["HERDR_WEB_TAILSCALE_OWNER"] = savedOwner;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("refuses a serve request inside the cache's TTL once a node is tagged since the cache was read", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-stale-identity-"));
    const savedOwner = process.env["HERDR_WEB_TAILSCALE_OWNER"];
    delete process.env["HERDR_WEB_TAILSCALE_OWNER"];
    const NODE = "stale-pc.example.ts.net";
    const self = { DNSName: `${NODE}.`, TailscaleIPs: ["100.101.102.103"], UserID: 7 };
    const sole = JSON.stringify({ BackendState: "Running", Self: self, User: { "7": { LoginName: OWNER } } });
    const tagged = JSON.stringify({ BackendState: "Running", Self: self, Peer: { node: { UserID: 7, Tags: ["tag:server"] } }, User: { "7": { LoginName: OWNER } } });
    let read = 0;
    const tailnet = new TailnetIdentitySource(() => Promise.resolve(read++ === 0 ? sole : tagged));
    await tailnet.freshIdentity(NODE);
    const serveOnly = createServer({ port: 0, stateDir: state, tailscaleServeOnly: true, tailnet });
    try {
      const auth = ((await (await fetch(`http://127.0.0.1:${serveOnly.port}/api/health?scope=bridge`, { headers: { ...proxied(), host: NODE } })).json()) as { auth: HealthAuth }).auth;
      expect(auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      serveOnly.stop();
      if (savedOwner === undefined) delete process.env["HERDR_WEB_TAILSCALE_OWNER"]; else process.env["HERDR_WEB_TAILSCALE_OWNER"] = savedOwner;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("takes the login named in HERDR_WEB_TAILSCALE_OWNER for the PC's own, as a tagged node needs", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-named-owner-"));
    const before = process.env["HERDR_WEB_TAILSCALE_OWNER"];
    process.env["HERDR_WEB_TAILSCALE_OWNER"] = " named@example.com ";
    const named = createServer({ port: 0, stateDir: state });
    try {
      const at = async (headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${named.port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
      expect(await at(proxied("named@example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      named.stop();
      if (before === undefined) delete process.env["HERDR_WEB_TAILSCALE_OWNER"]; else process.env["HERDR_WEB_TAILSCALE_OWNER"] = before;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("never treats a Funnel request as open", async () => {
    expect(await auth(proxied(undefined, { "tailscale-funnel-request": "?1" }))).toMatchObject({ authenticated: false, reason: "pairing_required" });
  });

  it("pairs a device with a code from this PC, and the gate closes for strangers", async () => {
    expect((await fetch(`${base()}/api/devices/pair/start`, { method: "POST" })).status).toBe(403); // the mutation guard
    const started = await fetch(`${base()}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(started.status).toBe(200);
    const { code } = (await started.json()) as { code: string; expires_at: string };
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: code === "000000" ? "111111" : "000000", label: "x" }) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiError).error.code).toBe("invalid_code");
    const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code, label: "  Test  phone " }) });
    expect(paired.status).toBe(204);
    const setCookie = paired.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^herdr_web_device=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/);
    cookie = setCookie.split(";")[0]!;
    // the device is in, from anywhere; a stranger no longer is; this PC still is
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: true, via: "device" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    const list = (await (await fetch(`${base()}/api/devices`, { headers: { ...proxied(), cookie } })).json()) as { devices: Array<{ id: string; label: string; current: boolean }> };
    expect(list.devices.map((d) => [d.label, d.current])).toEqual([["Test phone", true]]);
    deviceId = list.devices[0]!.id;
    expect(readFileSync(join(openState, "devices.json"), "utf8")).not.toContain(cookie.split("=")[1]);
  });

  it("renames and revokes a device; signing out drops its cookie", async () => {
    const renamed = await fetch(`${base()}/api/devices/${deviceId}`, { method: "PATCH", headers: guard, body: JSON.stringify({ label: "Kitchen iPad" }) });
    expect(((await renamed.json()) as { label: string }).label).toBe("Kitchen iPad");
    const out = await fetch(`${base()}/api/auth`, { method: "DELETE", headers: { cookie } });
    expect(out.headers.get("set-cookie") ?? "").toContain("herdr_web_device=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(204);
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(404);
    // the revoked device is out, and so are strangers: revoking the last device never reopens the gate
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
  });

  it("the plugin script prints a code a headless PC's owner can hand to a phone", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "herdr-pair-cli-"));
    try {
      // spawned asynchronously: a synchronous spawn would block the very server the script asks
      const pairCli = async (port: number) => {
        const child = Bun.spawn(["bun", "scripts/plugin.ts", "pair"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_WEB_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
        const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { out, err, exitCode };
      };
      const run = await pairCli(open.port);
      const out = run.out;
      expect(run.exitCode, run.err).toBe(0);
      const code = /Pairing code: (\d{3}) (\d{3})/.exec(out);
      expect(code).not.toBeNull();
      expect(out).toContain("enter the code");
      const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: `${code![1]}${code![2]}`, label: "Phone by CLI" }) });
      expect(paired.status).toBe(204);
      const list = (await (await fetch(`${base()}/api/devices`)).json()) as { devices: Array<{ label: string }> };
      expect(list.devices.map((d) => d.label)).toContain("Phone by CLI");
      // with a token configured, the script reads it from the plugin's .env file and gets past the gate
      const tokenState = mkdtempSync(join(tmpdir(), "herdr-pair-cli-token-"));
      const secured = createServer({ port: 0, stateDir: tokenState, token: "cli-t0k3n", tailscaleOwner: null });
      try {
        writeFileSync(join(configDir, ".env"), "HERDR_WEB_TOKEN=cli-t0k3n\n");
        const withToken = await pairCli(secured.port);
        expect(withToken.exitCode, withToken.err).toBe(0);
        expect(withToken.out).toMatch(/Pairing code: \d{3} \d{3}/);
        // `.env` wins over a stale token in the older `env` file
        writeFileSync(join(configDir, "env"), "HERDR_WEB_TOKEN=stale\n");
        const withLegacy = await pairCli(secured.port);
        expect(withLegacy.exitCode, withLegacy.err).toBe(0);
        expect(withLegacy.out).toMatch(/Pairing code: \d{3} \d{3}/);
      } finally { secured.stop(); rmSync(tokenState, { recursive: true, force: true }); }
    } finally { rmSync(configDir, { recursive: true, force: true }); }
  });

  it("a configured token gates this PC and its Tailscale login, and a paired device gets past it", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-pairing-token-"));
    const secured = createServer({ port: 0, stateDir: state, token: "t0k3n", tailscaleOwner: OWNER });
    const at = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${secured.port}/api/health?scope=bridge`, { headers }).then((r) => r.json() as Promise<{ auth: HealthAuth }>).then((b) => b.auth);
    try {
      expect(await at()).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token" });
      // another proxy on this PC can pass a visitor's copy of the login header on: the token is asked for anyway
      expect(await at(proxied(OWNER))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ ...proxied(OWNER), authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token" });
      // health only reports the decision: the guarded routes and the upgrade must refuse the header too
      expect((await fetch(`http://127.0.0.1:${secured.port}/api/session`, { headers: proxied(OWNER) })).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${secured.port}/ws`, { headers: proxied(OWNER) })).status).toBe(401);
      // a pairing started with the token lets a device in without it
      const started = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair/start`, { method: "POST", headers: { ...guard, authorization: "Bearer t0k3n" } });
      const { code } = (await started.json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
      expect(paired.status).toBe(204);
      expect(await at({ cookie: (paired.headers.get("set-cookie") ?? "").split(";")[0]! })).toMatchObject({ authenticated: true, via: "device" });
    } finally { secured.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("token auth", () => {
  /**
   * A second server with the gate ON: the default instance above stays open so the
   * rest of the suite keeps proving that an empty token changes nothing.
   */
  const TOKEN = "s3cret";
  let secured: { port: number; stop: () => void };

  beforeAll(() => {
    secured = createServer({ port: 0, token: TOKEN, stateDir });
  });

  afterAll(() => {
    secured?.stop();
  });

  const securedBase = () => `http://127.0.0.1:${secured.port}`;
  const wsUrl = () => `ws://127.0.0.1:${secured.port}/ws`;

  it("rejects an unauthenticated API call with 401 unauthorized", async () => {
    const res = await fetch(`${securedBase()}/api/session`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps web push behind the gate: a subscription receives pane titles", async () => {
    for (const [method, path] of [["GET", "/api/push"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/test"]] as const) {
      const res = await fetch(`${securedBase()}${path}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("keeps the image upload behind the gate", async () => {
    const res = await fetch(`${securedBase()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "w1:p1", content_type: "image/png", data_base64: "aaaa" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps /api/health public and advertises the gate state", async () => {
    const res = await fetch(`${securedBase()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: HealthAuth; herdr: { version: string; protocol: number; terminal_attach?: boolean } };
    expect(body.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    // a Unix herdr attaches terminals; Windows PCs report false and open in the chat lens
    expect(body.herdr.terminal_attach).toBe(true);
  });

  it("tells a client that got in when this server is open to the network, and nobody else", async () => {
    // the health body is JSON off the wire; LanExposure is the shape this endpoint adds to it
    type HealthBody = { auth: HealthAuth; lan_exposure?: LanExposure };
    const health = async (port: number, headers: Record<string, string> = {}): Promise<HealthBody> =>
      (await (await fetch(`http://127.0.0.1:${port}/api/health`, { headers })).json()) as HealthBody;
    // no token and nothing paired, pinned so an inherited HERDR_WEB_TOKEN cannot gate the case
    const bound = (hostname: string) => {
      const stateDir = mkdtempSync(join(tmpdir(), "herdr-lan-"));
      const instance = createServer({ port: 0, hostname, token: "", stateDir });
      return { port: instance.port, stop: () => { instance.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
    };
    const open = bound("0.0.0.0");
    try {
      // bound past this PC, no token, nothing paired: the one state the warning is for
      expect((await health(open.port)).lan_exposure).toEqual({ host: "0.0.0.0" });
      // a request that did not get in is told nothing, whatever the server's state: Funnel is the
      // public internet, which is never "open" (server/access.ts)
      const refused = await health(open.port, { "x-forwarded-for": "100.64.0.9", "tailscale-funnel-request": "?1" });
      expect(refused.auth).toMatchObject({ required: true, authenticated: false, reason: "pairing_required" });
      expect(refused.lan_exposure).toBeUndefined();
      // pairing one device closes the gate to strangers, and the warning leaves with the state
      const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
      const { code } = (await (await fetch(`http://127.0.0.1:${open.port}/api/devices/pair/start`, { method: "POST", headers: guard })).json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${open.port}/api/devices/pair`, { method: "POST", headers: { ...guard, "x-forwarded-for": "100.64.0.9" }, body: JSON.stringify({ code, label: "Phone" }) });
      expect(paired.status).toBe(204);
      expect((await health(open.port)).auth).toMatchObject({ authenticated: true, via: "local" });
      expect((await health(open.port)).lan_exposure).toBeUndefined();
    } finally {
      open.stop();
    }
    // the same empty configuration on a loopback bind is unreachable from the network
    const loopback = bound("127.0.0.1");
    try {
      expect((await health(loopback.port)).lan_exposure).toBeUndefined();
    } finally {
      loopback.stop();
    }
    // and a token is a closed gate, which this endpoint already reported
    const securedBody = await (await fetch(`${securedBase()}/api/health`)).json() as HealthBody;
    expect(securedBody.lan_exposure).toBeUndefined();
  });

  it("refuses a token that does not match", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("invalid_token");
  });

  it("hands back a hardened session cookie for the right token", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`herdr_web_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=31536000");
  });

  it("accepts the session cookie", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { cookie: `herdr_web_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("expires the cookie on logout", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("never upgrades a websocket without a token", async () => {
    const ws = new WebSocket(wsUrl());
    const outcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error/close within 5000ms")), 5000);
      const settle = (result: string) => {
        clearTimeout(timer);
        resolve(result);
      };
      ws.addEventListener("error", () => settle("error"));
      ws.addEventListener("close", () => settle("close"));
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("the upgrade succeeded without a token"));
      });
    });
    expect(["error", "close"]).toContain(outcome);
  }, 10000);

  it("upgrades a websocket that carries the cookie", async () => {
    const ws = connectWithCookie(wsUrl(), `herdr_web_token=${TOKEN}`);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 5000ms")), 5000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the upgrade was refused despite a valid cookie"));
      });
      // a status of some pane may be broadcast before this connection's own snapshot is read
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type: string };
        if (message.type !== "snapshot") return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    expect(first.type).toBe("snapshot");
    ws.close();
  }, 10000);
});

describe("bind address", () => {
  let loopback: { port: number; stop: () => void };

  beforeAll(() => {
    loopback = createServer({ port: 0, hostname: "127.0.0.1", stateDir });
  });

  afterAll(() => {
    loopback?.stop();
  });

  it("serves the API on the requested hostname", async () => {
    const res = await fetch(`http://127.0.0.1:${loopback.port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("generated wire types", () => {
  it("carries an unknown agent_status through instead of dropping or throwing", async () => {
    // herdr gives no stability guarantee: a status this build has never heard of
    // must still reach the UI so it can render something honest.
    const res = await fetch(`${base()}/api/session`);
    const { snapshot } = (await res.json()) as { snapshot: SessionSnapshot };
    const mutated: SessionSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        agent_status: "teleporting" as AgentStatus,
      })),
    };
    const roundTripped = JSON.parse(JSON.stringify(mutated)) as SessionSnapshot;
    for (const workspace of roundTripped.workspaces) {
      expect(workspace.agent_status).toBe("teleporting");
    }
    expect(roundTripped.workspaces.length).toBe(snapshot.workspaces.length);
  });
});


describe("PC management API", () => {
  it("reports bridge auth independently of herdr and exposes the local PC", async () => {
    const health = await fetch(`${base()}/api/health?scope=bridge`);
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: HealthAuth; bridge_protocol: number };
    expect(body.bridge_protocol).toBe(1);
    expect(body.auth.authenticated).toBe(true);
    const list = await fetch(`${base()}/api/machines`);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const data = await list.json() as { machines: { id: string; kind: string }[] };
    expect(data.machines[0]).toMatchObject({ id: "local", kind: "local" });
    const local = await fetch(`${base()}/api/machines/local/session`);
    expect(local.status).toBe(200);
    const viaAlias = await fetch(`${base()}/api/machines/local/integrations`);
    expect(viaAlias.status).toBe(200);
    const direct = await fetch(`${base()}/api/integrations`);
    expect(await viaAlias.json()).toEqual(await direct.json());
  });
  it("rejects CSRF, malformed targets and remote forwarding outside the allowlist", async () => {
    for (const headers of [{}, { "x-herdr-machine": "1", origin: "https://evil.invalid" }, { "x-herdr-machine": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers, body: JSON.stringify({ destination: "host" }) });
      expect(response.status).toBe(403);
    }
    const bad = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers: { "x-herdr-machine": "1" }, body: JSON.stringify({ destination: "-oProxyCommand=bad" }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base()}/api/machines/missing/pane/read?pane_id=p1`)).status).toBe(503);
    expect((await fetch(`${base()}/api/machines/missing/auth`)).status).toBe(404);
  });
  it("gates PC metadata, setup and SSE behind the existing token", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-machine-auth-"));
    const gated = createServer({ port: 0, token: "machine-test-secret", stateDir });
    try {
      for (const path of ["/api/machines", "/api/machines/events", "/api/machines/setup", "/api/bridge"]) expect((await fetch(`http://localhost:${gated.port}${path}`)).status).toBe(401);
      const health = await fetch(`http://localhost:${gated.port}/api/health?scope=bridge`).then((r) => r.json()) as { auth: HealthAuth };
      expect(health.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    } finally { gated.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe("terminal lens of a bridge without the PTY sidecar", () => {
  const TOKEN = "sidecar-test-secret";
  /** what /api/health and /api/bridge tell of herdr, from a bridge whose runtime has the sidecar or lacks it */
  const told = async (sidecar: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-sidecar-"));
    const bridge = createServer({ port: 0, stateDir: dir, token: TOKEN, machines: false, sidecar });
    try {
      const get = async (path: string) => {
        const response = await fetch(`http://localhost:${bridge.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(200);
        return (await response.json()) as { herdr: unknown };
      };
      return { health: (await get("/api/health")).herdr, bridge: (await get("/api/bridge")).herdr };
    } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
  };

  it("reports a mirror from /api/health and /api/bridge though herdr itself can attach", async () => {
    const herdr = await ping();
    // the case only means something against a herdr that can attach
    expect(herdr.terminal_attach).toBe(true);
    const mirrored = { ...herdr, terminal_attach: false, terminal_mirror: true };
    expect(await told(false)).toEqual({ health: mirrored, bridge: mirrored });
  });

  it("passes herdr's own answer through where the sidecar runs", async () => {
    const herdr = await ping();
    expect(herdr).not.toHaveProperty("terminal_mirror");
    expect(await told(true)).toEqual({ health: herdr, bridge: herdr });
  });
});

describe("changed GitHub issue scope", () => {
  it("a fresh owner-approved attempt uses the new issue scope while the paused attempt stays frozen", async () => {
    const owned: string[] = []; const prompts: string[] = [];
    const f = await githubScheduleFixture({ version: async () => "owned-readiness-fixture", createWorkspace: async options => { const result = await herdrRpc<import("./herdr/client.ts").WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; }, startAgent: async options => { prompts.push(readFileSync(join(options.args![1]!, ".saurons-eye-prompt.md"), "utf8")); await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); } });
    try {
      const issue = { number: 12, node_id: "owned-renewal-12", title: "First scope", body: "First approved requirements", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      let source = (await f.request(f.route + "/sync", {})).body.sources[0];
      const plan = { acceptance_criteria: "Approved acceptance", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] };
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan });
      const prefix = `/implementations/${source.implementation_id}`;
      const first = (await f.request(prefix + "/runs", { action: "work", idempotency_key: "first-scope" })).body;
      expect(first.manifest.issue_scope.issue).toMatchObject({ title: "First scope", body: "First approved requirements" });
      issue.title = "Renewed scope"; issue.body = "New owner-approved requirements"; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      source = (await f.request(f.route + "/sync", {})).body.sources[0];
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan });
      const renewed = await f.request(prefix + "/runs", { action: "work", idempotency_key: "renewed-scope" });
      expect(renewed.status).toBe(202);
      expect(renewed.body.manifest.issue_scope.issue).toMatchObject({ title: "Renewed scope", body: "New owner-approved requirements" });
      expect(prompts[1]).toContain("New owner-approved requirements");
      expect(prompts[1]).toContain("Approved acceptance");
      expect(prompts[1]).toContain("Public HTTP");
      const detail = (await f.request(prefix)).body;
      expect(detail.runs).toHaveLength(2);
      expect(detail.runs[0]).toMatchObject({ condition: "cancelled", manifest: first.manifest });
    } finally { for (const id of owned) await workspaceClose(id).catch(() => {}); f.close(); }
  }, 60_000);

  it("keeps the revocation visible when scope changes during native allocation without launching an agent", async () => {
    const owned: string[] = []; let launched = 0; let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => release = resolve), waiting = new Promise<void>(resolve => reached = resolve);
    const f = await githubScheduleFixture({ version: async () => "owned-readiness-fixture", createWorkspace: async options => { const result = await herdrRpc<import("./herdr/client.ts").WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); reached(); await gate; return result; }, startAgent: async () => { launched++; } });
    try {
      const issue = { number: 12, node_id: "owned-allocation-12", title: "Pause before native launch", body: "Preserve notes", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      const source = (await f.request(f.route + "/sync", {})).body.sources[0];
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan: { acceptance_criteria: "Preserve notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] } });
      const prefix = `/implementations/${source.implementation_id}`;
      const pending = f.request(prefix + "/runs", { action: "work", idempotency_key: "allocation-drift" });
      await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned allocation did not reach the gate")), 5000))]);
      issue.body = "New scope during allocation"; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      await f.request(f.route + "/sync", {}); release(); await pending;
      const detail = (await f.request(prefix)).body;
      expect(detail.board.lane).toBe("needs_you");
      expect(detail.runs[0]).toMatchObject({ condition: "cancelled", scope_pause: { condition: "paused" } });
      expect(launched).toBe(0);
      expect(detail.runs).toHaveLength(1);
    } finally { release(); for (const id of owned) await workspaceClose(id).catch(() => {}); f.close(); }
  }, 60_000);

  it("rechecks native issue scope before launch and requires a fresh complete planning approval", async () => {
    let allocated = 0;
    const f = await githubScheduleFixture({ version: async () => "owned-readiness-fixture", createWorkspace: async () => { allocated++; throw new Error("This revoked issue must never allocate native work"); } });
    try {
      const issue = { number: 12, node_id: "owned-before-launch-12", title: "Frozen requirements", body: "Approved requirements", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      const source = (await f.request(f.route + "/sync", {})).body.sources[0];
      const plan = { acceptance_criteria: "Preserve notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] };
      const proof = { policy_revision: policy.revision, issue_revision: source.revision, plan };
      expect((await f.request(f.route + "/issues/12/approve", { ...proof, plan: { ...plan, testing_seams: [] } })).status).toBe(400);
      expect((await f.request(f.route + "/issues/12/approve", proof)).status).toBe(200);
      issue.body = "New testing choice"; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const started = await f.request(`/implementations/${source.implementation_id}/runs`, { action: "work", idempotency_key: "drift-before-launch" });
      expect(started.status).toBe(409);
      expect((await f.request(f.route)).body.sources[0].readiness.eligible).toBe(false);
      expect((await f.request(`/implementations/${source.implementation_id}`)).body.runs).toHaveLength(0);
      expect(allocated).toBe(0);
    } finally { f.close(); }
  }, 60_000);

  it.each([false, true])("retains uncertain child reservations, fences further work and reconciles a controlled pause after repair (resting child: %s)", async restingChild => {
    const owned: string[] = []; let reachable = true;
    const f = await githubScheduleFixture({ version: async () => "owned-readiness-fixture", createWorkspace: async options => { const result = await herdrRpc<import("./herdr/client.ts").WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; }, startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); }, closeWorkspace: async id => { if (!reachable) throw new Error("Owned fixture lost its stop receipt"); return workspaceClose(id); } });
    try {
      const issue = { number: 12, node_id: "owned-uncertain-12", title: "Pause uncertain work", body: "Preserve notes", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      let source = (await f.request(f.route + "/sync", {})).body.sources[0];
      const plan = { acceptance_criteria: "Preserve notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] };
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan });
      const prefix = `/implementations/${source.implementation_id}`;
      const run = (await f.request(prefix + "/runs", { action: "work", idempotency_key: "uncertain-scope" })).body as FactoryRun;
      expect(run.condition).toBe("working");
      const child = (await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "owned-review" })).body;
      expect(child.condition).toBe("working");
      if (restingChild) {
        await herdrRpc("pane.report_agent", { pane_id: child.pane_id, source: "manual", agent: "codex", state: "idle" });
        expect((await f.request(`/runs/${run.id}/workers/${child.id}/reconcile`, {})).body.condition).toBe("ready");
      }
      reachable = false; issue.labels = []; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      await f.request(f.route + "/sync", {});
      let detail = (await f.request(prefix)).body;
      expect(detail.runs[0]).toMatchObject({ condition: "needs_you", scope_pause: { condition: "uncertain" }, manifest: run.manifest });
      expect(detail.workers[0]).toMatchObject({ id: child.id, condition: restingChild ? "ready" : "working", worktree: child.worktree });
      await f.request("/settings", { max_implementations: 4, max_agents: 2 });
      const created = await f.request("/implementations", { title: "Independent capacity fixture", description: "Owned capacity check", project_id: f.route.split("/")[2] });
      expect(created.status).toBe(201); const other = created.body;
      const blocked = await f.request(`/implementations/${other.id}/runs`, { action: "work", idempotency_key: "unrelated-scope" });
      expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe("capacity_exhausted");
      const more = await f.request(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "must-not-launch" });
      expect(more.status).toBe(409);
      await f.request(`/runs/${run.id}/reconcile`, {});
      detail = (await f.request(prefix)).body;
      expect(detail.board.lane).toBe("needs_you");
      expect(detail.runs[0].condition).toBe("needs_you");
      expect(detail.workers).toHaveLength(1);
      f.restart();
      expect((await f.request(prefix)).body.runs[0].scope_pause.condition).toBe("uncertain");
      issue.labels = [{ name: "ready-for-agent" }]; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      source = (await f.request(f.route + "/sync", {})).body.sources[0];
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan });
      expect((await f.request(prefix + "/runs", { action: "work", idempotency_key: "renewed-but-owned" })).status).toBe(409);
      reachable = true;
      const reconciled = await f.request(`/runs/${run.id}/reconcile`, {});
      expect(reconciled.status).toBe(200);
      detail = (await f.request(prefix)).body;
      expect(detail.runs[0]).toMatchObject({ condition: "cancelled", scope_pause: { condition: "paused" }, manifest: run.manifest });
      expect(detail.workers[0].condition).toBe("cancelled");
      expect(detail.runs).toHaveLength(1);
      expect((await f.request(`/implementations/${other.id}/runs`, { action: "work", idempotency_key: "unrelated-scope" })).status).toBe(202);
    } finally { for (const id of owned) await workspaceClose(id).catch(() => {}); f.close(); }
  }, 60_000);

  it("pauses owned work and preserves the accepted issue contract and produced evidence", async () => {
    const owned: string[] = [];
    const f = await githubScheduleFixture({ version: async () => "owned-readiness-fixture", createWorkspace: async options => { const result = await herdrRpc<import("./herdr/client.ts").WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; }, startAgent: async options => { writeFileSync(join(options.args![1]!, "scope-work.md"), "Produced before scope changed\n"); await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); } });
    try {
      const issue = { number: 12, node_id: "owned-scope-12", title: "Retain the approved scope", body: "Preserve my notes", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "ready-for-agent" }] };
      writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      const source = (await f.request(f.route + "/sync", {})).body.sources[0];
      const plan = { acceptance_criteria: "Preserve notes", dependencies: [], testing_seams: ["Public HTTP", "Real browser journeys"], planning_decisions: [] };
      await f.request(f.route + "/issues/12/approve", { policy_revision: policy.revision, issue_revision: source.revision, plan });
      const prefix = `/implementations/${source.implementation_id}`;
      const started = await f.request(prefix + "/runs", { action: "work", idempotency_key: "approved-issue" });
      expect(started.status).toBe(202); const run = started.body as FactoryRun;
      expect(run.condition).toBe("working");
      const detail = (await f.request(prefix)).body;
      const artifact = (await f.request(prefix + "/artifacts", { chat_id: detail.chats[0].id, name: "retained.md", media_type: "text/markdown", content_base64: Buffer.from("Produced before scope changed").toString("base64") })).body;
      issue.body = "Different acceptance"; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
      expect((await f.request(f.route + "/sync", {})).status).toBe(200);
      const paused = (await f.request(prefix)).body;
      expect(paused.board.lane).toBe("needs_you");
      expect(paused.runs[0]).toMatchObject({ condition: "cancelled", scope_pause: { condition: "paused" }, worktree: run.worktree, branch: run.branch, manifest: run.manifest });
      expect(paused.artifacts.map((entry: { id: string }) => entry.id)).toContain(artifact.id);
      const evidence = await f.request(prefix + "/completion-evidence");
      expect(evidence.body.repository_changes).toBe("changes");
      const inspected = (await f.request(prefix)).body;
      expect(inspected.board.waiting_reason).toBe(paused.runs[0].scope_pause.reason);
      const retained = await f.request(prefix + "/snapshots", { mode: "workspace", run_id: run.id });
      expect(retained.body.files.find((file: { path: string }) => file.path === "scope-work.md").diff).toContain("Produced before scope changed");
      expect((await sessionSnapshot()).workspaces.some(workspace => workspace.workspace_id === run.workspace_id)).toBe(false);
      expect((await f.request(prefix + "/runs", { action: "work", idempotency_key: "duplicate-revoked" })).status).toBe(409);
      expect((await f.request(prefix)).body.runs).toHaveLength(1);
    } finally { for (const id of owned) await workspaceClose(id).catch(() => {}); f.close(); }
  }, 60_000);
});

it("refuses cross-origin changes while allowing same-origin and CLI requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-origin-"));
  const instance = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${instance.port}`;
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-origin" });
  try {
    for (const path of ["pane/input", "pane/keys", "pane/close", "pane/focus", "layout/ratio", "workspace/create", "tab/create", "tab/rename", "tab/close", "tab/move", "push/subscribe"]) {
      const response = await fetch(`${base}/api/${path}`, { method: "POST", headers: { origin: "http://other.example", "content-type": "text/plain" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, text: "must not type", keys: ["Enter"] }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    }
    for (const headers of [{ origin: base }, {}] as Record<string, string>[]) {
      const response = await fetch(`${base}/api/pane/rename`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, label: "allowed rename" }) });
      expect(response.status).toBe(200);
    }
  } finally { instance.stop(); await workspaceClose(created.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
});
