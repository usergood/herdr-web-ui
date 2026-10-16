/** Owned Machine protocol fixture. All assertions use the app's public HTTP operations. */
import type { FactoryCheck, FactoryProject, FactoryRun, FactoryWorker } from "../../shared/factory.ts";
import { githubQueueFixture } from "./github-queue.ts";

export function githubReviewFixture() {
  const fixture = githubQueueFixture(true);
  const runs = new Map<string, FactoryRun>(); const workers = new Map<string, FactoryWorker>();
  let head = "a".repeat(40); let workspaceHash = "owned-clean-workspace";
  let coordinator: FactoryRun["condition"] = "ready";
  let checkCondition: FactoryCheck["condition"] = "passed";
  let checkCommands: string[][] | null = null;
  let checkExitCodes: number[] = [];
  let reviewOutcome: "passed" | "failed" = "passed";
  let uncertainStop = false;
  let stopCondition: FactoryRun["condition"] = "cancelled";
  let stopHead: string | null = null;
  let nativeIdentity = false;
  let headUnavailable = false;
  const cleanedRuns = new Set<string>();
  let cleanupOutcome: "confirmed" | "lost" | "unconfirmed" | "other_checkout" = "confirmed";
  fixture.setExecutionHandler(async request => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, any> : {};
    if (path.endsWith("/launch")) {
      const run = { ...body.run, condition: "working", worktree: fixture.root, branch: "fictional-run", ...(nativeIdentity ? { workspace_id: `fictional-${body.run.id}`, pane_id: `fictional-${body.run.id}:p1` } : {}) } as FactoryRun;
      runs.set(run.id, run); return Response.json(run);
    }
    const id = path.match(/runs\/([^/]+)/)?.[1]; const run = id ? runs.get(id) : undefined;
    if (!run) return null;
    const action = path.split("/").at(-1);
    if (action === "head") return headUnavailable || cleanedRuns.has(run.id) ? Response.json({ error: { code: "workspace_gone", message: "Owned historical workspace was cleaned" } }, { status: 409 }) : Response.json({ head, workspace_hash: workspaceHash });
    if (action === "cleanup") {
      cleanedRuns.add(run.id);
      if (cleanupOutcome === "lost") return Response.json({ error: { code: "unreachable", message: "Owned cleanup response lost" } }, { status: 503 });
      return Response.json({ removed: cleanupOutcome === "unconfirmed" ? [] : cleanupOutcome === "other_checkout" ? [fixture.root + "/other"] : [run.worktree], branches_retained: true, notes_retained: true });
    }
    if (action === "reconcile") return Response.json({ ...run, condition: coordinator });
    if (action === "stop") {
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
    if (action === "stop-worker") return Response.json({ ok: true });
    if (action === "check") {
      const project = (run.manifest as { project: FactoryProject }).project;
      return Response.json({ ...body.check, head, workspace_hash: workspaceHash, condition: checkCondition, commands: (checkCommands ?? [...project.setup ?? [], ...project.checks ?? []]).map((args, index) => ({ args, exit_code: checkExitCodes[index] ?? 0, output: "Owned fixture command receipt" })) });
    }
    if (action === "review-evidence" && worker) return Response.json({ head, source_id: `owned-review-${worker.id}`, content: `Independent ${worker.role} fixture report`, outcome: reviewOutcome });
    return null;
  });
  async function prepare(commands?: Pick<FactoryProject, "setup" | "checks">) {
    const setup = await fixture.setup();
    if (commands) await fixture.json(`/projects/${setup.project.id}/configure`, commands);
    const source = (await fixture.json(setup.route + "/sync", {})).sources[0];
    await fixture.json(setup.route + "/issues/1/approve", { source_revision: source.revision, policy_revision: setup.readiness.revision });
    await fixture.json(setup.route + "/issues/1/prepare", { source_revision: source.revision });
    await fixture.json(setup.route + "/sync", {});
    const path = `/implementations/${source.implementation_id}`;
    const detail = await fixture.json(path);
    const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-reviewed-issue", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } });
    return { ...setup, source, path, run: run as FactoryRun };
  }
  async function integrate(run: FactoryRun) {
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: (run.manifest as { tickets: { id: string }[] }).tickets[0]!.id, idempotency_key: "owned-writer" });
    await fixture.json(`/runs/${run.id}/workers/${worker.id}/check`, {});
    await fixture.json(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
  }
  async function review(run: FactoryRun, axis: "standards" | "spec", key = axis) {
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: axis, idempotency_key: `owned-${key}` });
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
  return { ...fixture, prepare, integrate, review, second, setCleanupOutcome(value: typeof cleanupOutcome) { cleanupOutcome = value; }, setHeadUnavailable(value = true) { headUnavailable = value; if (!value) cleanedRuns.clear(); }, setHead(value: string) { head = value; }, setWorkspaceHash(value: string) { workspaceHash = value; }, setCoordinator(value: typeof coordinator) { coordinator = value; }, setCheck(value: typeof checkCondition) { checkCondition = value; }, setCheckCommands(value: string[][] | null, exitCodes: number[] = []) { checkCommands = value; checkExitCodes = exitCodes; }, setReview(value: typeof reviewOutcome) { reviewOutcome = value; }, setUncertainStop(value: boolean) { uncertainStop = value; }, setStopCondition(value: typeof stopCondition) { stopCondition = value; }, setStopHead(value: string) { stopHead = value; }, setNativeIdentity() { nativeIdentity = true; } };
}
