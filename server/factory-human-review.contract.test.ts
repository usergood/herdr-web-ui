import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

import { published, until } from "../scripts/factory-human-review-fixture.ts";

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "./index.ts";

// The stand-in native boundary exercises real host leases; it does not certify a provider.
async function humanHostFixture(holdCheck = false) {
  const root = mkdtempSync(join(tmpdir(), "human-review-native-")); const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "result.txt"), "before\n"); git(["add", "."]); git(["commit", "-m", "Owned base"]);
  const source = join(root, "source"); git(["worktree", "add", "-b", "owned-candidate", source]);
  writeFileSync(join(source, "result.txt"), "after\n"); execFileSync("git", ["-C", source, "commit", "-am", "Owned candidate"], { stdio: "ignore" });
  const candidate = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const checkStarted = join(root, "check-started"); const releaseCheck = join(root, "release-check");
  const checks = holdCheck ? [[process.execPath, "-e", `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(checkStarted)}, "working"); const deadline = Date.now() + 10000; while (!fs.existsSync(${JSON.stringify(releaseCheck)})) { if (Date.now() > deadline) process.exit(1); await Bun.sleep(20); }`]] : [];
  const panes: any[] = []; const workspaces: any[] = [];
  let snapshotGate: { entered: () => void; wait: Promise<void> } | null = null;
  const app = createServer({ port: 0, token: "owned-native-review", stateDir: join(root, "state"), machines: false, factory: { accountDiscoveryHome: root, native: {
    version: async () => "owned-native-review",
    createWorkspace: async (options: any) => { const workspace = { workspace_id: `owned-review-${workspaces.length}`, label: options.label }; const pane = { pane_id: `${workspace.workspace_id}:p1`, workspace_id: workspace.workspace_id, terminal_id: `${workspace.workspace_id}:terminal`, cwd: options.cwd, agent: "codex", agent_status: "idle" }; workspaces.push(workspace); panes.push(pane); return { workspace, root_pane: pane } as any; },
    startAgent: async () => ({}) as any,
    snapshot: async () => { if (snapshotGate) { const gate = snapshotGate; snapshotGate = null; gate.entered(); await gate.wait; } return { panes, workspaces } as any; },
    closeWorkspace: async (workspaceId: string) => { for (let i = panes.length - 1; i >= 0; i--) if (panes[i].workspace_id === workspaceId) panes.splice(i, 1); const index = workspaces.findIndex(w => w.workspace_id === workspaceId); if (index >= 0) workspaces.splice(index, 1); return {} as any; },
  } } });
  const api = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer owned-native-review", "x-herdr-factory": "1", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const checkout = await api("factory-host/inspect", { path: repo }).then(r => r.json());
  const capabilities = await api("factory/providers").then(r => r.json());
  const now = new Date().toISOString(); const id = crypto.randomUUID(); const assignmentId = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const parent = { id: parentId, created_at: now, updated_at: now, implementation_id: assignmentId, action: "work", provider: "codex", machine_id: "local", condition: "accepted", waiting_reason: null, idempotency_key: "owned-parent", specification_id: null, graph_hash: null, base: checkout.head, checkout: repo, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills: { hash: capabilities.skill_manifest.hash }, provider_version: "owned-native-review", checkout, project: { permission_mode: "approve_for_me", checks }, implementation: { title: "Owned review", description: "Discuss the captured result" } } };
  const launchedParent = await api("factory-host/launch", { run: parent }).then(r => r.json());
  if (launchedParent.condition !== "working") throw new Error("Owned parent launch failed");
  execFileSync("git", ["-C", launchedParent.worktree, "merge", "--ff-only", candidate], { stdio: "ignore" });
  await api(`factory-host/runs/${parentId}/reconcile`, {});
  const snapshotId = crypto.randomUUID();
  const run = { id, created_at: now, updated_at: now, implementation_id: assignmentId, action: "work", provider: "codex", machine_id: "local", conversation_kind: "human_review", condition: "accepted", waiting_reason: null, idempotency_key: "owned-human-native", specification_id: null, graph_hash: null, base: candidate, checkout: repo, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills: { hash: capabilities.skill_manifest.hash }, provider_version: "owned-native-review", checkout, project: { permission_mode: "approve_for_me", checks }, implementation: { title: "Owned review", description: "Discuss the captured result" }, human_review: { review: { id: parentId, run_id: parentId, implementation_id: assignmentId, conversation_id: `${assignmentId}:human_review`, condition: "ready", head: candidate, snapshot_id: snapshotId }, snapshot: { id: snapshotId, run_id: parentId, implementation_id: assignmentId, machine_id: "local", repository: checkout.repository, mode: "branch", base: checkout.head, head: candidate } } } };
  return { api, run, parent: launchedParent, source, repo, checkout, candidate, panes, workspaces, git, checkStarted, releaseCheck,
    holdNextSnapshot: () => { let entered!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); snapshotGate = { entered, wait }; return { started, release }; }, close: () => { app.stop(); rmSync(root, { recursive: true, force: true }); } };
}

