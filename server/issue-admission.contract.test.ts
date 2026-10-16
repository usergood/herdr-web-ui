import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";
import { githubReviewFixture } from "../scripts/fixtures/github-review.ts";

async function prepared(fixture: ReturnType<typeof githubQueueFixture>, githubLabel = false, labels?: { triage_labels: Record<string, string>; blocked_label: string }) {
  const setup = await fixture.setup();
  if (labels) setup.readiness = await fixture.json(setup.route + "/readiness", { expected_revision: setup.readiness.revision, account_profile_id: setup.account.id, ...labels });
  let view = await fixture.json(setup.route + "/sync", {});
  let source = view.sources[0];
  if (githubLabel) {
    const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000).toISOString();
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events: [{ id: 200, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-owner", id: 1042 }, created_at: at }] });
    source = (await fixture.json(setup.route + "/sync", {})).sources[0];
  } else {
    await fixture.json(setup.route + "/issues/1/approve", { source_revision: source.revision, policy_revision: setup.readiness.revision });
  }
  await fixture.json(setup.route + "/issues/1/prepare", { source_revision: source.revision });
  view = await fixture.json(setup.route + "/sync", {});
  const current = view.sources[0];
  return { ...setup, source: current, path: `/implementations/${source.implementation_id}`, start: { action: "implement-spec", idempotency_key: "explicit-issue-start", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } } };
}

async function prepareSecond(fixture: ReturnType<typeof githubQueueFixture>, route: string, readiness: { revision: string }) {
  const view = await fixture.json(route);
  const source = view.sources.find((entry: any) => entry.number === 2);
  await fixture.json(route + "/issues/2/approve", { source_revision: source.revision, policy_revision: readiness.revision });
  await fixture.json(route + "/issues/2/prepare", { source_revision: source.revision });
  await fixture.json(route + "/sync", {});
  const detail = await fixture.json(`/implementations/${source.implementation_id}`);
  return { path: `/implementations/${source.implementation_id}`, start: { action: "implement-spec", idempotency_key: "second-issue-start", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } } };
}

test("fresh issue readiness cannot authorize an older app plan before its first preparation", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const original = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${original.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Hello through public HTTP", issue_scope: { source_id: original.id, source_revision: original.revision } });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "hello", title: "Hello", acceptance: "Show hello via HTTP", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Hello graph", issue_scope: { source_id: original.id, source_revision: original.revision } });
    fixture.issue.body = fixture.issue.body.replaceAll("hello", "goodbye").replace("Public HTTP", "Public CLI");
    fixture.save();
    const changed = (await fixture.json(route + "/sync", {})).sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: changed.revision, policy_revision: readiness.revision });
    const preview = await fixture.json(route + "/preview", {});
    expect(preview.eligible_count).toBe(0);
    expect(preview.entries[0].reasons).toContainEqual({ code: "planning_needs_you", detail: "" });
    const waiting = await fixture.json(path);
    expect(waiting.questions).toHaveLength(1);
    expect(waiting.questions[0].question).toContain("current issue scope");
    await fixture.json(path + `/questions/${waiting.questions[0].id}/answer`, { revision: waiting.questions[0].revision, answer: "yes" });
    const prepare = await fixture.json(route + "/issues/1/prepare", { source_revision: changed.revision, question_revision: (await fixture.json(path)).question_revision });
    expect(prepare.sources[0].planning.condition).toBe("needs_you");
    expect((await fixture.json(path)).tickets).toEqual(waiting.tickets);
    expect((await fixture.post(path + "/runs", { action: "implement-spec", idempotency_key: "old-plan-start", issue_scope: { source_id: changed.id, source_revision: changed.revision, graph_hash: graph.hash } })).status).toBe(409);
    expect((await fixture.post(path + "/continue", { action: "implement-spec", idempotency_key: "old-plan-continue", run_id: null })).status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([]);
    expect((await fixture.post(path + "/approvals", { kind: "specification", revision: specification.id, scope: "Stale screen", issue_scope: { source_id: original.id, source_revision: original.revision } })).status).toBe(409);
    const issueScope = { source_id: changed.id, source_revision: changed.revision };
    const renewedApprovalIds: string[] = [];
    for (const [kind, revision] of [["specification", specification.id], ["testing_seams", specification.id], ["ticket_graph", graph.hash]]) {
      const approval = await fixture.json(path + "/approvals", { kind, revision, scope: "Explicitly retain this app plan for the displayed issue revision", issue_scope: issueScope });
      expect(approval.issue_scope).toMatchObject(issueScope);
      renewedApprovalIds.push(approval.id);
    }
    const decisions = await fixture.json(path);
    for (const question of decisions.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Retain the explicitly approved app plan." });
    const renewed = await fixture.json(route + "/issues/1/prepare", { source_revision: changed.revision, question_revision: (await fixture.json(path)).question_revision });
    expect(renewed.sources[0].planning).toMatchObject({ condition: "prepared", origin: "app_plan", specification_id: specification.id, graph_hash: graph.hash, testing_seams: "Public HTTP and real browser journeys." });
    expect(renewed.sources[0].planning.app_approval_ids).toEqual(renewedApprovalIds);
    expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(1);
    expect((await fixture.json(path)).tickets).toEqual(waiting.tickets);
  } finally { fixture.close(); }
}, 20_000);

