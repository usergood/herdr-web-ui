/** Owned public HTTP/native fixture for a prepared issue's exact planning handoff. */
import type { FactoryRun } from "../../shared/factory.ts";
import { githubQueueFixture } from "./github-queue.ts";

export function issueContinuationFixture() {
  const fixture = githubQueueFixture(true);
  const runs = new Map<string, FactoryRun>();
  const conditions = new Map<string, FactoryRun["condition"]>();
  let planningId: string | undefined;
  let planningCondition: FactoryRun["condition"] = "ready";
  let beforeFinish: (() => Promise<void>) | undefined;
  let finishUncertain = false;
  fixture.setExecutionHandler(async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/launch")) {
      const { run } = await request.json() as { run: FactoryRun };
      const native = { ...run, condition: "working" as const, worktree: fixture.root, branch: "fictional-continuation", workspace_id: `owned-${run.id}`, pane_id: `owned-${run.id}:p1` };
      runs.set(run.id, native); return Response.json(native);
    }
    const id = path.match(/runs\/([^/]+)/)?.[1]; const run = id ? runs.get(id) : undefined;
    if (!run) return null;
    if (path.endsWith("/reconcile")) return Response.json(run.condition === "completed" ? run : { ...run, condition: conditions.get(run.id) ?? (run.id === planningId || ["to-spec", "to-tickets"].includes(run.action) ? planningCondition : run.condition) });
    if (path.endsWith("/artifacts")) return Response.json([]);
    if (path.endsWith("/operations/transcript")) return Response.json({ source_id: `owned-planning-${run.id}`, version: "1", cursor: null, turns: [{ id: "handoff", role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained fictional planning handoff." }] }] });
    if (path.endsWith("/finish")) {
      await beforeFinish?.();
      if (finishUncertain) return Response.json({ error: { code: "uncertain", message: "Owned finish outcome is unavailable" } }, { status: 503 });
      const finished = { ...run, condition: "completed" as const }; runs.set(run.id, finished); return Response.json(finished);
    }
    return null;
  });
  async function preparedPlanning(action: "to-tickets" | "work" = "to-tickets") {
    const setup = await fixture.setup();
    const source = (await fixture.json(setup.route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP and real browser journeys." });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Approved greeting graph" });
    await fixture.json(setup.route + "/issues/1/approve", { source_revision: source.revision, policy_revision: setup.readiness.revision });
    await fixture.json(setup.route + "/issues/1/prepare", { source_revision: source.revision });
    await fixture.json(setup.route + "/sync", {});
    const planning: FactoryRun = await fixture.json(path + "/runs", { action, idempotency_key: "owned-issue-planning" });
    planningId = planning.id;
    await fixture.json(`/runs/${planning.id}/reconcile`, {});
    const detail = await fixture.json(path);
    const current = detail.github_sources[0];
    const body = { action: "implement-spec", run_id: planning.id, idempotency_key: "continue-owned-issue", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } };
    return { ...setup, path, planning, body, source: current };
  }
  return { ...fixture, preparedPlanning, setRunCondition(id: string, value: FactoryRun["condition"]) { conditions.set(id, value); }, setPlanningCondition(value: typeof planningCondition) { planningCondition = value; }, beforeFinish(callback: () => Promise<void>) { beforeFinish = callback; }, setFinishUncertain(value = true) { finishUncertain = value; } };
}
