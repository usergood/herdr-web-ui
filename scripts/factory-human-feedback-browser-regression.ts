/** Owned Human Review decline/fix/wait-for-approval journeys. No paid agents. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { githubFixture } from "./factory-github-fixture.ts";
import { fictionalGitHubPull } from "../site/demo/github-fixtures.ts";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const g = await githubFixture();
    const f = await capacityFixture({ advancingHeads: true, accountTools: { github: { executable: process.execPath, args: [join(g.root, "gh.mjs")] } } });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    let releaseDiscussion: (() => void) | undefined;
    try {
      const { id, detail } = await published(f);
      await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
      const ownerPost = async (path: string, body: unknown) => {
        const response = await context.request.post(`${origin}/api/factory${path}`, { headers: { "x-herdr-factory": "1", "x-herdr-machine": "1" }, data: body });
        assert(response.ok(), await response.text()); return response.json();
      };
      const profile = await ownerPost("/machines/local/accounts", { name: "Owned review GitHub", service: "github", expected_login: "fictional-owner" });
      await ownerPost(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
      const project = await ownerPost("/projects", { name: "Shared GitHub repository", path: join(g.root, "repo"), machine_id: "local", provider: "codex", tracker: "app" });
      const route = `/projects/${project.id}/github`;
      await ownerPost(route + "/configure", { ...g.policy, import_issues: false, import_fixes: false, auto_merge: true, account_profile_id: profile.id });
      const githubPage = await context.newPage(); githubPage.setDefaultTimeout(10000);
      githubPage.on("pageerror", e => errors.push(e.message));
      await githubPage.goto(`${origin}/#projects/${project.id}/settings`);
      await githubPage.getByRole("tab", { name: "GitHub", exact: true }).click();
      const github = githubPage.getByTestId("project-github");
      const assertFactoryFence = async (expectedApprovals = 1) => {
        const pr = (await detail()).pull_requests.at(-1);
        const pull = { ...structuredClone(fictionalGitHubPull), headRefOid: pr.head, headRefName: pr.branch, author: { login: "fictional-owner" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", reviewRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, reviews: { nodes: [{ id: "owned-review", state: "APPROVED", body: "Owned review", submittedAt: "2026-10-16T00:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: pr.head } }], pageInfo: { hasNextPage: false, endCursor: null } } };
        writeFileSync(g.state, JSON.stringify({ issues: [], pulls: [pull] }));
        const [response] = await Promise.all([githubPage.waitForResponse(r => r.url().endsWith(`${route}/sync`)), github.getByRole("button", { name: "Sync GitHub", exact: true }).click()]);
        assert.equal(response.status(), 200);
        await github.getByRole("link", { name: "#27 · Fictional pending review", exact: true }).waitFor();
        assert(!readFileSync(g.log, "utf8").includes("/pulls/27/merge"), "Project auto-merge must preserve Human Review authority");
        await github.getByRole("button", { name: "Merge PR", exact: true }).click();
        await githubPage.getByRole("alert").filter({ hasText: "Factory PRs merge only through revision-bound Human Review approval" }).waitFor();
        assert(!readFileSync(g.log, "utf8").includes("/pulls/27/merge"));
        assert.equal((await detail()).human_review_approvals.length, expectedApprovals);
        assert.equal(f.mergeEffects.length, 0);
      };
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      f.mergeFailure("merge_blocked");
      await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
      await review.getByRole("alert").filter({ hasText: "GitHub protection, pending reviews, required checks or conflicts block this target" }).waitFor();
      const oldApproval = (await detail()).human_review_approvals[0];
      assert.equal(oldApproval.condition, "blocked"); assert.equal(oldApproval.merge_not_sent, true);
      f.mergeFailure(null);
      await assertFactoryFence();
      for (let round = 0; round < 2; round++) {
        const before = await detail(); const previous = before.human_reviews[0];
        await review.getByRole("button", { name: "After 1", exact: true }).click();
        await review.getByRole("textbox", { name: "Review finding", exact: true }).fill(`Feedback ${round + 1}`);
        await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
        await review.getByRole("region", { name: "Draft comments", exact: true }).getByText(`Feedback ${round + 1}`, { exact: true }).waitFor();
        await page.reload();
        let assistantId: string | undefined;
        const discussionGate = round === 1 ? f.holdNextAllocation() : null;
        if (discussionGate) {
          releaseDiscussion = discussionGate.release;
          await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("Explain while I submit these fixes");
          await review.getByRole("button", { name: "Send discussion", exact: true }).click();
          await review.getByText("Explain while I submit these fixes", { exact: true }).waitFor();
          assistantId = await discussionGate.started;
        }
        await review.getByRole("button", { name: "Decline", exact: true }).click();
        await review.getByRole("region", { name: "Submitted comments", exact: true }).getByText(`Feedback ${round + 1}`, { exact: true }).waitFor();
        await review.getByText("Fixes are running. A later approval is required to merge.", { exact: true }).waitFor();
        assert(await review.getByRole("button", { name: "Decline", exact: true }).isDisabled());
        if (discussionGate && assistantId) {
          discussionGate.release();
          const delivered = await until(detail, d => d.human_review_deliveries.some((m: any) => m.condition === "sent"));
          assert.equal(delivered.human_reviews[0].condition, "repairing");
          assert.equal(delivered.human_reviews[0].assistant_run_id, assistantId);
          f.runs.get(assistantId)!.condition = "ready";
          await f.api(`/runs/${assistantId}/reconcile`, {});
        }
        const fixing = await until(detail, d => d.workers.some((w: any) => w.review_origin === "human" && w.condition === "working"));
        const fix = fixing.workers.find((w: any) => w.review_origin === "human" && w.condition === "working");
        if (round === 0) f.workers.get(fix.id)!.head = previous.head; // Owned Machine reports a completed no-op repair.
        f.workers.get(fix.id)!.condition = "ready";
        for (const axis of ["standards", "spec"]) {
          const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
          f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
        }
        const returned = await until(detail, d => d.human_reviews[0].condition === "ready" && d.human_feedback_batches[round]?.resolution);
        assert.equal(returned.human_reviews[0].head === previous.head, round === 0);
        assert.notEqual(returned.human_reviews[0].snapshot_id, previous.snapshot_id);
        assert.equal(returned.human_reviews[0].id, previous.id);
        await review.getByText("Fixes passed checks and independent reviews. Awaiting your approval.", { exact: true }).waitFor();
        await page.reload();
        await review.getByText("Fixes passed checks and independent reviews. Awaiting your approval.", { exact: true }).waitFor();
        if (round === 1) await review.getByText("Explain while I submit these fixes", { exact: true }).waitFor();
        assert.equal(returned.human_feedback_batches.length, round + 1);
        assert(returned.human_feedback_batches.every((b: any) => b.merge_authorized === false));
        assert.equal(returned.implementation.stage, "review");
        await assertFactoryFence(round + 1);
        if (round === 0) {
          f.mergeFailure("merge_blocked");
          await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
          await review.getByRole("alert").filter({ hasText: "GitHub protection, pending reviews, required checks or conflicts block this target" }).waitFor();
          const retried = (await detail()).human_review_approvals;
          assert.equal(retried.length, 2);
          assert.equal(retried[1].head, oldApproval.head);
          assert.equal(retried[1].snapshot_id, returned.human_reviews[0].snapshot_id);
          assert.notEqual(retried[1].idempotency_key, oldApproval.idempotency_key);
          assert.equal(retried[1].merge_not_sent, true);
          f.mergeFailure(null);
        }
      }
      assert.equal(await review.getByRole("region", { name: "Draft comments", exact: true }).locator("article").count(), 0);
      assert.equal(await review.getByRole("region", { name: "Submitted comments", exact: true }).locator("article").count(), 2);
      await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
      await review.getByText("Merge verified", { exact: true }).waitFor();
      assert.equal((await detail()).implementation.outcome, "merged");
      assert.equal(f.mergeEffects.length, 1);
      const approvals = (await detail()).human_review_approvals;
      assert.equal(approvals.length, 3);
      assert.equal(approvals[0].id, oldApproval.id);
      assert.equal(approvals[0].condition, "blocked");
      assert.equal(approvals[0].superseded_by_batch_id, (await detail()).human_feedback_batches[0].id);
      assert.equal(approvals[1].superseded_by_batch_id, (await detail()).human_feedback_batches[1].id);
      assert.notEqual(approvals[2].snapshot_id, oldApproval.snapshot_id);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { releaseDiscussion?.(); await context.close(); f.close(); g.close(); }
  }
  console.log("PASS Human Review decline, fresh repairs, return awaiting approval and explicit reapproval on desktop/mobile");
} finally { await browser.close(); }
