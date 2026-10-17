import { expect, it } from "bun:test";
import { mergeFixture } from "../scripts/factory-merge-fixture.ts";
import { releaseBrowserFixture } from "../scripts/factory-release-browser-fixture.ts";

it("Human Review releases intended changes despite an independent unchanged context edit", async () => {
  const f = await mergeFixture({ milestone: "release", baselineContent: "config=old\nfeature=disabled\n", candidateContent: "config=old\nfeature=enabled\n" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "independent-context", f.descendant("config=new\nfeature=enabled\n")]); f.change({ release: "independent-context" }); f.restart();
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "released", release_tag: "independent-context", head: f.head });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


it("Human Review keeps relocated reviewed additions unverified and recovers a covering release under the original approval", async () => {
  const baseline = "function checked() {\n  run();\n}\nfunction other() {\n  noop();\n}\n";
  const candidate = "function checked() {\n  validate();\n  run();\n}\nfunction other() {\n  noop();\n}\n";
  const moved = "function checked() {\n  run();\n}\nfunction other() {\n  validate();\n  noop();\n}\n";
  const f = await releaseBrowserFixture({ baselineContent: baseline, candidateContent: candidate });
  const post = (body: unknown) => fetch(`http://localhost:${f.app.port}${f.prefix}/human-review/approve`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
  try {
    const ready = await f.detail(); const review = ready.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "location-bound-release" };
    const approved = await post(body); expect(approved.status).toBe(200); const receipt = await approved.json();
    expect(receipt.condition).toBe("awaiting_release");
    const merge = f.core.githubState().pull.mergeCommit.oid;
    f.core.git(["tag", "relocated-release", f.core.descendant(moved)]); f.core.change({ release: "relocated-release" });
    const machine = await f.core.post(f.core.route + "merge", { ...f.mergeRequests[0], approval: receipt });
    expect(machine.status).toBe(200);
    expect(await machine.json()).toMatchObject({ condition: "awaiting_release", release_tag: null, merge_sha: merge });
    const observed = await post(body); expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ id: receipt.id, condition: "awaiting_release", release_tag: null });
    expect((await f.detail()).implementation.stage).toBe("review");
    f.core.git(["tag", "location-covering-release", f.core.descendant(candidate + "\n// Independent later note\n")]);
    f.core.change({ release: "location-covering-release", release_lookup_missing: true });
    expect(await post(body).then(r => r.json())).toMatchObject({ id: receipt.id, condition: "awaiting_release", reason_is_error: true });
    f.core.change({ release_lookup_missing: false }); await f.restart();
    const completed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "released");
    expect(completed.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: receipt.id, head: receipt.head, snapshot_id: receipt.snapshot_id, context_revision: receipt.context_revision, idempotency_key: receipt.idempotency_key, merge_sha: merge, release_tag: "location-covering-release" });
    expect(completed.events.filter((event: any) => event.kind === "human_review_merge_authorized")).toHaveLength(1);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 25000);


