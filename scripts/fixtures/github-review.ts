/** Owned Machine protocol fixture. All assertions use the app's public HTTP operations. */
import type { FactoryCheck, FactoryProject, FactoryRun, FactoryWorker } from "../../shared/factory.ts";
import { githubQueueFixture } from "./github-queue.ts";

export function githubReviewFixture() {
  const fixture = githubQueueFixture(true);
  const runs = new Map<string, FactoryRun>(); const workers = new Map<string, FactoryWorker>();
  let head = "a".repeat(40); let workspaceHash = "5dbdd367ae6759b5c09a4545071da13a38c21bf1a1353657d9917e5f8d503807";
  let coordinator: FactoryRun["condition"] = "ready";
  let checkCondition: FactoryCheck["condition"] = "passed";
  let checkCommands: string[][] | null = null;
  let checkExitCodes: number[] = [];
  let reviewOutcome: "passed" | "failed" = "passed";
  let launchFailure = false;
  let uncertainStop = false;
  let stopCondition: FactoryRun["condition"] = "cancelled";
  let stopHead: string | null = null;
  let nativeIdentity = false;
  let headUnavailable = false;
  let stopGate: (() => Promise<void>) | null = null;
  const cleanedRuns = new Set<string>();
  let cleanupOutcome: "confirmed" | "lost" | "unconfirmed" | "other_checkout" = "confirmed";
  fixture.setExecutionHandler(async request => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, any> : {};
    if (path.endsWith("/launch")) {
      const run = { ...body.run, condition: launchFailure ? "failed" : "working", worktree: launchFailure ? null : fixture.root, branch: launchFailure ? null : "fictional-run", ...(nativeIdentity ? { workspace_id: `fictional-${body.run.id}`, pane_id: `fictional-${body.run.id}:p1` } : {}) } as FactoryRun;
      runs.set(run.id, run); return Response.json(run);
    }
    if (path.endsWith("/review")) return Response.json({ repository: (runs.values().next().value!.manifest as { checkout: { repository: string } }).checkout.repository, head, files: [{ path: "README.md", status: "branch:M", diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Old greeting\n+Produced greeting\n", binary: false, oversized: false }] });
    const id = path.match(/runs\/([^/]+)/)?.[1]; const run = id ? runs.get(id) : undefined;
    if (!run) return null;
    const action = path.split("/").at(-1);
    if (["completed", "cancelled", "failed"].includes(run.condition) && ["worker", "check", "refresh", "integrate", "send"].includes(action!)) return Response.json({ error: { code: "factory_run_required", message: "The fictional host retains a stopped native lease" } }, { status: 409 });
    if (action === "send") { runs.set(run.id, { ...run, condition: "working" }); return Response.json({ ok: true }); }
    if (action === "head") return headUnavailable || cleanedRuns.has(run.id) ? Response.json({ error: { code: "workspace_gone", message: "Owned historical workspace was cleaned" } }, { status: 409 }) : Response.json({ head, workspace_hash: workspaceHash });
    if (action === "cleanup") {
      cleanedRuns.add(run.id);
      if (cleanupOutcome === "lost") return Response.json({ error: { code: "unreachable", message: "Owned cleanup response lost" } }, { status: 503 });
      return Response.json({ removed: cleanupOutcome === "unconfirmed" ? [] : cleanupOutcome === "other_checkout" ? [fixture.root + "/other"] : [run.worktree], branches_retained: true, notes_retained: true });
    }
    if (action === "reconcile") return Response.json(["completed", "cancelled", "failed"].includes(run.condition) ? run : { ...run, condition: coordinator });
    if (action === "finish") {
      if (coordinator !== "ready" || uncertainStop) return Response.json({ error: { code: "step_owned", message: "The fictional native step has not confirmed rest" } }, { status: 409 });
      const finished = { ...run, condition: "completed" as const }; runs.set(run.id, finished); return Response.json(finished);
    }
    if (action === "stop") {
      const gate = stopGate; stopGate = null; await gate?.();
      if (uncertainStop) return Response.json({ error: { code: "unreachable", message: "Owned stop outcome uncertain" } }, { status: 409 });
      if (stopHead) head = stopHead;
      const stopped = { ...run, condition: stopCondition } as FactoryRun; runs.set(run.id, stopped); return Response.json(stopped);
    }
    if (action === "worker") {
      const worker = { ...body.worker, condition: "ready", head, worktree: fixture.root + "/" + body.worker.id, branch: "owned-worker", workspace_id: null, pane_id: null } as FactoryWorker;
      workers.set(worker.id, worker); return Response.json(worker);
    }
    const worker = workers.get(body.worker_id);
    if (["refresh", "reconcile-worker"].includes(action!)) return worker ? Response.json(worker) : null;
    if (action === "integrate" && worker) { const next = { ...worker, condition: "completed" } as FactoryWorker; workers.set(worker.id, next); return Response.json(next); }
    if (action === "transcript") return Response.json({ ...(worker ? { worker_id: worker.id } : {}), source_id: `owned-review-history:${run.id}:${worker?.id ?? "parent"}`, version: body.before ? "earlier-v1" : "latest-v1", cursor: body.before ? null : "owned-earlier-page", turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: `${body.before ? "Earlier" : "Final"} owned review context retained before closure` }] }] });
    if (action === "stop-worker") {
      if (worker) workers.set(worker.id, { ...worker, condition: worker.condition === "completed" ? "completed" : "cancelled" });
      return Response.json({ ok: true });
    }
    if (action === "check") {
      const project = (run.manifest as { project: FactoryProject }).project;
      return Response.json({ ...body.check, head, workspace_hash: workspaceHash, condition: checkCondition, commands: (checkCommands ?? [...project.setup ?? [], ...project.checks ?? []]).map((args, index) => ({ args, exit_code: checkExitCodes[index] ?? 0, output: "Owned fixture command receipt" })) });
    }
    if (action === "review-evidence" && worker) return Response.json({ head, source_id: `owned-review-${worker.id}`, content: `Independent ${worker.role} fixture report`, outcome: reviewOutcome });
    return null;
  });
  async function prepare(commands?: Pick<FactoryProject, "setup" | "checks">, appTestingSeams?: string) {
    const setup = await fixture.setup();
    if (commands) await fixture.json(`/projects/${setup.project.id}/configure`, commands);
    const source = (await fixture.json(setup.route + "/sync", {})).sources[0];
    if (appTestingSeams !== undefined) {
      const path = `/implementations/${source.implementation_id}`;
      const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body.split("\n## Testing seams")[0] });
      for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: appTestingSeams, issue_scope: { source_id: source.id, source_revision: source.revision } });
    }
    await fixture.json(setup.route + "/issues/1/approve", { source_revision: source.revision, policy_revision: setup.readiness.revision });
    await fixture.json(setup.route + "/issues/1/prepare", { source_revision: source.revision });
    await fixture.json(setup.route + "/sync", {});
    const path = `/implementations/${source.implementation_id}`;
    const detail = await fixture.json(path);
    const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-reviewed-issue", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } });
    return { ...setup, source, path, run: run as FactoryRun };
  }
  async function settleChildSummary(run: FactoryRun) {
    if (coordinator !== "ready") return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await fixture.json(`/runs/${run.id}/reconcile`, {});
      if (!current.continuation || current.continuation.condition === "resumed") return;
      if (current.continuation.kind !== "children" || ["uncertain", "blocked"].includes(current.continuation.condition)) throw new Error(`Owned child summary cannot continue: ${JSON.stringify(current.continuation)}`);
      await Bun.sleep(25);
    }
    throw new Error("Owned child summary did not finish before the next public worker action");
  }
  async function integrate(run: FactoryRun) {
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: (run.manifest as { tickets: { id: string }[] }).tickets[0]!.id, idempotency_key: "owned-writer" });
    await fixture.json(`/runs/${run.id}/workers/${worker.id}/check`, {});
    await settleChildSummary(run);
    await fixture.json(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
  }
  async function review(run: FactoryRun, axis: "standards" | "spec", key: string = axis) {
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: axis, idempotency_key: `owned-${key}` });
    await settleChildSummary(run);
    return fixture.json(`/runs/${run.id}/workers/${worker.id}/review-evidence`, {});
  }
  async function second(route: string, readiness: { revision: string }) {
    const source = (await fixture.json(route)).sources.find((entry: any) => entry.number === 2);
    await fixture.json(route + "/issues/2/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/2/prepare", { source_revision: source.revision });
    await fixture.json(route + "/sync", {});
    const path = `/implementations/${source.implementation_id}`;
    const detail = await fixture.json(path);
    return { path, start: { action: "implement-spec", idempotency_key: "unrelated-issue", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } } };
  }
  function holdStop() {
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve);
    const gate = new Promise<void>(resolve => release = resolve);
    stopGate = async () => { entered(); await gate; };
    return { waiting, release };
  }
  return { ...fixture, get origin() { return fixture.origin; }, prepare, integrate, review, setLaunchFailure(value: boolean) { launchFailure = value; }, second, holdStop, setCleanupOutcome(value: typeof cleanupOutcome) { cleanupOutcome = value; }, setHeadUnavailable(value = true) { headUnavailable = value; if (!value) cleanedRuns.clear(); }, setHead(value: string) { head = value; }, setWorkspaceHash(value: string) { workspaceHash = value; }, setCoordinator(value: typeof coordinator) { coordinator = value; }, setCheck(value: typeof checkCondition) { checkCondition = value; }, setCheckCommands(value: string[][] | null, exitCodes: number[] = []) { checkCommands = value; checkExitCodes = exitCodes; }, setReview(value: typeof reviewOutcome) { reviewOutcome = value; }, setUncertainStop(value: boolean) { uncertainStop = value; }, setStopCondition(value: typeof stopCondition) { stopCondition = value; }, setStopHead(value: string) { stopHead = value; }, setNativeIdentity() { nativeIdentity = true; } };
}
