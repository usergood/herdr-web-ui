import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

describe("Human Review comment drafts through authenticated HTTP", () => {
  it("validates exact sides, contiguous ranges and change identities for renamed and deleted files", async () => {
    const f = await capacityFixture();
    try {
      const prefix = `/implementations/${await f.assignment("Captured ranges")}`;
      f.reviewFiles([
        { path: "renamed.ts", status: "branch:R090", diff: "rename from old.ts\nrename to renamed.ts\n@@ -3,2 +5,2 @@\n-old one\n-old two\n+new one\n+new two\n@@ -20 +22 @@\n-last\n+last new\n", binary: false, oversized: false },
        { path: "removed.txt", status: "branch:D", diff: "@@ -1,2 +0,0 @@\n-one\n-two\n", binary: false, oversized: false },
        { path: "same.txt", status: "staged:M", diff: "@@ -1 +1 @@\n-old\n+staged\n", binary: false, oversized: false },
        { path: "same.txt", status: "unstaged:M", diff: "@@ -1 +1 @@\n-staged\n+unstaged\n", binary: false, oversized: false },
      ]);
      const snapshot = await f.api(`${prefix}/snapshots`, { mode: "branch" }).then(r => r.json());
      const anchor = { snapshot_id: snapshot.id, path: "renamed.ts", change: "branch:R090", side: "old", line_start: 3, line_end: 4, content: "Keep this range" };
      for (const selection of [anchor, { ...anchor, side: "new", line_start: 5, line_end: 6 }, { ...anchor, path: "removed.txt", change: "branch:D", line_start: 1, line_end: 2 }]) {
        const result = await f.api(`${prefix}/comments`, selection);
        expect(result.status).toBe(201);
        expect(await result.json()).toMatchObject({ ...selection, snapshot_id: snapshot.id, status: "draft", batch_id: null });
      }
      for (const selection of [{ ...anchor, line_end: 20 }, { ...anchor, side: "new" }, { ...anchor, line_start: 0 }, { ...anchor, line_end: 2 }, { ...anchor, line_end: 104 }, { ...anchor, path: "removed.txt", change: "branch:D", side: "new", line_start: 1, line_end: 1 }, { ...anchor, path: "same.txt", change: undefined, line_start: 1, line_end: 1 }]) {
        expect((await f.api(`${prefix}/comments`, selection)).status).toBe(400);
      }
      const selected = await f.api(`${prefix}/comments`, { ...anchor, path: "same.txt", change: "unstaged:M", side: "new", line_start: 1, line_end: 1 }).then(r => r.json());
      expect(selected).toMatchObject({ path: "same.txt", change: "unstaged:M", context: expect.stringContaining("+unstaged") });
      const other = await f.assignment("Other Assignment");
      expect((await f.api(`/implementations/${other}/comments/${selected.id}/edit`, { content: "Wrong owner" })).status).toBe(404);
      expect((await f.api(`${prefix}/comments/${selected.id}/edit`, { content: " " })).status).toBe(400);
      expect((await f.api(`${prefix}/comments/${selected.id}/edit`, { content: "x".repeat(10001) })).status).toBe(400);
      const path = `http://localhost:${f.app.port}/api/factory${prefix}/comments/${selected.id}/delete`;
      expect((await fetch(path, { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-herdr-factory": "1" } })).status).toBe(401);
      expect((await fetch(path, { method: "POST", body: "{}", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" } })).status).toBe(403);
      expect((await f.api(prefix).then(r => r.json())).comments).toHaveLength(4);
    } finally { f.close(); }
  });
  it("refuses text anchors on binary or oversized captures even if a Machine includes hunk text", async () => {
    const f = await capacityFixture();
    try {
      const prefix = `/implementations/${await f.assignment("Non-text review")}`;
      f.reviewFiles([
        { path: "image.bin", status: "branch:M", diff: "@@ -1 +1 @@\n-before\n+after\n", binary: true, oversized: false },
        { path: "large.txt", status: "branch:M", diff: "@@ -1 +1 @@\n-before\n+after\n", binary: false, oversized: true },
      ]);
      const snapshot = await f.api(`${prefix}/snapshots`, { mode: "branch" }).then(r => r.json());
      for (const path of ["image.bin", "large.txt"]) {
        const response = await f.api(`${prefix}/comments`, { snapshot_id: snapshot.id, path, change: "branch:M", side: "new", line_start: 1, line_end: 1, content: "Cannot anchor this" });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_anchor" } });
      }
      expect((await f.api(prefix).then(r => r.json())).comments).toEqual([]);
    } finally { f.close(); }
  });
  it("keeps resolved history immutable even when a later capture makes its anchor stale", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail, run } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const snapshot = ready.snapshots[0];
      const comment = await f.api(`${prefix}/comments`, { snapshot_id: snapshot.id, path: "progress.ts", change: "branch:M", side: "new", line_start: 1, line_end: 1, content: "Resolved feedback" }).then(r => r.json());
      expect((await f.api(`${prefix}/comments/${comment.id}/resolve`, { head: snapshot.head, summary: "Reviewed the checked result" })).status).toBe(200);
      f.reviewHead("f".repeat(40));
      await f.api(`${prefix}/snapshots`, { run_id: run.id, mode: "branch" });
      expect((await f.api(`${prefix}/comments/${comment.id}/edit`, { content: "Rewrite history" })).status).toBe(409);
      expect((await f.api(`${prefix}/comments/${comment.id}/delete`, {})).status).toBe(409);
      expect((await detail()).comments[0].content).toBe("Resolved feedback");
    } finally { f.close(); }
  }, 20000);
  it("retains stale draft anchors and marks late drafts on a changed candidate as outdated", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail, run } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const snapshot = ready.snapshots[0];
      const body = { snapshot_id: snapshot.id, path: "progress.ts", change: "branch:M", side: "new", line_start: 1, line_end: 1, content: "Original candidate feedback" };
      const original = await f.api(`${prefix}/comments`, body).then(r => r.json());
      f.reviewHead("f".repeat(40));
      const changed = await f.api(`${prefix}/snapshots`, { run_id: run.id, mode: "branch" }).then(r => r.json());
      expect(changed.head).not.toBe(snapshot.head);
      const late = await f.api(`${prefix}/comments`, { ...body, content: "Late feedback on original candidate" }).then(r => r.json());
      expect(late.status).toBe("outdated");
      const edited = await f.api(`${prefix}/comments/${original.id}/edit`, { content: "Retained old anchor" }).then(r => r.json());
      expect(edited).toMatchObject({ snapshot_id: snapshot.id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, context: snapshot.files[0].diff, status: "outdated", batch_id: null });
      f.restart();
      expect((await detail()).comments.map((c: any) => c.status)).toEqual(["outdated", "outdated"]);
      expect((await detail()).snapshots.find((s: any) => s.id === original.snapshot_id).head).toBe(snapshot.head);
    } finally { f.close(); }
  }, 20000);
  it("edits and removes saved drafts without changing their captured anchors or launching work", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const snapshot = ready.snapshots[0];
      const response = await f.api(`${prefix}/comments`, { snapshot_id: snapshot.id, path: "progress.ts", change: "branch:M", side: "old", line_start: 1, line_end: 1, content: "Explain the old behavior" });
      expect(response.status).toBe(201);
      const original = await response.json();
      const edited = await f.api(`${prefix}/comments/${original.id}/edit`, { content: "Keep the old behavior documented" });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ ...original, updated_at: expect.any(String), content: "Keep the old behavior documented" });
      f.restart();
      expect((await detail()).comments).toHaveLength(1);
      expect((await detail()).comments[0].content).toBe("Keep the old behavior documented");
      expect((await f.api(`${prefix}/comments/${original.id}/delete`, {})).status).toBe(200);
      f.restart();
      const after = await detail();
      expect(after.comments).toEqual([]);
      expect(after.approvals).toEqual(ready.approvals);
      expect(after.workers).toHaveLength(3);
      expect(f.launches).toHaveLength(1);
      expect(f.prompts).toEqual([]);
    } finally { f.close(); }
  }, 20000);
});