test.each([false, true])("generic app-plan approvals stay unbound after an incompatible issue change: %s", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const original = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${original.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    if (change) { fixture.issue.body = fixture.issue.body.replace("hello", "goodbye").replace("Public HTTP", "Public CLI"); fixture.save(); }
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    for (const kind of ["specification", "testing_seams"]) {
      const approval = await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Generic approval without displayed issue scope" });
      expect(approval.issue_scope).toBeUndefined();
    }
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "hello", title: "Hello", acceptance: "Show hello via HTTP", dependencies: [] }] });
    expect((await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Generic graph approval" })).issue_scope).toBeUndefined();
    if (change) expect((await fixture.post(path + "/approvals", { kind: "specification", revision: specification.id, scope: "Stale displayed scope", issue_scope: { source_id: original.id, source_revision: original.revision } })).status).toBe(409);
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const waiting = await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    expect(waiting.sources[0].planning.condition).toBe("needs_you");
    expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(0);
    if (change) {
      const policy = (await fixture.json(route)).policy;
      await fixture.json(route + "/configure", { ...policy, expected_revision: policy.revision, sync_enabled: true });
      const preview = await fixture.json(route + "/preview", {});
      await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: preview.revision, paused: false, max_implementations: 1 });
      await fixture.json(route + "/sync", {}); fixture.restart(); await fixture.json(route + "/sync", {});
      expect((await fixture.json(route + "/queue")).eligible_count).toBe(0);
      expect(fixture.launches).toEqual([]);
    }
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["body", "testing_seams", "graph", "legacy"] as const)("prepared app planning blocks %s drift without replacing retained work", async drift => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    const issueScope = { source_id: source.id, source_revision: source.revision };
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Hello through HTTP", issue_scope: issueScope });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "hello", title: "Hello", acceptance: "Show hello via HTTP", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Hello graph", issue_scope: issueScope });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    if (drift === "body" || drift === "testing_seams") {
      fixture.issue.body = drift === "body" ? fixture.issue.body.replace("hello", "goodbye") : fixture.issue.body.replace("Public HTTP", "Public CLI");
      fixture.save(); const changed = (await fixture.json(route + "/sync", {})).sources[0];
      await fixture.json(route + "/issues/1/approve", { source_revision: changed.revision, policy_revision: readiness.revision });
    }
    if (drift === "graph") await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "expanded", title: "Unapproved graph", acceptance: "A different greeting", dependencies: [] }] });
    if (drift === "legacy") {
      const approvals = (await fixture.json(path)).approvals;
      // Historical input only: retain the pre-upgrade receipts without issue provenance.
      fixture.restart(() => {
        const db = new Database(join(fixture.root, "factory", "records.sqlite"));
        try { for (const { issue_scope: _scope, ...approval } of approvals) db.query("UPDATE records SET data=? WHERE kind='approvals' AND id=?").run(JSON.stringify(approval), approval.id); }
        finally { db.close(); }
      });
    }
    const before = await fixture.json(path); const current = before.github_sources[0];
    const prepared = await fixture.json(route + "/issues/1/prepare", { source_revision: current.revision });
    expect(prepared.sources[0].planning.condition).toBe("needs_you");
    const waiting = await fixture.json(path);
    expect(waiting.specifications).toEqual(before.specifications); expect(waiting.tickets).toEqual(before.tickets);
    for (const question of waiting.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "yes" });
    const retry = await fixture.json(route + "/issues/1/prepare", { source_revision: current.revision, question_revision: (await fixture.json(path)).question_revision });
    expect(retry.sources[0].planning.condition).toBe("needs_you");
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("bound unchanged app planning survives label and metadata observations with separately renewed readiness", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    const issueScope = { source_id: source.id, source_revision: source.revision };
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Hello through HTTP", issue_scope: issueScope });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "hello", title: "Hello", acceptance: "Show hello via HTTP", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Hello graph", issue_scope: issueScope });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    const before = await fixture.json(path);
    fixture.issue.labels.push({ name: "documentation" }); fixture.issue.updated_at = "2026-10-02T12:00:00Z"; fixture.save();
    const changed = (await fixture.json(route + "/sync", {})).sources[0];
    expect(changed.revision).not.toBe(source.revision);
    expect(changed.readiness.eligible).toBe(false);
    expect((await fixture.post(path + "/approvals", { kind: "specification", revision: specification.id, scope: "Stale screen despite unchanged semantics", issue_scope: issueScope })).status).toBe(409);
    await fixture.json(route + "/issues/1/approve", { source_revision: changed.revision, policy_revision: readiness.revision });
    const reused = await fixture.json(route + "/issues/1/prepare", { source_revision: changed.revision });
    expect(reused.sources[0].planning).toMatchObject({ condition: "prepared", specification_id: specification.id, graph_hash: graph.hash });
    fixture.restart(); expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(1);
    const after = await fixture.json(path);
    expect(after.approvals).toEqual(before.approvals); expect(after.tickets).toEqual(before.tickets); expect(after.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("a current app specification can authorize a bounded derived graph without synthetic approvals", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    const issueScope = { source_id: source.id, source_revision: source.revision };
    for (const kind of ["specification", "testing_seams"]) {
      const approval = await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Greeting through public HTTP", issue_scope: issueScope });
      expect(approval.issue_scope).toMatchObject(issueScope);
    }
    await fixture.json(route + "/issues/1/approve", { ...issueScope, policy_revision: readiness.revision });
    expect((await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision })).sources[0].planning.condition).toBe("prepared");
    fixture.restart();
    expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(1);
    const detail = await fixture.json(path);
    expect(detail.approvals).toHaveLength(2);
    expect(detail.tickets).toMatchObject([{ acceptance: fixture.issue.body }]);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("changed applicable testing seams invalidate cached app planning before admission", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const issueScope = { source_id: source.id, source_revision: source.revision };
    const specification = await fixture.json(path + "/specifications", { content: "## Scope\nShow a greeting.\n## Acceptance criteria\nShow hello.\n## Dependencies\nNone." });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP greeting", issue_scope: issueScope });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    const before = await fixture.json(path);
    const graph = before.graph_hash;
    const changed = await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Public HTTP and mobile browser greeting", issue_scope: issueScope });
    const stale = await fixture.json(path);
    expect(stale.github_sources[0].planning.condition).toBe("stale");
    const refused = await fixture.post(path + "/runs", { action: "implement-spec", idempotency_key: "stale-seam-start", issue_scope: { ...issueScope, graph_hash: graph } });
    expect(refused.status).toBe(409);
    const waiting = (await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision })).sources[0].planning;
    expect(waiting.condition).toBe("needs_you");
    expect(waiting.testing_seams).toBe("Public HTTP and mobile browser greeting");
    const decisions = await fixture.json(path);
    expect(decisions.questions).toHaveLength(1);
    expect(decisions.questions[0].question).toContain("changed scope or testing seams");
    await fixture.json(path + `/questions/${decisions.questions[0].id}/answer`, { revision: decisions.questions[0].revision, answer: "Use the explicitly approved mobile browser seam." });
    const renewed = (await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision, question_revision: (await fixture.json(path)).question_revision })).sources[0].planning;
    expect(renewed).toMatchObject({ condition: "prepared", testing_seams: changed.scope, specification_id: specification.id, graph_hash: graph });
    expect((await fixture.json(path)).tickets).toEqual(before.tickets);
    await fixture.json(route + "/sync", {});
    const admitted = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "renewed-seam-start", issue_scope: { ...issueScope, graph_hash: graph } });
    expect(admitted.manifest.issue_admission.planning.testing_seams).toBe("Public HTTP and mobile browser greeting");
    expect((await fixture.json(path)).approvals).toHaveLength(3);
  } finally { fixture.close(); }
}, 20_000);

test("local applicable seam changes pause admitted app work even during a GitHub outage", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const issueScope = { source_id: source.id, source_revision: source.revision };
    const specification = await fixture.json(path + "/specifications", { content: "## Scope\nShow a greeting.\n## Acceptance criteria\nShow hello.\n## Dependencies\nNone." });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP greeting", issue_scope: issueScope });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    const current = (await fixture.json(route + "/sync", {})).sources[0];
    const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "original-app-seams", issue_scope: { ...issueScope, graph_hash: current.planning.graph_hash } });
    expect((await fixture.tracker(run.id)).run.manifest.issue_admission.planning.testing_seams).toBe("Public HTTP greeting");
    fixture.save([fixture.issue], true);
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    expect((await fixture.json(path)).runs[0].condition).toBe("working");
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Generic CLI wording without issue authority" });
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Public HTTP greeting", issue_scope: issueScope });
    expect((await fixture.json(path)).runs[0].condition).toBe("working");
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Public HTTP and mobile browser greeting", issue_scope: issueScope });
    const paused = await fixture.json(path);
    expect(paused.runs[0]).toMatchObject({ condition: "needs_you", issue_pause: { reason: "scope_changed" }, manifest: run.manifest });
    expect(paused.questions).toHaveLength(1);
    expect(paused.questions[0]).toMatchObject({ run_id: run.id, answer: null });
    expect(paused.questions[0].question).toContain("Controlled pause requested: scope_changed");
    fixture.restart();
    const contract = await fixture.tracker(run.id);
    expect(contract.run.manifest).toEqual(run.manifest);
    expect(contract.run.condition).toBe("needs_you");
    expect((await fixture.json(path)).questions).toHaveLength(1);
    expect(fixture.launches).toEqual([run.id]);
  } finally { fixture.close(); }
}, 20_000);

test.each([false, true])("same effective app seams preserve planning and admission without synthetic approvals (spec section: %s)", async explicit => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const issueScope = { source_id: source.id, source_revision: source.revision };
    const specification = await fixture.json(path + "/specifications", { content: explicit ? fixture.issue.body : "## Scope\nShow a greeting.\n## Acceptance criteria\nShow hello.\n## Dependencies\nNone." });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP greeting", issue_scope: issueScope });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    const before = (await fixture.json(route + "/sync", {})).sources[0].planning;
    const reaffirmed = await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: explicit ? "Different approval wording, same explicit specification seams" : "Public HTTP greeting", issue_scope: issueScope });
    const generic = await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Unbound CLI seams" });
    expect(generic.issue_scope).toBeUndefined();
    expect((await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision })).sources[0].planning).toEqual(before);
    const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "same-effective-seams", issue_scope: { ...issueScope, graph_hash: before.graph_hash } });
    expect(run.manifest.issue_admission.planning.testing_seams).toBe(explicit ? "Public HTTP and real browser journeys." : "Public HTTP greeting");
    expect(run.manifest.issue_admission.planning.app_approval_ids).not.toContain(generic.id);
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: reaffirmed.scope, issue_scope: issueScope });
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: specification.id, scope: "Unbound changed CLI seams" });
    fixture.restart();
    const after = await fixture.json(path);
    expect(after.runs[0]).toMatchObject({ condition: "working", manifest: run.manifest });
    expect(after.questions).toEqual([]);
    expect(after.approvals).toHaveLength(6);
    expect(after.tickets).toHaveLength(1);
    expect(after.github_sources[0].planning).toEqual(before);
  } finally { fixture.close(); }
}, 20_000);

