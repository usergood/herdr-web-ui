import { expect, test } from "bun:test";
import { factoryLoadingFixture } from "./factory-loading.fixture.ts";
import type { FactoryCurrent, FactoryDetail, FactoryOverview, FactoryReviewDetail } from "../shared/factory.ts";

test("current loading preserves decisions and evidence while excluding retained bodies", async () => {
  const f = factoryLoadingFixture();
  const read = async <T>(path: string) => {
    const response = await f.request(path);
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) as T, text };
  };
  try {
    const prefix = `/implementations/${f.id}`;
    expect((await fetch(f.origin() + "/api/factory" + prefix + "?view=current")).status).toBe(401);
    const full = await read<FactoryDetail>(prefix), current = await read<FactoryCurrent>(prefix + "?view=current");
    expect(current.status).toBe(200);
    expect(current.bytes).toBeLessThan(full.bytes * 0.02);
    expect(current.body.board).toEqual(full.body.board);
    expect(current.body.implementation).toEqual(full.body.implementation);
    expect(current.body.specifications).toEqual(full.body.specifications.slice(-1));
    expect(current.body.tickets).toEqual(full.body.tickets);
    expect(current.body.graph_hash).toBe(full.body.graph_hash);
    expect(current.body.question_context).toEqual(full.body.question_context);
    expect(current.body.runs.map(run => ({ ...run, manifest: null }))).toEqual(full.body.runs.map(run => ({ ...run, manifest: null })));
    expect(current.body.runs[0]!.manifest).toEqual({ execution_preset: { model: "fixture-model", reasoning: "high" } });
    for (const field of ["messages", "native_snapshots", "snapshots", "review_batches", "artifacts"]) expect(field in current.body).toBe(false);
    expect(current.body.workers).toEqual(full.body.workers);
    expect(current.text).not.toContain("frozen_context");
    expect(current.body.checks.every(check => !("commands" in check))).toBe(true);
    expect(current.body.review_evidence.every(report => !("content" in report))).toBe(true);
    expect((await read<FactoryCurrent>(prefix + "?view=current")).body.revision).toBe(current.body.revision);

    const overview = await read<FactoryOverview>("?navigation=1"), completeOverview = await read<FactoryOverview>("");
    expect(overview.bytes).toBeLessThan(completeOverview.bytes * 0.15);
    expect(overview.body.board).toEqual(completeOverview.body.board);
    expect(overview.body.pane_links).toEqual(completeOverview.body.pane_links);
    expect(overview.body.activity).toEqual(completeOverview.body.activity);
    expect(overview.body.implementations.every(idea => !("description" in idea))).toBe(true);

    const review = await read<FactoryReviewDetail>(prefix + "?view=review");
    expect(review.body.snapshots).toHaveLength(full.body.snapshots.length);
    expect(review.body.snapshots.every(snapshot => !("files" in snapshot))).toBe(true);
    expect(review.body.review_evidence).toEqual(current.body.review_evidence);
    const report = full.body.review_evidence[0]!, snapshot = full.body.snapshots[0]!;
    expect((await read(prefix + `?view=report&record_id=${report.id}`)).body).toEqual(report);
    expect((await read(prefix + `?view=snapshot&record_id=${snapshot.id}`)).body).toEqual(snapshot);
    expect((await read(`/implementations/assignment-1?view=report&record_id=${report.id}`)).status).toBe(404);
    expect((await read(`/implementations/assignment-1?view=snapshot&record_id=${snapshot.id}`)).status).toBe(404);
    expect((await read("/implementations/missing?view=current")).status).toBe(404);
    expect((await f.request(prefix + "/chats", { title: "Public refresh probe" })).status).toBe(201);
    expect((await read<FactoryCurrent>(prefix + "?view=current")).body.revision).not.toBe(current.body.revision);
    f.restart(store => { store.event(f.id, "continuation_waiting", { run_id: current.body.runs.at(-1)!.id, message: "Retain this decision warning" }); });
    const next = (await read<FactoryCurrent>(prefix + "?view=current")).body;
    expect(next.revision).not.toBe(current.body.revision);
    expect(next.events.at(-1)?.data).toEqual({ run_id: current.body.runs.at(-1)!.id, message: "Retain this decision warning" });
    for (const reworkRequested of [true, false, null, "true"]) {
      const runId = current.body.runs.at(-1)!.id;
      f.restart(store => { store.event(f.id, "run_stopped", { run_id: runId, message: "Retained stop", rework_requested: reworkRequested, evidence: "retained_event_body".repeat(1000) }); });
      const stopped = await read<FactoryCurrent>(prefix + "?view=current");
      expect(stopped.body.events.find(event => event.kind === "run_stopped")?.data).toEqual({ run_id: runId, message: "Retained stop", ...(typeof reworkRequested === "boolean" ? { rework_requested: reworkRequested } : {}) });
      expect(stopped.text).not.toContain("retained_event_body");
    }
    expect((await read<FactoryDetail>(prefix)).body.native_snapshots).toEqual(full.body.native_snapshots);
    console.log(JSON.stringify({ fixture: "8 assignments / 4 retained attempts each", overview_bytes: overview.bytes, full_overview_bytes: completeOverview.bytes, workflow_current_bytes: current.bytes, full_detail_bytes: full.bytes, review_index_bytes: review.bytes }));
  } finally { f.close(); }
});