it.each([
  { name: "long moved block", baseline: "function checked() {\n  run();\n}\nfunction other() {\n  noop();\n}\n", approved: "function checked() {\n  validate();\n  verify();\n  audit();\n  persist();\n  run();\n}\nfunction other() {\n  noop();\n}\n", observed: "function checked() {\n  run();\n}\nfunction other() {\n  validate();\n  verify();\n  audit();\n  persist();\n  noop();\n}\n" },
  { name: "new conditional around a retained call", baseline: "function checked() {\n  run();\n}\n", approved: "function checked() {\n  validate();\n  run();\n}\n", observed: "function checked() {\n  if (false)\n  validate();\n  run();\n}\n" },
  { name: "duplicate context anchors", baseline: "entry\nrepeat\nfinish\nentry\nrepeat\nfinish\n", approved: "entry\n  validate();\nrepeat\nfinish\nentry\nrepeat\nfinish\n", observed: "entry\nrepeat\nfinish\nentry\n  validate();\nrepeat\nfinish\n" },
])("Human Review keeps ambiguous location evidence unverified: $name", async ({ baseline, approved, observed }) => {
  const f = await mergeFixture({ milestone: "release", baselineContent: baseline, candidateContent: approved });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "ambiguous-location", f.descendant(observed)]); f.change({ release: "ambiguous-location" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


it("Human Review permits an independent context edit outside preserved function anchors", async () => {
  const baseline = "config=old\nfunction checked() {\n  run();\n}\n";
  const candidate = "config=old\nfunction checked() {\n  validate();\n  run();\n}\n";
  const f = await mergeFixture({ milestone: "release", baselineContent: baseline, candidateContent: candidate });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "anchored-context-edit", f.descendant(candidate.replace("config=old", "config=new"))]); f.change({ release: "anchored-context-edit" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "anchored-context-edit" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("Human Review refuses a release deleted after inventory even while its containing tag remains", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "deleted-publication", "main"]); f.change({ release: "deleted-publication", release_after_inventory_patch: { release: null } });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "release_inventory_unavailable" } });
    expect(f.git(["rev-parse", "deleted-publication"])).toBe(f.git(["rev-parse", "main"]));
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "context following the feature", base: "feature=off\nconfig=old\n", approved: "feature=on\nconfig=old\n", released: "feature=on\nconfig=new\n", valid: true },
  { name: "deletion with independently changed context", base: "config=old\nremoved feature\nretained\n", approved: "config=old\nretained\n", released: "config=new\nretained\n", valid: true },
  { name: "no-final-newline feature", base: "config=old\nfeature=off", approved: "config=old\nfeature=on", released: "config=new\nfeature=on", valid: true },
  { name: "missing reviewed feature", base: "config=old\nfeature=off\n", approved: "config=old\nfeature=on\n", released: "config=new\nfeature=off\n", valid: false },
  { name: "unchanged duplicate substituting for an added occurrence", base: "feature=on\nfeature=off\n", approved: "feature=on\nfeature=on\n", released: "feature=on\nindependent config\n", valid: false },
  { name: "removed reviewed final newline", base: "feature=off\n", approved: "feature=on\n", released: "independent config\nfeature=on", valid: false },
  { name: "reversed reviewed additions", base: "old feature\n", approved: "first feature\nsecond feature\n", released: "second feature\nfirst feature\n", valid: false },
  { name: "additive release retaining an ambiguous removed duplicate", base: "duplicate\nremoved feature\nduplicate\n", approved: "duplicate\n", released: "duplicate\nindependent config\n", valid: true },
  { name: "additive release retaining a removed blank token", base: "\nremoved feature\n\n", approved: "\n", released: "\nindependent config\n", valid: true },
  { name: "ambiguous removal with rewritten context", base: "duplicate\nremoved feature\nduplicate\nconfig=old\n", approved: "duplicate\nconfig=old\n", released: "duplicate\nconfig=new\n", valid: false },
])("Human Review verifies intended diff scope: $name", async ({ base, approved, released, valid }) => {
  const f = await mergeFixture({ milestone: "release", baselineContent: base, candidateContent: approved });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "scoped-release", f.descendant(released)]); f.change({ release: "scoped-release" }); f.restart();
    const response = await f.post(f.route + "merge", f.body); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: valid ? "released" : "awaiting_release", release_tag: valid ? "scoped-release" : null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "draft", patch: { draft: true } },
  { name: "prerelease", patch: { prerelease: true } },
  { name: "changed immutable ID", patch: { id: 2 } },
  { name: "changed tag", patch: { tag_name: "another-tag" } },
  { name: "changed target", patch: { target_commitish: "another-branch" } },
  { name: "unpublished", patch: { published_at: null } },
  { name: "republished", patch: { published_at: "2026-10-18T00:00:00Z" } },
])("Human Review refuses a containing release changed after inventory: $name", async ({ patch }) => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "changed-publication", "main"]);
    f.change({ release: "changed-publication", release_after_inventory_patch: { release_lookup_patch: patch } });
    const rejected = await f.post(f.route + "merge", f.body); expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "release_inventory_unavailable" } });
    expect(f.calls().some(args => args[1] === "repos/fictional/project/releases/1")).toBe(true);
    f.change({ release_lookup_patch: null }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "changed-publication" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each(["independent context", "deleted publication"])("the connection automatically verifies %s under its original owner authority", async scenario => {
  const f = await releaseBrowserFixture({ baselineContent: "config=old\nfeature=off\n", candidateContent: "config=old\nfeature=on\n" });
  const post = (path: string, body: unknown) => fetch(`http://localhost:${f.app.port}${f.prefix}${path}`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
  try {
    const ready = await f.detail(); const review = ready.human_reviews[0]; expect(ready.human_review_approvals).toEqual([]);
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `scoped-release-${scenario.replaceAll(" ", "-")}` };
    const approved = await post("/human-review/approve", body); expect(approved.status).toBe(200);
    const receipt = await approved.json(); expect(receipt.condition).toBe("awaiting_release");
    const merge = f.core.githubState().pull.mergeCommit.oid;
    f.core.git(["tag", "scoped-owner-release", f.core.descendant("config=new\nfeature=on\n")]);
    f.core.change({ release: "scoped-owner-release", ...(scenario === "deleted publication" ? { release_after_inventory_patch: { release: null } } : {}) });
    if (scenario === "deleted publication") {
      const rejected = await post("/human-review/approve", body); expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ id: receipt.id, condition: "awaiting_release", reason_is_error: true, merge_sha: merge });
      expect((await f.detail()).implementation.stage).not.toBe("done");
      f.core.change({ release: "scoped-owner-release" });
    } else {
      // Establish actual recoverable observation backoff; ordinary release polls are thirty seconds apart.
      f.core.change({ release_lookup_missing: true });
      const unavailable = await post("/human-review/approve", body); expect(unavailable.status).toBe(200);
      expect(await unavailable.json()).toMatchObject({ id: receipt.id, condition: "awaiting_release", reason_is_error: true, merge_sha: merge });
      f.core.change({ release_lookup_missing: false });
    }
    await f.restart();
    const completed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "released" && d.runs.find((run: any) => run.id === f.core.id)?.condition === "completed");
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: receipt.id, idempotency_key: receipt.idempotency_key, context_revision: receipt.context_revision, head: receipt.head, merge_sha: merge, condition: "released", release_tag: "scoped-owner-release", reason: null });
    expect(completed.human_review_approvals[0].reason_is_error ?? false).toBe(false);
    expect(completed.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(completed.events.filter((event: any) => event.kind === "human_review_merge_authorized")).toHaveLength(1);
    for (const request of f.mergeRequests) expect(request.approval).toMatchObject({ id: receipt.id, idempotency_key: receipt.idempotency_key, context_revision: receipt.context_revision, head: receipt.head });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);

