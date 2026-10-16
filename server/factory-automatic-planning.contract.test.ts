import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { createServer } from "./index.ts";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Automatic planning did not progress: ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

describe("Automatic planning through authenticated HTTP", () => {
  it("retains acceptance while already Paused and automatically starts the same scope once after Resume and restart", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Paused before acceptance"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Preserve the accepted scope while Paused" }).then(r => r.json());
      expect((await f.api(`${prefix}/pause`, {})).status).toBe(200);
      const accept = () => f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      expect((await accept()).status).toBe(201);
      f.restart();
      const deadline = Date.now() + 700;
      do {
        const current = await detail();
        expect(current.automatic_planning[0].condition).toBe("pending");
        expect(current.automatic_planning[0].attempts ?? 0).toBe(0);
        expect(current.runs).toHaveLength(0);
        expect(f.launches).toHaveLength(0);
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      const retained = (await detail()).automatic_planning[0];
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      f.restart();
      const started = await until(detail, d => d.runs.some((r: any) => r.action === "implement-spec" && r.condition === "working"));
      expect(started.runs).toHaveLength(1);
      expect(started.runs[0].manifest.specification).toMatchObject({ id: spec.id, hash: spec.hash });
      expect(started.automatic_planning[0]).toMatchObject({ id: retained.id, scope_hash: retained.scope_hash, specification_id: spec.id });
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      await accept(); f.restart();
      expect((await detail()).runs).toHaveLength(1);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });

  for (const phase of ["queued capacity", "Machine admission"] as const) it(`keeps accepted planning unfinished when Paused during ${phase} and admits once after restart and Resume`, async () => {
    const f = await capacityFixture(); let release: (() => void) | undefined;
    try {
      await f.api("/settings", { max_agents: 1 });
      const occupied = phase === "queued capacity" ? await f.assignment("Capacity holder") : null;
      const holder = occupied ? await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json()) : null;
      const id = await f.assignment(`Pause during ${phase}`); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Retain this scope through admission Pause" }).then(r => r.json());
      const gate = phase === "Machine admission" ? f.holdNextAdmission() : null; release = gate?.release;
      await f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      if (gate) await Promise.race([gate.started, Bun.sleep(4000).then(() => { throw new Error("Machine admission did not start"); })]);
      else await until(detail, d => d.automatic_planning[0]?.condition === "queued");
      const retained = (await detail()).automatic_planning[0];
      expect((await f.api(`${prefix}/pause`, {})).status).toBe(200);
      gate?.release(); release = undefined;
      if (holder) await f.api(`/runs/${holder.id}/stop`, {});
      const deadline = Date.now() + 700;
      do {
        const current = await detail();
        expect(["pending", "queued"]).toContain(current.automatic_planning[0].condition);
        expect(current.automatic_planning[0].attempts ?? 0).toBe(0);
        expect(current.runs).toHaveLength(0);
        expect(f.launches).toHaveLength(holder ? 1 : 0);
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      f.restart();
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      const started = await until(detail, d => d.runs.some((r: any) => r.action === "implement-spec" && r.condition === "working"));
      expect(started.runs).toHaveLength(1);
      expect(started.runs[0].manifest.specification).toMatchObject({ id: spec.id, hash: spec.hash });
      expect(started.automatic_planning[0]).toMatchObject({ id: retained.id, scope_hash: retained.scope_hash });
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      f.restart();
      expect((await detail()).runs).toHaveLength(1);
      expect(f.launches).toHaveLength(holder ? 2 : 1);
    } finally { release?.(); f.close(); }
  });

  it("starts one Orchestrator and exposes its bounded plan and frontier with Specification authority alone", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Automatic plan"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      const projectId = (await detail()).implementation.project_id;
      await f.api(`/projects/${projectId}/configure`, { checks: [["bun", "test"]], permissions: "Edit the owned workspace" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Build and validate the accepted result through public HTTP." }).then(r => r.json());
      const accept = () => f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      expect((await accept()).status).toBe(201);
      const started = await until(detail, d => d.runs.some((r: any) => r.action === "implement-spec"));
      const run = started.runs.find((r: any) => r.action === "implement-spec");
      const frozen = JSON.stringify(run.manifest);
      const plan = { specification_id: spec.id, testing_plan: "Exercise the public HTTP interface with disposable state.", tickets: [
        { key: "first", title: "Build the result", acceptance: "The public API returns the accepted result", dependencies: [] },
        { key: "second", title: "Validate the result", acceptance: "Public HTTP validation succeeds", dependencies: ["first"] },
      ] };
      const response = await f.agent(run.id, "tickets", plan);
      expect(response.status).toBe(201);
      const saved = await response.json();
      expect(saved.authority).toMatchObject({ kind: "specification", specification_id: spec.id, specification_hash: spec.hash, run_id: run.id });
      expect(saved.testing_plan).toBe(plan.testing_plan);
      const contract = await f.agent(run.id, "contract").then(r => r.json());
      expect(contract.execution_plan.hash).toBe(saved.hash);
      expect(contract.frontier.map((t: any) => t.title)).toEqual(["Build the result"]);
      expect(contract.execution_plan.tickets[1].dependencies).toEqual([saved.tickets[0].id]);
      expect(JSON.stringify(contract.run.manifest)).toBe(frozen);
      expect((await detail()).approvals.map((a: any) => a.kind)).toEqual(["specification"]);
      f.restart(); await accept();
      expect((await f.agent(run.id, "tickets", plan).then(r => r.json())).hash).toBe(saved.hash);
      expect((await detail()).runs).toHaveLength(1);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });

  it("retains automatically planned Ticket names and context ownership after later Specification revisions and restart", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Retained automatic Ticket history"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned history fixture only" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Retain the reviewed result" }).then(r => r.json());
      await f.api(`${prefix}/specification-acceptance`, { source: "button", specification_id: spec.id, hash: spec.hash });
      const run = (await until(detail, d => d.runs.length === 1)).runs[0];
      expect(run.manifest.tickets).toEqual([]);
      const plan = await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Public HTTP retained history", tickets: [{ key: "result", title: "Reviewed result", acceptance: "Retain its name and ownership", dependencies: [] }] }).then(r => r.json());
      f.setTranscript({ source_id: "retained-orchestrator-history", version: "v1", cursor: null, turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: "Original execution decisions" }] }] });
      expect((await f.api(`/runs/${run.id}/import-conversation`, {})).status).toBe(200);
      f.runs.get(run.id)!.condition = "ready";
      const started = await until(detail, d => d.workers.some((w: any) => w.role === "implementer" && w.condition === "working"));
      const worker = started.workers.find((w: any) => w.role === "implementer");
      f.workers.get(worker.id)!.condition = "ready";
      const completed = await until(detail, d => d.workers.find((w: any) => w.id === worker.id)?.condition === "completed");
      await f.api(`${prefix}/pause`, {});
      const original = completed.conversations.find((c: any) => c.kind === "implementation");
      expect(original.title).toBe("Reviewed result");
      expect(original.contexts[0]).toMatchObject({ run_id: run.id, worker_id: worker.id });
      const orchestrator = completed.conversations.find((c: any) => c.kind === "orchestrator");
      expect(original.parent_id).toBe(orchestrator.id);
      expect(orchestrator.contexts[0].snapshot_ids).toHaveLength(1);
      const assertRetained = async () => {
        const current = await detail();
        expect(current.execution_plans.find((p: any) => p.run_id === run.id)).toEqual(plan);
        expect(current.conversations.find((c: any) => c.id === original.id)).toEqual(original);
        expect(current.conversations.find((c: any) => c.id === orchestrator.id)).toEqual(orchestrator);
        expect((await f.api("").then(r => r.json())).conversations.find((c: any) => c.id === original.id)).toEqual(original);
        expect(current.workers.find((w: any) => w.id === worker.id).condition).toBe("completed");
      };
      const next = await f.api(`${prefix}/specifications`, { content: "A later, separate scope" }).then(r => r.json());
      expect((await detail()).tickets).toEqual([]);
      await assertRetained();
      await f.api(`${prefix}/tickets`, { specification_id: next.id, tickets: [{ key: "different", title: "Newest scope Ticket", acceptance: "Separate work", dependencies: [] }] });
      await f.api(`${prefix}/specification-acceptance`, { source: "button", specification_id: next.id, hash: next.hash });
      await assertRetained();
      f.restart();
      await assertRetained();
      expect(f.workerLaunches.filter(value => value === worker.id)).toHaveLength(1);
    } finally { f.close(); }
  });

  it("blocks dependent planning and frontier work for genuine owner decisions and preserves the frozen plan", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("New scope question"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Only the accepted behavior" }).then(r => r.json());
      await f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "owner_chat", content: "accepted", idempotency_key: "accept" });
      const run = (await until(detail, d => d.runs.length === 1)).runs[0];
      const plan = { specification_id: spec.id, testing_plan: "Validate public HTTP behavior", tickets: [{ key: "one", title: "Accepted behavior", acceptance: "The API delivers it", dependencies: [] }] };
      const question = await f.agent(run.id, "question", { question: "May the new design change the public behavior?" }).then(r => r.json());
      expect((await f.agent(run.id, "tickets", plan)).status).toBe(409);
      await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Keep the originally accepted scope" });
      expect((await f.agent(run.id, "tickets", plan)).status).toBe(409);
      const context = await f.agent(run.id, "contract").then(r => r.json());
      await f.agent(run.id, "consume", { revision: context.question_revision });
      expect((await f.agent(run.id, "tickets", plan)).status).toBe(201);
      await f.agent(run.id, "question", { question: "Which new dependency is permitted?" });
      expect((await f.agent(run.id, "contract").then(r => r.json())).frontier).toEqual([]);
      const before = (await detail()).execution_plans[0];
      await f.api(`${prefix}/specifications`, { content: "New unrelated scope" });
      expect((await f.agent(run.id, "tickets", { ...plan, specification_id: (await detail()).specifications.at(-1).id })).status).toBe(409);
      expect((await detail()).execution_plans[0]).toEqual(before);
      expect((await detail()).runs[0].manifest.specification.id).toBe(spec.id);
    } finally { f.close(); }
  });

  it("hands off the native Specifications conversation at a cap of one and reconciles a lost launch after restart", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Native automatic handoff"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit the owned workspace" });
      const source = await f.api(`${prefix}/runs`, { action: "to-spec", idempotency_key: "specifying" }).then(r => r.json());
      const spec = await f.agent(source.id, "specification", { content: "Accepted native scope" }).then(r => r.json());
      f.setTranscript({ source_id: "owned-native-approval", version: "v1", cursor: null, turns: [
        { role: "assistant", ts: new Date(Date.parse(spec.created_at) + 1000).toISOString(), parts: [{ kind: "text", text: `Specification ${spec.id}, SHA-256 ${spec.hash}\n\n${spec.content}` }] },
        { role: "user", ts: new Date(Date.parse(spec.created_at) + 2000).toISOString(), parts: [{ kind: "text", text: "accepted" }] },
      ] });
      await f.api(`/runs/${source.id}/import-conversation`, {});
      expect((await detail()).automatic_planning).toHaveLength(1);
      expect((await detail()).runs).toHaveLength(1);
      f.restart();
      f.loseNextLaunch();
      f.runs.get(source.id)!.condition = "ready";
      const result = await until(detail, d => d.runs.some((r: any) => r.action === "implement-spec"));
      const orchestrator = result.runs.find((r: any) => r.action === "implement-spec");
      expect(result.runs.find((r: any) => r.id === source.id).condition).toBe("completed");
      f.restart();
      const contract = await until(() => f.agent(orchestrator.id, "contract").then(r => r.json()), c => c.run.condition === "working");
      expect(contract.run.condition).toBe("working");
      expect(contract.run.manifest.planning_authority.provenance.kind).toBe("native_chat");
      const overview = await f.api("").then(r => r.json());
      expect(overview.capacity.normal.used).toBe(1);
      expect(overview.capacity.planning.used).toBe(0);
      expect((await detail()).conversations.find((c: any) => c.kind === "orchestrator").contexts).toHaveLength(1);
      expect(f.launches).toHaveLength(2);
    } finally { f.close(); }
  });

  it("asks the owner when the accepted execution scope changes before admission", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Changed accepted scope"); const prefix = `/implementations/${id}`;
      const spec = await f.api(`${prefix}/specifications`, { content: "Original accepted scope" }).then(r => r.json());
      await f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      await f.api(`${prefix}/specifications`, { content: "Unaccepted replacement" });
      const detail = await until(() => f.api(prefix).then(r => r.json()), d => d.automatic_planning[0]?.condition === "blocked");
      expect(detail.runs).toHaveLength(0);
      expect(detail.questions).toEqual([expect.objectContaining({ answer: null, question: expect.stringContaining("accepted execution scope changed") })]);
      f.restart();
      expect((await f.api(prefix).then(r => r.json())).questions).toHaveLength(1);
    } finally { f.close(); }
  });

  it("keeps automatic requests inert in a restored recovery copy", async () => {
    const f = await capacityFixture();
    let recovery: ReturnType<typeof createServer> | undefined;
    try {
      await f.api("/settings", { max_agents: 1 });
      const occupied = await f.assignment("Recovery capacity holder");
      await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "recovery-holder" });
      const id = await f.assignment("Recovery copy"); const prefix = `/implementations/${id}`;
      const assignment = await f.api(prefix).then(r => r.json());
      await f.api(`/projects/${assignment.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
      const spec = await f.api(`${prefix}/specifications`, { content: "Preserve this approved scope" }).then(r => r.json());
      await f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      const backup = await f.api("/backups", {}).then(r => r.json());
      const restored = await f.api(`/backups/${backup.id}/restore`, {}).then(r => r.json());
      f.app.stop();
      recovery = createServer({ port: 0, token: f.token, stateDir: restored.state_dir, machines: false, factory: { accountDiscoveryHome: f.state } });
      const deadline = Date.now() + 700;
      do {
        const detail = await fetch(`http://localhost:${recovery.port}/api/factory${prefix}`, { headers: { authorization: `Bearer ${f.token}` } }).then(r => r.json());
        expect(["pending", "queued"]).toContain(detail.automatic_planning[0].condition);
        expect(detail.runs).toHaveLength(0);
        await Bun.sleep(20);
      } while (Date.now() < deadline);
    } finally { recovery?.stop(); f.close(); }
  });
});
