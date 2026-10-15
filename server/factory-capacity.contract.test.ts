import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 6_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (ready(value)) return value; await Bun.sleep(30); }
  throw new Error("Expected public factory state did not arrive");
}

describe("global factory capacity through authenticated HTTP", () => {
  it("automatically dispatches durable requests oldest first after capacity is released", async () => {
    const f = await capacityFixture();
    const start = (id: string) => f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "queued-start" });
    const waitForRun = async (id: string) => {
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        const detail = await f.api(`/implementations/${id}`).then(r => r.json());
        if (detail.runs[0]?.condition === "working") return detail.runs[0];
        await Bun.sleep(30);
      }
      throw new Error("Queued request did not start automatically");
    };
    try {
      await f.api("/settings", { max_agents: 1 });
      const holder = await f.assignment("Holder"); const oldest = await f.assignment("Oldest", "claude", "owned-b"); const newest = await f.assignment("Newest", "opencode", "owned-c");
      const running = await start(holder).then(r => r.json());
      const queued = await start(oldest); expect(queued.status).toBe(202);
      expect(await queued.json()).toMatchObject({ implementation_id: oldest, condition: "queued", purpose: "execution" });
      await start(newest);
      const before = await f.api("").then(r => r.json());
      f.restart();
      await f.api(`/runs/${running.id}/stop`, {});
      const first = await waitForRun(oldest);
      expect((await f.api(`/implementations/${newest}`).then(r => r.json())).runs).toEqual([]);
      const waiting = (await f.api("").then(r => r.json())).capacity.waiting;
      expect(waiting).toEqual([expect.objectContaining({ implementation_id: newest, created_at: before.capacity.waiting[1].created_at })]);
      await f.api(`/runs/${first.id}/stop`, {});
      await waitForRun(newest);
      expect(f.launches).toHaveLength(3);
    } finally { f.close(); }
  }, 15_000);
  it("orders child reviews with root requests and deduplicates concurrent starts", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Review parent");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "parent" }).then(r => r.json());
      const child = () => f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "oldest-child" });
      const requests = await Promise.all([child(), child()]);
      expect(requests.map(r => r.status)).toEqual([202, 202]);
      const waits = await Promise.all(requests.map(r => r.json())); expect(waits[0].id).toBe(waits[1].id);
      const next = await f.assignment("Later root", "claude", "owned-b");
      await f.api(`/implementations/${next}/runs`, { action: "work", idempotency_key: "later" });
      f.runs.get(run.id)!.condition = "ready";
      f.restart();
      const detail = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.workers[0]?.condition === "working");
      expect(detail.workers).toHaveLength(1);
      expect((await f.api(`/implementations/${next}`).then(r => r.json())).runs).toHaveLength(0);
      await f.api(`/runs/${run.id}/workers/${detail.workers[0].id}/stop`, {});
      await eventually(() => f.api(`/implementations/${next}`).then(r => r.json()), d => d.runs[0]?.condition === "working");
      expect(f.workerLaunches).toHaveLength(1);
    } finally { f.close(); }
  });
  it("skips a dependency-blocked Ticket while admitting eligible work without losing its age", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Dependent Tickets");
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      await f.api(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixture only" });
      const spec = await f.api(`/implementations/${id}/specifications`, { content: "First Ticket before second" }).then(r => r.json());
      for (const kind of ["specification", "testing_seams"]) await f.api(`/implementations/${id}/approvals`, { kind, revision: spec.id, scope: "Owned scope" });
      const graph = await f.api(`/implementations/${id}/tickets`, { specification_id: spec.id, tickets: [{ key: "first", title: "First", acceptance: "First completes", dependencies: [] }, { key: "second", title: "Second", acceptance: "Second waits", dependencies: ["first"] }] }).then(r => r.json());
      await f.api(`/implementations/${id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Owned dependencies" });
      const run = await f.api(`/implementations/${id}/runs`, { action: "implement-spec", idempotency_key: "parent" }).then(r => r.json());
      const child = (ticket: string) => f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: ticket, idempotency_key: ticket });
      const blocked = await child(graph.tickets[1].id); expect(blocked.status).toBe(202);
      const wait = await blocked.json(); expect(wait.reason).toContain("Ticket");
      f.runs.get(run.id)!.condition = "ready";
      await child(graph.tickets[0].id);
      const first = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.workers.some((w: { ticket_id: string }) => w.ticket_id === graph.tickets[0].id));
      expect(first.workers).toHaveLength(1);
      expect((await f.api("").then(r => r.json())).capacity.waiting[0]).toMatchObject({ id: wait.id, created_at: wait.created_at, condition: "queued" });
    } finally { f.close(); }
  });
  it("recovers a disconnected queued request after restart without resetting its age", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Reconnect wait");
      f.offline(true);
      const response = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "offline" });
      expect(response.status).toBe(202); const wait = await response.json();
      expect(wait).toMatchObject({ condition: "queued", implementation_id: id });
      f.restart();
      expect((await f.api("").then(r => r.json())).capacity.waiting[0].created_at).toBe(wait.created_at);
      f.offline(false);
      await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.runs[0]?.condition === "working");
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });
  it("bounds failed reconnect recovery and exposes the remaining required action", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Unavailable Machine"); f.offline(true);
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "unavailable" });
      const state = await eventually(() => f.api("").then(r => r.json()), o => o.capacity.waiting[0]?.condition === "blocked", 45_000);
      expect(state.capacity.waiting[0].reason).toContain("6 attempts");
      expect(state.capacity.waiting[0].reason).toContain("Inspect");
      expect(f.launches).toHaveLength(0);
    } finally { f.close(); }
  }, 60_000);
  it("queues the owner-facing planning control without requiring another Continue", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const a = await f.assignment("Normal work"); const b = await f.assignment("Planning allowance"); const c = await f.assignment("Queued planning control");
      const normal = await f.api(`/implementations/${a}/runs`, { action: "work", idempotency_key: "normal" }).then(r => r.json());
      await f.api(`/implementations/${b}/runs`, { action: "grill-with-docs", idempotency_key: "planning" });
      const body = { action: "grill-with-docs", run_id: null, idempotency_key: "continued-planning" };
      const queued = await f.api(`/implementations/${c}/continue`, body); expect(queued.status).toBe(202);
      expect((await queued.json()).condition).toBe("queued");
      f.restart(); await f.api(`/runs/${normal.id}/stop`, {});
      const detail = await eventually(() => f.api(`/implementations/${c}`).then(r => r.json()), d => d.runs[0]?.condition === "working");
      expect((await f.api(`/implementations/${c}/continue`, body).then(r => r.json())).id).toBe(detail.runs[0].id);
      expect(f.launches).toHaveLength(3);
    } finally { f.close(); }
  });
  it("reconciles an uncertain child without pane metadata before admitting another request", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Unknown child parent");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "parent" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      f.loseNextWorker();
      const child = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "lost-child" }).then(r => r.json());
      expect(child.condition).toBe("disconnected");
      const next = await f.assignment("After child");
      await f.api(`/implementations/${next}/runs`, { action: "work", idempotency_key: "after-child" });
      expect(f.launches).toHaveLength(1);
      // The owned Machine confirms termination; no launch is replayed.
      f.workers.get(child.id)!.condition = "cancelled"; f.restart();
      await eventually(() => f.api(`/implementations/${next}`).then(r => r.json()), d => d.runs[0]?.condition === "working");
      expect(f.workerLaunches).toHaveLength(1);
      expect(f.launches).toHaveLength(2);
    } finally { f.close(); }
  });
  it("replaces an unresolved request when the owner explicitly starts its corrected scope", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Corrected request");
      const bad = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "stale", expected: {} });
      expect(bad.status).toBe(409);
      expect((await f.api("").then(r => r.json())).capacity.waiting[0].condition).toBe("blocked");
      const corrected = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "corrected" });
      expect((await corrected.json()).condition).toBe("working");
      expect((await f.api("").then(r => r.json())).capacity.waiting).toEqual([]);
    } finally { f.close(); }
  });
  it("admits one shared extra planning context across Projects, providers and Machines", async () => {
    const f = await capacityFixture();
    const start = (id: string, action: string) => f.api(`/implementations/${id}/runs`, { action, idempotency_key: "start" });
    try {
      await f.api("/settings", { max_agents: 1, max_builds: 1 });
      const a = await f.assignment("Implementation", "codex", "owned-a");
      const b = await f.assignment("Interview", "claude", "owned-b");
      const c = await f.assignment("Specification", "opencode", "owned-c");
      const work = await start(a, "work"); expect(work.status).toBe(202);
      const run = await work.json();
      const planning = await start(b, "grill-with-docs"); expect(planning.status).toBe(202);
      expect((await planning.json()).capacity_pool).toBe("planning");
      const full = await start(c, "to-spec"); expect(full.status).toBe(202);
      expect(await full.json()).toMatchObject({ condition: "queued", reason: expect.stringContaining("1/1") });
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "review" });
      expect(reviewer.status).toBe(202);
      const overview = await f.api("").then(r => r.json());
      expect(overview.capacity).toMatchObject({ normal: { limit: 1, used: 1 }, planning: { limit: 1, used: 1 }, builds: { limit: 1, used: 0 } });
      expect(overview.capacity.contexts).toHaveLength(2);
      expect(overview.capacity.contexts).toEqual(expect.arrayContaining([
        expect.objectContaining({ assignment_title: "Implementation", machine_id: "owned-a", provider: "codex", pool: "normal", uncertain: false }),
        expect.objectContaining({ assignment_title: "Interview", machine_id: "owned-b", provider: "claude", pool: "planning", uncertain: false }),
      ]));
      // Viewing and approval are owner controls, not executing contexts.
      const specification = await f.api(`/implementations/${c}/specifications`, { content: "Owned capacity acceptance" }).then(r => r.json());
      expect((await f.api(`/implementations/${c}/approvals`, { kind: "specification", revision: specification.id, scope: "Owned approval" })).status).toBe(201);
    } finally { f.close(); }
  });
  it("keeps lost launch acknowledgments reserved across restart and concurrent planning starts", async () => {
    const f = await capacityFixture();
    const start = (id: string, action = "grill-with-docs") => f.api(`/implementations/${id}/runs`, { action, idempotency_key: "start" });
    try {
      await f.api("/settings", { max_agents: 1 });
      const normalId = await f.assignment("Unknown normal");
      f.loseNextLaunch(); f.uncertain(true);
      const unknown = await start(normalId, "work").then(r => r.json());
      expect(unknown.condition).toBe("disconnected");
      f.restart();
      let capacity = await f.api("").then(r => r.json()).then(o => o.capacity);
      expect(capacity.contexts).toEqual([expect.objectContaining({ id: unknown.id, pool: "normal", uncertain: true })]);
      const a = await f.assignment("Planning A", "claude", "owned-b");
      const b = await f.assignment("Planning B", "opencode", "owned-c");
      f.loseNextLaunch();
      const starts = await Promise.all([start(a), start(b)]);
      expect(starts.map(r => r.status)).toEqual([202, 202]);
      const results = await Promise.all(starts.map(r => r.json()));
      const extra = results.find(r => r.condition === "disconnected");
      expect(extra).toMatchObject({ capacity_pool: "planning", condition: "disconnected" });
      f.restart();
      capacity = await f.api("").then(r => r.json()).then(o => o.capacity);
      expect(capacity).toMatchObject({ normal: { used: 1 }, planning: { used: 1 } });
      expect(capacity.contexts.every((context: { uncertain: boolean }) => context.uncertain)).toBe(true);
      // Only an observed stop releases the uncertain extra reservation.
      expect((await f.api(`/runs/${extra.id}/stop`, {})).status).toBe(200);
      const waitingId = extra.implementation_id === a ? b : a;
      expect((await start(waitingId)).status).toBe(202);
    } finally { f.close(); }
  });

  it("explains the independent build limit and preserves uncertain builds across restart", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1, max_builds: 1 });
      const id = await f.assignment("Uncertain build");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "start" }).then(r => r.json());
      f.loseNextCheck();
      const check = await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json());
      expect(check.condition).toBe("interrupted");
      f.restart();
      const full = await f.api(`/runs/${run.id}/checks`, {});
      expect(full.status).toBe(409);
      expect((await full.json()).error).toMatchObject({ code: "build_capacity_exhausted", message: expect.stringContaining("1/1") });
      const capacity = await f.api("").then(r => r.json()).then(o => o.capacity);
      expect(capacity).toMatchObject({ normal: { used: 1 }, builds: { limit: 1, used: 1 } });
      expect(capacity.build_reservations).toEqual([expect.objectContaining({ id: check.id, assignment_title: "Uncertain build", machine_id: "owned-a", uncertain: true })]);
    } finally { f.close(); }
  });

  it("retains a further planning request as a visible capacity wait until admitted", async () => {
    const f = await capacityFixture();
    const start = (id: string) => f.api(`/implementations/${id}/runs`, { action: "grill-with-docs", idempotency_key: "retained-wait" });
    try {
      await f.api("/settings", { max_agents: 1 });
      const a = await f.assignment("Normal interview"); const b = await f.assignment("Extra interview"); const c = await f.assignment("Waiting interview");
      const normal = await start(a).then(r => r.json()); await start(b);
      expect((await start(c)).status).toBe(202);
      const first = await f.api("").then(r => r.json());
      expect(first.capacity.waiting).toEqual([expect.objectContaining({ implementation_id: c, assignment_title: "Waiting interview", action: "grill-with-docs", idempotency_key: "retained-wait", reason: expect.stringContaining("1/1") })]);
      f.restart(); expect((await start(c)).status).toBe(202);
      const retained = await f.api("").then(r => r.json());
      expect(retained.capacity.waiting[0].id).toBe(first.capacity.waiting[0].id);
      expect(retained.capacity.waiting[0].created_at).toBe(first.capacity.waiting[0].created_at);
      await f.api(`/runs/${normal.id}/stop`, {});
      expect((await start(c)).status).toBe(202);
      expect((await f.api("").then(r => r.json())).capacity.waiting).toEqual([]);
    } finally { f.close(); }
  });

  it("reacquires normal capacity before sending answered context to a resting implementation", async () => {
    const f = await capacityFixture();
    const start = (id: string) => f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "start" }).then(r => r.json());
    try {
      await f.api("/settings", { max_agents: 1 });
      const a = await f.assignment("Resting implementation"); const b = await f.assignment("Occupied implementation");
      const resting = await start(a);
      const question = await f.api(`/implementations/${a}/questions`, { run_id: resting.id, question: "Which fixture behavior?" }).then(r => r.json());
      await f.api(`/implementations/${a}/questions/${question.id}/answer`, { revision: question.revision, answer: "Only the accepted capacity behavior" });
      f.runs.get(resting.id)!.condition = "ready";
      await f.api(`/runs/${resting.id}/reconcile`, {});
      const occupied = await start(b);
      const detail = await f.api(`/implementations/${a}`).then(r => r.json());
      const send = (key: string) => f.api(`/runs/${resting.id}/send-answers`, { revision: detail.question_revision, idempotency_key: key }).then(r => r.json());
      expect((await send("at-capacity")).condition).toBe("blocked");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      await f.api(`/runs/${occupied.id}/stop`, {});
      expect((await send("after-release")).condition).toBe("sent");
      expect((await f.api("").then(r => r.json())).capacity.contexts).toEqual([expect.objectContaining({ id: resting.id, pool: "normal", uncertain: false })]);
    } finally { f.close(); }
  });

  it("keeps the app's planning reservation when a resting interview resumes into the allowance", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const a = await f.assignment("Resuming interview"); const b = await f.assignment("Normal work");
      const interview = await f.api(`/implementations/${a}/runs`, { action: "grill-with-docs", idempotency_key: "interview" }).then(r => r.json());
      f.runs.get(interview.id)!.condition = "ready"; await f.api(`/runs/${interview.id}/reconcile`, {});
      const work = await f.api(`/implementations/${b}/runs`, { action: "work", idempotency_key: "work" }).then(r => r.json());
      const worker = await f.api(`/runs/${work.id}/workers`, { role: "standards", idempotency_key: "review" });
      expect(worker.status).toBe(202); // Review queues instead of using the planning allowance.
      const detail = await f.api(`/implementations/${a}`).then(r => r.json());
      expect((await f.api(`/runs/${interview.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "resume" }).then(r => r.json())).condition).toBe("sent");
      // The Machine echoes its original normal reservation. Capacity belongs to the app.
      const reconciled = await f.api(`/runs/${interview.id}/reconcile`, {}).then(r => r.json());
      expect(reconciled).toMatchObject({ condition: "working", capacity_pool: "planning" });
      expect((await f.api("").then(r => r.json())).capacity).toMatchObject({ normal: { used: 1 }, planning: { used: 1 } });
    } finally { f.close(); }
  });

});
