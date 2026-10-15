import { expect, test } from "bun:test";
import { reviewReworkFixture } from "./factory-review-rework.fixture.ts";

test("retained failed reports reach one repair writer intact without inline comments", async () => {
  const f = await reviewReworkFixture();
  try {
    const sent = await f.request(f.prefix + "/request-changes", f.submission);
    expect(sent.body.error).toBeUndefined(); expect(sent.status).toBe(200); expect(sent.body.status).toBe("sent");
    expect(sent.body.reports).toEqual([...f.reports].sort((a, b) => a.id.localeCompare(b.id)));
    expect(f.deliveries).toHaveLength(1);
    for (const report of f.reports) expect(f.deliveries[0]).toContain(report.id);
    expect((await f.request(f.prefix + "/request-changes", f.submission)).body.id).toBe(sent.body.id);
    expect((await f.request(f.prefix + "/request-changes", { ...f.submission, idempotency_key: "duplicate" })).status).toBe(409);
    const repair = { role: "implementer", ticket_id: f.ticket.id, review_batch_id: sent.body.id, idempotency_key: "repair-writer" };
    const worker = await f.request(f.workerRoute, repair);
    expect(worker.status).toBe(200);
    expect(f.workerContexts.at(-1)).toMatchObject({ review_batch: { id: sent.body.id, report_ids: sent.body.report_ids, head: f.head } });
    expect((await f.request(f.workerRoute, { ...repair, idempotency_key: "second-writer" })).status).toBe(409);
    expect((await f.request(f.prefix)).body.review_batches[0].id).toBe(sent.body.id);
    expect((await f.agentContract(f.run.id)).review_batches.find((entry: { id: string }) => entry.id === sent.body.id).reports).toEqual(sent.body.reports);
    expect((await f.request(f.prefix)).body.comments).toEqual([]);
  } finally { f.close(); }
}, 30_000);

test("uncertain report delivery survives restart without replay or a repair allocation", async () => {
  const f = await reviewReworkFixture();
  try {
    f.uncertainDelivery(true);
    const sent = await f.request(f.prefix + "/request-changes", f.submission);
    expect(sent.body.status).toBe("uncertain");
    f.restart();
    expect((await f.request(f.prefix + "/request-changes", f.submission)).body.id).toBe(sent.body.id);
    expect((await f.request(f.prefix + "/request-changes", { ...f.submission, idempotency_key: "new-key" })).status).toBe(409);
    expect((await f.request(f.workerRoute, { role: "implementer", ticket_id: f.ticket.id, review_batch_id: sent.body.id, idempotency_key: "repair" })).status).toBe(409);
    expect(f.deliveries).toHaveLength(1);
    expect((await f.request(f.prefix)).body.review_batches[0].status).toBe("uncertain");
  } finally { f.close(); }
}, 30_000);

test("report selection rejects another Run, another report, a stale head and dirty work", async () => {
  const f = await reviewReworkFixture();
  try {
    for (const change of [{ run_id: "other-run" }, { report_ids: ["other-report"] }, { head: "f".repeat(40) }]) expect((await f.request(f.prefix + "/request-changes", { ...f.submission, ...change })).status).toBe(409);
    f.commit(f.run.worktree!, "Later integration version\n");
    expect((await f.request(f.prefix + "/request-changes", f.submission)).body.error.code).toBe("review_stale");
    expect(f.deliveries).toEqual([]);
  } finally { f.close(); }
}, 30_000);

test("large retained reports use bounded notifications and worker context while the scoped tracker preserves every byte", async () => {
  const content = "Full original report and anchor ready.txt:1\n" + "漢字\n".repeat(100_000);
  const f = await reviewReworkFixture(content);
  try {
    const batch = (await f.request(f.prefix + "/request-changes", f.submission)).body;
    expect(batch.status).toBe("sent"); expect(f.deliveries[0]!.length).toBeLessThan(2000);
    const worker = await f.request(f.workerRoute, { role: "implementer", ticket_id: f.ticket.id, review_batch_id: batch.id, idempotency_key: "large-report-repair" });
    expect(worker.status).toBe(200);
    expect(JSON.stringify(f.workerContexts.at(-1)).length).toBeLessThan(50_000);
    const retained = (await f.agentContract(f.run.id)).review_batches.find((entry: { id: string }) => entry.id === batch.id);
    expect(retained.reports).toHaveLength(2);
    expect(retained.reports.every((report: { content: string }) => report.content === content)).toBe(true);
  } finally { f.close(); }
}, 30_000);
