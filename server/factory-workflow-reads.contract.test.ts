import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";
import { seedWorkflowConversations } from "../scripts/fixtures/workflow-conversations.ts";

test("compact polls expose workflow metadata and selected conversations exclude unrelated retained bodies", async () => {
  const state = mkdtempSync(join(tmpdir(), "factory-workflow-reads-"));
  const f = seedWorkflowConversations(state);
  const store = new FactoryStore(state);
  store.put("runs", { ...f.orchestrator, manifest: { tickets: [{ id: "ticket-fixture", title: "Keep the approved Ticket name" }], planning_authority: { automatic_execution: true, id: "owned-authority" }, frozen_context: "Unrelated frozen context".repeat(20_000) } }, f.assignment.id);
  const hidden = store.get<any>("native_snapshots", `${f.human.id}-history`)!;
  store.put("native_snapshots", { ...hidden, turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: "Human-only retained evidence".repeat(30_000) }] }] }, f.human.id);
  for (const title of ["Specifications", "Human Review"]) {
    const chat = { ...store.record(), implementation_id: f.assignment.id, title };
    store.put("chats", chat, f.assignment.id);
    store.put("messages", { ...store.record(), implementation_id: f.assignment.id, chat_id: chat.id, role: "owner", content: `${title} owned reply`, source_id: null, sequence: null }, f.assignment.id);
  }
  const snapshot = { ...store.record(), id: "active-human-diff", implementation_id: f.assignment.id, run_id: f.orchestrator.id, machine_id: "local", repository: "owned", mode: "branch", base: "base", head: "head", hash: "owned-diff-hash", files: [{ path: "approved.ts", status: "M", diff: "@@ -1 +1 @@\n-before\n+approved\n", binary: false, oversized: false }] };
  store.put("snapshots", snapshot, f.assignment.id);
  store.put("snapshots", { ...snapshot, id: "earlier-human-diff", head: "earlier", files: [{ ...snapshot.files[0], diff: "Unrelated earlier diff body".repeat(20_000) }] }, f.assignment.id);
  store.put("snapshots", { ...snapshot, id: "unselected-diff", files: [{ ...snapshot.files[0], diff: "Unselected diff body".repeat(20_000) }] }, f.assignment.id);
  store.put("human_reviews", { ...store.record(), id: f.orchestrator.id, implementation_id: f.assignment.id, run_id: f.orchestrator.id, conversation_id: `${f.assignment.id}:human_review`, head: "head", snapshot_id: snapshot.id, assistant_run_id: f.human.id, condition: "ready", reason: null }, f.assignment.id);
  store.put("comments", { ...store.record(), implementation_id: f.assignment.id, run_id: f.orchestrator.id, snapshot_id: "earlier-human-diff", path: "approved.ts", change: "M", side: "new", line_start: 1, line_end: 1, context: "+Original anchor", content: "Retained earlier feedback", status: "resolved", batch_id: "old-human-batch" }, f.assignment.id);
  store.put("automatic_review_batches", { ...store.record(), implementation_id: f.assignment.id, run_id: f.orchestrator.id, origin: "automatic", status: "sent", reports: [{ content: "Unselected report body".repeat(20_000) }], ticket_ids: [], head: "head", round: 1 }, f.assignment.id);
  store.close();
  const app = createServer({ port: 0, stateDir: state, token: "owned-workflow-read", machines: false, factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
  const prefix = `http://localhost:${app.port}/api/factory/implementations/${f.assignment.id}`;
  const read = async (query: string) => {
    const response = await fetch(prefix + query, { headers: { authorization: "Bearer owned-workflow-read" } });
    return { status: response.status, text: await response.text() };
  };
  try {
    expect((await fetch(prefix + "?view=workflow")).status).toBe(401);
    const compact = await read("?view=current"); const current = JSON.parse(compact.text);
    expect(compact.status).toBe(200);
    expect(current).not.toHaveProperty("native_snapshots");
    expect(current).not.toHaveProperty("messages");
    expect(current.conversations.map((conversation: any) => conversation.kind)).toEqual(["specifications", "orchestrator", "human_review", "implementation", "reviewer", "standards", "spec", "review_fixes", "review_fixes"]);
    expect(current.conversations.find((conversation: any) => conversation.kind === "implementation").title).toBe("Keep the approved Ticket name");
    expect(current.workers).toHaveLength(5);
    expect(current.runs.find((run: any) => run.id === f.orchestrator.id).manifest.planning_authority).toEqual({ automatic_execution: true, id: "owned-authority" });
    expect(compact.text).not.toContain("Human-only retained evidence");
    expect(compact.text).not.toContain("Unrelated frozen context");
    expect(compact.text).not.toContain("Unselected report body");
    expect(current.automatic_review_batches[0]).not.toHaveProperty("reports");
    const selected = await read("?view=workflow"); const specifications = JSON.parse(selected.text);
    expect(selected.status).toBe(200);
    expect(specifications.native_snapshots.map((snapshot: any) => snapshot.id)).toEqual([`${f.interview.id}-history`, `${f.specification.id}-history`]);
    expect(specifications.messages.map((message: any) => message.content)).toEqual(["Specifications owned reply"]);
    expect(selected.text).not.toContain("Human-only retained evidence");
    expect(selected.text).not.toContain("Unrelated frozen context");
    expect(specifications.snapshots).toEqual([]);
    expect(specifications.comments).toEqual([]);
    const workerId = current.conversations.find((conversation: any) => conversation.kind === "implementation").id;
    const implementation = JSON.parse((await read(`?view=workflow&conversation_id=${encodeURIComponent(workerId)}`)).text);
    expect(implementation.native_snapshots.map((snapshot: any) => snapshot.id)).toEqual([`${f.implementation.id}-history`]);
    expect(implementation.messages).toEqual([]);
    const human = JSON.parse((await read(`?view=workflow&conversation_id=${encodeURIComponent(f.assignment.id + ":human_review")}`)).text);
    expect(human.native_snapshots.map((snapshot: any) => snapshot.id)).toEqual([`${f.human.id}-history`]);
    expect(human.messages.map((message: any) => message.content)).toEqual(["Human Review owned reply"]);
    expect(human.snapshots.map((entry: any) => entry.id)).toEqual(["active-human-diff", "earlier-human-diff"]);
    expect(human.snapshots[0].files[0].diff).toBe(snapshot.files[0]!.diff);
    expect(human.snapshots[1]).toMatchObject({ head: "earlier", files: [] });
    expect(human.comments[0].context).toBe("+Original anchor");
    expect((await read("?view=workflow&conversation_id=another-assignment%3Aspecifications")).status).toBe(404);
    expect(Buffer.byteLength(selected.text)).toBeLessThan(Buffer.byteLength(human.native_snapshots[0].turns[0].parts[0].text) * 0.05);
  } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
});
