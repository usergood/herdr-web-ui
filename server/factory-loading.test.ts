import { expect, test } from "bun:test";
import { factoryLoadingFixture } from "./factory-loading.fixture.ts";
import type { FactoryCurrent, FactoryDetail, FactoryOverview, FactoryReviewDetail } from "../shared/factory.ts";

test("current loading preserves decisions and evidence while excluding retained bodies", async () => {
  const f = factoryLoadingFixture();
  const read = async <T>(path: string) => {
    const url = new URL("http://localhost/api/factory" + path);
    const response = await f.service.handle(new Request(url), url);
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) as T, text };
  };
  try {
    const prefix = `/implementations/${f.id}`;
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
    for (const field of ["messages", "native_snapshots", "snapshots", "review_batches", "artifacts", "workers"]) expect(field in current.body).toBe(false);
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
    f.service.store.event(f.id, "continuation_waiting", { run_id: current.body.runs.at(-1)!.id, message: "Retain this decision warning" });
    const next = (await read<FactoryCurrent>(prefix + "?view=current")).body;
    expect(next.revision).not.toBe(current.body.revision);
    expect(next.events.at(-1)?.data).toEqual({ run_id: current.body.runs.at(-1)!.id, message: "Retain this decision warning" });
    expect((await read<FactoryDetail>(prefix)).body.native_snapshots).toEqual(full.body.native_snapshots);
    console.log(JSON.stringify({ fixture: "8 assignments / 4 retained attempts each", overview_bytes: overview.bytes, full_overview_bytes: completeOverview.bytes, workflow_current_bytes: current.bytes, full_detail_bytes: full.bytes, review_index_bytes: review.bytes }));
  } finally { f.close(); }
});

test("current question scope and old active attempts match full detail", async () => {
  const f = factoryLoadingFixture();
  try {
    const store = f.service.store;
    const probe = store.get<any>("runs", "run-0-0");
    store.put("runs", { ...probe, action: "verify-provider", condition: "needs_you" }, f.id);
    for (const [id, run_id] of [["probe", probe.id], ["product", null]] as const) store.put("questions", { ...store.record(), id, implementation_id: f.id, run_id, question: id, answer: null, revision: id }, f.id);
    const url = new URL(`http://localhost/api/factory/implementations/${f.id}?view=current`);
    const current: FactoryCurrent = await (await f.service.handle(new Request(url), url)).json();
    const full = f.service.detail(f.id)!;
    expect(current.question_context).toEqual(full.question_context);
    expect(current.question_revision).toBe(full.question_revision);
    expect(current.board).toEqual(full.board);
    expect(current.question_context?.questions.map(q => q.id)).toEqual(["probe"]);
    expect(current.runs.find(run => run.id === probe.id)?.condition).toBe("needs_you");
  } finally { f.close(); }
});
