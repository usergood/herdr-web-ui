import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

import { published, until } from "../scripts/factory-human-review-fixture.ts";

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "./index.ts";

describe("Human Review through authenticated HTTP", () => {
  it("parks an assistant's owner question and resumes through normal capacity with the exact answered revision", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the result", idempotency_key: "question-discussion" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      const question = await f.agent(assistant.id, "question", { question: "Which changed file should we discuss?" }).then(r => r.json());
      f.runs.get(assistant.id)!.condition = "ready";
      const parked = await until(detail, d => d.runs.find((r: any) => r.id === assistant.id)?.continuation?.condition === "parked");
      expect(parked.runs.find((r: any) => r.id === assistant.id).continuation.kind).toBe("owner");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "The progress file" })).status).toBe(200);
      const resumed = await until(detail, d => d.runs.find((r: any) => r.id === assistant.id)?.continuation?.condition === "resumed");
      expect(resumed.runs.find((r: any) => r.id === assistant.id).continuation.question_revision).toBe(resumed.question_revision);
      const receipt = await f.agent(assistant.id, "consume", { revision: resumed.question_revision }).then(r => r.json());
      expect(receipt.receipt.revision).toBe(resumed.question_revision);
      expect(resumed.runs).toHaveLength(2);
    } finally { f.close(); }
  }, 20000);
  it("rejects direct-work completion of the Human Review assistant without stopping its discussion", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: d.human_reviews[0].id, content: "Discuss the result", idempotency_key: "discussion" });
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
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
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
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
      expect(waiting.snapshots).toEqual([]);
      f.restart(); f.reviewUnavailable(false);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      expect(ready.human_reviews[0].id).toBe(waiting.human_reviews[0].id);
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
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
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
      const next = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
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
      const { id, prefix, detail } = await published(f);
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
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      expect(assistant).toMatchObject({ action: "work", capacity_pool: "normal", base: d.human_reviews[0].head });
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