it("Human Review discovers a valid containing release on page two after restart", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    const merge = f.git(["rev-parse", "main"]);
    f.git(["tag", "draft-containing", merge]); f.git(["tag", "prerelease-containing", merge]); f.git(["tag", "older-release", f.base]);
    f.git(["tag", "page-two-release", f.descendant("after\nIndependent release addition\n")]);
    const first = Array.from({ length: 98 }, (_, index) => ({ id: index + 1, draft: true, prerelease: false, tag_name: "draft-containing" }));
    const pages = { 1: [...first, { id: 99, draft: false, prerelease: true, tag_name: "prerelease-containing" }, { id: 100, draft: false, prerelease: false, tag_name: "older-release" }], 2: [{ id: 101, draft: false, prerelease: false, tag_name: "page-two-release" }] };
    f.change({ release_pages: pages }); f.restart();
    const response = await f.post(f.route + "merge", f.body); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "released", head: f.head, merge_sha: merge, release_tag: "page-two-release" });
    expect(f.calls().some(args => args[1] === "repos/fictional/project/releases?per_page=100&page=2")).toBe(true);
    expect(f.calls().some(args => args[1]?.includes("page=3"))).toBe(false);
    f.restart(); expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", merge_sha: merge, release_tag: "page-two-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

const draftReleasePage = (page: number) => Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1, draft: true, prerelease: false, tag_name: `draft-${page}-${index}` }));

