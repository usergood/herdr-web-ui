import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readyIssuesFixture } from "./ready-issues.fixture.ts";
import type { FactoryRun, FactoryReviewEvidence } from "../shared/factory.ts";

/** Public API setup with an owned external provider and real isolated Git worktrees. */
export async function reviewReworkFixture(reportContent?: string) {
  const f = await readyIssuesFixture({ reviewOutcome: "failed", reportContent });
  const policy = (await f.request(f.route + "/configure", f.policy)).body;
  f.respond({ issues: [f.issue(1)] });
  const source = (await f.request(f.route + "/sync", {})).body.sources[0];
  await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
  await f.tick();
  const prefix = `/implementations/${source.implementation_id}`;
  const run: FactoryRun = (await f.request(prefix)).body.runs[0];
  const ticket = (run.manifest as { tickets: { id: string }[] }).tickets[0]!;
  const workerRoute = `/runs/${run.id}/workers`;
  const worker = (await f.request(workerRoute, { role: "implementer", ticket_id: ticket.id, idempotency_key: "first-writer" })).body;
  const commit = (path: string, content: string) => {
    writeFileSync(path + "/ready.txt", content);
    for (const args of [["add", "ready.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "owned change"]]) execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  };
  commit(worker.worktree, "First reviewed version\n");
  f.restWorker(worker.id);
  await f.request(`${workerRoute}/${worker.id}/reconcile`, {});
  await f.request(`${workerRoute}/${worker.id}/check`, {});
  const integrated = await f.request(`${workerRoute}/${worker.id}/integrate`, {});
  if (integrated.body.condition !== "completed") throw new Error(JSON.stringify(integrated));
  const check = (await f.request(`/runs/${run.id}/checks`, {})).body;
  const reports: FactoryReviewEvidence[] = [];
  for (const role of ["standards", "spec"]) {
    const reviewer = (await f.request(workerRoute, { role, idempotency_key: role })).body;
    const report = await f.request(`${workerRoute}/${reviewer.id}/review-evidence`, {});
    if (report.status !== 200) throw new Error(JSON.stringify(report));
    reports.push(report.body);
  }
  return { ...f, prefix, run, ticket, reports, workerRoute, commit, head: check.head as string,
    submission: { run_id: run.id, head: check.head as string, report_ids: reports.map(report => report.id), idempotency_key: "retained-reports" } };
}
