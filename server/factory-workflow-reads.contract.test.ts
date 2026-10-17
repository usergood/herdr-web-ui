import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { FactoryStore } from "./factory-store.ts";
import { seedWorkflowConversations } from "../scripts/fixtures/workflow-conversations.ts";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

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
    const navigation = await (await fetch(`http://localhost:${app.port}/api/factory?navigation=1`, { headers: { authorization: "Bearer owned-workflow-read" } })).json() as any;
    expect(navigation.conversations).toEqual(current.conversations.map((conversation: any) => ({ ...conversation, contexts: conversation.contexts.map(({ run_id, worker_id }: any) => ({ run_id, worker_id })) })));
    const workerContext = navigation.conversations.find((conversation: any) => conversation.kind === "implementation").contexts[0];
    expect(workerContext.worker_id).toBe(f.implementation.id);
    expect(navigation.pane_links.find((link: any) => link.worker_id === workerContext.worker_id)).toMatchObject({ run_id: workerContext.run_id, pane_id: f.implementation.pane_id, workspace_id: f.implementation.workspace_id, worktree: f.implementation.worktree });
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


test("capacity-queued Start appears in the same board lane across compact and full reads and dispatches by request age", async () => {
  const f = await capacityFixture();
  const read = (path = "") => f.api(path).then(response => response.json());
  const start = (id: string, key: string) => f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: key });
  const boardFor = (overview: any, id: string) => overview.board.find((item: any) => item.implementation_id === id);
  try {
    await f.api("/settings", { max_agents: 1 });
    const createdFirst = await f.assignment("Created first but queued second");
    const queuedFirst = await f.assignment("Created second but queued first");
    const inbox = await f.assignment("Untouched Inbox");
    const holder = await f.assignment("Owned slot holder");
    const running = await (await start(holder, "holder")).json();
    const first = await start(queuedFirst, "first-request");
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ condition: "queued", implementation_id: queuedFirst });
    expect((await start(createdFirst, "second-request")).status).toBe(202);
    for (const path of ["", "?navigation=1"]) {
      const overview = await read(path);
      expect(boardFor(overview, queuedFirst)).toMatchObject({ lane: "queued", busy: false, activity: null });
      expect(boardFor(overview, createdFirst)).toMatchObject({ lane: "queued", busy: false, activity: null });
      expect(boardFor(overview, holder).lane).toBe("running");
      expect(boardFor(overview, inbox).lane).toBe("inbox");
      expect(overview.progress.find((item: any) => item.implementation_id === queuedFirst)).toMatchObject({ lane: "queued", activities: [] });
      expect(overview.implementations.filter((idea: any) => [createdFirst, queuedFirst].includes(idea.id)).map((idea: any) => idea.id)).toEqual([queuedFirst, createdFirst]);
    }
    const full = await read(`/implementations/${queuedFirst}`);
    const current = await read(`/implementations/${queuedFirst}?view=current`);
    expect(full.board).toMatchObject({ lane: "queued", busy: false, activity: null });
    expect(current.board).toEqual(full.board);
    expect(current.board).toEqual(boardFor(await read(), queuedFirst));
    f.restart();
    expect(boardFor(await read("?navigation=1"), queuedFirst).lane).toBe("queued");
    await f.api(`/runs/${running.id}/stop`, {});
    const deadline = Date.now() + 6_000;
    let resumed: any;
    while (Date.now() < deadline) {
      resumed = await read(`/implementations/${queuedFirst}?view=current`);
      if (resumed.runs[0]?.condition === "working") break;
      await Bun.sleep(30);
    }
    expect(resumed.runs[0]?.condition).toBe("working");
    expect(resumed.board.lane).toBe("running");
    const after = await read("?navigation=1");
    expect(boardFor(after, queuedFirst).lane).toBe("running");
    expect(boardFor(after, createdFirst).lane).toBe("queued");
    expect(after.capacity.waiting.map((wait: any) => wait.implementation_id)).toEqual([createdFirst]);
  } finally { f.close(); }
});


