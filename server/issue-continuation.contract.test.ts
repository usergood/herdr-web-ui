import { expect, test } from "bun:test";
import { issueContinuationFixture } from "../scripts/fixtures/issue-continuation.ts";

test("Continue retires only the exact ready planning step and freezes guarded issue admission with its retained handoff", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning();
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(202);
    const run = await response.json();
    expect(run).toMatchObject({ action: "implement-spec", condition: "working", manifest: { issue_admission: { source: { id: body.issue_scope.source_id, revision: body.issue_scope.source_revision } } } });
    const detail = await fixture.json(path);
    expect(detail.runs.map((entry: any) => [entry.id, entry.action, entry.condition])).toEqual([[planning.id, "to-tickets", "completed"], [run.id, "implement-spec", "working"]]);
    expect(detail.messages.some((message: any) => message.content.includes("Retained fictional planning handoff."))).toBe(true);
    expect(detail.events.some((event: any) => event.kind === "workflow_step_finished" && event.data.run_id === planning.id)).toBe(true);
    expect((await fixture.json(path + "/continue", body)).id).toBe(run.id);
    expect((await fixture.json(path)).runs).toHaveLength(2);
  } finally { fixture.close(); }
}, 15_000);

test.each(["working", "disconnected", "interrupted", "failed"] as const)("Continue cannot retire a %s issue planning predecessor", async condition => {
  const fixture = issueContinuationFixture();
  try {
    fixture.setPlanningCondition(condition);
    const { path, planning, body } = await fixture.preparedPlanning();
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("step_not_ready");
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ id: planning.id, condition });
    expect(detail.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
  } finally { fixture.close(); }
}, 15_000);

test("an unrelated ready predecessor or a direct Start run_id cannot retire the issue's planning ownership", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body, project } = await fixture.preparedPlanning();
    const unrelated = await fixture.json("/implementations", { title: "Unrelated planning", project_id: project.id, description: "An owned independent plan" });
    const other = await fixture.json(`/implementations/${unrelated.id}/runs`, { action: "to-spec", idempotency_key: "unrelated-ready-planning" });
    await fixture.json(`/runs/${other.id}/reconcile`, {});
    const response = await fixture.post(path + "/continue", { ...body, run_id: other.id });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("step_changed");
    const direct = await fixture.post(path + "/runs", { ...body, idempotency_key: "direct-cannot-retire" });
    expect(direct.status).toBe(409); expect((await direct.json()).error.code).toBe("issue_not_eligible");
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1); expect(detail.runs[0]).toMatchObject({ id: planning.id, condition: "ready" });
    expect(detail.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
  } finally { fixture.close(); }
}, 15_000);

test("ready planning cannot conceal a failed implementation that still requires explicit Retry", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body } = await fixture.preparedPlanning();
    const implemented = await fixture.json(path + "/continue", body);
    fixture.setRunCondition(implemented.id, "failed"); await fixture.json(`/runs/${implemented.id}/reconcile`, {});
    const planning = await fixture.json(path + "/runs", { action: "to-tickets", idempotency_key: "planning-after-failed-implementation" });
    fixture.setPlanningCondition("ready"); await fixture.json(`/runs/${planning.id}/reconcile`, {});
    const response = await fixture.post(path + "/continue", { ...body, run_id: planning.id, idempotency_key: "cannot-disguise-retry" });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("retry_required");
    const detail = await fixture.json(path);
    expect(detail.runs.at(-1)).toMatchObject({ id: planning.id, condition: "ready" });
    expect(detail.runs.filter((run: any) => run.action === "implement-spec")).toHaveLength(1);
  } finally { fixture.close(); }
}, 15_000);

test("a ready planning predecessor cannot release an uncertain worker reservation", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning();
    const worker = await fixture.json(`/runs/${planning.id}/workers`, { role: "standards", idempotency_key: "uncertain-planning-child" });
    expect(worker.condition).toBe("disconnected");
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("implementation_owned");
    const detail = await fixture.json(path);
    expect(detail.workers).toEqual([worker]);
    expect(detail.runs).toHaveLength(1); expect(detail.runs[0]).toMatchObject({ id: planning.id, condition: "ready" });
  } finally { fixture.close(); }
}, 15_000);

