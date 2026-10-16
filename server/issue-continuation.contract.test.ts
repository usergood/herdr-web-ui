import { expect, test } from "bun:test";
import { issueContinuationFixture } from "../scripts/fixtures/issue-continuation.ts";

test("continuation browser origin reaches retained Assignment state after restart", async () => {
  const fixture = issueContinuationFixture();
  let retired: ReturnType<typeof Bun.serve> | undefined;
  try {
    const assignment = await fixture.json("/implementations", { title: "Retained continuation Assignment", description: "Fictional restart state" });
    const port = Number(new URL(fixture.origin).port);
    fixture.restart(() => { retired = Bun.serve({ port, fetch: () => new Response("Retired fixture address", { status: 410 }) }); });
    const response = await fetch(fixture.origin + `/api/factory/implementations/${assignment.id}`, { headers: fixture.headers, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect((await response.json()).implementation).toMatchObject({ id: assignment.id, title: "Retained continuation Assignment" });
  } finally { retired?.stop(true); fixture.close(); }
});

test("Continue retires only the exact ready planning step and freezes guarded issue admission with its retained handoff", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning();
    const prepared = await fixture.json(path);
    expect(prepared.questions).toEqual([]);
    expect(prepared.github_sources[0].planning).toMatchObject({ condition: "prepared", origin: "app_plan", graph_hash: body.issue_scope.graph_hash });
    expect(prepared.approvals).toHaveLength(3);
    for (const approval of prepared.approvals) expect(approval.issue_scope).toMatchObject({ source_id: body.issue_scope.source_id, source_revision: body.issue_scope.source_revision });
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

test("prepared issue Continue retains its intent through required verification and restart, then admits one guarded successor", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body } = await fixture.preparedPlanning("to-spec");
    expect((await fixture.json(path)).approvals).toEqual([]);
    fixture.setFactoryReady(false);
    const response = await fixture.post(path + "/continue", body);
    expect(response.status).toBe(202);
    const probe = await response.json();
    expect(probe.action).toBe("verify-provider");
    expect(probe.manifest.issue_admission).toBeUndefined();
    expect((await fixture.json(path)).runs).toMatchObject([{ id: planning.id, condition: "completed" }, { id: probe.id, action: "verify-provider" }]);
    const unproven = await fixture.post(`/runs/${probe.id}/verify-provider`, {});
    expect(unproven.status).toBe(409); expect((await unproven.json()).error.code).toBe("verification_round_required");
    expect(fixture.verificationRequests).toBe(0);
    const question = await fixture.agent(probe.id, "question", { question: "Confirm this owned verification round?" }).then(response => response.json());
    await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Owned fixture answer" });
    fixture.restart();
    fixture.setVerificationAvailable(); fixture.setRunCondition(probe.id, "ready");
    const contract = await fixture.agent(probe.id, "contract").then(response => response.json());
    expect((await fixture.agent(probe.id, "consume", { revision: contract.question_revision })).status).toBe(200);
    const deadline = Date.now() + 5000;
    let detail;
    do {
      detail = await fixture.json(path);
      if (detail.runs.some((run: any) => run.action === "implement-spec" && run.condition === "working")) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    expect(detail.runs.map((run: any) => [run.action, run.condition])).toEqual([["to-spec", "completed"], ["verify-provider", "completed"], ["implement-spec", "working"]]);
    expect(detail.approvals).toEqual([]);
    const successor = detail.runs.at(-1);
    expect(successor.manifest.issue_admission.source).toMatchObject({ id: body.issue_scope.source_id, revision: body.issue_scope.source_revision });
    expect(successor.graph_hash).toBe(body.issue_scope.graph_hash);
    expect((await fixture.json(path + "/continue", body)).id).toBe(successor.id);
    fixture.restart();
    await fixture.json(`/runs/${successor.id}/reconcile`, {});
    expect((await fixture.json(path)).runs).toHaveLength(3);
  } finally { fixture.close(); }
}, 15_000);

test("an explicit Continue from the ready verification prerequisite reuses displayed issue scope and still requires native proof", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body } = await fixture.preparedPlanning("to-spec");
    fixture.setFactoryReady(false);
    const probe = await fixture.json(path + "/continue", body);
    fixture.setRunCondition(probe.id, "ready");
    const continued = { ...body, run_id: probe.id, idempotency_key: "explicit-verified-issue" };
    const unproven = await fixture.post(path + "/continue", continued);
    expect(unproven.status).toBe(409); expect((await unproven.json()).error.code).toBe("verification_round_required");
    const question = await fixture.agent(probe.id, "question", { question: "Verify this fictional provider?" }).then(response => response.json());
    await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Owned verification decision" });
    const contract = await fixture.agent(probe.id, "contract").then(response => response.json());
    await fixture.agent(probe.id, "consume", { revision: contract.question_revision });
    const deadline = Date.now() + 3000;
    while (!fixture.verificationRequests && Date.now() < deadline) await Bun.sleep(25);
    expect(fixture.verificationRequests).toBeGreaterThan(0);
    fixture.setVerificationAvailable();
    const response = await fixture.post(path + "/continue", continued);
    expect(response.status).toBe(202);
    const successor = await response.json();
    expect(successor.action).toBe("implement-spec");
    expect(successor.manifest.issue_admission.source.revision).toBe(body.issue_scope.source_revision);
    expect((await fixture.json(path + "/continue", continued)).id).toBe(successor.id);
    fixture.restart();
    expect((await fixture.json(path)).runs.map((run: any) => [run.action, run.condition])).toEqual([["to-spec", "completed"], ["verify-provider", "completed"], ["implement-spec", "working"]]);
  } finally { fixture.close(); }
}, 15_000);

