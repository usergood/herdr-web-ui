import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Automatic execution did not progress: ${JSON.stringify(value, (key, entry) => ["manifest", "events", "execution_plans"].includes(key) ? undefined : entry)}`);
    await Bun.sleep(20);
  }
}

async function acceptedPlan(f: Awaited<ReturnType<typeof capacityFixture>>, cap = 1, concurrent = false) {
  await f.api("/settings", { max_agents: cap });
  const id = await f.assignment("Automatic Ticket execution");
  const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
  await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only" });
  const specification = await f.api(`/implementations/${id}/specifications`, { content: "Implement the accepted dependency chain" }).then(r => r.json());
  await f.api(`/implementations/${id}/specification-acceptance`, { source: "button", specification_id: specification.id, hash: specification.hash });
  const run = (await until(detail, d => d.runs.length === 1)).runs[0];
  const response = await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Public HTTP and desktop/mobile browser validation", tickets: [
    { key: "first", title: "First accepted Ticket", acceptance: "The public behavior exists", dependencies: [] },
    { key: "next", title: "Dependent accepted Ticket", acceptance: "Uses the integrated first result", dependencies: concurrent ? [] : ["first"] },
  ] });
  expect(response.status).toBe(201);
  return { id, detail, run, plan: await response.json() };
}

describe("Automatic Ticket execution through authenticated HTTP", () => {
  it("dispatches the accepted frontier and checks and integrates a dependency chain at cap one without owner continuation", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run, plan } = await acceptedPlan(f);
      expect((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition).toBe("passed");
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.some((w: any) => w.condition === "working"));
      expect(started.workers.map((w: any) => w.ticket_id)).toEqual([plan.tickets[0].id]);
      expect(started.runs[0].continuation.condition).toBe("parked");
      f.workers.get(started.workers[0].id)!.condition = "ready";
      const next = await until(detail, d => d.workers.some((w: any) => w.ticket_id === plan.tickets[1].id && w.condition === "working"));
      expect(next.workers[0].condition).toBe("completed");
      f.workers.get(next.workers[1].id)!.condition = "ready";
      const checked = await until(detail, d => d.automatic_execution?.[0]?.condition === "checked");
      expect(checked.tickets.map((t: any) => t.status)).toEqual(["done", "done"]);
      expect(checked.checks.map((c: any) => c.condition)).toEqual(["passed", "passed", "passed", "passed"]);
      expect(checked.implementation.stage).toBe("review");
      expect(checked.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
      expect(f.workerLaunches).toHaveLength(2);
      expect(f.prompts).toHaveLength(0);
      f.restart();
      const retained = await detail();
      expect(retained.automatic_execution[0].condition).toBe("checked");
      expect(retained.workers.map((w: any) => w.id)).toEqual(checked.workers.map((w: any) => w.id));
    } finally { f.close(); }
  });
  it("recovers concurrent accepted workers, checks and integration after lost replies and restart without repeating Tickets", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run } = await acceptedPlan(f, 3, true);
      f.loseNextWorker();
      const running = await until(detail, d => d.workers.length === 2 && d.workers[1].condition === "working");
      expect(new Set(running.workers.map((w: any) => w.id)).size).toBe(2);
      f.restart();
      f.runs.get(run.id)!.condition = "ready";
      f.loseNextCheck();
      f.loseNextIntegration();
      for (const worker of running.workers) f.workers.get(worker.id)!.condition = "ready";
      const done = await until(detail, d => d.automatic_execution?.[0]?.condition === "checked");
      expect(done.workers.map((w: any) => w.condition)).toEqual(["completed", "completed"]);
      expect(done.checks.map((c: any) => c.condition)).toEqual(["passed", "passed", "passed"]);
      expect(f.workerLaunches).toHaveLength(2);
      expect(f.executedChecks).toHaveLength(3);
      expect(done.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(2);
    } finally { f.close(); }
  });

  it("surfaces a native permission gate without completing an idle or blocked Ticket", async () => {
    const f = await capacityFixture();
    try {
      const { detail, run } = await acceptedPlan(f);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      const worker = f.workers.get(started.workers[0].id)!;
      worker.condition = "needs_you"; worker.waiting_reason = "Owned native permission required";
      const waiting = await until(detail, d => d.automatic_execution?.[0]?.reason === "Owned native permission required");
      expect(waiting.checks).toEqual([]);
      expect(waiting.workers[0].condition).toBe("needs_you");
      expect(waiting.tickets.map((t: any) => t.status)).toEqual(["proposed", "proposed"]);
      worker.condition = "ready"; worker.waiting_reason = null;
      await until(detail, d => d.workers.some((w: any) => w.ticket_id !== worker.ticket_id));
      expect(f.workerLaunches).toHaveLength(2);
    } finally { f.close(); }
  });

  it("retains scope questions and exact worker answer receipts as integration gates", async () => {
    const f = await capacityFixture();
    try {
      const { id, detail, run } = await acceptedPlan(f, 3);
      const question = await f.agent(run.id, "question", { question: "Which accepted behavior should the Ticket retain?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const waiting = await until(detail, d => d.automatic_execution?.[0]?.condition === "waiting");
      expect(waiting.workers).toEqual([]);
      await f.api(`/implementations/${id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Retain the frozen Specification" });
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.workers.get(started.workers[0].id)!.condition = "ready";
      await until(detail, d => d.automatic_execution?.[0]?.reason?.includes("exact answered context"));
      expect((await detail()).checks).toEqual([]);
      const context = await f.agent(run.id, "contract").then(r => r.json());
      expect((await f.agent(run.id, "consume", { revision: context.question_revision, worker_id: started.workers[0].id })).status).toBe(200);
      const done = await until(detail, d => d.workers[0].condition === "completed");
      expect(done.questions[0].answer).toBe("Retain the frozen Specification");
    } finally { f.close(); }
  });

  it("waits for the separate build reservation and surfaces a failing check without integrating or retrying it", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextCheck();
    let held: Promise<Response> | undefined;
    try {
      await f.api("/settings", { max_builds: 1 });
      const holder = await f.assignment("Owned build holder");
      const holderRun = await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      held = f.api(`/runs/${holderRun.id}/checks`, {});
      await gate.started;
      const { detail, run } = await acceptedPlan(f, 3);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.workers.get(started.workers[0].id)!.condition = "ready";
      await until(detail, d => d.automatic_execution?.[0]?.reason?.includes("build capacity"));
      expect((await detail()).checks).toEqual([]);
      f.failNextCheck(); gate.release(); await held;
      const blocked = await until(detail, d => d.automatic_execution?.[0]?.condition === "blocked");
      expect(blocked.automatic_execution[0].reason).toContain("failed: bun test");
      expect(blocked.checks[0].condition).toBe("failed");
      expect(blocked.workers[0].condition).toBe("ready");
      f.restart();
      const retained = await detail();
      expect(retained.checks).toHaveLength(1);
      expect(retained.automatic_execution[0].condition).toBe("blocked");
      expect(f.workerLaunches).toHaveLength(1);
    } finally { gate.release(); await held; f.close(); }
  });

  it("names an integration conflict and retains the candidate and ownership for inspection", async () => {
    const f = await capacityFixture();
    try {
      const { detail, run } = await acceptedPlan(f);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.integrationConflict(true);
      f.workers.get(started.workers[0].id)!.condition = "ready";
      const blocked = await until(detail, d => d.automatic_execution?.[0]?.condition === "blocked");
      expect(blocked.automatic_execution[0].reason).toContain("integration conflict");
      expect(blocked.automatic_execution[0].reason).not.toContain("Unsafe remote diagnostic");
      expect(blocked.workers[0].worktree).toBe(started.workers[0].worktree);
      expect(blocked.checks).toEqual([]);
    } finally { f.close(); }
  });

  it("reconciles an accepted check across restart without launching a second build", async () => {
    const f = await capacityFixture(); const gate = f.holdNextCheck();
    try {
      const { detail, run } = await acceptedPlan(f);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.workers.get(started.workers[0].id)!.condition = "ready";
      await gate.started;
      f.restart(); gate.release();
      const next = await until(detail, d => d.workers[0].condition === "completed");
      expect(next.checks).toHaveLength(1);
      expect(next.checks[0].condition).toBe("passed");
      expect(f.executedChecks).toHaveLength(1);
      expect(next.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(1);
    } finally { gate.release(); f.close(); }
  });

  it("retains an uncertain writer and exposes bounded recovery exhaustion after six observations", async () => {
    const f = await capacityFixture();
    try {
      const { detail, run } = await acceptedPlan(f);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.offline(true);
      const blocked = await until(detail, d => d.automatic_execution?.[0]?.condition === "blocked", 40000);
      expect(blocked.automatic_execution[0]).toMatchObject({ attempts: 6, reason: expect.stringContaining("exhausted after six observations") });
      expect(blocked.workers[0].id).toBe(started.workers[0].id);
      expect(blocked.workers[0].condition).not.toBe("completed");
      expect(f.workerLaunches).toHaveLength(1);
      expect((await f.api("").then(r => r.json())).capacity.contexts).toEqual(expect.arrayContaining([expect.objectContaining({ worker_id: started.workers[0].id, uncertain: true })]));
    } finally { f.close(); }
  }, 45000);

  it("keeps completed Ticket progress while the Assignment is paused and automatically continues only unfinished work after Resume", async () => {
    const f = await capacityFixture();
    try {
      const { id, detail, run } = await acceptedPlan(f, 1);
      f.runs.get(run.id)!.condition = "ready";
      const first = await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working");
      f.workers.get(first.workers[0].id)!.condition = "ready";
      const second = await until(detail, d => d.workers.length === 2 && d.workers[1].condition === "working");
      expect(second.workers[0].condition).toBe("completed");
      expect((await f.api(`/implementations/${id}/pause`, {})).status).toBe(200);
      const deadline = Date.now() + 600;
      do {
        const paused = await detail();
        expect(paused.implementation.pause.condition).toBe("paused");
        expect(paused.automatic_execution[0].condition).not.toBe("blocked");
        expect(paused.checks).toHaveLength(1);
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      f.restart();
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      const resumed = await until(detail, d => !d.workers[1].suspension && d.workers[1].condition === "working");
      f.runs.get(run.id)!.condition = "ready";
      f.workers.get(resumed.workers[1].id)!.condition = "ready";
      const done = await until(detail, d => d.automatic_execution?.[0]?.condition === "checked");
      expect(done.workers.map((w: any) => w.id)).toEqual(second.workers.map((w: any) => w.id));
      expect(done.tickets.map((t: any) => t.status)).toEqual(["done", "done"]);
      expect(f.workerLaunches).toHaveLength(2);
    } finally { f.close(); }
  });

});