test.each(["pause", "outage", "scope", "dependencies"])("Continue revalidates %s after retaining and finishing the exact planning step", async blocker => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body, route } = await fixture.preparedPlanning();
    fixture.beforeFinish(async () => {
      if (blocker === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
      if (blocker === "outage") { fixture.save([fixture.issue], true); expect((await fixture.post(route + "/sync", {})).status).toBe(409); }
      if (blocker === "scope") { fixture.issue.body += "\nChanged greeting during handoff."; fixture.save(); await fixture.json(route + "/sync", {}); }
      if (blocker === "dependencies") {
        fixture.save([fixture.issue], false, { 1: [{ ...fixture.issue, number: 42, node_id: "undelivered-dependency", html_url: "https://github.com/fictional/project/issues/42" }] });
        await fixture.json(route + "/sync", {});
      }
    });
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ id: planning.id, condition: "completed" });
    expect(detail.messages.some((message: any) => message.content.includes("Retained fictional planning handoff."))).toBe(true);
  } finally { fixture.close(); }
}, 15_000);

test("an uncertain planning finish cannot admit a successor or release the predecessor", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning();
    fixture.setFinishUncertain();
    expect((await fixture.post(path + "/continue", body)).status).toBe(503);
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1); expect(detail.runs[0]).toMatchObject({ id: planning.id, condition: "ready" });
    expect(detail.messages.some((message: any) => message.content.includes("Retained fictional planning handoff."))).toBe(true);
  } finally { fixture.close(); }
}, 15_000);

test("a ready ordinary Work Run is not a retiring issue planning predecessor", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning("work");
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("step_not_ready");
    expect((await fixture.json(path)).runs).toMatchObject([{ id: planning.id, action: "work", condition: "ready" }]);
  } finally { fixture.close(); }
}, 15_000);

test.each(["project", "global"])("Continue rechecks %s capacity acquired while the planning handoff finishes", async limit => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body, route, readiness, project } = await fixture.preparedPlanning();
    fixture.beforeFinish(async () => {
      if (limit === "global") {
        const idea = await fixture.json("/implementations", { title: "Other active context", project_id: project.id, description: "Owned unrelated Work" });
        await fixture.json(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: "other-active-context" });
        await fixture.json("/settings", { max_agents: 1 });
      } else {
        fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "other-issue", title: "Other issue", html_url: "https://github.com/fictional/project/issues/2" }]);
        const second = (await fixture.json(route + "/sync", {})).sources.find((source: any) => source.number === 2);
        await fixture.json(route + "/issues/2/approve", { source_revision: second.revision, policy_revision: readiness.revision });
        await fixture.json(route + "/issues/2/prepare", { source_revision: second.revision });
        const current = (await fixture.json(route + "/sync", {})).sources.find((source: any) => source.number === 2);
        await fixture.json(`/implementations/${current.implementation_id}/runs`, { action: "implement-spec", idempotency_key: "other-project-owner", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
      }
    });
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe(limit === "project" ? "project_capacity_exhausted" : "capacity_exhausted");
    expect((await fixture.json(path)).runs).toMatchObject([{ id: planning.id, condition: "completed" }]);
  } finally { fixture.close(); }
}, 15_000);

test.each(["working", "disconnected"] as const)("Continue reobserves a displayed ready planning step that is now %s", async condition => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body } = await fixture.preparedPlanning();
    fixture.setPlanningCondition(condition);
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("step_not_ready");
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1); expect(detail.runs[0].condition).toBe(condition);
    expect(detail.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
  } finally { fixture.close(); }
}, 15_000);

test.each(["pause", "outage"])("Continue refuses current %s evidence before retiring its ready planning predecessor", async blocker => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body, route } = await fixture.preparedPlanning();
    if (blocker === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    else { fixture.save([fixture.issue], true); expect((await fixture.post(route + "/sync", {})).status).toBe(409); }
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe(blocker === "pause" ? "queue_paused" : "issue_not_eligible");
    const detail = await fixture.json(path);
    expect(detail.runs).toHaveLength(1); expect(detail.runs[0].condition).toBe("ready");
    expect(detail.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
  } finally { fixture.close(); }
}, 15_000);
