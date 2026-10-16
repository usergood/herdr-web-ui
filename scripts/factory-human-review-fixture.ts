import type { capacityFixture } from "./factory-capacity-fixture.ts";

export async function until(read: () => Promise<any>, ready: (d: any) => boolean, timeoutMs = 12000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await read(); if (ready(d)) return d;
    if (Date.now() > deadline) throw new Error(`Human Review stalled: ${JSON.stringify(d.human_reviews)}`);
    await Bun.sleep(20);
  }
}
export async function published(f: Awaited<ReturnType<typeof capacityFixture>>, milestone: "merge" | "release" = "merge") {
  await f.api("/settings", { max_agents: 1 });
  const id = await f.assignment("Human Review result"); const prefix = `/implementations/${id}`;
  const detail = () => f.api(prefix).then(r => r.json());
  await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { delivery_policy: milestone, checks: [["bun", "test"]], permissions: "Owned fixtures only", pull_request: { repository: "fictional/project", base_branch: "main" } });
  const spec = await f.api(`${prefix}/specifications`, { content: "Retain the reviewed result" }).then(r => r.json());
  await f.api(`${prefix}/specification-acceptance`, { source: "button", specification_id: spec.id, hash: spec.hash });
  const run = (await until(detail, d => d.runs.length === 1)).runs[0];
  await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Public HTTP and desktop/mobile browser", tickets: [{ key: "one", title: "Reviewed result", acceptance: "Readable captured changes", dependencies: [] }] });
  f.runs.get(run.id)!.condition = "ready";
  for (const role of ["implementer", "standards", "spec"]) {
    const d = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
    f.workers.get(d.workers.find((w: any) => w.role === role).id)!.condition = "ready";
  }
  await until(detail, d => d.automatic_review?.[0]?.condition === "published");
  return { id, prefix, detail, run };
}
