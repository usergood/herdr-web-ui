import { expect, test } from "bun:test";
import { factoryHistoryFixture, historicalChangeEvidence, historicalDeliveryScope, historicalMerge, historicalRelease } from "./factory-history.fixture.ts";

test("startup corrects unverified historical Done work without losing history or restarting it", async () => {
  const f = factoryHistoryFixture();
  try {
    const detail = await f.detail();
    expect(detail.board).toMatchObject({ lane: "needs_you", busy: false });
    expect(detail.board?.waiting_reason).toContain("Historical completion");
    expect(detail.implementation).toMatchObject({ id: "historical-done", title: "Historical work", description: "Retained owner request", outcome: "none" });
    expect(detail.implementation.archived_at ?? null).toBeNull();
    expect(detail.messages[0]?.content).toBe("Keep my historical context");
    expect(detail.runs.map(run => [run.id, run.condition])).toEqual([["historical-done-run", "completed"]]);
    expect(detail.workers.map(worker => [worker.id, worker.condition])).toEqual([["historical-done-worker", "completed"]]);
    expect(await f.request("/artifacts/historical-done-artifact/source").then(r => r.text())).toBe("Retained research artifact\n");
    expect(detail.events.some(event => event.id === "historical-done-event")).toBe(true);
    const queue = await f.request("/projects/history-project/queue").then(r => r.json());
    expect(queue.next_implementation_id).toBeNull();
    expect(queue.items[0]).toMatchObject({ implementation_id: "historical-done", eligible: false });
    expect(queue.items[0].reasons).toContain("awaiting_delivery");
    f.restart();
    expect(await f.detail()).toEqual(detail);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("explicitly restoring archived historical work reconciles completion before returning it to the board", async () => {
  const f = factoryHistoryFixture([{ archived_at: "2026-09-02T12:00:00Z" }]);
  try {
    expect((await f.detail()).implementation.archived_at).toBe("2026-09-02T12:00:00Z");
    const response = await f.request("/implementations/historical-done/restore", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ archived_at: null, stage: "review", outcome: "none" });
    const detail = await f.detail();
    expect(detail.board?.lane).toBe("needs_you");
    expect(detail.messages[0]?.content).toBe("Keep my historical context");
    expect(detail.events.filter(event => event.kind === "historical_completion_reconciled")).toHaveLength(1);
    f.restart();
    expect(await f.detail()).toEqual(detail);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("restoring an owned prior-version backup reconciles completion while preserving history and disabling execution", async () => {
  const f = factoryHistoryFixture([{ id: "restore-unverified" }, { id: "restore-archived", archived_at: "2026-09-02T12:00:00Z" }], [], true);
  try {
    const original = await f.detail("restore-unverified");
    const response = await f.request("/backups/prior-version-backup/restore", {});
    expect(response.status).toBe(201);
    const restored = await response.json();
    expect(restored.execution_enabled).toBe(false);
    f.restart(restored.state_dir);
    const detail = await f.detail("restore-unverified");
    expect(detail.board?.lane).toBe("needs_you");
    expect(detail.messages).toEqual(original.messages);
    expect(detail.runs).toEqual(original.runs);
    expect(detail.workers).toEqual(original.workers);
    expect(detail.events.filter(event => event.kind === "historical_completion_reconciled")).toHaveLength(1);
    expect(await f.request("/artifacts/restore-unverified-artifact/source").then(r => r.text())).toBe("Retained research artifact\n");
    expect((await f.detail("restore-archived")).implementation.archived_at).toBe("2026-09-02T12:00:00Z");
    f.restart(restored.state_dir);
    expect(await f.detail("restore-unverified")).toEqual(detail);
    expect((await f.request("/implementations/restore-unverified/runs", { action: "work", idempotency_key: "must-stay-disabled" })).status).toBe(409);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("historical correction recovers its repository baseline from the saved Run rather than current Project settings", async () => {
  const f = factoryHistoryFixture([{}], [
    { kind: "projects", parent: null, data: { id: "history-project", name: "Historical Project", repository: "owned-history-repository", delivery_policy: "merge", delivery_branch: "today-main", provider: "codex", machine_id: "local", tracker: "app", tracker_reference: "" } },
    { kind: "runs", parent: "historical-done", data: { id: "historical-done-run", implementation_id: "historical-done", action: "work", condition: "completed", provider: "codex", machine_id: "local", base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", checkout: "/owned/prior-repository", worktree: "/owned/retained-work", manifest: { project: { repository: "owned-history-repository", delivery_policy: "release", delivery_branch: "stable" }, checkout: { repository: "owned-history-repository", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "prior-main" } } } },
  ]);
  try {
    const detail = await f.detail();
    expect(detail.board?.lane).toBe("needs_you");
    expect(detail.implementation.delivery_scope).toMatchObject({ repository: "owned-history-repository", base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "stable", milestone: "release" });
    expect(detail.runs[0]?.manifest).toMatchObject({ project: { delivery_policy: "release", delivery_branch: "stable" } });
    f.restart();
    expect(await f.detail()).toEqual(detail);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("retained repository changes prevent historical no-change research from remaining Done", async () => {
  const f = factoryHistoryFixture([{ outcome: "research_accepted", completion_evidence: { repository_changes: "none", quiescent: true, reason: null, checked_at: "2026-09-01T12:00:00Z" } }], [{ kind: "snapshots", parent: "historical-done", data: { id: "retained-change-snapshot", implementation_id: "historical-done", files: [{ path: "findings.md", status: "added", diff: "Repository documentation", binary: false, oversized: false }] } }]);
  try {
    const detail = await f.detail();
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    expect(detail.implementation.completion_evidence?.repository_changes).toBe("changes");
    expect(detail.board?.waiting_reason).toContain("repository changes");
    expect(detail.snapshots[0]?.files[0]?.path).toBe("findings.md");
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("startup preserves confirmed Discard and keeps uncertain owned work visible without stopping or restarting it", async () => {
  const f = factoryHistoryFixture([
    { id: "discarded-history", outcome: "discarded", discard_requested_at: "2026-09-01T12:00:00Z" },
    { id: "discard-pending", outcome: "discarded", discard_requested_at: "2026-09-01T12:00:00Z" },
  ], [{ kind: "workers", parent: "discard-pending-run", data: { id: "discard-pending-worker", run_id: "discard-pending-run", ticket_id: "discard-pending-ticket", role: "implementer", condition: "disconnected", waiting_reason: "Owned Machine is unreachable", created_at: "2026-09-01T12:00:00Z", updated_at: "2026-09-01T12:00:00Z" } }]);
  try {
    const discarded = await f.detail("discarded-history");
    expect(discarded.board).toMatchObject({ lane: "done", sidebar_hidden: true });
    expect(discarded.implementation.outcome).toBe("discarded");
    const uncertain = await f.detail("discard-pending");
    expect(uncertain.board).toMatchObject({ lane: "needs_you", activity: "discard_pending", sidebar_hidden: false });
    expect(uncertain.workers[0]).toMatchObject({ id: "discard-pending-worker", condition: "disconnected", waiting_reason: "Owned Machine is unreachable" });
    expect(uncertain.implementation.completion_evidence?.quiescent).toBe(false);
    f.restart();
    expect(await f.detail("discarded-history")).toEqual(discarded);
    expect(await f.detail("discard-pending")).toEqual(uncertain);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("historical Done work missing required delivery proof returns to Needs you with correction options", async () => {
  const f = factoryHistoryFixture([
    { id: "unmerged", outcome: "pr_open", delivery_scope: historicalDeliveryScope, delivery: { ...historicalMerge, condition: "linked", pulls: [] }, completion_evidence: historicalChangeEvidence },
    { id: "awaiting-release", outcome: "merged", delivery_scope: { ...historicalDeliveryScope, milestone: "release" }, delivery: historicalMerge, completion_evidence: historicalChangeEvidence },
    { id: "unrelated-target", outcome: "merged", delivery_scope: historicalDeliveryScope, delivery: { ...historicalMerge, branch: "other" }, completion_evidence: historicalChangeEvidence },
    { id: "unrelated-release", outcome: "released", delivery_scope: { ...historicalDeliveryScope, milestone: "release" }, delivery: { ...historicalRelease, release: { ...historicalRelease.release!, merge_commits: ["ffffffffffffffffffffffffffffffffffffffff"] } }, completion_evidence: historicalChangeEvidence },
    { id: "unverified-research", outcome: "research_accepted" },
  ]);
  try {
    for (const id of ["unmerged", "awaiting-release", "unrelated-target", "unrelated-release", "unverified-research"]) {
      const detail = await f.detail(id);
      expect(detail.board).toMatchObject({ lane: "needs_you", busy: false });
      expect(detail.board?.waiting_reason).toContain("Historical completion");
      expect(detail.board?.waiting_reason).toContain("discard");
      expect(detail.implementation.outcome).toBe("none");
      if (id !== "unverified-research") {
        expect(detail.implementation.completion_evidence?.repository_changes).toBe("changes");
        expect(detail.implementation.delivery?.revision).toBe("retained-delivery-revision");
        expect(detail.implementation.delivery?.condition).toBe(id === "awaiting-release" ? "merged" : "needs_you");
        expect(detail.implementation.delivery?.release).toBeUndefined();
      }
    }
    expect((await f.detail("awaiting-release")).board?.waiting_reason).toContain("containing release");
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("startup retains historical completion backed by a containing release", async () => {
  const f = factoryHistoryFixture([{ outcome: "released", delivery_scope: { ...historicalDeliveryScope, milestone: "release" }, delivery: historicalRelease, completion_evidence: historicalChangeEvidence }]);
  try {
    const detail = await f.detail();
    expect(detail.board).toMatchObject({ lane: "done", sidebar_hidden: true });
    expect(detail.implementation.outcome).toBe("released");
    expect(detail.implementation.delivery?.release?.url).toBe("https://github.com/fictional/history/releases/tag/v1.0.0");
    expect(detail.events.map(event => event.id)).toEqual(["historical-done-event"]);
    f.restart();
    expect(await f.detail()).toEqual(detail);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("startup retains historical Done work covered by verified PR merges", async () => {
  const f = factoryHistoryFixture([{ outcome: "merged", delivery_scope: historicalDeliveryScope, delivery: historicalMerge, completion_evidence: historicalChangeEvidence }]);
  try {
    const detail = await f.detail();
    expect(detail.board).toMatchObject({ lane: "done", sidebar_hidden: true });
    expect(detail.implementation).toMatchObject({ stage: "done", outcome: "merged", updated_at: "2026-09-01T12:00:00Z" });
    expect(detail.implementation.delivery?.pulls[0]?.url).toBe("https://github.com/fictional/history/pull/12");
    expect(detail.events.map(event => event.id)).toEqual(["historical-done-event"]);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});

test("startup retains accepted no-change research and archived historical Done records", async () => {
  const f = factoryHistoryFixture([
    { id: "accepted-research", outcome: "research_accepted", completion_evidence: { repository_changes: "none", quiescent: true, reason: null, checked_at: "2026-09-01T12:00:00Z" } },
    { id: "archived-history", archived_at: "2026-09-02T12:00:00Z" },
  ]);
  try {
    const research = await f.detail("accepted-research");
    expect(research.board).toMatchObject({ lane: "done", sidebar_hidden: true });
    expect(research.implementation).toMatchObject({ stage: "done", outcome: "research_accepted", updated_at: "2026-09-01T12:00:00Z" });
    const archived = await f.detail("archived-history");
    expect(archived.implementation).toMatchObject({ stage: "done", outcome: "implementation_complete", archived_at: "2026-09-02T12:00:00Z", updated_at: "2026-09-01T12:00:00Z" });
    expect(archived.events.map(event => event.id)).toEqual(["archived-history-event"]);
    f.restart();
    expect(await f.detail("accepted-research")).toEqual(research);
    expect(await f.detail("archived-history")).toEqual(archived);
    expect(f.starts).toEqual([]);
  } finally { f.close(); }
});
