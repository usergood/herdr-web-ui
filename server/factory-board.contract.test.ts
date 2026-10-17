import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { factoryMergeFixture } from "./factory-merge.fixture.ts";
import { factoryHistoryFixture } from "./factory-history.fixture.ts";
import { boardRepair, boardScenario } from "../scripts/factory-board-fixture.ts";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

describe("Assignment board through authenticated HTTP", () => {
  it("retains completion faults through delivery verification and keeps ordinary waits as status", async () => {
    const f = await factoryMergeFixture(true, "release");
    try {
      const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
      const sync = () => f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
      const error = "Repository change evidence is unavailable. Reconnect the Machine and inspect the retained work before accepting research.";
      expect((await f.request(`${f.prefix}/snapshots`, { run_id: f.run.id, mode: "branch" })).status).toBe(201);
      expect((await f.request(`/runs/${f.run.id}/stop`, {})).status).toBe(200);
      f.disconnect(); await sync();
      expect((await f.request(f.prefix).then(r => r.json())).implementation.completion_evidence).toMatchObject({ reason: error, reason_is_error: true });
      f.reconnect(); f.pull.merged = false; f.respond();
      const ordinary = await sync();
      expect(ordinary.problem).toContain("is not verified merged");
      expect((await f.request(f.prefix).then(r => r.json())).board).toMatchObject({ waiting_reason: ordinary.problem, waiting_reason_is_error: false });
      f.pull.merged = true; f.respond();
      expect((await sync()).condition).toBe("merged");
      const waiting = await f.request(f.prefix).then(r => r.json());
      expect(waiting.board).toMatchObject({ lane: "running", activity: "awaiting_release", waiting_reason: null, waiting_reason_is_error: false });
      expect(waiting.implementation.completion_evidence.reason_is_error).toBe(false);
      f.data["repos/fictional/project/releases?per_page=100&page=1"] = null; f.respond();
      const failed = await sync();
      expect(failed.problem).toBe("GitHub release evidence is incomplete; sync again when it is available");
      for (const suffix of ["", "?navigation=1"]) {
        const overview = await f.request(suffix).then(r => r.json());
        expect(overview.board.find((item: any) => item.implementation_id === f.run.implementation_id)).toMatchObject({ activity: "awaiting_release", waiting_reason: failed.problem, waiting_reason_is_error: true });
        expect(overview.progress.find((item: any) => item.implementation_id === f.run.implementation_id).error_reasons).toContain(failed.problem);
      }
      for (const suffix of ["", "?view=current"]) expect((await f.request(f.prefix + suffix).then(r => r.json())).board.waiting_reason_is_error).toBe(true);
      f.restart();
      expect((await f.request(f.prefix).then(r => r.json())).implementation.completion_evidence.reason_is_error).toBe(true);
      f.data["repos/fictional/project/releases?per_page=100&page=1"] = []; f.respond(); await sync();
      const recovered = await f.request("").then(r => r.json());
      expect(recovered.board.find((item: any) => item.implementation_id === f.run.implementation_id)).toMatchObject({ lane: "running", activity: "awaiting_release", waiting_reason: null, waiting_reason_is_error: false });
      expect(recovered.progress.find((item: any) => item.implementation_id === f.run.implementation_id).error_reasons).toEqual([]);
    } finally { await f.close(); }
  }, 30000);

  it("keeps historical missing completion proof distinct from a failed observation", async () => {
    const f = factoryHistoryFixture();
    try {
      for (const suffix of ["", "?navigation=1"]) {
        const overview = await f.request(suffix).then(r => r.json());
        expect(overview.implementations[0].completion_evidence.repository_changes).toBe("unknown");
        expect(overview.board[0].waiting_reason_is_error).toBe(false);
        expect(overview.progress[0].error_reasons).toEqual([]);
      }
    } finally { f.close(); }
  });

  it.each([false, true])("announces unavailable completion evidence with retained changes=%s and clears it after inspection", async retainedChanges => {
    const f = await factoryDeliveryFixture(true);
    try {
      const run = await f.start();
      if (retainedChanges) {
        writeFileSync(join(run.worktree!, "findings.md"), "Owned retained findings\n");
        expect((await f.request(`${f.prefix}/snapshots`, { run_id: run.id, mode: "workspace" })).status).toBe(201);
        expect((await f.request(`/runs/${run.id}/stop`, {})).status).toBe(200);
      }
      f.disconnect();
      const error = "Repository change evidence is unavailable. Reconnect the Machine and inspect the retained work before accepting research.";
      const inspection = await f.request(`${f.prefix}/completion-evidence`).then(r => r.json());
      const observe = async () => {
        for (const suffix of ["", "?navigation=1"]) {
          const overview = await f.request(suffix).then(r => r.json());
          expect(overview.board.find((item: any) => item.implementation_id === run.implementation_id)).toMatchObject({ lane: "needs_you", activity: retainedChanges ? "awaiting_merge" : "implementing", busy: !retainedChanges, waiting_reason: error, waiting_reason_is_error: true });
          expect(overview.progress.find((item: any) => item.implementation_id === run.implementation_id).error_reasons).toContain(error);
        }
        for (const suffix of ["", "?view=current"]) expect((await f.request(f.prefix + suffix).then(r => r.json())).board).toMatchObject({ waiting_reason: error, waiting_reason_is_error: true });
      };
      await observe();
      expect(inspection).toMatchObject({ repository_changes: retainedChanges ? "changes" : "unknown", quiescent: false, reason: error, reason_is_error: true });
      f.restart(); await observe();
      f.reconnect();
      const recovered = await f.request(`${f.prefix}/completion-evidence`).then(r => r.json());
      expect(recovered.reason_is_error).toBe(false);
      if (retainedChanges) expect(recovered.reason).toBe("Repository changes require verified PR delivery. Link the delivery evidence before completing this Assignment.");
      for (const suffix of ["", "?navigation=1"]) {
        const overview = await f.request(suffix).then(r => r.json());
        expect(overview.board.find((item: any) => item.implementation_id === run.implementation_id).waiting_reason_is_error ?? false).toBe(false);
        expect(overview.progress.find((item: any) => item.implementation_id === run.implementation_id).error_reasons).not.toContain(error);
      }
    } finally { await f.close(); }
  }, 30000);

  it("keeps Running as the displayed lifecycle lane through Pause and restart", async () => {
    const f = await capacityFixture();
    try {
      const { id, run } = await boardScenario(f);
      expect((await f.api(`/runs/${run.id}/checks`, {})).status).toBe(200);
      const observe = async () => {
        for (const suffix of ["", "?navigation=1"]) {
          const overview = await f.api(suffix).then(r => r.json());
          expect(overview.progress.find((entry: any) => entry.implementation_id === id).lane).toBe("running");
          expect(overview.board.find((entry: any) => entry.implementation_id === id).lane).toBe("running");
        }
        for (const suffix of ["", "?view=current"]) expect((await f.api(`/implementations/${id}${suffix}`).then(r => r.json())).board.lane).toBe("running");
      };
      await observe();
      expect((await f.api(`/implementations/${id}/pause`, {})).status).toBe(200);
      expect((await f.api(`/implementations/${id}`).then(r => r.json())).implementation.pause.condition).toBe("paused");
      await observe(); f.restart(); await observe();
      expect((await f.api("").then(r => r.json())).progress.find((entry: any) => entry.implementation_id === id).activities).toEqual([]);
    } finally { f.close(); }
  });

  it("keeps delivered Done as the displayed lifecycle lane while Human Review discussion executes", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { id, prefix, detail } = await published(f);
      const review = (await until(detail, d => d.human_reviews?.[0]?.condition === "ready")).human_reviews[0];
      const approved = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "board-delivered" });
      expect(approved.status).toBe(200); expect(await approved.json()).toMatchObject({ condition: "merged" });
      expect((await detail()).implementation).toMatchObject({ stage: "done", outcome: "merged" });
      const message = await f.api(`${prefix}/human-review/messages`, { review_id: review.id, content: "Explain this delivered result without changing it", idempotency_key: "done-discussion" });
      expect(message.status).toBe(202);
      const discussing = await until(detail, d => d.runs.some((run: any) => run.conversation_kind === "human_review" && run.condition === "working"));
      expect(discussing.implementation.stage).toBe("done");
      const observe = async () => {
        for (const suffix of ["", "?navigation=1"]) {
          const overview = await f.api(suffix).then(r => r.json());
          expect(overview.progress.find((entry: any) => entry.implementation_id === id).lane).toBe("done");
          expect(overview.board.find((entry: any) => entry.implementation_id === id).lane).toBe("done");
          expect(overview.board.find((entry: any) => entry.implementation_id === id).sidebar_hidden ?? false).toBe(false);
        }
        for (const suffix of ["", "?view=current"]) expect((await f.api(`${prefix}${suffix}`).then(r => r.json())).board.lane).toBe("done");
      };
      expect((await detail()).board.busy).toBe(true);
      await observe();
      expect((await f.api(`${prefix}/questions`, { question: "Explain the already delivered behavior" })).status).toBe(201);
      await observe(); f.restart(); await observe();
    } finally { f.close(); }
  }, 20000);

  it.each(["retained-completion-evidence", "validation-only"])("preserves Running through Pause for %s", async scenario => {
    const f = await capacityFixture(); let check: Promise<Response> | undefined; let release = () => {};
    try {
      const id = await f.assignment("Paused lifecycle family");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "phase" }).then(r => r.json());
      if (scenario === "retained-completion-evidence") {
        const evidence = await f.api(`/implementations/${id}/completion-evidence`).then(r => r.json());
        expect(evidence).toMatchObject({ repository_changes: "changes", quiescent: false, reason: "Repository changes require verified PR delivery. Link the delivery evidence before completing this Assignment." });
      } else {
        f.researchReady(run.id); await f.api(`/runs/${run.id}/reconcile`, {});
        const gate = f.holdNextCheck("integration"); release = gate.release;
        check = f.api(`/runs/${run.id}/checks`, {}); await gate.started;
      }
      const lane = async () => {
        const view = await f.api("").then(r => r.json());
        expect(view.board.find((entry: any) => entry.implementation_id === id).lane).toBe("running");
        expect(view.progress.find((entry: any) => entry.implementation_id === id).lane).toBe("running");
      };
      await lane();
      expect((await f.api(`/implementations/${id}/pause`, {})).status).toBe(200);
      await check; await lane(); f.restart(); await lane();
    } finally { release(); await check; f.close(); }
  });

  it("names running Tickets and explains dependencies, then retains integrated completion across restart", async () => {
    const f = await capacityFixture();
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect(await progress()).toMatchObject({
        lane: "running", activities: ["implementing"], error_reasons: [], counts: { waiting: 1, running: 1, completed: 0 },
        tickets: [
          { ticket_id: graph.tickets[0].id, title: "Transport progress", state: "running" },
          { title: "Dependent view", state: "waiting", reason: "Waiting for dependencies: Transport progress" },
        ],
      });
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      expect((await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {})).status).toBe(200);
      f.restart();
      expect(await progress()).toMatchObject({ counts: { waiting: 1, running: 0, completed: 1 }, tickets: [{ state: "completed" }, { state: "waiting" }] });
      expect((await f.api(`/implementations/${id}`).then(r => r.json())).runs[0].id).toBe(run.id);
    } finally { f.close(); }
  });
  it("shows overlapping worker, check and review activities and stops claiming execution after verified Pause", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextCheck();
    let check: Promise<Response> | undefined;
    try {
      const { id, run, worker } = await boardScenario(f);
      check = f.api(`/runs/${run.id}/checks`, {});
      await gate.started;
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect((await progress()).activities).toEqual(["implementing", "testing"]);
      gate.release(); await check;
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "review" });
      expect(reviewer.status).toBe(200);
      expect((await progress()).activities).toEqual(["auto_review"]);
      const reviewWorker = await reviewer.json();
      f.workers.get(reviewWorker.id)!.condition = "failed";
      f.workers.get(reviewWorker.id)!.waiting_reason = "Standards reviewer disconnected";
      await f.api(`/runs/${run.id}/workers/${reviewWorker.id}/reconcile`, {});
      expect((await progress()).reasons).toContain("Standards reviewer disconnected");
      await f.api(`/implementations/${id}/pause`, {});
      f.restart();
      expect(await progress()).toMatchObject({ activities: [], counts: { waiting: 1, running: 0, completed: 1 } });
    } finally { gate.release(); await check; f.close(); }
  });

  it("exposes queued capacity and failed child reasons without claiming that retained work is running", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 2 });
      const { id, run, worker, graph } = await boardScenario(f);
      await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[1].id, shared_paths: [], idempotency_key: "dependent" });
      const queuedId = await f.assignment("Waiting oldest request");
      await f.api(`/implementations/${queuedId}/runs`, { action: "work", idempotency_key: "queued" });
      const overview = () => f.api("").then(r => r.json());
      const queued = (await overview()).progress.find((p: any) => p.implementation_id === queuedId);
      expect(queued).toMatchObject({ lane: "queued", activities: [], error_reasons: [], counts: { waiting: 0, running: 0, completed: 0 } });
      expect(queued.reasons.join(" ")).toContain("capacity");
      const native = f.workers.get(worker.id)!;
      native.condition = "failed"; native.waiting_reason = "Transport compiler failed";
      await f.api(`/runs/${run.id}/workers/${worker.id}/reconcile`, {});
      const progress = (await overview()).progress.find((p: any) => p.implementation_id === id);
      expect(progress).toMatchObject({ lane: "needs_you", activities: [], counts: { waiting: 2, running: 0, completed: 0 }, tickets: [{ state: "waiting", reason: "Transport compiler failed" }, { state: "waiting" }] });
      expect(progress.tickets[1].reason).toContain("Transport progress");
      expect(progress.reasons).toContain("Transport compiler failed");
      expect(progress.error_reasons).toContain("Transport compiler failed");
    } finally { f.close(); }
  });

  it("keeps the executing Ticket scope visible when a newer Specification is drafted", async () => {
    const f = await capacityFixture();
    try {
      const { id } = await boardScenario(f);
      await f.api(`/implementations/${id}/specifications`, { content: "A later unapproved draft must not erase executing work" });
      const progress = (await f.api("").then(r => r.json())).progress.find((p: any) => p.implementation_id === id);
      expect(progress).toMatchObject({ counts: { waiting: 1, running: 1, completed: 0 }, tickets: [{ title: "Transport progress", state: "running" }, { title: "Dependent view" }] });
    } finally { f.close(); }
  });

  it("refuses manual priority changes and retains creation order across restart", async () => {
    const f = await capacityFixture();
    try {
      const first = await f.assignment("First captured");
      const second = await f.assignment("Second captured");
      const reorder = await f.api(`/implementations/${second}/order`, { before_id: first });
      expect(reorder.status).toBe(409);
      expect(await reorder.json()).toMatchObject({ error: { code: "automatic_order" } });
      f.restart();
      expect((await f.api("").then(r => r.json())).implementations.map((idea: any) => idea.id)).toEqual([first, second]);
    } finally { f.close(); }
  });

  it("shows fresh repair work as Fixing and keeps its failed Ticket unfinished despite earlier integration", async () => {
    const f = await capacityFixture();
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      const repair = await boardRepair(f, id, run.id, graph.tickets[0].id);
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect(await progress()).toMatchObject({ activities: ["fixing"], counts: { waiting: 1, running: 1, completed: 0 } });
      f.workers.get(repair.id)!.condition = "failed";
      f.workers.get(repair.id)!.waiting_reason = "Repair compilation failed";
      await f.api(`/runs/${run.id}/workers/${repair.id}/reconcile`, {});
      expect(await progress()).toMatchObject({ lane: "needs_you", activities: [], counts: { waiting: 2, running: 0, completed: 0 }, tickets: [{ state: "waiting", reason: "Repair compilation failed" }, { state: "waiting" }] });
    } finally { f.close(); }
  });

  it("orders queued cards by request age even when Assignments were captured in the opposite order", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const older = await f.assignment("Captured earlier but requested last");
      const newer = await f.assignment("Captured later but requested first");
      const holder = await f.assignment("Slot holder");
      await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" });
      await f.api(`/implementations/${newer}/runs`, { action: "work", idempotency_key: "first-request" });
      await f.api(`/implementations/${older}/runs`, { action: "work", idempotency_key: "last-request" });
      const overview = await f.api("").then(r => r.json());
      expect(overview.implementations.filter((idea: any) => [older, newer].includes(idea.id)).map((idea: any) => idea.id)).toEqual([newer, older]);
    } finally { f.close(); }
  });

  it("keeps Paused separate from queued and Needs you lanes", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const holder = await f.assignment("Occupied slot");
      const run = await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      const queued = await f.assignment("Paused queued request");
      await f.api(`/implementations/${queued}/runs`, { action: "work", idempotency_key: "queued" });
      await f.api(`/implementations/${queued}/pause`, {});
      f.runs.get(run.id)!.condition = "failed";
      f.runs.get(run.id)!.waiting_reason = "Compiler failed before Pause";
      await f.api(`/runs/${run.id}/reconcile`, {});
      await f.api(`/implementations/${holder}/pause`, {});
      const overview = await f.api("").then(r => r.json());
      expect(overview.progress.find((p: any) => p.implementation_id === queued)).toMatchObject({ lane: "queued", activities: [] });
      expect(overview.progress.find((p: any) => p.implementation_id === holder)).toMatchObject({ lane: "needs_you", activities: [] });
    } finally { f.close(); }
  });

  it("explains failed checks but does not carry a stopped attempt's failures into new work", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Fresh work after a failed attempt");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "first" }).then(r => r.json());
      f.failNextCheck();
      await f.api(`/runs/${run.id}/checks`, {});
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect((await progress()).reasons).toContain("Checks failed: bun test (exit 1)");
      expect((await progress()).error_reasons).toEqual(["Checks failed: bun test (exit 1)"]);
      await f.api(`/runs/${run.id}/checks`, {});
      expect((await progress()).error_reasons).toEqual([]);
      f.failNextCheck(); await f.api(`/runs/${run.id}/checks`, {});
      expect((await progress()).error_reasons).toEqual(["Checks failed: bun test (exit 1)"]);
      await f.api(`/runs/${run.id}/stop`, {});
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "fresh" });
      expect(await progress()).toMatchObject({ lane: "running", activities: ["implementing"], reasons: [], error_reasons: [] });
    } finally { f.close(); }
  });

  it("distinguishes automatic reconnects from blocked requests that need owner correction", async () => {
    const f = await capacityFixture();
    try {
      const blocked = await f.assignment("Scope correction needed");
      const recovering = await f.assignment("Reconnect automatically");
      expect((await f.api(`/implementations/${blocked}/runs`, { action: "work", idempotency_key: "blocked", expected: {} })).status).toBe(409);
      f.loseNextLaunch(); f.uncertain(true);
      const run = await f.api(`/implementations/${recovering}/runs`, { action: "work", idempotency_key: "recovering" }).then(r => r.json());
      expect(run.condition).toBe("disconnected");
      const overview = await f.api("").then(r => r.json());
      expect(overview.progress.find((p: any) => p.implementation_id === recovering)).toMatchObject({ lane: "running", activities: [] });
      expect(overview.progress.find((p: any) => p.implementation_id === blocked)).toMatchObject({ lane: "needs_you", activities: [] });
      expect(overview.progress.find((p: any) => p.implementation_id === blocked).error_reasons).toContain(overview.capacity.waiting.find((wait: any) => wait.implementation_id === blocked).reason);
      expect(overview.progress.find((p: any) => p.implementation_id === recovering).error_reasons).toContain(run.waiting_reason);
    } finally { f.close(); }
  });

  it("keeps a parked owner conversation in Needs you when the owner pauses it", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Parked owner answer");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "owner" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions`, { question: "Which scope?", run_id: run.id });
      f.runs.get(run.id)!.condition = "ready";
      const deadline = Date.now() + 4_000;
      while (true) {
        const detail = await f.api(`/implementations/${id}`).then(r => r.json());
        if (detail.runs[0].continuation?.condition === "parked") break;
        if (Date.now() >= deadline) throw new Error("Owned conversation did not park");
        await Bun.sleep(30);
      }
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect(await progress()).toMatchObject({ lane: "needs_you", activities: [], error_reasons: [] });
      await f.api(`/implementations/${id}/pause`, {});
      expect(await progress()).toMatchObject({ lane: "needs_you", activities: [] });
    } finally { f.close(); }
  });

  it("retains every concurrent failed Ticket reason separately from ordinary waiting", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 4 });
      const id = await f.assignment("Concurrent failed Tickets");
      const prefix = `/implementations/${id}`;
      const detail = await f.api(prefix).then(r => r.json());
      await f.api(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned unpaid fixtures" });
      const spec = await f.api(prefix + "/specifications", { content: "Two independent owned Tickets" }).then(r => r.json());
      for (const kind of ["specification", "testing_seams"]) await f.api(prefix + "/approvals", { kind, revision: spec.id, scope: "Public HTTP and browser" });
      const graph = await f.api(prefix + "/tickets", { specification_id: spec.id, tickets: [{ key: "transport", title: "Transport progress", acceptance: "Transport", dependencies: [] }, { key: "view", title: "View progress", acceptance: "View", dependencies: [] }] }).then(r => r.json());
      await f.api(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Independent Tickets" });
      const run = await f.api(prefix + "/runs", { action: "implement-spec", idempotency_key: "failures" }).then(r => r.json());
      const reasons = ["Transport compiler failed", "View compiler failed"];
      const workers = [];
      for (const [index, ticket] of graph.tickets.entries()) workers.push(await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: ticket.id, shared_paths: [], idempotency_key: `independent-${index}` }).then(r => r.json()));
      for (const [index, worker] of workers.entries()) {
        Object.assign(f.workers.get(worker.id)!, { condition: "failed", waiting_reason: reasons[index] });
        await f.api(`/runs/${run.id}/workers/${worker.id}/reconcile`, {});
      }
      const overview = await f.api("").then(r => r.json());
      const progress = overview.progress.find((entry: any) => entry.implementation_id === id);
      expect(progress.error_reasons).toEqual(reasons);
      expect(progress.tickets.map((ticket: any) => ticket.reason)).toEqual(reasons);
      expect(overview.board.find((entry: any) => entry.implementation_id === id)).toMatchObject({ condition: "failed", waiting_reason: reasons[0] });
      await f.api(prefix + "/questions", { run_id: run.id, question: reasons[0] });
      const attention = await f.api("").then(r => r.json());
      expect(attention.board.find((entry: any) => entry.implementation_id === id)).toMatchObject({ condition: "needs_you", waiting_reason: reasons[0] });
      expect(attention.progress.find((entry: any) => entry.implementation_id === id).error_reasons).toEqual(reasons);
    } finally { f.close(); }
  });

  it.each(["failed", "interrupted", "disconnected", "blocked", "needs_you"] as const)("classifies native %s reasons without treating owner attention as failure", async condition => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Retained native condition");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "native" }).then(r => r.json());
      const reason = condition === "needs_you" ? "Which owner scope should be retained?" : "Owned native execution requires recovery";
      Object.assign(f.runs.get(run.id)!, { condition, waiting_reason: reason });
      await f.api(`/runs/${run.id}/reconcile`, {});
      const progress = (await f.api("").then(r => r.json())).progress.find((entry: any) => entry.implementation_id === id);
      expect(progress.reasons).toContain(reason);
      expect(progress.error_reasons).toEqual(condition === "needs_you" ? [] : [reason]);
    } finally { f.close(); }
  });

});