test("fallback seam renewal retains the chosen text and original admitted work through explicit successor recovery", async () => {
  const fixture = githubReviewFixture(); let release = () => {};
  try {
    const { path, run, route, source } = await fixture.prepare(undefined, "Public HTTP greeting");
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const gate = fixture.holdStop(); release = gate.release;
    const retiring = fixture.post(`/runs/${run.id}/reconcile`, {});
    await Promise.race([gate.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned retirement did not reach Stop")), 5000))]);
    const issueScope = { source_id: source.id, source_revision: source.revision };
    await fixture.json(path + "/approvals", { kind: "testing_seams", revision: run.specification_id, scope: "Public CLI greeting", issue_scope: issueScope });
    release(); expect((await retiring).status).toBe(409);
    await fixture.json(`/runs/${run.id}/stop`, {});
    fixture.restart(); await fixture.json(`/runs/${run.id}/reconcile`, {});
    let detail = await fixture.json(path);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Retain work and renew the chosen CLI seam." });
    const waiting = (await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision, question_revision: (await fixture.json(path)).question_revision })).sources[0].planning;
    expect(waiting).toMatchObject({ condition: "needs_you", testing_seams: "Public CLI greeting" });
    for (const kind of ["specification", "testing_seams", "ticket_graph"]) await fixture.json(path + "/approvals", { kind, revision: kind === "ticket_graph" ? run.graph_hash : run.specification_id, scope: kind === "testing_seams" ? waiting.testing_seams : "Retain displayed app plan for the current issue", issue_scope: issueScope });
    detail = await fixture.json(path);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Use the explicitly chosen Public CLI greeting seam." });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision, question_revision: (await fixture.json(path)).question_revision });
    await fixture.json(route + "/sync", {});
    const successor = await fixture.json(`/runs/${run.id}/retry`, { idempotency_key: "renewed-fallback-rework", issue_scope: { ...issueScope, graph_hash: run.graph_hash } });
    expect(successor).toMatchObject({ retry_of: run.id, manifest: { rework: { run_id: run.id, head: "a".repeat(40) }, issue_admission: { planning: { testing_seams: "Public CLI greeting" } } } });
    expect((await fixture.json(path)).runs[0].manifest).toEqual(run.manifest);
    expect((run.manifest as any).issue_admission.planning.testing_seams).toBe("Public HTTP greeting");
  } finally { release(); fixture.close(); }
}, 20_000);

test("missing issue-bound fallback seams remain a targeted owner decision", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: "Show hello with separately agreed testing seams." });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Generic manual approval" });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const waiting = (await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision })).sources[0].planning;
    expect(waiting).toMatchObject({ condition: "needs_you", origin: "app_plan", testing_seams: "" });
    const before = await fixture.json(path);
    await fixture.json(path + `/questions/${before.questions[0].id}/answer`, { revision: before.questions[0].revision, answer: "Keep the missing seam decision pending." });
    expect((await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision, question_revision: (await fixture.json(path)).question_revision })).sources[0].planning).toMatchObject({ condition: "needs_you", testing_seams: "" });
    expect((await fixture.json(path)).approvals).toEqual(before.approvals);
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("an empty explicit testing-seams section requires a seam decision rather than approval audit text", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: "## Scope\nShow hello.\n## Testing seams\n" });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Approval audit text", issue_scope: { source_id: source.id, source_revision: source.revision } });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const waiting = (await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision })).sources[0].planning;
    expect(waiting).toMatchObject({ condition: "needs_you", testing_seams: "" });
    expect((await fixture.json(path)).questions[0].question).toContain("testing seams");
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("explicit Start admits the prepared trusted plan with its frozen authorization and quality gates", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, source, project } = await prepared(fixture);
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(202);
    const run = await response.json();
    expect(run).toMatchObject({ action: "implement-spec", condition: "working", specification_id: source.planning.specification_id, graph_hash: source.planning.graph_hash });
    expect(run.manifest.issue_admission).toMatchObject({ source: { id: source.id, revision: source.revision }, planning: { testing_seams: "Public HTTP and real browser journeys.", authorization: { checks_required: true, independent_reviews: ["standards", "spec"] } }, queue_policy: { automatic_implementation: false } });
    expect(run.manifest.project.checks).toEqual(project.checks);
    expect(run.manifest.tickets).toHaveLength(1);
    const detail = await fixture.json(path);
    expect(detail.approvals).toEqual([]);
    expect((await fixture.json(path + "/runs", start)).id).toBe(run.id);
    const reordered = { ...start, issue_scope: { graph_hash: start.issue_scope.graph_hash, source_revision: start.issue_scope.source_revision, source_id: start.issue_scope.source_id } };
    expect((await fixture.json(path + "/runs", reordered)).id).toBe(run.id);
    expect((await fixture.json(path)).runs).toHaveLength(1);
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: run.base });
    expect(accepted.status).toBe(409);
    expect((await accepted.json()).error.code).toBe("fresh_evidence_required");
  } finally { fixture.close(); }
}, 20_000);

test.each(["outage", "readiness"] as const)("retained natural issue planning survives %s without authorizing Start until fresh recovery", async loss => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route, readiness } = await prepared(fixture);
    const before = await fixture.json(path);
    expect(before.approvals).toEqual([]);
    if (loss === "readiness") fixture.issue.labels = [];
    fixture.save([fixture.issue], loss === "outage");
    expect((await fixture.post(route + "/sync", {})).status).toBe(loss === "outage" ? 409 : 200);
    const stale = await fixture.json(path);
    expect(stale.github_sources[0].planning).toMatchObject({ condition: "stale", origin: "issue_body", specification_id: before.specifications.at(-1).id, graph_hash: before.graph_hash });
    expect(stale.specifications).toEqual(before.specifications); expect(stale.tickets).toEqual(before.tickets);
    expect(stale.approvals).toEqual([]); expect(stale.questions).toEqual([]);
    const refused = await fixture.post(path + "/runs", start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe(loss === "outage" ? "issue_not_eligible" : "issue_changed");
    expect((await fixture.json(path)).runs).toEqual([]); expect(fixture.launches).toEqual([]);
    fixture.issue.labels = [{ name: "ready-for-agent" }]; fixture.save();
    let current = (await fixture.json(route + "/sync", {})).sources[0];
    if (loss === "readiness") {
      await fixture.json(route + "/issues/1/approve", { source_revision: current.revision, policy_revision: readiness.revision });
      expect((await fixture.json(path)).github_sources[0].planning.condition).toBe("stale");
      const stillBlocked = await fixture.post(path + "/runs", { ...start, issue_scope: { ...start.issue_scope, source_revision: current.revision } });
      expect(stillBlocked.status).toBe(409); expect((await stillBlocked.json()).error.code).toBe("issue_not_eligible");
      expect((await fixture.json(path)).runs).toEqual([]); expect(fixture.launches).toEqual([]);
    }
    await fixture.json(route + "/issues/1/prepare", { source_revision: current.revision });
    current = (await fixture.json(route + "/sync", {})).sources[0];
    const admitted = await fixture.json(path + "/runs", { ...start, issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
    expect(admitted).toMatchObject({ condition: "working", manifest: { issue_admission: { source: { id: current.id, revision: current.revision }, planning: { graph_hash: current.planning.graph_hash } } } });
    expect((await fixture.json(path)).approvals).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("Pause queue refuses a new explicit issue Start while keeping its prepared plan", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("queue_paused");
    const detail = await fixture.json(path);
    expect(detail.runs).toEqual([]);
    expect(detail.github_sources[0].planning.condition).toBe("prepared");
  } finally { fixture.close(); }
}, 20_000);

test.each(["paused", "outage", "changed_scope", "unresolved_dependencies", "needs_you"])("ordinary Start cannot omit formerly prepared issue provenance with %s evidence", async blocker => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, source, route, readiness } = await prepared(fixture);
    const issueScope = { source_id: source.id, source_revision: source.revision };
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: source.planning.specification_id, scope: "Public HTTP and real browser journeys.", issue_scope: issueScope });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: source.planning.graph_hash, scope: "Approved bounded greeting", issue_scope: issueScope });
    expect((await fixture.json(path)).questions).toEqual([]);
    if (blocker === "paused") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    if (blocker === "outage") { fixture.save([fixture.issue], true); expect((await fixture.post(route + "/sync", {})).status).toBe(409); }
    if (blocker === "changed_scope" || blocker === "needs_you") {
      fixture.issue.body += "\nChange the greeting after preparation.";
      fixture.save(); await fixture.json(route + "/sync", {});
      if (blocker === "needs_you") {
        const current = (await fixture.json(route)).sources[0];
        await fixture.json(route + "/issues/1/approve", { source_revision: current.revision, policy_revision: readiness.revision });
        await fixture.json(route + "/issues/1/prepare", { source_revision: current.revision });
      }
    }
    if (blocker === "unresolved_dependencies") {
      fixture.save([fixture.issue], false, { 1: [{ ...fixture.issue, number: 42, node_id: "missing-dependency", html_url: "https://github.com/fictional/project/issues/42" }] });
      await fixture.json(route + "/sync", {});
    }
    if (blocker !== "paused") expect((await fixture.json(path)).github_sources[0].planning.condition).not.toBe("prepared");
    for (const route of ["/runs", "/continue"]) {
      const response = await fixture.post(path + route, { action: "implement-spec", idempotency_key: "ordinary-prepared-start" + route.slice(1), run_id: null });
      expect(response.status).toBe(409);
      // Only an actual scope/relationship edit introduces a product question here.
      const code = (await response.json()).error.code;
      if (route === "/runs") expect(code).toBe("issue_scope_required");
      else expect(code).toBe(["changed_scope", "needs_you", "unresolved_dependencies"].includes(blocker) ? "answers_unready" : "issue_scope_required");
    }
    expect((await fixture.json(path)).runs).toEqual([]);
    expect(fixture.launches).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("issue preparation during an ordinary Start cannot bypass final guarded admission", async () => {
  const fixture = githubQueueFixture(true);
  let release: (() => void) | undefined;
  let starting: Promise<Response> | undefined;
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const issueScope = { source_id: source.id, source_revision: source.revision };
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP and real browser journeys.", issue_scope: issueScope });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Approved bounded greeting", issue_scope: issueScope });
    const gate = fixture.holdCapabilities(); release = gate.release;
    starting = fixture.post(path + "/runs", { action: "implement-spec", idempotency_key: "prepare-during-start" });
    await gate.waiting;
    const prepared = await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    expect(prepared.sources[0].planning.condition).toBe("prepared");
    expect((await fixture.json(path)).questions).toEqual([]);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    gate.release();
    const refused = await starting;
    expect(refused.status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([]);
    expect(fixture.launches).toEqual([]);
  } finally { release?.(); await starting?.catch(() => undefined); fixture.close(); }
}, 20_000);