test("an exhausted current capacity request needs attention without overriding fresh running work", async () => {
  const f = await capacityFixture();
  const read = (path = "") => f.api(path).then(response => response.json());
  const boardFor = (overview: any, id: string) => overview.board.find((item: any) => item.implementation_id === id);
  try {
    await f.api("/settings", { max_agents: 1 });
    const holder = await f.assignment("Capacity holder");
    await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" });
    const id = await f.assignment("Changed pending scope");
    expect((await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "old-work" })).status).toBe(202);
    const projectId = (await read(`/implementations/${id}?view=current`)).implementation.project_id;
    await f.api(`/projects/${projectId}/configure`, { permissions: "Changed Project scope requires a new Start request" });
    const deadline = Date.now() + 6_000;
    let blocked: any;
    while (Date.now() < deadline) {
      blocked = (await read()).capacity.waiting.find((wait: any) => wait.implementation_id === id);
      if (blocked?.condition === "blocked") break;
      await Bun.sleep(30);
    }
    expect(blocked).toMatchObject({ condition: "blocked", reason: expect.stringContaining("scope changed") });
    for (const path of ["", "?navigation=1"]) expect(boardFor(await read(path), id)).toMatchObject({ lane: "needs_you", busy: false, waiting_reason: blocked.reason });
    expect((await read(`/implementations/${id}?view=current`)).board).toEqual((await read(`/implementations/${id}`)).board);
    expect((await read(`/implementations/${id}?view=current`)).board.lane).toBe("needs_you");
    const planning = await f.api(`/implementations/${id}/runs`, { action: "grill-with-docs", idempotency_key: "fresh-planning" });
    expect(planning.status).toBe(202);
    expect((await planning.json()).condition).toBe("working");
    expect((await read()).capacity.waiting).toEqual([expect.objectContaining({ id: blocked.id, condition: "blocked" })]);
    for (const path of ["", "?navigation=1"]) expect(boardFor(await read(path), id)).toMatchObject({ lane: "running", busy: true });
    expect((await read(`/implementations/${id}?view=current`)).board.lane).toBe("running");
  } finally { f.close(); }
});