it("admits only captured readonly Human Review after the candidate owner confirms native Stop", async () => {
  const f = await humanHostFixture();
  try {
    expect((await f.api(`factory-host/runs/${f.parent.id}/stop`, {})).status).toBe(200);
    expect(f.workspaces).toHaveLength(0);
    const response = await f.api("factory-host/launch", { run: f.run });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ conversation_kind: "human_review", condition: "working", base: f.candidate });
    expect(f.workspaces).toHaveLength(1);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.checkout.head);
  } finally { f.close(); }
}, 20000);

it("rejects an older Human Review admission observation when Stop or Pause closes its candidate owner", async () => {
  for (const control of ["stop", "pause"] as const) {
    const f = await humanHostFixture(); const gate = f.holdNextSnapshot(); let pending: Promise<Response> | undefined;
    try {
      pending = f.api("factory-host/launch", { run: f.run });
      await gate.started;
      const route = `factory-host/runs/${f.parent.id}/${control === "pause" ? "operations/pause" : "stop"}`;
      expect((await f.api(route, control === "pause" ? { pause_id: crypto.randomUUID() } : {})).status).toBe(200);
      gate.release();
      const rejected = await pending;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { code: "host_owned" } });
      expect(f.workspaces).toHaveLength(0);
    } finally { gate.release(); if (pending) await pending.catch(() => {}); f.close(); }
  }
}, 20000);

it("does not treat a completed step with a still-live native chat as confirmed parent shutdown", async () => {
  const f = await humanHostFixture();
  try {
    expect((await f.api(`factory-host/runs/${f.parent.id}/finish`, {})).status).toBe(200);
    expect(f.workspaces).toHaveLength(1);
    f.panes[0].agent_status = "running";
    const response = await f.api("factory-host/launch", { run: f.run });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "host_owned" } });
    expect(f.workspaces).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