test("explicit issue Start follows current board priority", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("queue_priority_changed");
    await fixture.json(second.path + "/order", { before_id: path.split("/").at(-1) });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
  } finally { fixture.close(); }
}, 20_000);

test("Project implementing capacity remains reserved by an admitted issue Run", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("project_capacity_exhausted");
    expect((await fixture.json(second.path)).runs).toEqual([]);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
  } finally { fixture.close(); }
}, 20_000);

test("a Start key cannot replay a different trusted issue scope", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const changed = { ...start, issue_scope: { ...start.issue_scope, source_revision: "another-revision" } };
    const refused = await fixture.post(path + "/runs", changed);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("idempotency_conflict");
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);

test("local approved specification changes pause admitted issue work without a GitHub sync", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], true);
    const replacement = await fixture.json(path + "/specifications", { content: "Show a different greeting through the approved public seams." });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: replacement.id, scope: "Public HTTP and real browser journeys." });
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" }, specification_id: run.specification_id, graph_hash: run.graph_hash, manifest: run.manifest });
    const worker = await fixture.post(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "after-local-change" });
    expect(worker.status).toBe(409);
    expect((await worker.json()).error.code).toBe("issue_pause_required");
  } finally { fixture.close(); }
}, 20_000);

test("local graph changes pause once, retain uncertain workers and survive restart while unchanged approvals do not pause", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, source, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: source.planning.specification_id, scope: "Public HTTP and real browser journeys." });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: run.graph_hash, scope: "Same bounded greeting" });
    expect((await fixture.json(path)).runs[0].issue_pause).toBeUndefined();
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "uncertain-before-local-change" });
    expect(worker.condition).toBe("disconnected");
    fixture.save([fixture.issue], true);
    const graph = await fixture.json(path + "/tickets", { specification_id: run.specification_id, tickets: [{ key: "different", title: "Different greeting", acceptance: "Show the new greeting", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Reviewed new graph" });
    let detail = await fixture.json(path);
    const paused = detail.runs[0];
    expect(paused).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" }, manifest: run.manifest, worktree: run.worktree, graph_hash: run.graph_hash });
    expect(detail.workers).toEqual([worker]);
    expect(detail.questions.filter((question: any) => question.question.startsWith("Controlled pause requested:"))).toHaveLength(1);
    const unrelated = await fixture.json("/implementations", { title: "Unrelated manual Assignment", description: "Keep manual decisions independent", project_id: source.project_id });
    await fixture.json(`/implementations/${unrelated.id}/specifications`, { content: "An unrelated approved manual change" });
    const policy = (await fixture.json(route)).policy;
    expect(policy.sync_enabled).toBe(false);
    fixture.restart();
    detail = await fixture.json(path);
    expect(detail.runs[0].issue_pause).toEqual(paused.issue_pause);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.workers).toEqual([worker]);
    expect(detail.questions.filter((question: any) => question.question.startsWith("Controlled pause requested:"))).toHaveLength(1);
    const refused = await fixture.post(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "after-local-graph-restart" });
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("issue_pause_required");
    expect((await fixture.json(`/implementations/${unrelated.id}`)).questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("a worker allocation awaiting native observation cannot pass a concurrent local scope change", async () => {
  const fixture = githubQueueFixture(true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve);
  try {
    const { path, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.setExecutionHandler(async request => {
      if (new URL(request.url).pathname.endsWith("/operations/head")) { entered(); await gate; }
      return null;
    });
    const allocating = fixture.post(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "racing-local-change" });
    await waiting;
    const replacement = await fixture.json(path + "/specifications", { content: "A changed local specification" });
    await fixture.json(path + "/approvals", { kind: "specification", revision: replacement.id, scope: "Reviewed changed greeting" });
    release();
    const refused = await allocating;
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("issue_pause_required");
    const detail = await fixture.json(path);
    expect(detail.workers).toEqual([]);
    expect(detail.runs[0]).toMatchObject({ issue_pause: { reason: "scope_changed" }, manifest: run.manifest });
  } finally { release(); fixture.close(); }
}, 20_000);

test("a known active-scope edit requests controlled pause without rewriting the admitted contract", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.issue.body += "\nA newly requested behavior.";
    fixture.issue.updated_at = "2026-10-02T12:00:00Z";
    fixture.save(); await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed", source_id: start.issue_scope.source_id } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.runs[0].worktree).toBe(run.worktree);
    expect(detail.questions.some((question: any) => question.run_id === run.id && question.answer === null)).toBe(true);
    const worker = await fixture.post(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "paused-worker" });
    expect(worker.status).toBe(409); expect((await worker.json()).error.code).toBe("issue_pause_required");
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { fixture.close(); }
}, 20_000);

test("an inventory edit pauses admitted work before a later dependency failure", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.issue.body += "\nNew behavior observed in the inventory.";
    fixture.save([fixture.issue], false, { "1": null });
    const held = fixture.holdSync("/dependencies/blocked_by"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].condition).toBe("needs_you");
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { release(); fixture.close(); }
}, 20_000);

test("observed native dependency changes pause frozen work before a PR outage", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependency = { ...fixture.issue, number: 2, node_id: "new-prerequisite", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue], false, { "1": [dependency] }, false, [fixture.issue], undefined, { pulls_fail: true });
    const held = fixture.holdSync("graphql"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
      expect(detail.github_sources[0].current.native_dependencies).toEqual([]);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    expect((await fixture.json(path)).github_sync.problem).toContain("PR inventory");
  } finally { release(); fixture.close(); }
}, 20_000);

test("a validated added dependency pauses frozen work before the next dependency page fails", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependencies = Array.from({ length: 30 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `prerequisite-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], undefined, { dependency_pages: { "1": [dependencies, null] } });
    const held = fixture.holdSync("/dependencies/blocked_by?per_page=30&page=2"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
  } finally { release(); fixture.close(); }
}, 20_000);

test.each([
  ["title", "dependency", "scope_changed"],
  ["body", "pulls", "scope_changed"],
  ["closure", "dependency", "issue_closed"],
  ["readiness", "pulls", "readiness_revoked"],
  ["blocked", "dependency", "readiness_revoked"],
])("inventory %s drift survives a later %s failure", async (change, failure, reason) => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    if (change === "title") fixture.issue.title = "New title";
    if (change === "body") fixture.issue.body += "\nNew scope.";
    if (change === "closure") fixture.issue.state = "closed";
    if (change === "readiness") fixture.issue.labels = [];
    if (change === "blocked") fixture.issue.labels.push({ name: "blocked" });
    fixture.save([fixture.issue], false, failure === "dependency" ? { "1": null } : {}, false, [fixture.issue], undefined, { pulls_fail: failure === "pulls" });
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause?.reason).toBe(reason);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
    expect(detail.github_sync.problem).toBeString();
    expect(detail.implementation.outcome).toBe("none");
  } finally { fixture.close(); }
}, 20_000);

test.each(["body", "closure", "readiness"])("positive %s drift on an issue page survives a later page failure", async change => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "owned-partial-inventory-worker" });
    expect(worker.condition).toBe("disconnected");
    const siblings = Array.from({ length: 29 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `sibling-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    if (change === "body") fixture.issue.body += "\nEdited on the first page.";
    if (change === "closure") fixture.issue.state = "closed";
    if (change === "readiness") fixture.issue.labels = [];
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], undefined, { issue_pages: [[fixture.issue, ...siblings], null] });
    const held = fixture.holdSync("/issues?state=all&per_page=30&page=2"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    const reason = change === "closure" ? "issue_closed" : change === "readiness" ? "readiness_revoked" : "scope_changed";
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe(reason);
      expect(detail.runs[0].manifest).toEqual(run.manifest);
      expect(detail.workers).toEqual([worker]);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    await fixture.post(route + "/sync", {});
    fixture.restart();
    const detail = await fixture.json(path);
    expect(detail.runs[0].issue_pause?.reason).toBe(reason);
    expect(detail.runs[0].worktree).toBe(run.worktree);
    expect(detail.workers).toEqual([worker]);
    expect(detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
  } finally { release(); fixture.close(); }
}, 20_000);

