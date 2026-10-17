import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

describe("retaining planning handoff history through authenticated HTTP", () => {
  it("retains all native pages before planning context replacement without manual imports", async () => {
    const f = await capacityFixture({ runTranscript: (run, before) => run.condition === "completed" ? null : ({ source_id: `planning:${run.id}`, version: before ? "older-v3" : "newest-v9", cursor: before ? null : "planning-before", turns: [{ role: "assistant", ts: "2026-10-16T00:00:00Z", parts: [{ kind: "text", text: before ? "Earlier planning decision" : "Current planning decision" }] }] }) });
    try {
      const id = await f.assignment("Planning retained before continuation");
      const plan = await f.api(`/implementations/${id}/runs`, { action: "grill-with-docs", idempotency_key: "planning" }).then(r => r.json());
      f.runs.get(plan.id)!.condition = "ready";
      await f.api(`/runs/${plan.id}/reconcile`, {});
      const response = await f.api(`/implementations/${id}/continue`, { action: "to-spec", run_id: plan.id, idempotency_key: "continue-planning" });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      const detail = await read();
      const pages = detail.native_snapshots.filter((snapshot: any) => snapshot.run_id === plan.id);
      expect(pages.map((snapshot: any) => [snapshot.source_id, snapshot.version, snapshot.cursor])).toEqual([[`planning:${plan.id}`, "newest-v9", "planning-before"], [`planning:${plan.id}`, "older-v3", null]]);
      expect(detail.runs.find((run: any) => run.id === plan.id).condition).toBe("completed");
      const context = detail.conversations.find((entry: any) => entry.kind === "specifications").contexts.find((entry: any) => entry.run_id === plan.id);
      expect(context.snapshot_ids).toEqual(pages.map((page: any) => page.id));
      const handoff = detail.events.find((event: any) => event.kind === "planning_handoff_retained" && event.data.run_id === plan.id);
      expect(handoff.data).toMatchObject({ partial: false, snapshot_ids: pages.map((page: any) => page.id) });
      f.restart();
      expect((await read()).native_snapshots).toEqual(detail.native_snapshots);
    } finally { f.close(); }
  });  for (const mode of ["repeat", "source-change", "latest-change", "unavailable", "empty"] as const) it(`preserves urgent Pause and warns truthfully when history is ${mode}`, async () => {
    let latestReads = 0;
    const f = await capacityFixture({ runTranscript: (run, before) => {
      if (!before) latestReads++;
      if (mode === "unavailable" && before) return null;
      return { source_id: mode === "source-change" && before ? "different-native-context" : `bounded:${run.id}`, version: mode === "latest-change" && latestReads > 1 ? "changed-latest" : before ? "old-page" : "latest-page", cursor: mode === "repeat" || !before && mode !== "empty" ? "older-bounded" : null, turns: mode === "empty" ? [] : [{ role: "assistant", ts: "2026-10-16T00:00:00Z", parts: [{ kind: "text", text: before ? "Older available context" : "Latest available context" }] }] };
    } });
    try {
      const id = await f.assignment(`Incomplete history ${mode}`);
      const run = await f.api(`/implementations/${id}/runs`, { action: "grill-with-docs", idempotency_key: "bounded-root" }).then(r => r.json());
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.runs[0].suspension.condition).toBe("stopped");
      expect(detail.events.some((event: any) => event.kind === "native_history_retained" && event.data.run_id === run.id)).toBe(false);
      expect(detail.events.find((event: any) => event.kind === "native_history_unavailable" && event.data.run_id === run.id)?.data).toMatchObject({ worker_id: null, partial: true, native_store_retained: true });
    } finally { f.close(); }
  });

});