describe("Human Review through authenticated HTTP", () => {
  it("hands the resting candidate owner to a read-only assistant without releasing the parent's ownership", async () => {
    const f = await humanHostFixture();
    try {
      const response = await f.api("factory-host/launch", { run: f.run });
      expect(response.status).toBe(202); const launched = await response.json();
      expect(launched.condition).toBe("working");
      expect((await f.api("factory-host/inspect", { path: launched.worktree }).then(r => r.json())).head).toBe(f.candidate);
      expect((await f.api(`factory-host/runs/${f.parent.id}/reconcile`, {}).then(r => r.json())).condition).toBe("ready");
      const repeated = await f.api("factory-host/launch", { run: f.run });
      expect(await repeated.json()).toMatchObject({ id: launched.id, workspace_id: launched.workspace_id });
      expect(f.workspaces).toHaveLength(2);
      f.git(["worktree", "remove", f.source]);
      const deleted = await f.api(`factory-host/runs/${f.run.id}/operations/delete`, { deletion_id: crypto.randomUUID(), implementation_id: f.run.implementation_id });
      expect(deleted.status).toBe(200); expect(await deleted.json()).toMatchObject({ condition: "deleted" });
      expect((await f.api(`factory-host/runs/${f.parent.id}/reconcile`, {}).then(r => r.json())).condition).toBe("ready");
      expect((await f.api("factory-host/inspect", { path: f.repo }).then(r => r.json())).head).toBe(f.checkout.head);
    } finally { f.close(); }
  }, 20000);
  it("keeps ordinary second Runs and changed or unrelated review scopes excluded", async () => {
    const f = await humanHostFixture();
    try {
      const ordinary = { ...f.run, conversation_kind: undefined };
      const invalid = [ordinary, { ...f.run, action: "setup" },
        { ...f.run, provider: "claude" }, { ...f.run, machine_id: "another-machine" },
        { ...f.run, implementation_id: crypto.randomUUID() }, { ...f.run, capacity_pool: "planning" },
        { ...f.run, base: f.checkout.head },
        { ...f.run, manifest: { ...f.run.manifest, project: { permission_mode: "read_only" } } },
        { ...f.run, manifest: { ...f.run.manifest, human_review: { ...f.run.manifest.human_review, review: { ...f.run.manifest.human_review.review, run_id: crypto.randomUUID() } } } },
        { ...f.run, manifest: { ...f.run.manifest, human_review: { ...f.run.manifest.human_review, snapshot: { ...f.run.manifest.human_review.snapshot, id: crypto.randomUUID() } } } },
      ];
      for (const run of invalid) {
        const response = await f.api("factory-host/launch", { run });
        expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "host_owned" } });
      }
      expect(f.workspaces).toHaveLength(1);
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(202);
      const duplicate = await f.api("factory-host/launch", { run: { ...f.run, id: crypto.randomUUID() } });
      expect(duplicate.status).toBe(409); expect(f.workspaces).toHaveLength(2);
    } finally { f.close(); }
  }, 20000);
  it("requires current native rest rather than a cached ready condition", async () => {
    const f = await humanHostFixture();
    try {
      const pane = f.panes[0];
      for (const state of [{ agent_status: "running" }, { agent_status: "blocked" }, { agent_status: "idle", background_tasks: 1 }, { agent_status: "idle", agent: null }]) {
        Object.assign(pane, { agent: "codex", agent_status: "idle", background_tasks: undefined }, state);
        const response = await f.api("factory-host/launch", { run: f.run });
        expect(response.status).toBe(409);
      }
      Object.assign(pane, { agent: "codex", agent_status: "idle", background_tasks: undefined });
      const workspace = f.workspaces.pop();
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      f.workspaces.push(workspace);
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(202);
    } finally { f.close(); }
  }, 20000);
  it("retains resting assistant history while admitting a later candidate only after all contexts rest", async () => {
    const f = await humanHostFixture();
    try {
      const first = await f.api("factory-host/launch", { run: f.run }).then(r => r.json());
      writeFileSync(join(f.parent.worktree, "result.txt"), "repaired\n");
      execFileSync("git", ["-C", f.parent.worktree, "commit", "-am", "Owned repair"], { stdio: "ignore" });
      const head = execFileSync("git", ["-C", f.parent.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const snapshotId = crypto.randomUUID();
      const next = { ...f.run, id: crypto.randomUUID(), base: head, manifest: { ...f.run.manifest, human_review: { ...f.run.manifest.human_review, review: { ...f.run.manifest.human_review.review, head, snapshot_id: snapshotId }, snapshot: { ...f.run.manifest.human_review.snapshot, id: snapshotId, head } } } };
      const pane = f.panes.find(p => p.pane_id === first.pane_id); pane.agent_status = "running";
      expect((await f.api("factory-host/launch", { run: next })).status).toBe(409);
      pane.agent_status = "idle";
      expect((await f.api("factory-host/launch", { run: next })).status).toBe(202);
      expect(f.workspaces).toHaveLength(3);
      expect((await f.api(`factory-host/runs/${first.id}/reconcile`, {}).then(r => r.json())).condition).toBe("ready");
    } finally { f.close(); }
  }, 20000);
  it("keeps live and uncertain child reservations until verified shutdown", async () => {
    const f = await humanHostFixture();
    try {
      const now = new Date().toISOString();
      const worker = { id: crypto.randomUUID(), created_at: now, updated_at: now, run_id: f.parent.id, ticket_id: null, role: "standards", condition: "accepted", waiting_reason: null, idempotency_key: "owned-reviewer", base: f.candidate, head: null, integration_tip: null, worktree: null, branch: null, workspace_id: null, pane_id: null, shared_paths: [] };
      const child = await f.api(`factory-host/runs/${f.parent.id}/operations/worker`, { worker, context: {} }).then(r => r.json());
      expect(child.condition).toBe("working");
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      const index = f.workspaces.findIndex(w => w.workspace_id === child.workspace_id); const [workspace] = f.workspaces.splice(index, 1);
      const uncertain = await f.api(`factory-host/runs/${f.parent.id}/operations/reconcile-worker`, { worker_id: child.id }).then(r => r.json());
      expect(uncertain.condition).toBe("disconnected");
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      f.workspaces.push(workspace);
      expect((await f.api(`factory-host/runs/${f.parent.id}/operations/stop-worker`, { worker_id: child.id })).status).toBe(200);
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(202);
    } finally { f.close(); }
  }, 20000);
  it("waits for a live validation command before admitting the captured discussion", async () => {
    const f = await humanHostFixture(true);
    let pending: Promise<Response> | undefined;
    try {
      const now = new Date().toISOString();
      const check = { id: crypto.randomUUID(), created_at: now, updated_at: now, run_id: f.parent.id, worker_id: null, condition: "working", head: f.candidate, workspace_hash: null, commands: [] };
      pending = f.api(`factory-host/runs/${f.parent.id}/operations/check`, { check });
      const deadline = Date.now() + 5000;
      while (!existsSync(f.checkStarted)) { if (Date.now() > deadline) throw new Error("Owned validation did not start"); await Bun.sleep(20); }
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      writeFileSync(f.releaseCheck, "continue");
      expect(await (await pending).json()).toMatchObject({ condition: "passed" });
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(202);
    } finally { writeFileSync(f.releaseCheck, "continue"); await pending; f.close(); }
  }, 20000);
  it("does not hand a paused or deleting parent to a new assistant", async () => {
    const f = await humanHostFixture();
    try {
      const paused = await f.api(`factory-host/runs/${f.parent.id}/operations/pause`, { pause_id: crypto.randomUUID() });
      expect(paused.status).toBe(200);
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      const deleted = await f.api(`factory-host/runs/${f.parent.id}/operations/delete`, { deletion_id: crypto.randomUUID(), implementation_id: f.run.implementation_id });
      expect(deleted.status).toBe(200);
      expect((await f.api("factory-host/launch", { run: f.run })).status).toBe(409);
      expect(f.workspaces).toHaveLength(0);
    } finally { f.close(); }
  }, 20000);
  it("explains an older Machine bridge without launching the discussion as unrestricted direct work", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      f.legacyHumanReview();
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the result", idempotency_key: "older-machine" });
      const blocked = await until(detail, d => d.capacity_waiting.some((w: any) => w.condition === "blocked"));
      expect(blocked.capacity_waiting[0].reason).toContain("Human Review bridge support");
      expect(blocked.runs).toHaveLength(1);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  }, 20000);
  it("parks an assistant's owner question and resumes through normal capacity with the exact answered revision", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the result", idempotency_key: "question-discussion" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      const question = await f.agent(assistant.id, "question", { question: "Which changed file should we discuss?" }).then(r => r.json());
      f.runs.get(assistant.id)!.condition = "ready";
      const parked = await until(detail, d => d.runs.find((r: any) => r.id === assistant.id)?.continuation?.condition === "parked");
      expect(parked.runs.find((r: any) => r.id === assistant.id).continuation.kind).toBe("owner");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The progress file" })).status).toBe(200);
      const previousWorkers = new Set(d.workers.map((worker: any) => worker.id));
      const consumedReviewers = new Set<string>();
      // Changed owner context also schedules fresh independent review on the
      // same normal pool. Let those owned reviewers genuinely consume and rest.
      const observeReviews = async () => {
        const current = await detail();
        for (const worker of current.workers.filter((worker: any) => !previousWorkers.has(worker.id) && ["standards", "spec"].includes(worker.role) && worker.condition === "working" && !consumedReviewers.has(worker.id))) {
          const contract = await f.agent(d.human_reviews[0].run_id, "contract").then(response => response.json());
          expect(contract.question_revision).toBe(current.question_revision);
          expect((await f.agent(d.human_reviews[0].run_id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
          consumedReviewers.add(worker.id);
          f.workers.get(worker.id)!.condition = "ready";
        }
        return current;
      };
      const resumed = await until(observeReviews, d => d.runs.find((r: any) => r.id === assistant.id)?.continuation?.condition === "resumed");
      expect(resumed.runs.find((r: any) => r.id === assistant.id).continuation.id).toBe(parked.runs.find((r: any) => r.id === assistant.id).continuation.id);
      const capacity = (await f.api("").then(response => response.json())).capacity;
      expect(capacity.contexts.filter((context: any) => context.pool === "normal")).toEqual([expect.objectContaining({ id: assistant.id, pool: "normal" })]);
      expect(resumed.runs.find((r: any) => r.id === assistant.id).continuation.question_revision).toBe(resumed.question_revision);
      const receipt = await f.agent(assistant.id, "consume", { revision: resumed.question_revision }).then(r => r.json());
      expect(receipt.receipt.revision).toBe(resumed.question_revision);
      expect(resumed.runs).toHaveLength(2);
      f.runs.get(assistant.id)!.condition = "ready";
      expect((await f.api(`/runs/${assistant.id}/reconcile`, {})).status).toBe(200);
      const refreshed = await until(observeReviews, current => current.automatic_review[0]?.condition === "published" && current.automatic_review[0]?.context_revision === resumed.question_revision);
      expect(consumedReviewers.size).toBe(2);
      expect(refreshed.pull_requests[0].check_id).not.toBe(d.pull_requests[0].check_id);
      expect(refreshed.pull_requests[0].evidence_ids.every((id: string) => !d.pull_requests[0].evidence_ids.includes(id))).toBe(true);
      expect(refreshed.human_reviews[0].snapshot_id).toBe(d.human_reviews[0].snapshot_id);
      expect(refreshed.human_review_approvals).toHaveLength(0);
      expect(f.mergeEffects).toHaveLength(0);
    } finally { f.close(); }
  }, 20000);
  it("rejects direct-work completion of the Human Review assistant without stopping its discussion", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the result", idempotency_key: "discussion" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      const native = f.runs.get(assistant.id)!; native.workspace_id = "owned-human-review"; native.pane_id = "owned-human-review:p1"; native.condition = "ready";
      await f.api(`/runs/${assistant.id}/reconcile`, {});
      const result = await f.api(`${prefix}/complete-work`, { run_id: assistant.id });
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ error: { code: "direct_work_required" } });
      expect((await detail()).runs.find((r: any) => r.id === assistant.id).condition).toBe("ready");
    } finally { f.close(); }
  }, 20000);
  it("replaces a confirmed stopped native assistant while retaining the same Human Review and earlier history", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { id, prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const review = ready.human_reviews[0];
      await f.api(`${prefix}/human-review/messages`, { review_id: review.id, content: "First context", idempotency_key: "first-context" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const first = started.runs.find((r: any) => r.conversation_kind === "human_review");
      f.setTranscript({ source_id: "first-native-context", version: "one", cursor: null, turns: [{ role: "assistant", ts: new Date().toISOString(), parts: [{ kind: "text", text: "Retain this review explanation." }] }] });
      f.runs.get(first.id)!.condition = "ready";
      await until(detail, d => d.native_snapshots.some((s: any) => s.run_id === first.id));
      expect((await f.api(`/runs/${first.id}/stop`, { summary: "Owned native context replacement" })).status).toBe(200);
      await f.api(`${prefix}/human-review/messages`, { review_id: review.id, content: "Continue our discussion", idempotency_key: "replacement-context" });
      const continued = await until(detail, d => d.runs.filter((r: any) => r.conversation_kind === "human_review").length === 2);
      const second = continued.runs.filter((r: any) => r.conversation_kind === "human_review").at(-1);
      expect(second.manifest.human_review.history).toContain("Retain this review explanation.");
      expect(continued.human_reviews[0]).toMatchObject({ id: review.id, assistant_run_id: second.id, snapshot_id: review.snapshot_id });
      f.restart();
      const restored = await detail();
      expect(restored.conversations.find((c: any) => c.id === `${id}:human_review`).contexts.map((c: any) => c.run_id)).toEqual([first.id, second.id]);
      expect(restored.native_snapshots.some((s: any) => s.run_id === first.id)).toBe(true);
    } finally { f.close(); }
  }, 25000);
  it("keeps a changed candidate blocked instead of silently replacing the captured review after restart", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      f.reviewHead("f".repeat(40));
      const { detail } = await published(f);
      const blocked = await until(detail, d => d.human_reviews?.[0]?.condition === "blocked");
      expect(blocked.human_reviews[0].reason).toContain("checked PR head");
      f.restart(); f.reviewHead(null);
      const other = await f.assignment("Probe queue after restart");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "probe" });
      await until(() => f.api("").then(r => r.json()), d => d.implementations.length === 2);
      const deadline = Date.now() + 1000;
      await until(detail, d => {
        expect(d.human_reviews[0].condition).toBe("blocked");
        expect(d.events.filter((e: any) => e.kind === "human_review_handoff")).toHaveLength(0);
        return Date.now() >= deadline;
      });
    } finally { f.close(); }
  }, 20000);
  it("keeps an unavailable Machine handoff visible and completes once after reconnect and restart", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      f.reviewUnavailable(true);
      const { detail } = await published(f);
      const waiting = await until(detail, d => d.human_reviews?.[0]?.condition === "waiting");
      expect(waiting.human_reviews[0].reason).toContain("Machine");
      expect(waiting.human_reviews[0].reason_is_error).toBe(true);
      expect(waiting.snapshots).toEqual([]);
      const overview = await f.api("").then(response => response.json());
      expect(overview.progress.find((progress: any) => progress.implementation_id === waiting.implementation.id).error_reasons).toContain(waiting.human_reviews[0].reason);
      f.offline(true); f.reviewUnavailable(false);
      const disconnected = await until(detail, current => current.runs[0].condition === "disconnected");
      expect(disconnected.human_reviews[0].reason_is_error).toBe(true);
      f.restart();
      expect((await detail()).human_reviews[0].reason_is_error).toBe(true);
      f.offline(false);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      expect(ready.human_reviews[0].id).toBe(waiting.human_reviews[0].id);
      expect(ready.human_reviews[0]).toMatchObject({ reason: null, reason_is_error: false });
      expect((await f.api(`/implementations/${ready.implementation.id}?view=current`).then(response => response.json())).human_reviews[0].reason_is_error).toBe(false);
      expect((await f.api("").then(response => response.json())).progress.find((progress: any) => progress.implementation_id === ready.implementation.id).error_reasons).not.toContain(disconnected.human_reviews[0].reason);
      expect(ready.snapshots).toHaveLength(1);
      expect(ready.events.filter((e: any) => e.kind === "human_review_handoff")).toHaveLength(1);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  }, 20000);
  it("retains an uncertain discussion delivery across restart without replaying the owner's message", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const reviewId = ready.human_reviews[0].id;
      await f.api(`${prefix}/human-review/messages`, { review_id: reviewId, content: "First discussion", idempotency_key: "first" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      f.runs.get(assistant.id)!.condition = "ready";
      await f.api(`/runs/${assistant.id}/reconcile`, {});
      f.loseNextSend();
      const body = { review_id: reviewId, content: "Second discussion", idempotency_key: "second" };
      const message = await f.api(`${prefix}/human-review/messages`, body).then(r => r.json());
      const uncertain = await until(detail, d => d.human_review_deliveries?.some((m: any) => m.id === message.id && m.condition === "uncertain"));
      expect(uncertain.human_review_deliveries.find((m: any) => m.id === message.id).reason).toContain("not confirmed");
      expect(f.prompts.filter(p => p.text.includes("Second discussion"))).toHaveLength(1);
      f.restart();
      await f.api(`${prefix}/human-review/messages`, body);
      const restored = await detail();
      expect(restored.human_review_deliveries.find((m: any) => m.id === message.id).condition).toBe("uncertain");
      expect(restored.messages.filter((m: any) => m.content === "Second discussion")).toHaveLength(1);
      expect(f.prompts.filter(p => p.text.includes("Second discussion"))).toHaveLength(1);
    } finally { f.close(); }
  }, 25000);
  it("keeps the discussion assistant outside implementation and reviewer dispatch authority", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the captured result", idempotency_key: "discuss" });
      const next = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = next.runs.find((r: any) => r.conversation_kind === "human_review");
      f.runs.get(assistant.id)!.condition = "ready";
      await f.api(`/runs/${assistant.id}/reconcile`, {});
      const response = await f.agent(assistant.id, "worker", { role: "standards", idempotency_key: "unauthorized-review" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "discussion_only" } });
      expect((await detail()).workers).toHaveLength(3);
    } finally { f.close(); }
  }, 20000);
  it("captures renamed, binary and oversized deleted files from an owned repository without reading unbounded diffs", async () => {
    const root = mkdtempSync(join(tmpdir(), "human-review-git-")); const repo = join(root, "repo"); mkdirSync(repo);
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-b", "main"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repo, "old.txt"), "Rename me without losing my contents\n");
    writeFileSync(join(repo, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    git(["add", "."]); git(["commit", "-m", "Owned base"]);
    const app = createServer({ port: 0, token: "owned-review", stateDir: join(root, "state"), machines: false, factory: { accountDiscoveryHome: root } });
    const api = (path: string, body: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: "POST", headers: { authorization: "Bearer owned-review", "x-herdr-factory": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const project = await api("/projects", { name: "Owned review", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
      const idea = await api("/implementations", { title: "Owned review", description: "Capture changes", project_id: project.id }).then(r => r.json());
      renameSync(join(repo, "old.txt"), join(repo, "renamed.txt")); rmSync(join(repo, "large.txt"));
      writeFileSync(join(repo, "binary.dat"), new Uint8Array([0, 1, 2]));
      git(["add", "."]); git(["commit", "-m", "Owned changes"]);
      const result = await api(`/implementations/${idea.id}/snapshots`, { mode: "branch" });
      expect(result.status).toBe(201);
      const snapshot = await result.json();
      expect(snapshot.files.find((file: any) => file.path === "large.txt")).toMatchObject({ status: "branch:D", diff: "", oversized: true });
      expect(snapshot.files.find((file: any) => file.path === "renamed.txt")).toMatchObject({ status: "branch:R100", old_path: "old.txt", diff: expect.stringContaining("rename from old.txt") });
      expect(snapshot.files.find((file: any) => file.path === "binary.dat")).toMatchObject({ binary: true });
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("queues discussion on normal capacity, retains replies and parks without a competing Orchestrator", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { id, prefix, detail, run } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const other = await f.assignment("Occupied normal capacity");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "occupy" });
      const body = { review_id: d.human_reviews[0].id, content: "Explain the progress change", idempotency_key: "discuss-progress" };
      const response = await f.api(`${prefix}/human-review/messages`, body);
      expect(response.status).toBe(202);
      const queued = await detail();
      expect(queued.capacity_waiting.at(-1).purpose).toBe("execution");
      expect(queued.messages.filter((m: any) => m.content === body.content)).toHaveLength(1);
      expect(queued.runs).toHaveLength(1);
      expect((await f.api(`${prefix}/human-review/messages`, body)).status).toBe(202);
      f.restart();
      f.runs.get(f.launches.at(-1)!)!.condition = "ready";
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      expect(assistant).toMatchObject({ action: "work", capacity_pool: "normal", base: d.human_reviews[0].head, checkout: run.checkout });
      expect(started.runs.filter((r: any) => r.action === "implement-spec")).toHaveLength(1);
      const overview = await f.api("").then(r => r.json());
      expect(overview.progress.find((p: any) => p.implementation_id === id).activities).not.toContain("implementing");
      expect((await f.api("").then(r => r.json())).capacity.planning.used).toBe(0);
      f.setTranscript({ source_id: "review-reply", version: "one", cursor: null, turns: [{ role: "assistant", ts: new Date().toISOString(), parts: [{ kind: "text", text: "The change updates progress." }] }] });
      f.runs.get(assistant.id)!.condition = "ready";
      await until(detail, d => d.native_snapshots.some((s: any) => s.run_id === assistant.id));
      f.restart();
      const restored = await detail();
      expect(restored.conversations.find((c: any) => c.id === `${id}:human_review`).contexts[0].run_id).toBe(assistant.id);
      expect(restored.native_snapshots.some((s: any) => s.turns.some((t: any) => t.parts.some((p: any) => p.text === "The change updates progress.")))).toBe(true);
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
    } finally { f.close(); }
  }, 25000);
  it("hands off one checked PR with captured provenance and stable history without allocating an assistant", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { id, detail, run } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const review = d.human_reviews[0];
      expect(review).toMatchObject({ run_id: run.id, conversation_id: `${id}:human_review`, head: d.pull_requests[0].head });
      const snapshot = d.snapshots.find((s: any) => s.id === review.snapshot_id);
      expect(snapshot).toMatchObject({ head: review.head, mode: "branch", run_id: run.id });
      expect(snapshot.files[0]).toMatchObject({ path: "progress.ts", diff: expect.stringContaining("+after") });
      expect(d.runs[0].continuation.condition).toBe("parked");
      expect(f.launches).toHaveLength(1);
      f.restart();
      const restored = await detail();
      expect(restored.human_reviews).toEqual(d.human_reviews);
      expect(restored.events.filter((e: any) => e.kind === "human_review_handoff")).toHaveLength(1);
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
    } finally { f.close(); }
  }, 20000);
});