it.each([0, 1, 3])("Human Review keeps a complete inventory with %s full pages and no eligible release as an ordinary wait", async fullPages => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    const pages = Object.fromEntries(Array.from({ length: fullPages }, (_, index) => [index + 1, draftReleasePage(index + 1)]));
    f.change({ release_pages: pages });
    const response = await f.post(f.route + "merge", f.body); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "awaiting_release", release_tag: null, reason: "Merge verified; waiting for a published release containing it" });
    const lookups = f.calls().filter(args => /\/releases(?:\?|$)/.test(args[1] ?? ""));
    expect(lookups).toHaveLength(fullPages + 1);
    expect(lookups.at(-1)?.[1]).toBe(`repos/fictional/project/releases?per_page=100&page=${fullPages + 1}`);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each(["unavailable", "malformed page", "malformed row", "overlap", "oversized page", "bounded incomplete"])("Human Review reports %s release inventory as a recoverable fault rather than absent delivery", async fault => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    const first = draftReleasePage(1); const pages: Record<string, unknown> = { 1: first, 2: [] };
    if (fault === "malformed page") pages[2] = null;
    if (fault === "malformed row") pages[2] = [{ id: 101, draft: false, prerelease: false }];
    if (fault === "overlap") pages[2] = [first[0]];
    if (fault === "oversized page") pages[2] = [...draftReleasePage(2), { id: 201, draft: true, prerelease: false, tag_name: "too-many" }];
    if (fault === "bounded incomplete") for (let page = 2; page <= 11; page++) pages[page] = draftReleasePage(page);
    f.change({ release_pages: pages, release_page_error: fault === "unavailable" ? 2 : 0 }); f.restart();
    const before = f.calls().length;
    const response = await f.post(f.route + "merge", f.body); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "release_inventory_unavailable" } });
    const lookups = f.calls().slice(before).filter(args => /\/releases(?:\?|$)/.test(args[1] ?? ""));
    expect(lookups).toHaveLength(fault === "bounded incomplete" ? 10 : 2);
    expect(lookups.some(args => args[1]?.includes("page=11"))).toBe(false);
    f.change({ release_pages: { 1: [] }, release_page_error: 0 }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each(["initial merge", "verified merge"])("the connection automatically recovers a paginated inventory fault after %s with its original owner authority", async stage => {
  const f = await releaseBrowserFixture();
  const post = (path: string, body: unknown) => fetch(`http://localhost:${f.app.port}${f.prefix}${path}`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
  try {
    const ready = await f.detail(); const review = ready.human_reviews[0]; expect(ready.human_review_approvals).toEqual([]);
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `inventory-recovery-${stage.replaceAll(" ", "-")}` };
    if (stage === "verified merge") {
      const approved = await post("/human-review/approve", body); expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ condition: "awaiting_release" });
    }
    f.core.change({ release_pages: { 1: draftReleasePage(1), 2: [] }, release_page_error: 2 });
    const response = await post("/human-review/approve", body); expect(response.status).toBe(200); const retained = await response.json();
    expect(retained.condition).toBe(stage === "initial merge" ? "uncertain" : "awaiting_release");
    expect(retained.reason).toContain("release inventory is incomplete or unavailable");
    if (stage === "verified merge") expect(retained.reason_is_error).toBe(true);
    else expect((await post("/questions", { question: "Must remain unsaved while merge confirmation is unknown" })).status).toBe(409);
    expect((await f.detail()).human_review_approvals).toHaveLength(1);
    const merge = f.core.githubState().pull.mergeCommit.oid; f.core.git(["tag", "recovered-paged-release", merge]);
    f.core.change({ release_page_error: 0, release_pages: { 1: draftReleasePage(1), 2: [{ id: 101, draft: false, prerelease: false, tag_name: "recovered-paged-release" }] } });
    await f.restart();
    const completed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "released" && d.runs.find((run: any) => run.id === f.core.id)?.condition === "completed");
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: retained.id, head: retained.head, context_revision: retained.context_revision, idempotency_key: retained.idempotency_key, merge_sha: merge, release_tag: "recovered-paged-release", condition: "released", reason: null });
    expect(completed.human_review_approvals[0].reason_is_error ?? false).toBe(false);
    expect(completed.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(completed.events.filter((event: any) => event.kind === "human_review_merge_authorized")).toHaveLength(1);
    for (const request of f.mergeRequests) expect(request.approval).toMatchObject({ id: retained.id, head: retained.head, context_revision: retained.context_revision, idempotency_key: retained.idempotency_key });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);