test.each(["scope", "readiness", "policy", "pause", "outage", "dependencies", "project_limit", "global_limit"])("%s changed while verifying blocks the retained issue intent before implementation admission", async blocker => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body, route, readiness, project } = await fixture.preparedPlanning("to-spec");
    fixture.setFactoryReady(false);
    const probe = await fixture.json(path + "/continue", body);
    const question = await fixture.agent(probe.id, "question", { question: "Confirm the fictional verification round?" }).then(response => response.json());
    await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Owned fixture answer" });
    if (blocker === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    else if (blocker === "readiness") await fixture.json(route + "/readiness", { expected_revision: readiness.revision, account_profile_id: readiness.account_profile_id, triage_labels: {}, blocked_label: "on-hold" });
    else if (blocker === "policy") {
      const policy = (await fixture.json(route)).policy;
      await fixture.json(route + "/configure", { ...policy, expected_revision: policy.revision, review_context: "New owner Project guidance during verification" });
    }
    else if (blocker === "scope" || blocker === "outage" || blocker === "dependencies") {
      if (blocker === "scope") fixture.issue.body += "\nA new greeting requirement.";
      fixture.save([fixture.issue], blocker === "outage", blocker === "dependencies" ? { 1: [{ ...fixture.issue, number: 42, node_id: "undelivered-verification-dependency", html_url: "https://github.com/fictional/project/issues/42" }] } : {});
      expect((await fixture.post(route + "/sync", {})).status).toBe(blocker === "outage" ? 409 : 200);
    } else {
      const other = await fixture.json("/implementations", { title: "Other owned execution", project_id: project.id, description: "Unrelated fixture" });
      if (blocker === "global_limit") {
        await fixture.json(`/implementations/${other.id}/runs`, { action: "work", idempotency_key: "global-verification-blocker" });
        await fixture.json("/settings", { max_agents: 1 });
      } else {
        const spec = await fixture.json(`/implementations/${other.id}/specifications`, { content: "Independent owned execution" });
        for (const kind of ["specification", "testing_seams"]) await fixture.json(`/implementations/${other.id}/approvals`, { kind, revision: spec.id, scope: "Owned HTTP fixture" });
        const graph = await fixture.json(`/implementations/${other.id}/tickets`, { specification_id: spec.id, tickets: [{ key: "other", title: "Other", acceptance: "Other fixture", dependencies: [] }] });
        await fixture.json(`/implementations/${other.id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Owned fixture graph" });
        fixture.setFactoryReady(true);
        await fixture.json(`/implementations/${other.id}/runs`, { action: "implement-spec", idempotency_key: "project-verification-blocker" });
      }
    }
    fixture.setVerificationAvailable(); fixture.setRunCondition(probe.id, "ready");
    const contract = await fixture.agent(probe.id, "contract").then(response => response.json());
    expect((await fixture.agent(probe.id, "consume", { revision: contract.question_revision })).status).toBe(200);
    const deadline = Date.now() + 5000;
    let detail;
    do {
      detail = await fixture.json(path);
      if (detail.events.some((event: any) => event.kind === "continuation_waiting" && event.data.run_id === probe.id)) break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    expect(detail.events.some((event: any) => event.kind === "continuation_waiting" && event.data.run_id === probe.id)).toBe(true);
    expect(detail.runs.map((run: any) => [run.action, run.condition])).toEqual([["to-spec", "completed"], ["verify-provider", blocker === "global_limit" ? "completed" : "ready"]]);
    fixture.restart();
    expect((await fixture.json(path)).runs).toHaveLength(2);
    const replay = await fixture.json(path + "/continue", body);
    expect(replay.id).toBe(probe.id);
  } finally { fixture.close(); }
}, 15_000);

test("an uncertain verification launch retains its accepted identity and never replays on Continue or restart", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, body } = await fixture.preparedPlanning();
    fixture.setFactoryReady(false); fixture.setVerificationLaunchUncertain();
    const probe = await fixture.json(path + "/continue", body);
    expect(probe).toMatchObject({ action: "verify-provider", condition: "disconnected" });
    expect((await fixture.json(path + "/continue", body)).id).toBe(probe.id);
    fixture.restart();
    await fixture.json(`/runs/${probe.id}/reconcile`, {});
    expect((await fixture.json(path + "/continue", body)).id).toBe(probe.id);
    const other = await fixture.json("/implementations", { title: "Other work", description: "Owned independent context" });
    await fixture.json(`/implementations/${other.id}/configure`, { machine_id: "fictional-host", provider: "codex" });
    await fixture.json("/settings", { max_agents: 1 });
    const blocked = await fixture.post(`/implementations/${other.id}/runs`, { action: "grill-me", idempotency_key: "uncertain-probe-still-owns" });
    expect(blocked.status).toBe(409); expect((await blocked.json()).error.code).toBe("capacity_exhausted");
    expect((await fixture.json(path)).runs.map((run: any) => run.action)).toEqual(["to-tickets", "verify-provider"]);
    expect(fixture.verificationRequests).toBe(0);
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

test.each(["outage", "readiness"] as const)("natural planning Continue retains its %s-blocked handoff and requires fresh authorization", async loss => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body, route, readiness } = await fixture.preparedPlanning("to-spec");
    const before = await fixture.json(path);
    expect(before.approvals).toEqual([]);
    if (loss === "readiness") fixture.issue.labels = [];
    fixture.save([fixture.issue], loss === "outage");
    expect((await fixture.post(route + "/sync", {})).status).toBe(loss === "outage" ? 409 : 200);
    const stale = await fixture.json(path);
    expect(stale.github_sources[0].planning).toMatchObject({ condition: "stale", origin: "issue_body", specification_id: before.specifications.at(-1).id, graph_hash: before.graph_hash });
    expect(stale.questions).toEqual([]);
    const refused = await fixture.post(path + "/continue", body);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe(loss === "outage" ? "issue_not_eligible" : "issue_changed");
    const unchanged = await fixture.json(path);
    expect(unchanged.runs).toEqual(before.runs); expect(unchanged.messages).toEqual(before.messages);
    expect(unchanged.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
    fixture.issue.labels = [{ name: "ready-for-agent" }]; fixture.save();
    const current = (await fixture.json(route + "/sync", {})).sources[0];
    if (loss === "readiness") {
      await fixture.json(route + "/issues/1/approve", { source_revision: current.revision, policy_revision: readiness.revision });
      const busy = await fixture.post(route + "/issues/1/prepare", { source_revision: current.revision });
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe("planning_busy");
      const stillBlocked = await fixture.post(path + "/continue", { ...body, issue_scope: { ...body.issue_scope, source_revision: current.revision } });
      expect(stillBlocked.status).toBe(409); expect((await stillBlocked.json()).error.code).toBe("issue_not_eligible");
      const retained = await fixture.json(path);
      expect(retained.runs).toEqual(before.runs); expect(retained.messages).toEqual(before.messages);
      expect(retained.events.some((event: any) => event.kind === "workflow_step_finished")).toBe(false);
      expect(retained.approvals).toEqual([]);
      return;
    }
    expect(current.planning.condition).toBe("prepared");
    const successor = await fixture.json(path + "/continue", { ...body, issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
    expect(successor).toMatchObject({ action: "implement-spec", condition: "working", manifest: { issue_admission: { source: { id: current.id, revision: current.revision } } } });
    const after = await fixture.json(path);
    expect(after.runs.map((run: any) => [run.id, run.condition])).toEqual([[planning.id, "completed"], [successor.id, "working"]]);
    expect(after.messages.some((message: any) => message.content.includes("Retained fictional planning handoff."))).toBe(true);
    expect(after.approvals).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);

test("an unrelated ready predecessor or a direct Start run_id cannot retire the issue's planning ownership", async () => {
  const fixture = issueContinuationFixture();
  try {
    const { path, planning, body, project } = await fixture.preparedPlanning();
    const before = await fixture.json(path);
    expect(before.questions).toEqual([]);
    expect(before.github_sources[0].planning.condition).toBe("prepared");
    const unrelated = await fixture.json("/implementations", { title: "Unrelated planning", project_id: project.id, description: "An owned independent plan" });
    const other = await fixture.json(`/implementations/${unrelated.id}/runs`, { action: "to-spec", idempotency_key: "unrelated-ready-planning" });
    await fixture.json(`/runs/${other.id}/reconcile`, {});
    const response = await fixture.post(path + "/continue", { ...body, run_id: other.id });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("step_changed");
    const direct = await fixture.post(path + "/runs", { ...body, idempotency_key: "direct-cannot-retire" });
    expect(direct.status).toBe(409); expect((await direct.json()).error.code).toBe("issue_not_eligible");
    const detail = await fixture.json(path);
    expect(detail.runs).toEqual(before.runs); expect(detail.runs[0]).toMatchObject({ id: planning.id, condition: "ready" });
    expect(detail.messages).toEqual(before.messages);
    expect((await fixture.json(`/implementations/${unrelated.id}`)).runs[0]).toMatchObject({ id: other.id, condition: "ready" });
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