test("historical child waits and finished work retain their board lanes", async () => {
  const state = mkdtempSync(join(tmpdir(), "factory-board-history-"));
  const store = new FactoryStore(state);
  for (const id of ["history", "finished"]) {
    store.put("implementations", { ...store.record(), id, title: id, description: "Owned historic projection", project_id: null, provider: "codex", machine_id: "local", stage: id === "finished" ? "done" : "inbox", position: 0, outcome: id === "finished" ? "research_accepted" : "none" });
    for (const suffix of ["old", "current"]) store.put("runs", { ...store.record(), id: `${id}-${suffix}`, implementation_id: id, action: "work", provider: "codex", machine_id: "local", condition: "completed", waiting_reason: null, idempotency_key: suffix, specification_id: null, graph_hash: null, base: null, checkout: null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: {} }, id);
    store.put("capacity_waits", { ...store.record(), id: `${id}-old-wait`, implementation_id: id, assignment_title: id, action: "work", provider: "codex", machine_id: "local", idempotency_key: "old-child", condition: "blocked", purpose: "execution", run_id: `${id}-old`, reason: "Historical worker admission failed" }, id);
  }
  store.close();
  const app = createServer({ port: 0, stateDir: state, token: "owned-board-history", machines: false, factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
  const read = async (path: string) => (await fetch(`http://localhost:${app.port}/api/factory${path}`, { headers: { authorization: "Bearer owned-board-history" } })).json() as Promise<any>;
  try {
    for (const path of ["", "?navigation=1"]) {
      const overview = await read(path);
      expect(overview.board.find((item: any) => item.implementation_id === "history")).toMatchObject({ lane: "inbox", waiting_reason: null });
      expect(overview.board.find((item: any) => item.implementation_id === "finished")).toMatchObject({ lane: "done", sidebar_hidden: true, waiting_reason: null });
    }
    for (const id of ["history", "finished"]) {
      const full = await read(`/implementations/${id}`);
      const current = await read(`/implementations/${id}?view=current`);
      expect(current.board).toEqual(full.board);
      expect(current.board.lane).toBe(id === "finished" ? "done" : "inbox");
      expect(current.capacity_waiting[0].condition).toBe("blocked");
    }
  } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
});


test("compact failed-check reasons retain command arguments and exit codes without output bodies", async () => {
  const state = mkdtempSync(join(tmpdir(), "factory-check-summary-"));
  const f = seedWorkflowConversations(state);
  const store = new FactoryStore(state);
  const output = "Owned large check output".repeat(50_000);
  store.put("checks", { ...store.record(), id: "owned-failed-check", run_id: f.human.id, worker_id: null, head: "owned-head", workspace_hash: "owned-hash", condition: "failed", commands: [{ args: ["bun", "test", "--passed"], exit_code: 0, output }, { args: ["bun", "test", "--owned-fixture"], exit_code: 7, output }] }, f.human.id);
  store.close();
  const app = createServer({ port: 0, stateDir: state, token: "owned-check-summary", machines: false, factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
  const read = async (path: string) => {
    const response = await fetch(`http://localhost:${app.port}/api/factory${path}`, { headers: { authorization: "Bearer owned-check-summary" } });
    const text = await response.text(); return { text, body: JSON.parse(text) };
  };
  try {
    for (const path of ["", "?navigation=1"]) {
      const overview = await read(path);
      expect(overview.body.progress.find((item: any) => item.implementation_id === f.assignment.id).reasons).toContain("Checks failed: bun test --owned-fixture (exit 7)");
      expect(overview.text).not.toContain("Owned large check output");
      expect(overview.text).not.toContain("--passed");
      expect(Buffer.byteLength(overview.text)).toBeLessThan(25_000);
    }
    const current = await read(`/implementations/${f.assignment.id}?view=current`);
    expect(current.body.checks[0]).not.toHaveProperty("commands");
    expect(current.text).not.toContain("Owned large check output");
    const full = await read(`/implementations/${f.assignment.id}`);
    expect(full.body.checks[0].commands[1].output).toBe(output);
  } finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
});


test("held native checks stay working through public reconciliation and preserve Pause cancellation", async () => {
  const f = await capacityFixture();
  let gate = f.holdNextCheck(); let pending: Promise<Response> | undefined;
  const detail = (id: string) => f.api(`/implementations/${id}?view=current`).then(r => r.json());
  try {
    const id = await f.assignment("Observed held check");
    const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "held-check" }).then(r => r.json());
    pending = f.api(`/runs/${run.id}/checks`, {}); await gate.started;
    const check = (await detail(id)).checks.at(-1);
    const observed = await f.api(`/runs/${run.id}/checks/${check.id}/reconcile`, {}).then(r => r.json());
    expect(observed.condition).toBe("working");
    expect((await f.api("?navigation=1").then(r => r.json())).progress.find((item: any) => item.implementation_id === id).activities).toContain("testing");
    gate.release(); expect((await (await pending).json()).condition).toBe("passed");
    gate = f.holdNextCheck(); f.failNextCheck();
    pending = f.api(`/runs/${run.id}/checks`, {}); await gate.started;
    const failure = (await detail(id)).checks.at(-1);
    expect((await f.api(`/runs/${run.id}/checks/${failure.id}/reconcile`, {}).then(r => r.json())).condition).toBe("working");
    gate.release(); expect((await (await pending).json()).condition).toBe("failed");
    gate = f.holdNextCheck(); pending = f.api(`/runs/${run.id}/checks`, {}); await gate.started;
    const cancelled = (await detail(id)).checks.at(-1);
    const pause = await f.api(`/implementations/${id}/pause`, {}).then(r => r.json());
    expect(pause.pause.condition).toBe("paused");
    await pending;
    expect((await detail(id)).checks.find((check: any) => check.id === cancelled.id)).toMatchObject({ condition: "cancelled", pause_id: pause.pause.id });
  } finally { gate.release(); await pending; f.close(); }
});