for (const lost of [false, true]) it(`waits for a retained Orchestrator continuation during fresh review with ${lost ? "lost" : "confirmed"} delivery acknowledgment`, async () => {
  const f = await capacityFixture({ advancingHeads: true });
  let checkGate: ReturnType<typeof f.holdNextCheck> | undefined;
  let sendGate: ReturnType<typeof f.holdNextSend> | undefined;
  try {
    const { prefix, detail, run } = await published(f);
    const ready = await until(detail, current => current.human_reviews?.[0]?.condition === "ready");
    const oldWorkers = new Set(ready.workers.map((worker: any) => worker.id));
    const oldChecks = [...f.executedChecks];
    f.runs.get(run.id)!.condition = "working";
    const question = await f.agent(run.id, "question", { question: "Retain this accepted behavior after the owner decision?" }).then(response => response.json());
    checkGate = f.holdNextCheck("integration"); sendGate = f.holdNextSend();
    if (lost) f.loseNextSend();
    expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Yes; freshly review the same accepted behavior" })).status).toBe(200);
    await checkGate.started;
    // The previous native turn genuinely rests before its answered continuation
    // is dispatched; the next turn remains working while its acknowledgment waits.
    f.runs.get(run.id)!.condition = "ready";
    expect((await f.api(`/runs/${run.id}/reconcile`, {})).status).toBe(200);
    await sendGate.started;
    const sending = await detail(); const retained = sending.runs.find((current: any) => current.id === run.id);
    expect(retained).toMatchObject({ condition: "accepted", continuation: { kind: "owner", condition: "sending", question_revision: sending.question_revision } });
    expect(f.runs.get(run.id)!.condition).toBe("working");
    checkGate.release();
    const waiting = await until(detail, current => current.automatic_review[0]?.check_id === current.checks.at(-1)?.id && ["reviewing", "waiting", "blocked"].includes(current.automatic_review[0]?.condition));
    expect(["reviewing", "waiting"]).toContain(waiting.automatic_review[0].condition);
    expect(waiting.automatic_review[0].reason_is_error).toBe(false);
    if (waiting.automatic_review[0].condition === "waiting") expect(waiting.automatic_review[0].reason).toContain("continuation");
    expect(waiting.runs.find((current: any) => current.id === run.id)).toMatchObject({ worktree: retained.worktree, continuation: { id: retained.continuation.id, condition: "sending", question_revision: sending.question_revision } });
    const reserved = (await f.api("").then(response => response.json())).capacity;
    expect(reserved.contexts).toContainEqual(expect.objectContaining({ id: run.id, pool: "normal" }));
    expect(waiting.workers.map((worker: any) => worker.id)).toEqual(ready.workers.map((worker: any) => worker.id));
    expect(waiting.checks.at(-1).condition).toBe("passed");
    expect(f.executedChecks).toHaveLength(oldChecks.length + 1);
    expect(f.prompts).toHaveLength(1);
    sendGate.release();
    if (lost) {
      await until(detail, current => current.runs.find((candidate: any) => candidate.id === run.id)?.continuation?.condition === "uncertain");
      f.restart();
      expect((await f.api(`/runs/${run.id}/reconcile`, {})).status).toBe(200);
      const uncertain = await detail();
      expect(uncertain.runs.find((candidate: any) => candidate.id === run.id).continuation).toMatchObject({ id: retained.continuation.id, condition: "uncertain", question_revision: sending.question_revision });
      const capacity = (await f.api("").then(response => response.json())).capacity;
      expect(capacity.contexts).toContainEqual(expect.objectContaining({ id: run.id, pool: "normal", uncertain: true }));
      expect(uncertain.workers.map((worker: any) => worker.id)).toEqual(ready.workers.map((worker: any) => worker.id));
      expect(f.prompts).toHaveLength(1);
    } else {
      await until(detail, current => current.runs.find((candidate: any) => candidate.id === run.id)?.continuation?.condition === "resumed");
      const contract = await f.agent(run.id, "contract").then(response => response.json());
      expect((await f.agent(run.id, "consume", { revision: contract.question_revision })).status).toBe(200);
      f.runs.get(run.id)!.condition = "ready";
      expect((await f.api(`/runs/${run.id}/reconcile`, {})).status).toBe(200);
      for (const role of ["standards", "spec"]) {
        const current = await until(detail, current => current.workers.some((worker: any) => worker.role === role && !oldWorkers.has(worker.id) && worker.condition === "working"));
        const worker = current.workers.find((worker: any) => worker.role === role && worker.condition === "working");
        const context = await f.agent(run.id, "contract").then(response => response.json());
        expect(context.question_revision).toBe(sending.question_revision);
        expect((await f.agent(run.id, "consume", { revision: context.question_revision, worker_id: worker.id })).status).toBe(200);
        f.workers.get(worker.id)!.condition = "ready";
      }
      const refreshed = await until(detail, current => current.automatic_review[0]?.condition === "published" && current.automatic_review[0]?.context_revision === sending.question_revision);
      expect(refreshed.human_reviews[0].snapshot_id).toBe(ready.human_reviews[0].snapshot_id);
      expect(f.executedChecks).toHaveLength(oldChecks.length + 1);
      expect(refreshed.workers.filter((worker: any) => worker.role === "implementer")).toHaveLength(1);
      expect(f.prompts).toHaveLength(1);
    }
    expect((await detail()).human_review_approvals).toHaveLength(0);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { checkGate?.release(); sendGate?.release(); f.close(); }
}, 30000);

it("keeps a working Orchestrator handoff wait non-error and clears it after native rest", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { detail, run } = await published(f, "merge", false);
    f.runs.get(run.id)!.condition = "working";
    const waiting = await until(detail, current => current.human_reviews?.[0]?.condition === "waiting");
    expect(waiting.human_reviews[0].reason_is_error).toBe(false);
    expect(waiting.human_reviews[0].reason).toContain("native rest");
    const native = f.runs.get(run.id)!;
    native.condition = "blocked"; native.waiting_reason = "Owned repository operation is blocked";
    const blocked = await until(detail, current => current.human_reviews[0].reason === native.waiting_reason);
    expect(blocked.human_reviews[0].reason_is_error).toBe(true);
    native.condition = "working"; native.waiting_reason = null;
    await until(detail, current => current.human_reviews[0].reason === waiting.human_reviews[0].reason && current.human_reviews[0].reason_is_error === false);
    f.offline(true);
    const fault = await until(detail, current => current.runs[0].condition === "disconnected" && current.human_reviews[0].reason_is_error === true);
    expect(fault.human_reviews[0].reason_is_error).toBe(true);
    f.restart();
    expect((await detail()).human_reviews[0].reason_is_error).toBe(true);
    f.offline(false);
    f.runs.get(run.id)!.condition = "ready";
    const ready = await until(detail, current => current.human_reviews[0]?.condition === "ready");
    expect(ready.human_reviews[0]).toMatchObject({ id: waiting.human_reviews[0].id, reason: null, reason_is_error: false });
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);