test.each(["missing", "malformed", "dependency", "pulls", "unrelated_label"])("%s inventory evidence alone leaves frozen work running", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const siblings = Array.from({ length: 30 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `sibling-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    const malformed = { ...fixture.issue, body: "Unvalidated changed scope", updated_at: "not-a-timestamp" };
    if (failure === "unrelated_label") fixture.issue.labels.push({ name: "documentation" });
    fixture.save([fixture.issue], false, failure === "dependency" || failure === "unrelated_label" ? { "1": null } : {}, false, [fixture.issue], undefined, { issue_pages: failure === "missing" ? [siblings, null] : failure === "malformed" ? [[malformed]] : undefined, pulls_fail: failure === "pulls" });
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
  } finally { fixture.close(); }
}, 20_000);

test("a malformed dependency alone cannot pause frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, { "1": [{ ...fixture.issue, number: 2, node_id: "unvalidated-prerequisite", html_url: "https://github.com/fictional/project/issues/2", updated_at: "invalid" }] });
    const response = await fixture.post(route + "/sync", {});
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("github_dependencies_incomplete");
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("an edit detected during readiness collection pauses frozen work before another sync", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, body: fixture.issue.body + "\nNew behavior." }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { fixture.close(); }
}, 20_000);

test("closure detected during readiness collection pauses the admitted Run", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, state: "closed" }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("issue_closed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.implementation.outcome).toBe("none");
  } finally { fixture.close(); }
}, 20_000);

test("readiness removal detected during collection pauses frozen work despite incomplete evidence", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, labels: [] }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("readiness_revoked");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).questions).toHaveLength(detail.questions.length);
  } finally { fixture.close(); }
}, 20_000);

test("an unrelated label added at the readiness fence leaves frozen execution and ownership unchanged", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "owned-label-fence-worker" });
    const fresh = { ...fixture.issue, labels: [...fixture.issue.labels, { name: "documentation" }], updated_at: "2026-10-02T12:00:00Z" };
    fixture.save([fixture.issue], false, {}, false, [fresh]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.github_sources[0].readiness.blockers).toContain("evidence_incomplete");
    expect(detail.runs[0]).toEqual(run);
    expect(detail.workers).toEqual([worker]);
    expect(detail.questions).toEqual([]);
    fixture.issue.labels = fresh.labels; fixture.issue.updated_at = fresh.updated_at; fixture.save();
    await fixture.json(route + "/sync", {});
    fixture.restart();
    const recovered = await fixture.json(path);
    expect(recovered.github_sources[0].readiness_evidence.complete).toBe(true);
    expect(recovered.github_sources[0].readiness.eligible).toBe(false);
    expect(recovered.runs[0]).toEqual(run);
    expect(recovered.workers).toEqual([worker]);
    expect(recovered.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

const customReadinessLabels = { triage_labels: { "needs-triage": "Triage", "needs-info": "Question", "ready-for-agent": "Go", "ready-for-human": "Human", "wontfix": "Declined" }, blocked_label: "Hold" };

test.each(["body edit", "rename"])("a proven later %s still pauses restored scope after unrelated metadata observations", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.issue.labels.push({ name: "documentation" }); fixture.save();
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).runs[0]).toEqual(run);
    const at = new Date(Date.now() + 2000).toISOString();
    fixture.issue.updated_at = at;
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], {
      events: change === "rename" ? [{ id: 200, event: "renamed", created_at: at }] : [],
      proof: { id: fixture.issue.node_id, title: fixture.issue.title, body: fixture.issue.body, state: "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: at, lastEditedAt: change === "body edit" ? at : null },
    });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(true);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test.each(["addition", "removal", "reorder", "case"])("custom readiness labels tolerate irrelevant %s at the REST fence and later complete observations", async change => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.issue.labels = [{ name: "Go" }, { name: "documentation" }, { name: "backend" }]; fixture.save();
    const { path, start, route } = await prepared(fixture, false, customReadinessLabels);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "owned-custom-label-worker" });
    const labels = change === "addition" ? [...fixture.issue.labels, { name: "blocked" }, { name: "needs-info" }]
      : change === "removal" ? fixture.issue.labels.filter(label => label.name !== "documentation")
      : change === "reorder" ? fixture.issue.labels.slice().reverse()
      : fixture.issue.labels.map(label => ({ name: label.name.toUpperCase() }));
    const fresh = { ...fixture.issue, labels };
    fixture.save([fixture.issue], false, {}, false, [fresh]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(change === "reorder");
    expect(detail.runs[0]).toEqual(run);
    expect(detail.workers).toEqual([worker]); expect(detail.questions).toEqual([]);
    fixture.issue.labels = labels; fixture.save();
    await fixture.json(route + "/sync", {}); fixture.restart();
    const recovered = await fixture.json(path);
    expect(recovered.github_sources[0].readiness_evidence.complete).toBe(true);
    expect(recovered.github_sources[0].readiness.eligible).toBe(change === "reorder");
    expect(recovered.runs[0]).toEqual(run);
    expect(recovered.workers).toEqual([worker]); expect(recovered.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["ready removal", "hold", "triage", "question", "human", "declined", "nonready"])("custom %s with an unrelated label still requests a durable controlled pause at the fence", async change => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.issue.labels = [{ name: "Go" }]; fixture.save();
    const { path, start, route } = await prepared(fixture, false, customReadinessLabels);
    const run = await fixture.json(path + "/runs", start);
    const labels = [{ name: "documentation" }, ...(change === "ready removal" || change === "nonready" ? [] : [{ name: "GO" }]), ...(change === "ready removal" ? [] : [{ name: change === "nonready" ? "QUESTION" : change.toUpperCase() }])];
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, labels }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "readiness_revoked" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    const questions = detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null);
    expect(questions).toHaveLength(1);
    // Complete unchanged scope cannot automatically clear a real revocation.
    fixture.save(); await fixture.json(route + "/sync", {}); fixture.restart();
    const recovered = await fixture.json(path);
    expect(recovered.runs[0]).toEqual({ ...detail.runs[0], updated_at: expect.any(String) });
    expect(recovered.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toEqual(questions);
  } finally { fixture.close(); }
}, 20_000);

test("native dependency drift detected during readiness collection pauses frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependency = { ...fixture.issue, number: 2, node_id: "new-dependency", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { dependencies: { "1": [dependency] } });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("scope_changed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test.each(["body", "title", "closure"])("%s drift proven by GraphQL during readiness collection pauses frozen work", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { proof: { id: fixture.issue.node_id, title: change === "title" ? "Renamed after REST" : fixture.issue.title, body: fixture.issue.body + (change === "body" ? "\nEdited after REST." : ""), state: change === "closure" ? "CLOSED" : "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z", lastEditedAt: "2026-10-02T12:00:00Z" } });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe(change === "closure" ? "issue_closed" : "scope_changed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test("a malformed fresh issue response leaves admitted frozen work running", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, body: "Malformed response with a different body", updated_at: "not-a-timestamp" }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["native", "graphql", "unavailable", "timestamp"])("incomplete %s readiness evidence alone preserves admitted frozen work", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const fresh = { ...fixture.issue, ...(failure === "timestamp" ? { updated_at: "2026-10-02T12:00:00Z" } : {}) };
    const invalidProof = { id: fixture.issue.node_id, title: fixture.issue.title, body: "Different body in malformed evidence", state: "OPEN", createdAt: "invalid", updatedAt: fixture.issue.updated_at, lastEditedAt: null };
    fixture.save([fixture.issue], false, {}, false, [fresh], failure === "native" ? { dependencies: { "1": null } } : failure === "graphql" ? { proof: invalidProof } : failure === "unavailable" ? { proof: null } : undefined);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["scope", "closure", "readiness", "outage", "pause", "policy"])("Start revalidates %s changed during native observation before admitting work", async change => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route, readiness } = await prepared(fixture);
    const held = fixture.holdCapabilities(); release = held.release;
    const pending = fixture.post(path + "/runs", start);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Native fixture did not reach admission gate")), 5000))]);
    if (change === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    else if (change === "policy") await fixture.json(route + "/readiness", { expected_revision: readiness.revision, account_profile_id: readiness.account_profile_id, triage_labels: {}, blocked_label: "on-hold" });
    else {
      if (change === "scope") fixture.issue.body += "\nChanged testing requirement.";
      if (change === "closure") fixture.issue.state = "closed";
      if (change === "readiness") fixture.issue.labels = [];
      fixture.save([fixture.issue], change === "outage");
      const sync = await fixture.post(route + "/sync", {});
      expect(sync.status).toBe(change === "outage" ? 409 : 200);
    }
    release();
    expect((await pending).status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { release(); fixture.close(); }
}, 20_000);

test("outage retains visible evidence and admitted frozen work while blocking a fresh Start", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], true);
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.github_sync.problem).toBeString();
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(409);
    expect((await fixture.json(path + "/runs", start)).id).toBe(run.id);
  } finally { fixture.close(); }
}, 20_000);

test("concurrent and overlapping Start requests retain one admitted attempt", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start } = await prepared(fixture);
    const held = fixture.holdCapabilities(); release = held.release;
    const first = fixture.post(path + "/runs", start);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Native fixture did not reach admission gate")), 5000))]);
    const replay = fixture.post(path + "/runs", start);
    const other = fixture.post(path + "/runs", { ...start, idempotency_key: "overlapping-request" });
    release();
    const responses = await Promise.all([first, replay, other]);
    expect(responses.map(response => response.status)).toEqual([202, 202, 409]);
    expect((await responses[0]!.json()).id).toBe((await responses[1]!.json()).id);
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { release(); fixture.close(); }
}, 20_000);

test("scope pause retains unreachable worker ownership and owner answers cannot resume frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, route, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "unreachable-native-worker" });
    expect(worker.condition).toBe("disconnected");
    fixture.issue.body += "\nChanged scope."; fixture.save(); await fixture.json(route + "/sync", {});
    let detail = await fixture.json(path);
    expect(detail.workers[0]).toEqual(worker);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Preserve the work for a separately authorized attempt." });
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("scope_changed");
    const send = await fixture.post(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "do-not-resume" });
    expect(send.status).toBe(409); expect((await send.json()).error.code).toBe("issue_pause_required");
    expect((await fixture.json(path)).workers[0]).toEqual(worker);
  } finally { fixture.close(); }
}, 20_000);

test("an unfinished GitHub inventory cannot authorize admission from the previous snapshot", async () => {
  const fixture = githubQueueFixture(true); let release = () => {}; let sync: Promise<Response> | undefined;
  try {
    const { path, route, start } = await prepared(fixture);
    const held = fixture.holdSync(); release = held.release;
    sync = fixture.post(route + "/sync", {}); await held.waiting;
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("github_busy");
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { release(); await sync; fixture.close(); }
}, 20_000);

test.each(["readiness", "closure"])("known active %s changes request a durable owner decision", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, route, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    if (change === "closure") fixture.issue.state = "closed"; else fixture.issue.labels = [];
    fixture.save(); await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ condition: "needs_you", issue_pause: { reason: change === "closure" ? "issue_closed" : "readiness_revoked" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.implementation.outcome).toBe("none");
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).questions).toHaveLength(detail.questions.length);
  } finally { fixture.close(); }
}, 20_000);

test("global agent capacity remains effective even when the Project allows another implementation", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, route, readiness, start } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    await fixture.json("/settings", { max_agents: 1 });
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const response = await fixture.post(second.path + "/runs", second.start);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("capacity_exhausted");
    expect((await fixture.json(second.path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);


test.each(["free", "worker", "build"])("a confirmed owner Stop permits one explicit successor after current scope resolution while retaining %s ownership", async ownership => {
  const fixture = githubReviewFixture(); let release = () => {};
  try {
    const { path, run, route, readiness, source } = await fixture.prepare();
    if (ownership === "worker") await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: (run.manifest as { tickets: { id: string }[] }).tickets[0]!.id, idempotency_key: "retained-native-worker" });
    if (ownership === "build") { fixture.setCheck("interrupted"); await fixture.json(`/runs/${run.id}/checks`, {}); }
    fixture.issue.body += "\nA reviewed change to the greeting.";
    fixture.save(); await fixture.json(route + "/sync", {});
    const scope = { source_id: source.id, source_revision: source.revision, graph_hash: run.graph_hash };
    expect((await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "before-stop", issue_scope: scope })).status).toBe(409);
    fixture.setUncertainStop(true);
    expect((await fixture.post(`/runs/${run.id}/stop`, {})).status).toBe(409);
    expect((await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "uncertain-stop", issue_scope: scope })).status).toBe(409);
    fixture.setUncertainStop(false);
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped).toMatchObject({ condition: "cancelled", issue_pause: { reason: "scope_changed" }, worktree: run.worktree, manifest: run.manifest });
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    let detail = await fixture.json(path);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Keep produced work and use the reviewed current issue plan in a new attempt." });
    const current = (await fixture.json(route)).sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: current.revision, policy_revision: readiness.revision });
    detail = await fixture.json(path);
    await fixture.json(route + "/issues/1/prepare", { source_revision: current.revision, question_revision: detail.question_revision });
    await fixture.json(route + "/sync", {}); fixture.restart();
    detail = await fixture.json(path);
    expect(detail.runs).toEqual([stopped]);
    const prepared = detail.github_sources[0];
    const successorScope = { source_id: source.id, source_revision: prepared.revision, graph_hash: prepared.planning.graph_hash };
    expect((await fixture.post(path + "/runs", { action: "implement-spec", idempotency_key: "no-automatic-resume", issue_scope: successorScope })).status).toBe(409);
    const generic = await fixture.post(path + "/runs", { action: "implement-spec", idempotency_key: "no-manual-bypass" });
    expect((await generic.json()).error.code).toBe("retry_required");
    const retry = { idempotency_key: "owner-stopped-successor", issue_scope: successorScope };
    if (ownership !== "free") {
      const response = await fixture.post(`/runs/${run.id}/retry`, retry);
      expect(response.status).toBe(409);
      expect(["implementation_owned", "project_capacity_exhausted"]).toContain((await response.json()).error.code);
      const retained = await fixture.json(path);
      expect(retained.runs).toEqual([stopped]);
      expect(ownership === "worker" ? retained.workers[0].condition : retained.checks[0].condition).toBe(ownership === "worker" ? "ready" : "interrupted");
      return;
    }
    const held = fixture.holdCapabilities(); release = held.release;
    const first = fixture.post(`/runs/${run.id}/retry`, retry);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Successor did not reach native observation")), 5000))]);
    const same = fixture.post(`/runs/${run.id}/retry`, retry);
    const other = fixture.post(`/runs/${run.id}/retry`, { ...retry, idempotency_key: "competing-successor" });
    release();
    const responses = await Promise.all([first, same, other]);
    expect(responses.map(response => response.status)).toEqual([202, 202, 409]);
    const next = await responses[0]!.json();
    expect((await responses[1]!.json()).id).toBe(next.id);
    expect(next).toMatchObject({ condition: "working", retry_of: run.id, manifest: { issue_admission: { source: { revision: prepared.revision } } } });
    expect((await fixture.json(`/runs/${run.id}/retry`, retry)).id).toBe(next.id);
    expect((await fixture.json(path)).runs).toEqual([stopped, next]);
  } finally { release(); fixture.close(); }
}, 30_000);

test.each([
  ["to-spec", "cancelled"], ["to-spec", "completed"], ["verify-provider", "cancelled"], ["verify-provider", "completed"],
])("%s ending %s after failure preserves explicit Retry of the latest implementation attempt", async (action, condition) => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    fixture.setLaunchOutcome("working");
    const planning = await fixture.json(path + "/runs", { action, idempotency_key: "planning-after-failure" });
    const retry = { idempotency_key: "retry-after-planning", issue_scope: start.issue_scope };
    expect((await fixture.post(`/runs/${failed.id}/retry`, retry)).status).toBe(409);
    let nativeCondition = "disconnected";
    fixture.setExecutionHandler(async request => new RegExp(`/runs/${planning.id}/(stop|reconcile)$`).test(new URL(request.url).pathname) ? Response.json({ ...planning, condition: nativeCondition }) : null);
    await fixture.json(`/runs/${planning.id}/reconcile`, {});
    fixture.restart();
    expect((await fixture.post(`/runs/${failed.id}/retry`, retry)).status).toBe(409);
    expect(fixture.launches).toEqual([failed.id, planning.id]);
    nativeCondition = condition!;
    await fixture.json(`/runs/${planning.id}/${condition === "cancelled" ? "stop" : "reconcile"}`, {});
    fixture.restart();
    const response = await fixture.post(`/runs/${failed.id}/retry`, retry);
    expect(response.status).toBe(202);
    const next = await response.json();
    expect(next).toMatchObject({ condition: "working", retry_of: failed.id });
    expect((await fixture.json(path)).runs.map((run: any) => [run.id, run.condition])).toEqual([[failed.id, "failed"], [planning.id, condition], [next.id, "working"]]);
    const superseded = await fixture.post(`/runs/${failed.id}/retry`, { ...retry, idempotency_key: "obsolete-predecessor" });
    expect(superseded.status).toBe(409); expect((await superseded.json()).error.code).toBe("retry_superseded");
  } finally { fixture.close(); }
}, 20_000);

test("failed issue work waits through sync and restart for explicit owner Retry", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    expect(failed.condition).toBe("failed");
    await fixture.json(route + "/sync", {}); fixture.restart();
    const replay = await fixture.json(path + "/runs", start);
    expect(replay.id).toBe(failed.id);
    expect(fixture.launches).toEqual([failed.id]);
    const retry = { idempotency_key: "owner-retry", issue_scope: start.issue_scope };
    fixture.setLaunchOutcome("working");
    const response = await fixture.post(`/runs/${failed.id}/retry`, retry);
    expect(response.status).toBe(202);
    const next = await response.json();
    expect(next).toMatchObject({ condition: "working", retry_of: failed.id });
    expect(next.id).not.toBe(failed.id);
    expect((await fixture.json(path)).runs).toEqual([failed, next]);
    expect(fixture.launches).toEqual([failed.id, next.id]);
  } finally { fixture.close(); }
}, 20_000);

test("an explicitly retried implementation supersedes the historical failure for later Start decisions", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    fixture.setLaunchOutcome("working");
    const next = await fixture.json(`/runs/${failed.id}/retry`, { idempotency_key: "newest-implementation", issue_scope: start.issue_scope });
    fixture.setExecutionHandler(async request => new URL(request.url).pathname.endsWith(`/runs/${next.id}/reconcile`) ? Response.json({ ...next, condition: "completed" }) : null);
    await fixture.json(`/runs/${next.id}/reconcile`, {});
    fixture.restart();
    const response = await fixture.post(path + "/runs", { ...start, idempotency_key: "after-retried-implementation" });
    expect(response.status).toBe(409);
    // The latest attempt already exists; the old failed attempt cannot demand Retry forever.
    expect((await response.json()).error.code).toBe("issue_not_eligible");
    expect((await fixture.json(path)).runs).toHaveLength(2);
  } finally { fixture.close(); }
}, 20_000);

test("restart recovers a lost launch response by observing the admitted identity without replay", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    fixture.setLaunchOutcome("lost");
    const uncertain = await fixture.json(path + "/runs", start);
    expect(uncertain.condition).toBe("disconnected");
    fixture.restart();
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ id: uncertain.id, condition: "working" });
    expect(detail.runs[0].manifest).toEqual(uncertain.manifest);
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path + "/runs", start)).id).toBe(uncertain.id);
    expect(fixture.launches).toEqual([uncertain.id]);
    const retry = await fixture.post(`/runs/${uncertain.id}/retry`, { idempotency_key: "do-not-replay", issue_scope: start.issue_scope });
    expect(retry.status).toBe(409);
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);

test("a new Start key cannot silently retry failed issue work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    for (const body of [{ ...start, idempotency_key: "renewed-eligibility" }, { action: "implement-spec", idempotency_key: "generic-start" }]) {
      const response = await fixture.post(path + "/runs", body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("retry_required");
    }
    expect(fixture.launches).toEqual([failed.id]);
  } finally { fixture.close(); }
}, 20_000);


test("restart during native launch retains the accepted intent and recovers the same Run", async () => {
  const fixture = githubQueueFixture(true); let release = () => {}; let pending: Promise<Response> | undefined;
  try {
    const { path, start } = await prepared(fixture);
    const held = fixture.holdLaunch(); release = held.release;
    pending = fixture.post(path + "/runs", start).catch(() => new Response(null, { status: 503 }));
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Launch fixture never accepted the Run")), 5000))]);
    const accepted = (await fixture.json(path)).runs[0];
    expect(accepted.condition).toBe("accepted");
    fixture.restart();
    const recovered = (await fixture.tracker(accepted.id)).run;
    expect(recovered.id).toBe(accepted.id);
    expect(recovered.condition).toBe("working");
    expect(recovered.manifest).toEqual(accepted.manifest);
    release(); await pending;
    expect((await fixture.json(path + "/runs", start)).id).toBe(accepted.id);
    expect(fixture.launches).toEqual([accepted.id]);
  } finally { release(); await pending; fixture.close(); }
}, 20_000);

test("concurrent owner retries and a lost Retry response create one successor with retained history", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed"); const failed = await fixture.json(path + "/runs", start);
    fixture.setLaunchOutcome("lost");
    const held = fixture.holdCapabilities(); release = held.release;
    const retry = { idempotency_key: "same-retry", issue_scope: start.issue_scope };
    const first = fixture.post(`/runs/${failed.id}/retry`, retry);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Retry fixture never reached its gate")), 5000))]);
    const same = fixture.post(`/runs/${failed.id}/retry`, retry);
    const other = fixture.post(`/runs/${failed.id}/retry`, { ...retry, idempotency_key: "overlapping-retry" });
    release();
    const results = await Promise.all([first, same, other]);
    expect(results.map(result => result.status)).toEqual([202, 202, 409]);
    const next = await results[0]!.json();
    expect((await results[1]!.json()).id).toBe(next.id);
    fixture.restart();
    expect((await fixture.json(`/runs/${failed.id}/retry`, retry)).id).toBe(next.id);
    expect((await fixture.json(path)).runs.map((run: any) => [run.id, run.condition, run.retry_of ?? null])).toEqual([[failed.id, "failed", null], [next.id, "working", failed.id]]);
    expect(fixture.launches).toEqual([failed.id, next.id]);
  } finally { release(); fixture.close(); }
}, 20_000);

test("unreachable execution after restart retains Project capacity until its original identity is observed", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Next issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    fixture.setLaunchOutcome("lost"); const uncertain = await fixture.json(path + "/runs", start);
    fixture.setHostOffline(true); fixture.restart();
    expect((await fixture.json(path)).runs[0].condition).toBe("disconnected");
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("project_capacity_exhausted");
    expect(fixture.launches).toEqual([uncertain.id]);
    fixture.setHostOffline(false);
    expect((await fixture.json(`/runs/${uncertain.id}/reconcile`, {})).id).toBe(uncertain.id);
    expect((await fixture.json(path)).runs[0].condition).toBe("working");
  } finally { fixture.close(); }
}, 20_000);


test("Retry cannot replace a failed parent while an uncertain build still owns the Assignment", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    const run = await fixture.json(path + "/runs", start);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    expect(check.condition).toBe("interrupted");
    fixture.failNativeRun(run.id); await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.restart();
    const response = await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "owned-build-retry", issue_scope: start.issue_scope });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("implementation_owned");
    const detail = await fixture.json(path);
    expect(detail.checks).toEqual([check]);
    expect(detail.runs).toHaveLength(1);
    expect(fixture.launches).toEqual([run.id]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["pause", "priority", "scope", "outage", "readiness"])("Retry revalidates current %s instead of reusing failed authorization", async change => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Next issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    fixture.setLaunchOutcome("failed"); const failed = await fixture.json(path + "/runs", start);
    if (change === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    if (change === "priority") await fixture.json(second.path + "/order", { before_id: failed.implementation_id });
    if (change === "scope") fixture.issue.body += "\nA different behavior.";
    if (change === "readiness") fixture.issue.labels = [];
    if (["scope", "readiness", "outage"].includes(change)) {
      fixture.save([fixture.issue], change === "outage"); await fixture.post(route + "/sync", {});
    }
    const response = await fixture.post(`/runs/${failed.id}/retry`, { idempotency_key: "stale-retry", issue_scope: start.issue_scope });
    expect(response.status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([failed]);
    expect(fixture.launches).toEqual([failed.id]);
  } finally { fixture.close(); }
}, 20_000);


test("completed planning Runs allow approved issue preparation and one guarded implementation attempt", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const planning = await fixture.json(path + "/runs", { action: "to-spec", idempotency_key: "owned-manual-planning" });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    expect((await fixture.json(route + "/preview", {})).entries[0].reasons).toContainEqual({ code: "attempt_exists", detail: "" });
    fixture.setExecutionHandler(async request => new URL(request.url).pathname.endsWith(`/runs/${planning.id}/reconcile`) ? Response.json({ ...planning, condition: "completed" }) : null);
    await fixture.json(`/runs/${planning.id}/reconcile`, {});
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP and real browser journeys.", issue_scope: { source_id: source.id, source_revision: source.revision } });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello.", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Approved bounded greeting", issue_scope: { source_id: source.id, source_revision: source.revision } });
    const preview = await fixture.json(route + "/preview", {});
    expect(preview).toMatchObject({ eligible_count: 1, entries: [expect.objectContaining({ eligible: true, reasons: [] })] });
    const prepared = (await fixture.json(route)).sources[0].planning;
    expect(prepared).toMatchObject({ condition: "prepared", origin: "app_plan", specification_id: specification.id, graph_hash: graph.hash });
    const start = { action: "implement-spec", idempotency_key: "after-manual-planning", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: graph.hash } };
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    expect((await fixture.post(path + "/runs", { ...start, idempotency_key: "no-duplicate-after-planning" })).status).toBe(409);
    expect((await fixture.json(path)).runs.map((run: any) => run.action)).toEqual(["to-spec", "implement-spec"]);
  } finally { fixture.close(); }
}, 20_000);


test.each(["fresh_issue", "dependencies", "graphql", "malformed_history"])("observed untrusted relabeling survives later %s failure", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "readiness-history-worker" });
    const at = new Date(Date.now() + 1000).toISOString();
    const events = [
      { id: 10, event: "unlabeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-reviewer", id: 9999 }, created_at: at },
      { id: 11, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-reviewer", id: 9999 }, created_at: at },
    ];
    if (failure === "malformed_history") events.push({ invalid: true } as never);
    const fresh = failure === "fresh_issue" ? { ...fixture.issue, updated_at: "invalid" } : fixture.issue;
    fixture.save([fixture.issue], false, {}, false, [fresh], { events, ...(failure === "dependencies" ? { dependencies: { "1": null } } : { proof: null }) });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].issue_pause?.reason).toBe("readiness_revoked");
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.workers).toEqual([worker]);
    fixture.save([fixture.issue], false, {}, false, [fresh], { events, ...(failure === "dependencies" ? { dependencies: { "1": null } } : { proof: null }) });
    await fixture.json(route + "/sync", {}); fixture.restart();
    const restored = await fixture.json(path);
    expect(restored.runs[0].issue_pause?.reason).toBe("readiness_revoked");
    expect(restored.workers).toEqual([worker]);
    expect(restored.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);


test("upgrade rejects an unproven cached GitHub label approval while preserving explicit owner approval", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue], false, {}, true);
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const approved = (await fixture.json(route)).sources[0];
    const cached = { ...approved, readiness_approvals: [{ ...approved.readiness.approval, provenance: "github_label", approved_at: fixture.issue.updated_at, event_id: "1" }] };
    // Historical input only: seed the pre-upgrade receipt while stopped. All
    // observations and assertions use the public HTTP surface.
    const seed = (value: unknown) => fixture.restart(() => {
      const db = new Database(join(fixture.root, "factory", "records.sqlite"));
      try { db.query("UPDATE records SET data=? WHERE kind='github_sources' AND id=?").run(JSON.stringify(value), source.id); }
      finally { db.close(); }
    });
    seed(cached);
    expect((await fixture.json(route)).sources[0].readiness).toMatchObject({ eligible: false, approval: null, blockers: ["stale"] });
    expect((await fixture.json(route + "/sync", {})).sources[0].readiness.approval).toBeNull();
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
    seed(approved);
    expect((await fixture.json(route)).sources[0].readiness).toMatchObject({ eligible: true, approval: { provenance: "app_owner", id: approved.readiness.approval.id } });
    expect((await fixture.json(route + "/sync", {})).sources[0].readiness.approval.id).toBe(approved.readiness.approval.id);
  } finally { fixture.close(); }
}, 20_000);


test("a readiness removal is durable before the next history page fails", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const at = new Date(Date.now() + 1000).toISOString();
    const removed = { id: 10, event: "unlabeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-reviewer", id: 9999 }, created_at: at };
    const unrelated = Array.from({ length: 99 }, (_, index) => ({ ...removed, id: index + 11, event: "labeled", label: { name: "documentation" } }));
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { event_pages: [[removed, ...unrelated], null] });
    const held = fixture.holdSync("/events?per_page=100&page=2"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("readiness_revoked");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await fixture.json(path)).github_sources[0].readiness_evidence.complete).toBe(false);
  } finally { release(); fixture.close(); }
}, 20_000);

test.each(["missing", "malformed", "unavailable", "old_revocation", "unknown_actor", "unrelated"])("%s history without affirmative revocation leaves frozen work running", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const event = { id: 10, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-reviewer", id: 9999 }, created_at: new Date(Date.now() + 1000).toISOString() };
    const events = failure === "unavailable" ? null : failure === "malformed" ? [{ ...event, created_at: "invalid" }]
      : failure === "old_revocation" ? [{ ...event, event: "unlabeled", created_at: "2026-10-01T12:00:00Z" }]
      : failure === "unknown_actor" ? [{ ...event, actor: null }]
      : failure === "unrelated" ? [{ ...event, label: { name: "documentation" } }] : [];
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events, proof: null });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);


test("an untrusted ready event alone requests pause before the fresh issue request returns", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const events = [{ id: 10, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-reviewer", id: 9999 }, created_at: new Date(Date.now() + 1000).toISOString() }];
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, updated_at: "invalid" }], { events });
    const held = fixture.holdSync("=repos/fictional/project/issues/1"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("readiness_revoked");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await fixture.json(path)).github_sources[0].readiness_evidence.complete).toBe(false);
  } finally { release(); fixture.close(); }
}, 20_000);


test.each(["app_owner", "github_label"])("same-second revocation after the frozen %s event requests controlled pause", async origin => {
  const fixture = githubQueueFixture(true);
  try {
    const ready = { id: 100, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-owner", id: 1042 }, created_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events: [ready] });
    const { path, start, route } = await prepared(fixture, origin === "github_label");
    const run = await fixture.json(path + "/runs", start);
    const approval = run.manifest.issue_admission.planning.authorization.approval;
    expect(approval.provenance).toBe(origin);
    const observed = run.manifest.issue_admission.source.readiness_evidence.label_event;
    const at = new Date(Math.floor(Date.parse(approval.approved_at) / 1000) * 1000).toISOString();
    const events = [
      { ...ready, id: Number(observed.id) + 1, event: "unlabeled", created_at: at },
      { ...ready, id: Number(observed.id) + 2, actor: { login: "fictional-reviewer", id: 9999 }, created_at: at },
    ];
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events, proof: null });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].issue_pause?.reason).toBe("readiness_revoked");
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);


test.each(["app_owner", "github_label"])("a same-second historical revocation before the frozen %s event leaves work running", async origin => {
  const fixture = githubQueueFixture(true);
  try {
    const ready = { id: 100, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-owner", id: 1042 }, created_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events: [ready] });
    const { path, start, route } = await prepared(fixture, origin === "github_label");
    const run = await fixture.json(path + "/runs", start);
    const frozen = run.manifest.issue_admission;
    const observed = frozen.source.readiness_evidence.label_event;
    const at = new Date(Math.floor(Date.parse(frozen.planning.authorization.approval.approved_at) / 1000) * 1000).toISOString();
    const events = [{ ...ready, id: Number(observed.id) - 1, event: "unlabeled", created_at: at }, { ...ready, id: Number(observed.id), created_at: observed.created_at }];
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { events, proof: null });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);