test("current question scope and old active attempts match full detail", async () => {
  const f = factoryLoadingFixture(store => {
    const probe = store.get<any>("runs", "run-0-0");
    const waiting = { ...probe, action: "verify-provider", condition: "needs_you", worktree: store.root, workspace_id: "owned-loading-probe" };
    store.put("runs", waiting, "assignment-0");
    store.put("host_leases", { id: waiting.id, signature: "owned-loading-probe", run: waiting });
    for (const [id, run_id] of [["probe", probe.id], ["product", null]] as const) store.put("questions", { ...store.record(), id, implementation_id: "assignment-0", run_id, question: id, answer: null, revision: id }, "assignment-0");
  });
  try {
    const current: FactoryCurrent = await (await f.request(`/implementations/${f.id}?view=current`)).json();
    const full: FactoryDetail = await (await f.request(`/implementations/${f.id}`)).json();
    expect(current.question_context).toEqual(full.question_context);
    expect(current.question_revision).toBe(full.question_revision);
    expect(current.board).toEqual(full.board);
    expect(current.question_context?.questions.map(q => q.id)).toEqual(["probe"]);
    expect(current.runs.find(run => run.id === "run-0-0")?.condition).toBe("needs_you");
  } finally { f.close(); }
});


test("navigation keeps visible Project conversation identities without duplicating native provenance", async () => {
  const f = factoryLoadingFixture();
  const read = async <T>(path: string) => {
    return await (await f.request(path)).json() as T;
  };
  try {
    expect((await read<FactoryOverview>("?navigation=1")).conversations).toEqual([]);
    const projectId = "visible-project";
    const linkedImplementationId = "assignment-1";
    f.restart(store => {
      const legacy = store.get<any>("runs", "run-2-0")!;
      store.put("runs", { ...legacy, manifest: null }, legacy.implementation_id);
      const project = { ...store.record(), id: "visible-project", name: "Owned Project", repository: "owned", provider: "codex", machine_id: "local", tracker: "app", tracker_reference: "" };
      store.put("projects", project);
      const assigned = store.get<any>("implementations", f.id)!;
      store.put("implementations", { ...assigned, project_id: project.id });
      const linked = store.get<any>("runs", "run-1-0")!;
      store.put("runs", { ...linked, manifest: { ...linked.manifest, project: { id: project.id } } }, linked.implementation_id);
    });
    const navigation = await read<FactoryOverview>("?navigation=1");
    const complete = await read<FactoryOverview>("");
    expect(navigation.pane_links).toEqual(complete.pane_links);
    expect(navigation.progress).toEqual(complete.progress);
    expect(navigation.capacity).toEqual(complete.capacity);
    expect(navigation.conversations?.map(c => c.id)).toEqual(complete.conversations?.filter(c => [f.id, linkedImplementationId].includes(c.implementation_id)).map(c => c.id));
    const contexts = navigation.conversations?.find(c => c.id === `${f.id}:orchestrator`)?.contexts;
    expect(contexts).toEqual([0, 1, 2, 3].map(r => ({ run_id: `run-0-${r}`, worker_id: null })));
    const current = await read<FactoryCurrent>(`/implementations/${f.id}?view=current`);
    const detail = await read<FactoryDetail>(`/implementations/${f.id}`);
    expect(current.conversations).toEqual(detail.conversations);
    expect(current.conversations?.find(c => c.kind === "orchestrator")?.contexts[0]).toMatchObject({ pane_id: "pane-0-0", machine_id: "local", snapshot_ids: ["native-0-0"] });
    f.restart(store => {
      const assigned = store.get<any>("implementations", f.id)!;
      store.put("implementations", { ...assigned, project_id: projectId, archived_at: store.record().created_at });
      const hidden = store.get<any>("implementations", linkedImplementationId)!;
      store.put("implementations", { ...hidden, stage: "done", outcome: "discarded" });
    });
    expect((await read<FactoryOverview>("?navigation=1")).conversations).toEqual([]);
    f.restart(store => {
      const assigned = store.get<any>("implementations", f.id)!;
      const project = store.get<any>("projects", projectId)!;
      store.put("implementations", { ...assigned, project_id: projectId, archived_at: null });
      store.put("projects", { ...project, removed_at: store.record().created_at });
    });
    expect((await read<FactoryOverview>("?navigation=1")).conversations).toEqual([]);
    expect((await read<FactoryDetail>(`/implementations/${f.id}`)).conversations).toEqual(detail.conversations);
  } finally { f.close(); }
});