for (const scope of ["worker", "integration"] as const) it(`Resume reruns the unchanged ${scope} check cancelled by Pause without repeating completed Tickets`, async () => {
  const f = await capacityFixture({ advancingHeads: true });
  const gate = f.holdNextCheck(scope);
  try {
    const { id, detail, run } = await acceptedPlan(f, 3);
    f.runs.get(run.id)!.condition = "ready";
    const first = await until(detail, d => d.workers.some((w: any) => w.role === "implementer" && w.condition === "working"));
    f.workers.get(first.workers[0].id)!.condition = "ready";
    if (scope === "integration") {
      const second = await until(detail, d => d.workers.filter((w: any) => w.role === "implementer").length === 2);
      f.workers.get(second.workers[1].id)!.condition = "ready";
    }
    await gate.started;
    const before = await detail();
    const stoppedId = before.checks.at(-1).id;
    expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
    const paused = await until(detail, d => d.checks.find((c: any) => c.id === stoppedId)?.condition === "cancelled");
    const cancelled = paused.checks.find((c: any) => c.id === stoppedId);
    expect(cancelled.pause_id).toBe(paused.implementation.pause.id);
    f.restart();
    await f.api(`/implementations/${id}/resume`, {});
    await until(detail, d => !d.runs[0].suspension && d.workers.every((w: any) => !w.suspension));
    f.runs.get(run.id)!.condition = "ready";
    for (const worker of f.workers.values()) if (worker.run_id === run.id && worker.condition === "working") worker.condition = "ready";
    if (scope === "worker") {
      const second = await until(detail, d => d.workers.filter((w: any) => w.role === "implementer").length === 2);
      f.workers.get(second.workers[1].id)!.condition = "ready";
    }
    const done = await until(detail, d => d.automatic_execution?.[0]?.condition === "checked");
    expect(done.tickets.map((t: any) => t.status)).toEqual(["done", "done"]);
    expect(done.checks.filter((c: any) => c.worker_id === cancelled.worker_id).at(-1)).toMatchObject({ condition: "passed", head: cancelled.head, workspace_hash: cancelled.workspace_hash });
    expect(f.workerLaunches).toHaveLength(2);
    expect(done.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
  } finally { gate.release(); f.close(); }
}, 20000);