it.each(["local", "remote"] as const)("the %s Machine automatically recovers an inventory fault in the first approval response without another owner decision", async machine => {
  const f = await releaseBrowserFixture(machine === "local" ? { machineId: "local" } : {});
  const post = (path: string, body: unknown) => fetch(`http://localhost:${f.app.port}${f.prefix}${path}`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
  try {
    const ready = await f.detail(); const review = ready.human_reviews[0];
    expect(ready.human_review_approvals).toEqual([]);
    expect(ready.runs.find((run: any) => run.id === f.core.id).machine_id).toBe(machine === "local" ? "local" : "owned-release");
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `first-response-${machine}` };
    f.core.change({ release_page_error: 1 });
    const response = await post("/human-review/approve", body); expect(response.status).toBe(200);
    const retained = await response.json();
    expect(retained).toMatchObject({ condition: "uncertain", head: review.head, snapshot_id: review.snapshot_id, context_revision: ready.question_revision, idempotency_key: body.idempotency_key, merge_sha: null, merge_not_sent: false });
    expect(retained.reason).toContain("release inventory");
    expect((await f.detail()).implementation.stage).toBe("review");
    const merge = f.core.githubState().pull.mergeCommit.oid;
    expect(merge).toMatch(/^[a-f0-9]{40}$/);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    f.core.git(["tag", "first-response-recovered", merge]);
    f.core.change({ release_page_error: 0, release: "first-response-recovered" });
    const callsBeforeRecovery = f.core.calls().length;
    await f.restart();
    const completed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "released");
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: retained.id, run_id: retained.run_id, review_id: retained.review_id, head: retained.head, snapshot_id: retained.snapshot_id, context_revision: retained.context_revision, idempotency_key: retained.idempotency_key, merge_sha: merge, release_tag: "first-response-recovered", condition: "released", reason: null });
    expect(completed.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(completed.pull_requests).toEqual(ready.pull_requests);
    expect(completed.checks).toEqual(ready.checks);
    expect(completed.review_evidence).toEqual(ready.review_evidence);
    expect(completed.events.filter((event: any) => event.kind === "human_review_merge_authorized")).toHaveLength(1);
    expect(f.core.calls().length).toBeGreaterThan(callsBeforeRecovery);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);

