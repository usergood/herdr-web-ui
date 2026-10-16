import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function continued(read: () => Promise<any>) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const detail = await read();
    if (detail.runs.every((run: any) => !run.suspension) && detail.workers.every((worker: any) => !worker.suspension)) return detail;
    if (Date.now() > deadline) throw new Error("Retained native contexts did not resume");
    await Bun.sleep(20);
  }
}

describe("Resumed native context history through authenticated HTTP", () => {
  it("continues the exact reviewer with the newest owner intent while preserving older pages after restart", async () => {
    let partial = false;
    const f = await capacityFixture({ workerTranscript: (worker, before) => before && partial ? null : ({
      source_id: `owned-resume-pages:${worker.id}`, version: before ? "older-v1" : partial ? "latest-v2" : "latest-v1", cursor: before ? null : "earlier-page",
      turns: [{ role: "user", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: before ? "Earlier intent: inspect the first candidate." : partial ? "Newest recovered intent: keep the existing review scope." : "Newest intent: validate the repaired candidate before publication." }] }],
    }) });
    try {
      const id = await f.assignment("Retain current review intent");
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "parent" }).then(r => r.json());
      const response = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "reviewer" });
      expect(response.status).toBe(200);
      const worker = await response.json();
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      const captured = await read();
      expect(captured.native_snapshots.filter((entry: any) => entry.worker_id === worker.id).map((entry: any) => entry.turns[0].parts[0].text).sort()).toEqual([
        "Earlier intent: inspect the first candidate.", "Newest intent: validate the repaired candidate before publication.",
      ]);
      f.restart();
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      const resumed = await continued(read);
      const index = f.resumptions.indexOf(worker.id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(f.resumeHistories[index]).toContain("Newest intent: validate the repaired candidate before publication.");
      expect(resumed.native_snapshots).toEqual(captured.native_snapshots);
      expect(resumed.conversations.find((entry: any) => entry.kind === "standards").contexts[0].snapshot_ids).toEqual(expect.arrayContaining(captured.native_snapshots.filter((entry: any) => entry.worker_id === worker.id).map((entry: any) => entry.id)));
      expect(f.workerLaunches).toEqual([worker.id]);
      expect(f.resumptions.filter(target => target === worker.id)).toHaveLength(1);
      // A later incomplete capture must not silently reuse the older complete receipt.
      partial = true;
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      f.restart();
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      const recovered = await continued(read);
      const latest = f.resumeHistories[f.resumptions.lastIndexOf(worker.id)];
      expect(latest).toContain("Newest recovered intent: keep the existing review scope.");
      expect(latest).toContain("this retained page may be partial or outdated");
      expect(recovered.native_snapshots.filter((entry: any) => entry.worker_id === worker.id)).toHaveLength(3);
      expect(f.workerLaunches).toEqual([worker.id]);
    } finally { f.close(); }
  });
});
