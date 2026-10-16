/** Explicit owner Retry against the built app and owned HTTP/native fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { githubQueueFixture } from "./fixtures/github-queue.ts";
import { githubReviewFixture } from "./fixtures/github-review.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const drift of ["issue", "testing_seams"] as const) {
      const fixture = githubReviewFixture();
      const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
      page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
      try {
        const { run, path, route, source } = await fixture.prepare(undefined, drift === "testing_seams" ? "Public HTTP greeting" : undefined);
        await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
        await fixture.review(run, "standards"); await fixture.review(run, "spec");
        const gate = fixture.holdStop();
        const retiring = fixture.post(`/runs/${run.id}/reconcile`, {});
        await Promise.race([gate.waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Stop was not reached")), 5000))]);
        try {
          if (drift === "testing_seams") await fixture.json(path + "/approvals", { kind: "testing_seams", revision: run.specification_id, scope: "Public CLI greeting", issue_scope: { source_id: source.id, source_revision: source.revision } });
          else { fixture.issue.body += "\nA reviewed change to the greeting."; fixture.save(); await fixture.json(route + "/sync", {}); }
        }
        finally { gate.release(); }
        assert.equal((await retiring).status, 409);
        await page.goto(fixture.origin + `/#factory/${run.implementation_id}`);
        const original = page.getByRole("region", { name: "Admitted issue contract", exact: true }).first();
        await original.getByText("Controlled pause requested. Issue scope changed.", { exact: true }).waitFor();
        await page.getByText("Advanced controls", { exact: true }).last().click();
        const stoppedResponse = page.waitForResponse(response => response.url().endsWith(`/runs/${run.id}/stop`) && response.request().method() === "POST");
        await page.getByRole("button", { name: "Stop Run", exact: true }).click();
        assert.equal((await stoppedResponse).status(), 200);
        fixture.restart(); await page.goto(fixture.origin + `/#factory/${run.implementation_id}`);
        await page.getByText("Advanced controls", { exact: true }).last().click();
        await page.getByRole("button", { name: "Reconcile Run", exact: true }).last().click();
        const actions = page.getByRole("region", { name: "Next step", exact: true });
        for (let remaining = await actions.getByLabel("Your answer", { exact: true }).count(); remaining > 0; remaining--) {
          await actions.getByLabel("Your answer", { exact: true }).first().fill("Keep produced work and use the reviewed current issue plan in a new attempt.");
          const saved = page.waitForResponse(response => /\/questions\/[^/]+\/answer$/.test(response.url()) && response.request().method() === "POST");
          await actions.getByRole("button", { name: "Save answer", exact: true }).first().click();
          assert.equal((await saved).status(), 200);
          await actions.getByLabel("Your answer", { exact: true }).nth(remaining - 1).waitFor({ state: "detached" });
        }
        if (drift === "issue") await page.getByRole("button", { name: "Approve this issue revision", exact: true }).click();
        await page.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
        if (drift === "testing_seams") {
          const planning = page.getByRole("region", { name: "Issue planning", exact: true });
          await planning.getByText("Needs you", { exact: true }).waitFor();
          const retained = planning.locator("details").filter({ has: page.locator("summary", { hasText: "Reused planning" }) });
          await retained.locator("summary").click();
          await retained.getByText("Public CLI greeting", { exact: true }).waitFor();
          const renewed = page.waitForResponse(response => response.url().endsWith(path + "/approvals") && response.request().postDataJSON().kind === "testing_seams");
          await planning.getByRole("button", { name: "Approve retained app plan for this issue revision", exact: true }).click();
          const approval = await renewed;
          assert.equal(approval.status(), 201);
          assert.equal(approval.request().postDataJSON().scope, "Public CLI greeting");
          await actions.getByLabel("Your answer", { exact: true }).fill("Use the explicitly reviewed Public CLI greeting seam in the successor.");
          const answered = page.waitForResponse(response => /\/questions\/[^/]+\/answer$/.test(response.url()) && response.request().method() === "POST");
          await actions.getByRole("button", { name: "Save answer", exact: true }).click();
          assert.equal((await answered).status(), 200);
          await actions.getByLabel("Your answer", { exact: true }).waitFor({ state: "detached" });
          await planning.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
        }
        await page.getByText("Planning prepared", { exact: true }).waitFor();
        await fixture.json(route + "/sync", {}); await page.reload();
        const retry = page.getByRole("region", { name: "Issue planning", exact: true }).getByRole("button", { name: "Retry", exact: true });
        await retry.waitFor();
        const stopped = (await fixture.json(path)).runs[0];
        assert.equal(stopped.condition, "cancelled");
        assert.equal(stopped.implementation_completion_pending, undefined);
        assert.deepEqual(stopped.manifest, run.manifest);
        assert.equal((await fixture.json(path)).runs.length, 1);
        await retry.click();
        await page.getByRole("region", { name: "Admitted issue contract", exact: true }).last().getByText("Execution confirmed.", { exact: true }).waitFor();
        const detail = await fixture.json(path);
        assert.equal(detail.runs.length, 2);
        assert.equal(detail.runs[1].retry_of, run.id);
        assert.equal(detail.runs[1].manifest.rework.run_id, run.id);
        assert.equal(detail.runs[1].manifest.rework.head, "a".repeat(40));
        assert.deepEqual(detail.runs[0], stopped);
        if (drift === "testing_seams") {
          assert.equal((detail.runs[0].manifest as any).issue_admission.planning.testing_seams, "Public HTTP greeting");
          assert.equal((detail.runs[1].manifest as any).issue_admission.planning.testing_seams, "Public CLI greeting");
          assert.equal(detail.github_sources[0].planning.testing_seams, "Public CLI greeting");
        }
        assert.equal(await retry.count(), 0);
      } finally { await page.close(); fixture.close(); }
    }
  }
  console.log("PASS: desktop/mobile issue and fallback-seam controlled pause, exact seam renewal, retained work and explicit successor");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = githubQueueFixture(true);
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    try {
      const { route, readiness } = await fixture.setup();
      const source = (await fixture.json(route + "/sync", {})).sources[0];
      await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
      await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
      const current = (await fixture.json(route + "/sync", {})).sources[0];
      const path = `/implementations/${source.implementation_id}`;
      fixture.setLaunchOutcome("failed");
      const failed = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "browser-first-attempt", issue_scope: { source_id: source.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
      assert.equal(failed.condition, "failed");
      await fixture.json(route + "/sync", {});
      await page.goto(fixture.origin + `/#factory/${source.implementation_id}`);
      await page.getByText("Attempt failed. Use Retry to start again.", { exact: true }).waitFor();
      const retry = page.getByRole("region", { name: "Issue planning", exact: true }).getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      await page.reload();
      await retry.waitFor();
      assert.deepEqual(fixture.launches, [failed.id]);
      fixture.setLaunchOutcome("working");
      const planning = await fixture.json(path + "/runs", { action: "to-spec", idempotency_key: "browser-planning-after-failure" });
      let planningStopped = false;
      fixture.setExecutionHandler(async request => {
        const operation = new URL(request.url).pathname;
        if (operation.endsWith(`/runs/${planning.id}/stop`)) planningStopped = true;
        return operation.endsWith(`/runs/${planning.id}/stop`) || operation.endsWith(`/runs/${planning.id}/reconcile`) ? Response.json({ ...planning, condition: planningStopped ? "cancelled" : "working" }) : null;
      });
      await page.reload();
      await retry.waitFor(); assert.equal(await retry.isDisabled(), true);
      await page.getByText("Advanced controls", { exact: true }).last().click();
      const stoppedPlanning = page.waitForResponse(response => response.url().endsWith(`/runs/${planning.id}/stop`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "Stop Run", exact: true }).click();
      assert.equal((await stoppedPlanning).status(), 200);
      fixture.restart(); await page.goto(fixture.origin + `/#factory/${source.implementation_id}`);
      await retry.waitFor(); assert.equal(await retry.isEnabled(), true);
      fixture.setLaunchOutcome("lost");
      await retry.click();
      await page.getByText("Reconciliation required. Ownership remains reserved.", { exact: true }).waitFor();
      const attempts = (await fixture.json(path)).runs;
      assert.equal(attempts.length, 3);
      assert.equal(attempts[1].id, planning.id); assert.equal(attempts[1].condition, "cancelled");
      assert.equal(attempts[2].retry_of, failed.id);
      const contract = page.getByRole("region", { name: "Admitted issue contract", exact: true }).last();
      await contract.getByRole("button", { name: "Reconcile Run", exact: true }).click();
      await contract.getByText("Execution confirmed.", { exact: true }).waitFor();
      assert.deepEqual(fixture.launches, [failed.id, planning.id, attempts[2].id]);
      assert.deepEqual((await fixture.json(path)).runs[0], failed);
      assert(await contract.evaluate(element => element.scrollWidth <= element.clientWidth));
      const evidence = process.env["UI_EVIDENCE_DIR"];
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `issue-retry-${viewport.width}.png`), fullPage: true }); }
    } finally { await page.close(); fixture.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile failed attempt, intervening stopped planning, restart, explicit Retry and uncertain outcome reconciliation");
} finally { await browser.close(); }