it("Human Review preserves the Assignment release milestone when a later Run captures merge policy", async () => {
  const f = await mergeFixture({ milestone: "merge", assignmentMilestone: "release" });
  try {
    const merged = await f.post(f.route + "merge", f.body);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ condition: "awaiting_release", head: f.head, release_tag: null });
    expect(f.calls().some(args => /\/releases(?:\?|$)/.test(args[1] ?? ""))).toBe(true);
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "frozen-milestone-release", "main"]); f.change({ release: "frozen-milestone-release" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "frozen-milestone-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it.each(["before", "middle", "after"].flatMap(position => [false, true].map(advanceTarget => ({ position, advanceTarget }))))("Human Review recognizes additive containing release after restart %j", async ({ position, advanceTarget }) => {
  const f = await mergeFixture({ milestone: "release", candidateContent: "approved first\napproved second\n" });
  try {
    const merged = await f.post(f.route + "merge", f.body);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ condition: "awaiting_release", release_tag: null });
    const merge = f.git(["rev-parse", "main"]);
    const lines = ["approved first", "approved second"];
    lines.splice(position === "before" ? 0 : position === "middle" ? 1 : 2, 0, "Independent later content");
    const content = lines.join("\n") + "\n";
    const containing = f.descendant(content, advanceTarget);
    f.git(["tag", "additive-release", containing]); f.change({ release: "additive-release" });
    expect(f.git(["show", "additive-release:result.txt"])).toBe(content.trim());
    f.restart();
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "released", merge_sha: merge, release_tag: "additive-release", head: f.head });
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", merge_sha: merge, release_tag: "additive-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "changed approved line", content: "changed first\napproved second\n" },
  { name: "full revert plus unrelated addition", content: "before\nIndependent later content\n" },
  { name: "restored removed line alongside approved content", content: "before\napproved first\napproved second\nIndependent later content\n" },
])("Human Review refuses descendant content that undoes the candidate: $name", async ({ content }) => {
  const f = await mergeFixture({ milestone: "release", candidateContent: "approved first\napproved second\n" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "invalid-content", f.descendant(content)]); f.change({ release: "invalid-content" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([false, true])("Human Review refuses restoring a reviewed deletion even with unrelated additions (colored Git diff: %s)", async colored => {
  const f = await mergeFixture({ milestone: "release", baselineContent: "removed line\nretained line\n", candidateContent: "retained line\n" });
  try {
    if (colored) f.git(["config", "color.diff", "always"]);
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "restored-deletion", f.descendant("removed line\nretained line\nIndependent later content\n")]); f.change({ release: "restored-deletion" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "wrong hash", patch: { blob_patch: { sha: "f".repeat(40) } } },
  { name: "wrong size", patch: { blob_patch: { size: 1 } } },
  { name: "oversized blob", patch: { blob_patch: { size: 2 * 1024 * 1024 + 1 } } },
  { name: "unsupported encoding", patch: { blob_patch: { encoding: "utf8" } } },
  { name: "malformed base64", patch: { blob_patch: { content: "not base64" } } },
  { name: "wrong mode", patch: { tree_mode: "100755" } },
  { name: "incomplete tree", patch: { truncated_tree: true } },
])("Human Review rejects incomplete or changed descendant evidence: $name", async ({ patch }) => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "unverified-release", f.descendant("after\nIndependent later content\n")]); f.change({ release: "unverified-release", ...patch }); f.restart();
    const response = await f.post(f.route + "merge", f.body); const result = await response.json();
    expect([200, 409]).toContain(response.status);
    if (response.status === 409) expect(result).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    else expect(result).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each(["", "approved\0binary\n"])("Human Review keeps non-text or empty approved blobs on exact coverage", async candidateContent => {
  const f = await mergeFixture({ milestone: "release", candidateContent });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "non-text-extension", f.descendant(candidateContent + "Independent later content\n")]); f.change({ release: "non-text-extension" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("Human Review refuses a containing release whose tag moves during blob verification", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "moving-release", f.descendant("after\nIndependent later content\n")]); f.change({ release: "moving-release", move_tag_after_lookup: f.base });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    expect(f.git(["rev-parse", "moving-release"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("Human Review does not treat a descendant release that reverts approved content as delivery", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    const merge = f.git(["rev-parse", "main"]);
    const reverted = f.git(["commit-tree", f.git(["rev-parse", f.base + "^{tree}"]), "-p", merge, "-m", "Revert approved content"]);
    f.git(["tag", "reverted-release", reverted]); f.change({ release: "reverted-release" });
    expect(f.git(["show", "reverted-release:result.txt"])).toBe("before");
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    f.git(["tag", "containing-release", merge]); f.change({ release: "containing-release" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "containing-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it("Human Review retains an uncertain merge when its target later reverts the intended changes", async () => {
  const f = await mergeFixture();
  try {
    f.change({ lose: true });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "uncertain" });
    const merged = f.git(["rev-parse", "main"]);
    const reverted = f.git(["commit-tree", f.git(["rev-parse", f.base + "^{tree}"]), "-p", merged, "-m", "Revert merged result"]);
    f.git(["update-ref", "refs/heads/main", reverted]); f.restart();
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    f.git(["update-ref", "refs/heads/main", merged]);
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged", merge_sha: merged });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

it("the connection server retains release authority when an older Machine returns merge-only delivery", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  f.setTranscript({ source_id: "frozen-release-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained delivered result" }] }] });
  try {
    const { prefix, detail, run } = await published(f, "release");
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    expect(ready.implementation.delivery_scope.milestone).toBe("release");
    expect((await f.api(`/projects/${ready.implementation.project_id}/configure`, { delivery_policy: "merge" })).status).toBe(200);
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "older-machine-merge" };
    const project = (f.runs.get(run.id)!.manifest as { project: { delivery_policy: string } }).project;
    project.delivery_policy = "merge";
    let response: Response;
    try { response = await f.api(`${prefix}/human-review/approve`, body); }
    finally { project.delivery_policy = "release"; }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "awaiting_release", merge_sha: "a".repeat(40), release_tag: null });
    const waiting = await detail();
    expect(waiting.implementation.stage).toBe("review");
    expect(waiting.runs.find((r: any) => r.id === run.id).condition).not.toBe("completed");
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
    f.restart();
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("awaiting_release");
    f.releaseMerged();
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("released");
    const released = await until(detail, d => d.runs.find((r: any) => r.id === run.id)?.condition === "completed");
    expect(released.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(released.human_review_approvals).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("the connection server refuses release completion without a nonempty verified release tag", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  f.setTranscript({ source_id: "release-tag-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained release result" }] }] });
  try {
    const { prefix, detail, run } = await published(f, "release");
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "missing-release-tag" };
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("awaiting_release");
    f.releaseMerged("");
    const malformed = await f.api(`${prefix}/human-review/approve`, body).then(r => r.json());
    expect(malformed.condition).not.toBe("released");
    const pending = await detail();
    expect(pending.implementation.stage).toBe("review");
    expect(pending.runs.find((r: any) => r.id === run.id).condition).not.toBe("completed");
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
    f.releaseMerged("verified-tag");
    expect(await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "verified-tag" });
    expect((await detail()).implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([{ branch: "other-target" }, { github_repository: "fictional/other" }, { repository: "unrelated-checkout" }])("the Machine refuses a candidate outside its frozen Assignment destination %j", async assignmentScope => {
  const f = await mergeFixture({ assignmentScope });
  try {
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_authority_changed" } });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
    expect(f.git(["rev-parse", "main"])).toBe(f.base);
  } finally { f.close(); }
}, 20000);
