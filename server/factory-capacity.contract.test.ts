import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

describe("global factory capacity through authenticated HTTP", () => {
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
      const full = await start(c, "to-spec"); expect(full.status).toBe(409);
      expect((await full.json()).error).toMatchObject({ code: "capacity_exhausted", message: expect.stringContaining("1/1") });
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "review" });
      expect(reviewer.status).toBe(409);
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
      f.loseNextLaunch();
      const unknown = await start(normalId, "work").then(r => r.json());
      expect(unknown.condition).toBe("disconnected");
      f.restart();
      let capacity = await f.api("").then(r => r.json()).then(o => o.capacity);
      expect(capacity.contexts).toEqual([expect.objectContaining({ id: unknown.id, pool: "normal", uncertain: true })]);
      const a = await f.assignment("Planning A", "claude", "owned-b");
      const b = await f.assignment("Planning B", "opencode", "owned-c");
      f.loseNextLaunch();
      const starts = await Promise.all([start(a), start(b)]);
      expect(starts.map(r => r.status).sort()).toEqual([202, 409]);
      const extra = await starts.find(r => r.status === 202)!.json();
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
      expect((await start(c)).status).toBe(409);
      const first = await f.api("").then(r => r.json());
      expect(first.capacity.waiting).toEqual([expect.objectContaining({ implementation_id: c, assignment_title: "Waiting interview", action: "grill-with-docs", idempotency_key: "retained-wait", reason: expect.stringContaining("1/1") })]);
      f.restart(); expect((await start(c)).status).toBe(409);
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
      expect(worker.status).toBe(409); // Review cannot use the still-free planning allowance.
      const detail = await f.api(`/implementations/${a}`).then(r => r.json());
      expect((await f.api(`/runs/${interview.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "resume" }).then(r => r.json())).condition).toBe("sent");
      // The Machine echoes its original normal reservation. Capacity belongs to the app.
      const reconciled = await f.api(`/runs/${interview.id}/reconcile`, {}).then(r => r.json());
      expect(reconciled).toMatchObject({ condition: "working", capacity_pool: "planning" });
      expect((await f.api("").then(r => r.json())).capacity).toMatchObject({ normal: { used: 1 }, planning: { used: 1 } });
    } finally { f.close(); }
  });

});
